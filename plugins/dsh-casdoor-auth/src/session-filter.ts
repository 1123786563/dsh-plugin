/**
 * The plugin-side session visibility hooks for the host sessionController's
 * single sessionFilter seat (ADR-0005, delivered by
 * scripts/host-patches/deepseek-harness.dsh-request-guard.patch): list
 * responses keep only the request principal's own sessions, every
 * sessionId-bearing method admits through the ownership kernel, and a
 * principal holding an admin role is exempt from both (full visibility,
 * including ownerless legacy sessions). Everything else — malformed
 * principals, unknown or ownerless session ids — is denied fail-closed.
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

/**
 * Structural mirror of the host's optional `SessionFilterHooks`. The
 * onSessionCreated observer is deliberately absent: auto-claiming new
 * sessions is a separate deliverable and lands with its own issue.
 */
export interface SessionFilterHooksLike {
  readonly listFilter?: SessionListFilterLike
  readonly accessCheck?: SessionAccessCheckLike
}

/**
 * Build the session visibility hooks over the ownership kernel.
 *
 * Semantics (ADR-0005): a principal whose roles intersect `adminRoles` is
 * exempt — the list passes through unchanged (same reference) and admission
 * is unconditional; every other authenticated principal sees and reaches
 * exactly its own claimed sessions, with malformed principals and unknown or
 * ownerless session ids denied fail-closed without existence leaks.
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
  }
}

/** Exemption judgment: the principal's roles intersect the configured admin roles. */
function isAdmin(principal: WebRequestPrincipal, adminRoles: readonly string[]): boolean {
  return principal.roles.some(role => adminRoles.includes(role))
}
