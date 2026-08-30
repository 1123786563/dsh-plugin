/**
 * The plugin-side tenant-scoped frame filters for the host's two frame-filter
 * seats (ADR-0005, issue #25; seats delivered by
 * scripts/host-patches/deepseek-harness.dsh-request-guard.patch):
 *
 *  - the typertGateway `$events` stream seat
 *    (`registerRemoteEventFrameFilter`): waterfalls and session-referenced
 *    emits on /api/remote.mux;
 *  - the sessionController control-stream seat
 *    (`registerControlFrameFilter`): the baseline session list and jobs/queue
 *    broadcasts.
 *
 * Both hosts call the factory once per connection, inside that connection's
 * request-principal continuation, and the returned filter must be
 * synchronous. The judgment: an admin (roles intersecting the configured
 * admin roles) passes everything; every other authenticated principal gets an
 * open-time snapshot of its own sessions plus an authoritative per-frame
 * ownership query for sessions claimed after the connection opened (MCP
 * claims, cross-process migration writes — correctness first); a carrier
 * without a guard principal is denied fail-closed. A throwing dependency is
 * never caught here: the host's contract drops that one frame with a warning,
 * which is exactly the fail-closed outcome.
 *
 * @module dsh-casdoor-auth/frame-filter
 */

import { isWebRequestPrincipal, type WebRequestPrincipal } from './guard.ts'

/**
 * Structural minimal face of the multi-tenant ownership kernel's synchronous
 * reads (shipped by dsh-multi-tenant's synchronous-ownership round); a
 * structural face keeps the hooks unit-testable without a full service.
 */
export interface FrameFilterDeps {
  /** Session ids owned by one minimal principal, ascending by session id. */
  listSessionsByOwnerSync(principal: { tenantId: string, userId: string }): string[]
  /** Fail-closed boolean admission: unknown, cross-tenant, and cross-user are false. */
  canAccessSessionSync(principal: { tenantId: string, userId: string }, sessionId: string): boolean
}

/** Structural mirror of the host's per-frame filter signature. */
export type FrameFilterLike = (sessionId: string, frameType: string) => boolean

/** Structural mirror of the host's per-connection filter factory signature. */
export type FrameFilterFactoryLike = (principal: unknown) => FrameFilterLike

/**
 * Minimal face of the typertGateway service's remote-event frame-filter seat.
 * The pinned devDependencies predate the seat, so presence is a runtime
 * feature check — the same stance as the WebRequestGuardSeat face in guard.ts.
 */
export interface RemoteEventFrameFilterSeat {
  /**
   * Claim the sole `$events` frame-filter seat; a second registration is
   * rejected by the host because two filters cannot compose.
   * @param factory - builds one connection's filter from its open-time principal.
   * @returns the disposer releasing the seat.
   */
  registerRemoteEventFrameFilter(factory: FrameFilterFactoryLike): () => void
}

/**
 * Minimal face of the sessionController service's control frame-filter seat.
 */
export interface ControlFrameFilterSeat {
  /**
   * Claim the sole control-stream frame-filter seat; a second registration is
   * rejected by the host because two filters cannot compose.
   * @param factory - builds one stream generation's filter from its open-time principal.
   * @returns the disposer releasing the seat.
   */
  registerControlFrameFilter(factory: FrameFilterFactoryLike): () => void
}

/**
 * Build the shared frame-filter factory over the ownership kernel's
 * synchronous reads.
 *
 * Semantics (ADR-0005): a principal whose roles intersect `adminRoles` is
 * exempt and admits every frame; every other authenticated principal admits
 * exactly its own claimed sessions — the open-time snapshot answers the hot
 * path, and any session not in the snapshot gets one authoritative ownership
 * query per frame, so claims made after the connection opened are honored
 * immediately (performance note: the miss path is one prepared-statement
 * lookup per frame, judged sufficient until profiling says otherwise). A
 * malformed or absent principal denies every frame fail-closed; dependency
 * throws propagate to the host's drop-one-frame-and-warn contract.
 *
 * @param deps - the multi-tenant ownership kernel's synchronous face.
 * @param adminRoles - role names exempting a principal from filtering (mirrors the gateway's GATEWAY_ADMIN_ROLES).
 * @returns the factory for both host frame-filter seats.
 */
export function createFrameFilterFactory(
  deps: FrameFilterDeps,
  adminRoles: readonly string[],
): FrameFilterFactoryLike {
  return principal => {
    if (!isWebRequestPrincipal(principal)) return () => false
    if (isAdmin(principal, adminRoles)) return () => true
    const own = new Set(deps.listSessionsByOwnerSync(principal))
    return sessionId => own.has(sessionId) || deps.canAccessSessionSync(principal, sessionId)
  }
}

/**
 * Wire the frame filter into the typertGateway's `$events` frame-filter seat.
 *
 * @param typertGateway - the host typertGateway service (feature-checked: a core without the seat carries a stale patch).
 * @param deps - the multi-tenant ownership kernel's synchronous face.
 * @param adminRoles - role names exempting a principal from filtering.
 * @returns the seat disposer.
 * @throws when the service exposes no registerRemoteEventFrameFilter seat — the operator must (re-)apply scripts/host-patches/deepseek-harness.dsh-request-guard.patch.
 */
export function applyRemoteEventFrameFilter(
  typertGateway: unknown,
  deps: FrameFilterDeps,
  adminRoles: readonly string[],
): () => void {
  if (!isRemoteEventFrameFilterSeat(typertGateway)) {
    throw new Error(
      'casdoor-auth remote-event frame filter is enabled but the host typertGateway exposes no registerRemoteEventFrameFilter seat; '
        + 'apply scripts/host-patches/deepseek-harness.dsh-request-guard.patch (current version) to the host core',
    )
  }
  return typertGateway.registerRemoteEventFrameFilter(createFrameFilterFactory(deps, adminRoles))
}

/**
 * Wire the frame filter into the sessionController's control frame-filter
 * seat.
 *
 * @param sessionController - the host sessionController service (feature-checked: a core without the seat carries a stale patch).
 * @param deps - the multi-tenant ownership kernel's synchronous face.
 * @param adminRoles - role names exempting a principal from filtering.
 * @returns the seat disposer.
 * @throws when the service exposes no registerControlFrameFilter seat — the operator must (re-)apply scripts/host-patches/deepseek-harness.dsh-request-guard.patch.
 */
export function applyControlFrameFilter(
  sessionController: unknown,
  deps: FrameFilterDeps,
  adminRoles: readonly string[],
): () => void {
  if (!isControlFrameFilterSeat(sessionController)) {
    throw new Error(
      'casdoor-auth control frame filter is enabled but the host sessionController exposes no registerControlFrameFilter seat; '
        + 'apply scripts/host-patches/deepseek-harness.dsh-request-guard.patch (current version) to the host core',
    )
  }
  return sessionController.registerControlFrameFilter(createFrameFilterFactory(deps, adminRoles))
}

/** Exemption judgment: the principal's roles intersect the configured admin roles. */
function isAdmin(principal: WebRequestPrincipal, adminRoles: readonly string[]): boolean {
  return principal.roles.some(role => adminRoles.includes(role))
}

/** Runtime feature check for the remote-event frame-filter seat. */
function isRemoteEventFrameFilterSeat(service: unknown): service is RemoteEventFrameFilterSeat {
  return typeof (service as { registerRemoteEventFrameFilter?: unknown } | null | undefined)?.registerRemoteEventFrameFilter === 'function'
}

/** Runtime feature check for the control frame-filter seat. */
function isControlFrameFilterSeat(service: unknown): service is ControlFrameFilterSeat {
  return typeof (service as { registerControlFrameFilter?: unknown } | null | undefined)?.registerControlFrameFilter === 'function'
}
