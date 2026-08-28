/**
 * The zero-trust private-port request guard: the plugin-side consumer of the
 * host webserver's single guard seat (ADR-0004, delivered by
 * scripts/host-patches/deepseek-harness.dsh-request-guard.patch). While
 * enabled, every HTTP and upgrade request on the dsh private port must carry
 * one valid credential — the gateway's DshIdentityToken or the per-process
 * launch token — and everything else is vetoed 401 with the fixed hint;
 * there is no path whitelist. Design adjudication:
 * docs/adr/0006-zero-trust-private-port-guard.md.
 *
 * @module dsh-casdoor-auth/guard
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Config } from './config.ts'
import type { CasdoorIdentity } from './identity.ts'
import type { CasdoorAuthService } from './index.ts'

/** Fixed body of every guard veto: the operator-readable way in. */
export const GUARD_HINT = '请走 http://127.0.0.1:3080'

/**
 * Minimal face of the host webserver's guard-seat API. The pinned
 * devDependency @deepseek-ai/dsh-host-webserver@0.1.1-rc.2 predates the
 * seat, so seat presence is a runtime feature check — the same stance as the
 * ConnectionService face in index.ts.
 */
export interface WebRequestGuardSeat {
  /**
   * Claim the single guard seat consulted before any routing.
   * @param guard - admission callback; a throw or rejection vetoes fail-closed.
   * @returns the disposer releasing the seat.
   */
  registerGuard(guard: WebRequestGuard): () => void
}

/**
 * Admission verdict for one request: allow, optionally attaching a principal
 * the host exposes per request, or veto with the HTTP response fields (an
 * upgrade veto destroys the socket instead). Mirrors the host's
 * RequestGuardDecision discriminant union.
 */
export type WebRequestGuardDecision =
  | { allow: true, principal?: unknown }
  | { allow: false, status?: number, body?: string }

/**
 * Single-seat admission callback consulted before any routing on both HTTP
 * and upgrade requests.
 */
export type WebRequestGuard = (
  req: IncomingMessage,
  kind: 'http' | 'upgrade',
) => WebRequestGuardDecision | Promise<WebRequestGuardDecision>

/**
 * The request-scoped principal the guard attaches to an authenticated allow:
 * exactly the CONTEXT.md 请求主体 fields. displayName deliberately stays out
 * of the request principal.
 */
export interface WebRequestPrincipal {
  readonly tenantId: string
  readonly userId: string
  readonly roles: readonly string[]
}

/**
 * Produce the guard callback for the host's guard seat. A verifiable
 * DshIdentityToken admits with the three-field request principal; else the
 * launch-token query parameter admits bare (the stock browser-auth bootstrap
 * credential); else the request is vetoed 401 with the fixed hint.
 * Verification misconfiguration (PinMisconfigurationError) propagates for
 * the host's fail-closed handler to veto on.
 *
 * @param service - the gateway-identity service verifying the token.
 * @param launchToken - reads the current process launch token at decision time; service boot order is unbounded.
 * @returns the host-compatible guard callback.
 */
export function createCasdoorRequestGuard(
  service: CasdoorAuthService,
  launchToken: () => string | undefined,
): WebRequestGuard {
  return async (req: IncomingMessage): Promise<WebRequestGuardDecision> => {
    const identity = await service.identityFromRequest(req)
    if (identity !== undefined) {
      return { allow: true, principal: toWebRequestPrincipal(identity) }
    }
    const presented = launchTokenQuery(req)
    const current = launchToken()
    if (presented !== undefined && current !== undefined && constantTimeMatch(presented, current)) {
      return { allow: true }
    }
    return { allow: false, status: 401, body: GUARD_HINT }
  }
}

/**
 * Wire the guard into the host webserver's single guard seat according to
 * configuration.
 *
 * @param webServer - the host webServer service (feature-checked: unpatched cores expose no seat).
 * @param entry - resolved plugin configuration; guardEnabled gates the whole wiring.
 * @param service - the gateway-identity service.
 * @param launchToken - reads the current process launch token at decision time.
 * @returns the seat disposer, or undefined when the guard is disabled (zero seat interaction).
 * @throws when guardEnabled is true but the host core carries no guard seat — the operator must apply scripts/host-patches/deepseek-harness.dsh-request-guard.patch.
 */
export function applyGuard(
  webServer: unknown,
  entry: Config,
  service: CasdoorAuthService,
  launchToken: () => string | undefined,
): (() => void) | undefined {
  if (!entry.guardEnabled) return undefined
  if (!isWebRequestGuardSeat(webServer)) {
    throw new Error(
      'casdoor-auth guardEnabled is true but the host webserver exposes no registerGuard seat; '
        + 'apply scripts/host-patches/deepseek-harness.dsh-request-guard.patch to the host core',
    )
  }
  return webServer.registerGuard(createCasdoorRequestGuard(service, launchToken))
}

/** Runtime feature check for the guard seat (the pinned webserver type predates it). */
function isWebRequestGuardSeat(webServer: unknown): webServer is WebRequestGuardSeat {
  return typeof (webServer as { registerGuard?: unknown } | null | undefined)?.registerGuard === 'function'
}

/** The launch-token query parameter of one request; absent or empty reads as absent. */
function launchTokenQuery(req: IncomingMessage): string | undefined {
  // node:http always sets url on server requests; the fallback covers the type only.
  const token = new URL(req.url ?? '/', 'http://x').searchParams.get('token')
  return token !== null && token !== '' ? token : undefined
}

/** Constant-time equality of two secrets through their sha256 digests, so raw length differences never reach timingSafeEqual. */
function constantTimeMatch(presented: string, current: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(presented).digest(),
    createHash('sha256').update(current).digest(),
  )
}

/** Map the verified identity onto the request principal (three fields; displayName stays out). */
function toWebRequestPrincipal(identity: CasdoorIdentity): WebRequestPrincipal {
  return { tenantId: identity.tenantId, userId: identity.userId, roles: identity.roles }
}
