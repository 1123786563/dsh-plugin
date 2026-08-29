/**
 * dsh-casdoor-auth: the dsh-side half of the Casdoor login gate.
 *
 * The standalone dsh-casdoor-gateway service owns the public port, the OIDC
 * login, and the proxying; this plugin consumes what the gateway forwards:
 *
 *  - ctx.casdoorAuth verifies the per-request DshIdentityToken (Ed25519 JWT
 *    against the gateway's JWKS) into a canonical CasdoorIdentity;
 *  - guardEnabled claims the host webserver's guard seat into a zero-trust
 *    private-port gate: every request without a valid DshIdentityToken (or
 *    the launch-token bootstrap credential) is vetoed 401 (ADR-0006);
 *  - the SPA shell gets the 401 login-redirect watcher injected through
 *    webServer.tapIndex;
 *  - the dsh-multi-tenant MCP SaaS runtime assembles on top: its web bridge
 *    (identity + agent admission routes) authenticates via ctx.casdoorAuth,
 *    and its identity resolver maps the subject to {tenantId, userId}.
 *
 * Known boundary (upstream #41): stock DSH web RPC does not materialize a
 * product-authenticated Principal per business method — the gateway gates
 * WHO gets in; tenant isolation lives in the Agent layer below.
 *
 * @module dsh-casdoor-auth
 */

import type { IncomingMessage } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  createMcpSaaSRuntime,
  InMemoryPrincipalCredentials,
  mountMcpSaaSWebBridge,
  type McpSaaSRuntime,
  type McpSaaSWebBridge,
} from 'dsh-multi-tenant'
import { Config, mcpServersFor, resolveConfig } from './config.ts'
import type { Config as ConfigShape } from './config.ts'
import { applyGuard } from './guard.ts'
import { IdentityVerifier, type CasdoorIdentity } from './identity.ts'
import { inject401Watcher, WATCHER_SCRIPT } from './watcher.ts'

/** Cordis plugin name; keep this stable after publishing. */
export const name = 'casdoor-auth'

/** No static injects: both webServer and the multi-tenant services bind dynamically below. */
export const inject: string[] = []

/**
 * The gateway-identity service: verification of DshIdentityTokens into the
 * canonical identity other plugins (and the multi-tenant bridge) consume.
 */
export class CasdoorAuthService extends Service {
  private readonly verifier: IdentityVerifier

  constructor(ctx: Context, config: ConfigShape) {
    super(ctx, 'casdoorAuth')
    this.verifier = new IdentityVerifier({
      gatewayJwksUrl: config.gatewayJwksUrl,
      identityPublicKey: config.identityPublicKey,
      identityHeader: config.identityHeader,
      issuer: config.issuer,
      audience: config.audience,
    })
  }

  /** Verify the identity the gateway attached to one incoming request. */
  identityFromRequest(req: IncomingMessage): Promise<CasdoorIdentity | undefined> {
    return this.verifier.fromRequest(req.headers)
  }

  /** Verify a raw DshIdentityToken (useful for tests and tooling). */
  verifyToken(token: string): Promise<CasdoorIdentity | undefined> {
    return this.verifier.verifyToken(token)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    casdoorAuth: CasdoorAuthService
  }
}

/**
 * Minimal face of the dsh-client-connection service: only the launch-token
 * URL is needed, and a static type import would pin another @deepseek-ai
 * package version that older cores did not ship.
 */
interface ConnectionService {
  authenticatedUrl(baseUrl: string): string
}

function expandHome(path: string): string {
  return path === '~' || path.startsWith(`~/`) ? join(homedir(), path.slice(1)) : path
}

export { Config }
export type { ConfigShape }
export { GUARD_HINT, applyGuard, createCasdoorRequestGuard } from './guard.ts'
export type {
  WebRequestGuard,
  WebRequestGuardDecision,
  WebRequestGuardSeat,
  WebRequestPrincipal,
} from './guard.ts'
export { IdentityVerifier }
export type { CasdoorIdentity }
export { inject401Watcher, WATCHER_SCRIPT }
export { mcpServersFor, resolveConfig }

/**
 * Activate the plugin: resolve configuration, provide ctx.casdoorAuth, inject
 * the 401 watcher into the SPA shell, claim the host's guard seat when
 * guardEnabled, and (on the web profile, with the dsh-multi-tenant services
 * present) assemble the MCP SaaS bridge.
 * @param ctx - host context.
 * @param config - loader-supplied entry config.
 */
export function apply(ctx: Context, config: Partial<ConfigShape> | undefined): void {
  const entry = resolveConfig(config)
  const service = new CasdoorAuthService(ctx, entry)

  // The per-process launch token, recorded whether or not the connection
  // service exposes one: the guard reads the holder at decision time, so the
  // unbounded boot order between webServer and connection cannot wedge the
  // comparison.
  const launchToken: { current: string | undefined } = { current: undefined }

  // 401 watcher: injected server-side into every rendered index.html, so a
  // mid-session expiry becomes a login redirect without any client-half
  // service dependency (works on every plugin's fetches too).
  //
  // Zero-trust private-port guard (default off): claim the host webserver's
  // single guard seat and admit only credentialed requests. Requires a core
  // carrying scripts/host-patches/deepseek-harness.dsh-request-guard.patch —
  // applyGuard fails loud when the seat is missing.
  ctx.inject(['webServer'], scoped => {
    scoped.effect(() => scoped.webServer.tapIndex(inject401Watcher), 'casdoor-auth: 401 watcher')
    if (entry.guardEnabled) {
      const releaseGuard = applyGuard(scoped.webServer, entry, service, () => launchToken.current)
      scoped.effect(() => releaseGuard, 'casdoor-auth: zero-trust private-port guard')
    }
  })

  // dsh >= 0.1.2-alpha browser auth: the webserver authenticates every
  // request with its own signed cookie, minted by exchanging the per-process
  // launch token. Publish that token to the gateway data dir so the gateway
  // can mint and attach the cookie on proxied traffic (see
  // services/casdoor-gateway/src/upstream-auth.ts). Cores without browser
  // auth (< 0.1.2-alpha) expose no launch token; the block self-skips.
  ctx.inject(['connection'], scoped => {
    const connection = scoped.get('connection') as Partial<ConnectionService> | undefined
    if (connection === undefined || typeof connection.authenticatedUrl !== 'function') return
    const token = new URL(connection.authenticatedUrl('http://127.0.0.1/')).searchParams.get('token')
    launchToken.current = token !== null && token !== '' ? token : undefined
    if (launchToken.current === undefined) {
      scoped.logger('casdoor-auth').warn(
        'connection service exposed no launch token; gateway login cannot satisfy dsh web browser auth',
      )
      return
    }
    const file = join(expandHome(entry.gatewayDataDir), 'webserver-token.json')
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${JSON.stringify({ token: launchToken.current, updatedAt: Date.now() })}\n`, { mode: 0o600 })
    } catch (error) {
      scoped.logger('casdoor-auth').warn(
        error instanceof Error ? error : new Error(String(error)),
        'failed to publish the webserver launch token to the gateway data dir',
      )
    }
  })

  // The multi-tenant assembly. Declared injects mirror the vendored starter's
  // contract: the bridge needs webServer, the runtime composition needs
  // tenantRuntime, and agent create/resume needs agents + multiTenant.
  ctx.inject(['webServer', 'tenantRuntime', 'agents', 'multiTenant'], scoped => {
    scoped.effect(() => {
      let bridge: McpSaaSWebBridge | undefined
      let runtime: McpSaaSRuntime<CasdoorIdentity> | undefined
      let cancelled = false
      void (async () => {
        try {
          const built = await createMcpSaaSRuntime<CasdoorIdentity>(scoped, {
            identity: subject => ({ tenantId: subject.tenantId, userId: subject.userId }),
            mcp: {
              load: async ({ tenantId }) => mcpServersFor(entry, tenantId),
            },
            credentials: {
              create: async () => new InMemoryPrincipalCredentials(entry.credentials),
            },
          })
          if (cancelled) {
            await built.dispose()
            return
          }
          runtime = built
          bridge = mountMcpSaaSWebBridge(scoped, runtime, {
            basePath: entry.basePath,
            controlPage: entry.controlPage,
            authenticate: req => service.identityFromRequest(req),
          })
        } catch (error) {
          scoped.logger('casdoor-auth').error(
            error instanceof Error ? error : new Error(String(error)),
          )
        }
      })()
      return () => {
        cancelled = true
        bridge?.dispose()
        void runtime?.dispose()
      }
    }, 'casdoor-auth: multi-tenant bridge')
  })
}
