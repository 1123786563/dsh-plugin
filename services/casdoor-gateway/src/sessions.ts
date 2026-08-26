/**
 * Server-side login sessions, persisted with node:sqlite so a gateway restart
 * never logs everyone out. One row per browser cookie (sid); the casdoor
 * tokens themselves are not retained — only the resolved identity needed to
 * mint DshIdentityTokens, plus the ID token for RP-initiated logout.
 *
 * @module dsh-casdoor-gateway/sessions
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** The authenticated identity carried by one login session. */
export interface LoginSession {
  readonly sid: string
  readonly tenantId: string
  readonly userId: string
  readonly displayName: string
  readonly roles: readonly string[]
  /** casdoor ID token, kept only for RP-initiated logout. */
  readonly idToken: string
  readonly createdAtMs: number
  readonly expiresAtMs: number
  readonly lastSeenMs: number
}

interface SessionRow {
  sid: string
  tenant_id: string
  user_id: string
  display_name: string
  roles_json: string
  id_token: string
  created_at_ms: number
  expires_at_ms: number
  last_seen_ms: number
}

function rowToSession(row: SessionRow): LoginSession {
  let roles: unknown
  try {
    roles = JSON.parse(row.roles_json)
  } catch {
    roles = []
  }
  return {
    sid: row.sid,
    tenantId: row.tenant_id,
    userId: row.user_id,
    displayName: row.display_name,
    roles: Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [],
    idToken: row.id_token,
    createdAtMs: row.created_at_ms,
    expiresAtMs: row.expires_at_ms,
    lastSeenMs: row.last_seen_ms,
  }
}

export class SessionStore {
  private readonly db: DatabaseSync

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS login_sessions (
        sid TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        roles_json TEXT NOT NULL,
        id_token TEXT NOT NULL DEFAULT '',
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        last_seen_ms INTEGER NOT NULL
      ) STRICT;
    `)
  }

  create(input: {
    tenantId: string
    userId: string
    displayName: string
    roles: readonly string[]
    idToken?: string
    ttlMs: number
    nowMs?: number
  }): LoginSession {
    const now = input.nowMs ?? Date.now()
    const session: LoginSession = {
      sid: randomBytes(32).toString('base64url'),
      tenantId: input.tenantId,
      userId: input.userId,
      displayName: input.displayName,
      roles: [...input.roles],
      idToken: input.idToken ?? '',
      createdAtMs: now,
      expiresAtMs: now + input.ttlMs,
      lastSeenMs: now,
    }
    this.db.prepare(
      'INSERT INTO login_sessions (sid, tenant_id, user_id, display_name, roles_json, id_token, created_at_ms, expires_at_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      session.sid,
      session.tenantId,
      session.userId,
      session.displayName,
      JSON.stringify(session.roles),
      session.idToken,
      session.createdAtMs,
      session.expiresAtMs,
      session.lastSeenMs,
    )
    return session
  }

  /** Look up one session; expired rows read as missing and are deleted. */
  get(sid: string, nowMs: number = Date.now()): LoginSession | undefined {
    if (typeof sid !== 'string' || sid.length === 0) return undefined
    const row = this.db.prepare(
      'SELECT sid, tenant_id, user_id, display_name, roles_json, id_token, created_at_ms, expires_at_ms, last_seen_ms FROM login_sessions WHERE sid = ?',
    ).get(sid) as SessionRow | undefined
    if (row === undefined) return undefined
    if (row.expires_at_ms <= nowMs) {
      this.delete(sid)
      return undefined
    }
    this.db.prepare('UPDATE login_sessions SET last_seen_ms = ? WHERE sid = ?').run(nowMs, sid)
    return rowToSession(row)
  }

  delete(sid: string): void {
    this.db.prepare('DELETE FROM login_sessions WHERE sid = ?').run(sid)
  }

  /** Drop every expired row; returns the number removed. */
  purgeExpired(nowMs: number = Date.now()): number {
    const result = this.db.prepare('DELETE FROM login_sessions WHERE expires_at_ms <= ?').run(nowMs)
    return Number(result.changes)
  }

  close(): void {
    this.db.close()
  }
}
