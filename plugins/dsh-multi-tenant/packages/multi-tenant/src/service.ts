/**
 * The multi-tenant session-ownership service (`ctx.multiTenant`).
 *
 * Responsibility, in one sentence: given an authenticated {@link TenantPrincipal},
 * own and authorize access to opaque DSH session ids through a fail-closed,
 * durable-store-compatible ownership contract.
 *
 * The service is storage-agnostic: it consumes the `tenantSessionStore` service
 * seam and never constructs or inspects a backend itself. Ownership is
 * claim-once and immutable; the tenant boundary is unconditional and checked
 * before the same-user ownership rule.
 *
 * @module dsh-multi-tenant/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { MultiTenantError, SessionAccessDeniedError, SessionOwnershipConflictError } from './errors.ts'
import type { TenantSessionStore } from './store.ts'
import { validateSessionId, validateTenantPrincipal } from './validation.ts'
import type { AccessDecision, SessionOwner, TenantPrincipal } from './types.ts'

export class MultiTenantService extends Service {
  static inject = ['tenantSessionStore']

  constructor(ctx: Context) {
    super(ctx, 'multiTenant')
  }

  private get store(): TenantSessionStore {
    return this.ctx.tenantSessionStore
  }

  async claimSession(sessionId: string, principal: TenantPrincipal): Promise<void> {
    validateSessionId(sessionId)
    validateTenantPrincipal(principal)
    const owner: SessionOwner = { tenantId: principal.tenantId, userId: principal.userId }
    const result = await this.store.claim(sessionId, owner)
    switch (result) {
      case 'created':
      case 'idempotent':
        return
      case 'conflict':
        throw new SessionOwnershipConflictError()
      default:
        throw new MultiTenantError('tenant session store returned an invalid claim result')
    }
  }

  /** Trusted-facing owner lookup. */
  async getSessionOwner(sessionId: string): Promise<SessionOwner | undefined> {
    validateSessionId(sessionId)
    return this.store.get(sessionId)
  }

  /** Trusted-facing list of the principal's session ids, ascending by session id. */
  async listSessionsByOwner(principal: TenantPrincipal): Promise<string[]> {
    validateTenantPrincipal(principal)
    return this.store.listByOwner(principal.tenantId, principal.userId)
  }

  /** Fail-closed boolean authorization. Unknown session → `false`. */
  async canAccessSession(principal: TenantPrincipal, sessionId: string): Promise<boolean> {
    return (await this.evaluateAccess(principal, sessionId)).allowed
  }

  /** Throw a uniform, non-enumerating denial when access is not allowed. */
  async assertSessionAccess(principal: TenantPrincipal, sessionId: string): Promise<void> {
    const decision = await this.evaluateAccess(principal, sessionId)
    if (!decision.allowed) throw new SessionAccessDeniedError()
  }

  /** Internal diagnostic decision; denial reasons never cross the public API. */
  protected async evaluateAccess(principal: TenantPrincipal, sessionId: string): Promise<AccessDecision> {
    validateSessionId(sessionId)
    validateTenantPrincipal(principal)
    return ownerMatchDecision(await this.store.get(sessionId), principal)
  }

  /** Synchronous fail-closed authorization for host hooks that cannot await. */
  canAccessSessionSync(principal: TenantPrincipal, sessionId: string): boolean {
    const store = this.requireSyncStore('canAccessSessionSync')
    validateSessionId(sessionId)
    validateTenantPrincipal(principal)
    return ownerMatchDecision(store.getSync(sessionId), principal).allowed
  }

  /** Synchronous owner session list for host hooks that cannot await. */
  listSessionsByOwnerSync(principal: TenantPrincipal): string[] {
    const store = this.requireSyncStore('listSessionsByOwnerSync')
    validateTenantPrincipal(principal)
    return store.listByOwnerSync(principal.tenantId, principal.userId)
  }

  private requireSyncStore(caller: string): TenantSessionStore & Required<Pick<TenantSessionStore, 'getSync' | 'listByOwnerSync'>> {
    const store = this.store
    if (typeof store.getSync !== 'function' || typeof store.listByOwnerSync !== 'function') {
      throw new MultiTenantError(
        `${caller}: the active tenant session store provides no synchronous ownership reads`,
      )
    }
    return store as TenantSessionStore & Required<Pick<TenantSessionStore, 'getSync' | 'listByOwnerSync'>>
  }
}

/**
 * Shared owner-match judgment behind both the async and sync read paths:
 * cross-tenant access is unconditionally denied. Policy attributes outside
 * this minimal ownership kernel cannot override this boundary.
 */
function ownerMatchDecision(owner: SessionOwner | undefined, principal: TenantPrincipal): AccessDecision {
  if (!owner) return { allowed: false, reason: 'UNKNOWN_SESSION' }
  if (owner.tenantId !== principal.tenantId) {
    return { allowed: false, reason: 'TENANT_MISMATCH' }
  }
  if (owner.userId !== principal.userId) {
    return { allowed: false, reason: 'USER_MISMATCH' }
  }
  return { allowed: true }
}
