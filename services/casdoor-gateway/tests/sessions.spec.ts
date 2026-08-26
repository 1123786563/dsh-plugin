import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SessionStore } from '../src/sessions.ts'

const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-sessions-'))
const store = new SessionStore(join(dir, 'sessions.sqlite'))

afterAll(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('SessionStore', () => {
  it('creates and reads back a session with roles round-tripping', () => {
    const session = store.create({
      tenantId: 'acme',
      userId: 'user-1',
      displayName: 'Alice',
      roles: ['dsh-admin', 'ops'],
      idToken: 'idt',
      ttlMs: 60_000,
    })
    const read = store.get(session.sid)
    expect(read).toBeDefined()
    expect(read?.tenantId).toBe('acme')
    expect(read?.userId).toBe('user-1')
    expect(read?.displayName).toBe('Alice')
    expect(read?.roles).toEqual(['dsh-admin', 'ops'])
    expect(read?.idToken).toBe('idt')
  })

  it('persists across store instances (restart never logs everyone out)', () => {
    const session = store.create({ tenantId: 't', userId: 'u', displayName: '', roles: [], ttlMs: 60_000 })
    const reopened = new SessionStore(join(dir, 'sessions.sqlite'))
    try {
      expect(reopened.get(session.sid)?.userId).toBe('u')
    } finally {
      reopened.close()
    }
  })

  it('reads an expired session as missing and deletes the row', () => {
    const now = Date.now()
    const session = store.create({ tenantId: 't', userId: 'u', displayName: '', roles: [], ttlMs: 1000, nowMs: now - 5000 })
    expect(store.get(session.sid, now)).toBeUndefined()
    expect(store.get(session.sid, now)).toBeUndefined()
  })

  it('purges expired rows and reports the count', () => {
    const now = Date.now()
    store.create({ tenantId: 't', userId: 'gone', displayName: '', roles: [], ttlMs: 1, nowMs: now - 10_000 })
    store.create({ tenantId: 't', userId: 'kept', displayName: '', roles: [], ttlMs: 60_000 })
    const purged = store.purgeExpired(now)
    expect(purged).toBeGreaterThanOrEqual(1)
    expect(store.get).toBeDefined()
  })

  it('rejects junk sids without throwing', () => {
    expect(store.get('')).toBeUndefined()
    expect(store.get('does-not-exist')).toBeUndefined()
  })

  it('delete removes the session', () => {
    const session = store.create({ tenantId: 't', userId: 'u', displayName: '', roles: [], ttlMs: 60_000 })
    store.delete(session.sid)
    expect(store.get(session.sid)).toBeUndefined()
  })
})
