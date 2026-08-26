/**
 * dsh-casdoor-auth: the dsh-side half of the Casdoor login gate.
 *
 * The standalone dsh-casdoor-gateway service owns the public port, the OIDC
 * login, and the proxying; this plugin consumes what the gateway forwards:
 *
 *  - ctx.casdoorAuth verifies the per-request DshIdentityToken (Ed25519 JWT
 *    against the gateway's JWKS) into a canonical CasdoorIdentity;
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

export { Config }
export type { ConfigShape }
export { IdentityVerifier }
export type { CasdoorIdentity }
export { inject401Watcher, WATCHER_SCRIPT }
export { mcpServersFor, resolveConfig }

/**
 * Activate the plugin: resolve configuration, provide ctx.casdoorAuth, inject
 * the 401 watcher into the SPA shell, and (on the web profile, with the
 * dsh-multi-tenant services present) assemble the MCP SaaS bridge.
 * @param ctx - host context.
 * @param config - loader-supplied entry config.
 */
export function apply(ctx: Context, config: Partial<ConfigShape> | undefined): void {
  const entry = resolveConfig(config)
  const service = new CasdoorAuthService(ctx, entry)

  // 401 watcher: injected server-side into every rendered index.html, so a
  // mid-session expiry becomes a login redirect without any client-half
  // service dependency (works on every plugin's fetches too).
  ctx.inject(['webServer'], scoped => {
    scoped.effect(() => scoped.webServer.tapIndex(inject401Watcher), 'casdoor-auth: 401 watcher')
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
