/**
 * The plugin-side session visibility hooks for the host sessionController's
 * single sessionFilter seat (ADR-0005, delivered by
 * scripts/host-patches/deepseek-harness.dsh-request-guard.patch): list
 * responses keep only the request principal's own sessions, every
 * sessionId-bearing method admits through the ownership kernel, and every
 * stock-UI session creation (create or fork) is auto-claimed to the request
 * principal — admins included, because ownership is bookkeeping, while the
 * admin exemption stays a visibility-filter concern. Everything else —
 * malformed principals, unknown or ownerless session ids, failed claims — is
 * denied fail-closed; a failed claim never rethrows, it warns.
 *
 * @module dsh-casdoor-auth/session-filter
 */

import { isWebRequestPrincipal, type WebRequestPrincipal } from './guard.ts'

/**
 * Structural minimal face of the multi-tenant ownership kernel the hooks
 * consume (both shipped by dsh-multi-tenant since its listByOwner round);
 * a structural face keeps the hooks unit-testable without a full service.
 */
export interface SessionFilterDeps {
  /** Session ids owned by one minimal principal, ascending by session id. */
  listSessionsByOwner(principal: { tenantId: string, userId: string }): Promise<string[]>
  /** Fail-closed boolean admission: unknown, cross-tenant, and cross-user are false. */
  canAccessSession(principal: { tenantId: string, userId: string }, sessionId: string): Promise<boolean>
  /**
   * Claim one session for the principal — claim-once; a losing claim rejects
   * (MultiTenantService.claimSession with the principal leading). Provide
   * together with `warn`; while omitted the creation observer stays inert,
   * because the index.ts wiring decides whether auto-claim is active.
   */
  claimSession?(principal: { tenantId: string, userId: string }, sessionId: string): Promise<void>
  /**
   * Operable alarm for every auto-claim failure (malformed principal,
   * ownership conflict, store error): the observer resolves without
   * rethrowing, so this channel is the only failure trace.
   */
  warn?(message: string): void
}

/** Structural mirror of the host's `SessionListFilter` (Item keeps its full type). */
export type SessionListFilterLike = <Item extends { readonly sessionId: string }>(
  principal: unknown,
  items: readonly Item[],
) => readonly Item[] | Promise<readonly Item[]>

/** Structural mirror of the host's `SessionAccessCheck`. */
export type SessionAccessCheckLike = (
  principal: unknown,
  sessionId: string,
) => boolean | Promise<boolean>

/** Structural mirror of the host's `SessionCreatedNotifier`. */
export type SessionCreatedNotifierLike = (
  principal: unknown,
  sessionId: string,
) => void | Promise<void>

/**
 * Structural mirror of the host's optional `SessionFilterHooks`: the two
 * visibility hooks plus the creation observer. The factory always provides
 * `onSessionCreated` — its registration activates the host's creation
 * admission, which vetoes principal-less create/fork before any creation
 * side effect.
 */
export interface SessionFilterHooksLike {
  readonly listFilter?: SessionListFilterLike
  readonly accessCheck?: SessionAccessCheckLike
  readonly onSessionCreated?: SessionCreatedNotifierLike
}

/**
 * Build the session visibility hooks over the ownership kernel.
 *
 * Semantics (ADR-0005): a principal whose roles intersect `adminRoles` is
 * exempt — the list passes through unchanged (same reference) and admission
 * is unconditional; every other authenticated principal sees and reaches
 * exactly its own claimed sessions, with malformed principals and unknown or
 * ownerless session ids denied fail-closed without existence leaks. Every
 * session the stock UI mints (create or fork) is auto-claimed to the request
 * principal, admins included; the observer never rethrows — a malformed
 * principal or any claim failure resolves inside the callback after
 * `deps.warn`, and visibility stays the two filters' judgment.
 *
 * @param deps - the multi-tenant ownership kernel face.
 * @param adminRoles - role names exempting a principal from filtering (mirrors the gateway's GATEWAY_ADMIN_ROLES).
 * @returns the hooks for the host's sessionFilter seat.
 */
export function createSessionFilterHooks(
  deps: SessionFilterDeps,
  adminRoles: readonly string[],
): SessionFilterHooksLike {
  return {
    listFilter: async (principal, items) => {
      if (!isWebRequestPrincipal(principal)) return []
      if (isAdmin(principal, adminRoles)) return items
      const own = new Set(await deps.listSessionsByOwner(principal))
      return items.filter(item => own.has(item.sessionId))
    },
    accessCheck: async (principal, sessionId) => {
      if (!isWebRequestPrincipal(principal)) return false
      if (isAdmin(principal, adminRoles)) return true
      return await deps.canAccessSession(principal, sessionId)
    },
    onSessionCreated: async (principal, sessionId): Promise<void> => {
      if (!isWebRequestPrincipal(principal)) {
        deps.warn?.(`session-filter auto-claim skipped for session ${sessionId}: request carries no valid web request principal`)
        return
      }
      if (deps.claimSession === undefined) return // inert observer: see SessionFilterDeps.claimSession
      try {
        await deps.claimSession(principal, sessionId)
      } catch (error) {
        deps.warn?.(`session-filter auto-claim failed for session ${sessionId} (principal ${principal.tenantId}/${principal.userId}): ${errorText(error)}`)
      }
    },
  }
}

/** Exemption judgment: the principal's roles intersect the configured admin roles. */
function isAdmin(principal: WebRequestPrincipal, adminRoles: readonly string[]): boolean {
  return principal.roles.some(role => adminRoles.includes(role))
}

/** Message text of a caught claim failure: Error messages verbatim, anything else stringified. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Minimal face of the host sessionController's session-filter seat. The
 * pinned devDependencies predate the seat, so presence is a runtime feature
 * check — the same stance as the WebRequestGuardSeat face in guard.ts.
 */
export interface SessionFilterSeat {
  /**
   * Claim the single session-hook seat; a second registration is rejected
   * by the host because two access policies cannot compose.
   * @param hooks - list and admission callbacks.
   * @returns the disposer releasing the seat.
   */
  registerSessionFilter(hooks: SessionFilterHooksLike): () => void
}

/**
 * Wire the session visibility hooks into the host sessionController's single
 * sessionFilter seat.
 *
 * @param sessionController - the host sessionController service (feature-checked: a core without the seat carries a stale patch).
 * @param deps - the multi-tenant ownership kernel face.
 * @param adminRoles - role names exempting a principal from filtering.
 * @returns the seat disposer.
 * @throws when the service exposes no registerSessionFilter seat — the operator must (re-)apply scripts/host-patches/deepseek-harness.dsh-request-guard.patch.
 */
export function applySessionFilter(
  sessionController: unknown,
  deps: SessionFilterDeps,
  adminRoles: readonly string[],
): () => void {
  if (!isSessionFilterSeat(sessionController)) {
    throw new Error(
      'casdoor-auth session visibility filter is enabled but the host sessionController exposes no registerSessionFilter seat; '
        + 'apply scripts/host-patches/deepseek-harness.dsh-request-guard.patch (current version) to the host core',
    )
  }
  return sessionController.registerSessionFilter(createSessionFilterHooks(deps, adminRoles))
}

/** Runtime feature check for the session-filter seat. */
function isSessionFilterSeat(service: unknown): service is SessionFilterSeat {
  return typeof (service as { registerSessionFilter?: unknown } | null | undefined)?.registerSessionFilter === 'function'
}
