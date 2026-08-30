/**
 * Tenant-session-store service seam (`ctx.tenantSessionStore`).
 *
 * Ownership is claim-once and immutable: there is deliberately NO release /
 * delete in the v0 contract. DSH session-lifecycle cleanup (actually ending a
 * session) is a separate concern to be designed against DSH's real Session
 * lifecycle later — it is not exposed here as an unconditional hazard.
 *
 * @module dsh-multi-tenant/store
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { ClaimResult, SessionOwner } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tenantSessionStore: TenantSessionStore
  }
}

/**
 * The ownership-storage seam. Backends store the tenant/user that claimed each
 * opaque session id. `claim` MUST be atomic — a single operation, not a
 * get-then-set — so a durable backend can map it to `INSERT … ON CONFLICT`
 * over a unique `session_id`. A future durable backend replaces the provider
 * of this service without touching `MultiTenantService`.
 */
export abstract class TenantSessionStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tenantSessionStore')
  }

  abstract claim(sessionId: string, owner: SessionOwner): Promise<ClaimResult>
  abstract get(sessionId: string): Promise<SessionOwner | undefined>

  /**
   * List every session id owned by `(tenantId, userId)`, ordered ascending by
   * session id. The order is the backend's native string order: SQLite BINARY
   * collation and JavaScript UTF-16 code-unit comparison agree on ASCII but
   * may differ for some non-ASCII ids, so callers must not rely on the two
   * backends producing identical order for such ids.
   */
  abstract listByOwner(tenantId: string, userId: string): Promise<string[]>

  /**
   * Optional synchronous ownership reads for host hooks that must judge
   * inside synchronous callbacks (e.g. per-frame stream filters). A backend
   * declares the capability by implementing both members; consumers must
   * feature-check before use. Reads see the backend's latest committed
   * state — no caching is implied or required.
   */
  getSync?(sessionId: string): SessionOwner | undefined
  listByOwnerSync?(tenantId: string, userId: string): string[]
}

/**
 * Development / bootstrap backend backed by a process-local `Map`.
 *
 * `claim` is atomic within a single JavaScript turn: the read and the write
 * happen synchronously inside one async function body with no `await` between
 * them, so no other claim can interleave. Lost on restart; NOT production
 * persistence.
 */
export class InMemoryTenantSessionStore extends TenantSessionStore {
  private readonly owners = new Map<string, SessionOwner>()

  constructor(ctx: Context) {
    super(ctx)
  }

  override async claim(sessionId: string, owner: SessionOwner): Promise<ClaimResult> {
    const existing = this.owners.get(sessionId)
    if (!existing) {
      this.owners.set(sessionId, { tenantId: owner.tenantId, userId: owner.userId })
      return 'created'
    }
    if (existing.tenantId === owner.tenantId && existing.userId === owner.userId) {
      return 'idempotent'
    }
    return 'conflict'
  }

  override async get(sessionId: string): Promise<SessionOwner | undefined> {
    const owner = this.owners.get(sessionId)
    return owner ? { tenantId: owner.tenantId, userId: owner.userId } : undefined
  }

  override async listByOwner(tenantId: string, userId: string): Promise<string[]> {
    const sessionIds: string[] = []
    for (const [sessionId, owner] of this.owners) {
      if (owner.tenantId === tenantId && owner.userId === userId) sessionIds.push(sessionId)
    }
    return sessionIds.sort()
  }

  override getSync(sessionId: string): SessionOwner | undefined {
    const owner = this.owners.get(sessionId)
    return owner ? { tenantId: owner.tenantId, userId: owner.userId } : undefined
  }

  override listByOwnerSync(tenantId: string, userId: string): string[] {
    const sessionIds: string[] = []
    for (const [sessionId, owner] of this.owners) {
      if (owner.tenantId === tenantId && owner.userId === userId) sessionIds.push(sessionId)
    }
    return sessionIds.sort()
  }
}

export default InMemoryTenantSessionStore
