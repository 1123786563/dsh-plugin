#!/usr/bin/env node
/**
 * Legacy session migration CLI (issue #26): claims the ownerless Agent
 * sessions that predate tenant gating to `dsh-ops/dsh-admin` (ADR-0005
 * Q12=a), making them invisible to tenant users while staying visible and
 * adoptable to admins.
 *
 * Data plane, in order:
 *   1. log in as the target principal through the gateway (cookie jar; the
 *      casdoor password-login sequence of scripts/e2e.mjs, no browser)
 *   2. POST /api/session.list — admins are exempt from the tenant list
 *      filter, so this is the full manifest; `cursor` is a reserved seat
 *      with no pagination in v1, one call returns everything
 *   3. open the `session_owners` SQLite read-only and read every row
 *   4. planMigration + applyMigration (src/migration → lib/ after build)
 *
 * Exit codes: 0 success (including nothing to migrate), 1 usage error,
 * 2 runtime error. stdout carries one JSON line plus a human summary.
 *
 * Usage: node scripts/migrate-legacy-sessions.mjs --dry-run --password …
 * Build first: pnpm --dir services/casdoor-gateway build
 * Full local drill: scripts/MIGRATION-RUNBOOK.md
 */

import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_DB_RELATIVE_PATH = join('.dsh-multi-tenant', 'session-ownership.sqlite')
/** ADR-0005 Q12=a: the ops principal owns migrated legacy sessions. */
const DEFAULT_TARGET_TENANT = 'dsh-ops'
const DEFAULT_TARGET_USER = 'dsh-admin'
const DEFAULT_GATEWAY = 'http://127.0.0.1:3080'
/** Same default the multi-tenant SQLite store opens with. */
const BUSY_TIMEOUT_MS = 5_000
/** How many would-be-migrated ids the human summary lists. */
const SUMMARY_LIST_LIMIT = 10

export const MIGRATION_USAGE = `usage: migrate-legacy-sessions.mjs [--dry-run] [--db <path>] [--tenant <t>] [--user <u>]
                                     [--gateway <url>] [--password <secret>] [--help]

Claim ownerless pre-gating sessions to the ops principal (issue #26).

  --db <path>        session_owners SQLite path; relative paths resolve
                     against the current directory. Default:
                     <cwd>/${DEFAULT_DB_RELATIVE_PATH}
  --tenant <t>       claim target tenant. Default: ${DEFAULT_TARGET_TENANT}
  --user <u>         claim target user (also the gateway login name).
                     Default: ${DEFAULT_TARGET_USER}
  --gateway <url>    gateway base URL. Default: ${DEFAULT_GATEWAY}
  --password <s>     target principal's casdoor password; falls back to
                     env MIGRATION_PASSWORD. Never hardcoded.
  --dry-run          read-only preview: report the would-claim list, write
                     nothing anywhere.
  --help             print this usage.

Exit codes: 0 success (incl. nothing to migrate), 1 usage error, 2 runtime error.
Prerequisite build: pnpm --dir services/casdoor-gateway build
Local drill: scripts/MIGRATION-RUNBOOK.md`

/**
 * Parse migration CLI arguments. Pure: the working directory and environment
 * are injected so tests need no process state.
 *
 * @param {readonly string[]} argv arguments after `node script`.
 * @param {{ cwd?: string, env?: Record<string, string | undefined> }} context
 *        `cwd` resolves relative --db values (default process.cwd()), `env`
 *        supplies the MIGRATION_PASSWORD fallback (default process.env).
 * @returns {{ ok: true, help: false, options: {
 *             db: string, tenant: string, user: string, dryRun: boolean,
 *             gateway: string, password: string } }
 *         | { ok: true, help: true }
 *         | { ok: false, error: string }}
 */
export function parseMigrationArgs (argv, context = {}) {
  const cwd = context.cwd ?? process.cwd()
  const env = context.env ?? process.env
  const values = { db: undefined, tenant: undefined, user: undefined, gateway: undefined, password: undefined }
  let dryRun = false
  let help = false

  const need = (flag, rest, index) => {
    if (rest !== undefined) return rest
    const inline = argv[index + 1]
    if (inline === undefined || inline.startsWith('--')) {
      return { missing: flag }
    }
    return inline
  }

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) return { ok: false, error: `unexpected argument: ${token}` }
    const eq = token.indexOf('=')
    const flag = eq === -1 ? token : token.slice(0, eq)
    const inline = eq === -1 ? undefined : token.slice(eq + 1)
    const key = flag.slice(2)
    if (key === 'help') {
      help = true
      continue
    }
    if (key === 'dry-run') {
      if (inline !== undefined) return { ok: false, error: '--dry-run takes no value' }
      dryRun = true
      continue
    }
    if (!(key in values)) return { ok: false, error: `unknown option: ${flag}` }
    const value = need(flag, inline, index)
    if (value && typeof value === 'object' && value.missing) return { ok: false, error: `${value.missing} requires a value` }
    if (typeof value !== 'string' || value.length === 0) return { ok: false, error: `${flag} requires a value` }
    if (inline === undefined) index++
    values[key] = value
  }
  if (help) return { ok: true, help: true }

  const db = values.db ?? join(cwd, DEFAULT_DB_RELATIVE_PATH)
  const tenant = values.tenant ?? DEFAULT_TARGET_TENANT
  const user = values.user ?? DEFAULT_TARGET_USER
  const gateway = values.gateway ?? DEFAULT_GATEWAY
  const password = values.password ?? env.MIGRATION_PASSWORD
  if (password === undefined || password.length === 0) {
    return { ok: false, error: 'admin password required: pass --password or set MIGRATION_PASSWORD' }
  }
  if (!/^https?:\/\//.test(gateway)) {
    return { ok: false, error: `--gateway must be an http(s) URL, got: ${gateway}` }
  }
  return {
    ok: true,
    help: false,
    options: {
      db: isAbsolute(db) ? db : resolve(cwd, db),
      tenant,
      user,
      dryRun,
      gateway: gateway.replace(/\/+$/, ''),
      password,
    },
  }
}

/** fetch client with a cookie jar and no redirect following (e2e.mjs shape). */
function makeClient () {
  const jar = new Map()
  const store = (res) => {
    for (const set of res.headers.getSetCookie?.() ?? []) {
      const [pair] = set.split(';')
      const eq = pair.indexOf('=')
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }
  return {
    cookieHeader: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
    async call (url, options = {}) {
      const headers = { ...(options.headers ?? {}) }
      const cookie = cookieHeader()
      if (cookie.length > 0) headers.cookie = cookie
      const res = await fetch(url, { ...options, headers, redirect: 'manual' })
      store(res)
      return res
    },
  }
}

/**
 * Casdoor password login over its API (e2e.mjs `casdoorLoginAndGetCode`):
 * the gateway's /login redirect carries the OAuth authorize parameters and
 * the casdoor /api/login response's `data` IS the authorization code.
 *
 * @returns {Promise<string>} the gateway callback URL carrying code+state.
 */
async function casdoorLoginAndGetCode (client, gateway, organization, username, password) {
  const loginPage = await client.call(`${gateway}/login`)
  const authorize = loginPage.headers.get('location') ?? ''
  if (!authorize.startsWith('http')) throw new Error(`gateway /login did not redirect to casdoor: ${authorize}`)
  const authorizeUrl = new URL(authorize)
  const casdoor = authorizeUrl.origin
  const clientId = authorizeUrl.searchParams.get('client_id') ?? ''
  const redirectUri = authorizeUrl.searchParams.get('redirect_uri') ?? ''
  const state = authorizeUrl.searchParams.get('state') ?? ''
  const scope = authorizeUrl.searchParams.get('scope') ?? 'openid profile'
  const challenge = authorizeUrl.searchParams.get('code_challenge') ?? ''
  const challengeMethod = authorizeUrl.searchParams.get('code_challenge_method') ?? 'S256'
  const loginQuery = `?clientId=${encodeURIComponent(clientId)}&responseType=code`
    + `&redirectUri=${encodeURIComponent(redirectUri)}&type=code`
    + `&scope=${encodeURIComponent(scope)}&state=${encodeURIComponent(state)}`
    + `&nonce=&code_challenge_method=${encodeURIComponent(challengeMethod)}`
    + `&code_challenge=${encodeURIComponent(challenge)}`
  const login = await client.call(`${casdoor}/api/login${loginQuery}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'code',
      organization,
      username,
      password,
      application: clientId,
      autoLogin: true,
    }),
  })
  const body = await login.json().catch(() => ({}))
  if (login.status !== 200 || body.status !== 'ok' || typeof body.data !== 'string' || body.data.length === 0) {
    throw new Error(`casdoor login failed for ${organization}/${username}: HTTP ${String(login.status)} ${JSON.stringify(body).slice(0, 200)}`)
  }
  const concat = redirectUri.includes('?') ? '&' : '?'
  return `${redirectUri}${concat}code=${encodeURIComponent(body.data)}&state=${encodeURIComponent(state)}`
}

/**
 * Full session manifest via the gateway's admin-exempt session.list.
 * Wire shape (host apiproxy fetch carrier): { type: 'server-response', rpcId,
 * result: { ok: true, value: { items: [{ sessionId, … } …] } } }; `cursor` is
 * a reserved seat with no pagination in v1, so one call is the whole list.
 *
 * @returns {Promise<string[]>} every session id visible to the admin.
 */
async function listAllSessions (client, gateway) {
  const res = await client.call(`${gateway}/api/session.list`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rpcId: 'legacy-migration', payload: {} }),
  })
  const text = await res.text()
  if (res.status !== 200) {
    throw new Error(`session.list answered HTTP ${String(res.status)}: ${text.slice(0, 200)}`)
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`session.list response is not JSON: ${text.slice(0, 200)}`)
  }
  const result = body?.result
  if (result?.ok !== true) {
    throw new Error(`session.list failed: ${JSON.stringify(result ?? body).slice(0, 200)}`)
  }
  const items = result.value?.items
  if (!Array.isArray(items)) {
    throw new Error(`session.list response has no items array: ${text.slice(0, 200)}`)
  }
  const sessionIds = items.map((item) => item?.sessionId)
  if (sessionIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error(`session.list item without a sessionId: ${text.slice(0, 200)}`)
  }
  return sessionIds
}

function fatal (message) {
  console.error(`error: ${message}`)
  process.exitCode = 2
}

async function main () {
  const parsed = parseMigrationArgs(process.argv.slice(2))
  if (!parsed.ok) {
    console.error(`error: ${parsed.error}\n\n${MIGRATION_USAGE}`)
    process.exitCode = 1
    return
  }
  if (parsed.help) {
    console.log(MIGRATION_USAGE)
    return
  }
  const { db, tenant, user, dryRun, gateway, password } = parsed.options

  const planModule = join(import.meta.dirname, '..', 'lib', 'migration', 'plan-migration.js')
  const applyModule = join(import.meta.dirname, '..', 'lib', 'migration', 'apply-migration.js')
  if (!existsSync(planModule) || !existsSync(applyModule)) {
    fatal('compiled migration modules not found under lib/ — run: pnpm --dir services/casdoor-gateway build')
    return
  }
  const { planMigration } = await import(`file://${planModule}`)
  const { applyMigration } = await import(`file://${applyModule}`)

  if (!existsSync(db)) {
    fatal(`session_owners database not found: ${db} (pass --db; see scripts/MIGRATION-RUNBOOK.md)`)
    return
  }

  let sessionIds
  try {
    const client = makeClient()
    const back = await casdoorLoginAndGetCode(client, gateway, tenant, user, password)
    const callback = await client.call(back)
    if (callback.status !== 302) throw new Error(`gateway callback answered HTTP ${String(callback.status)}, expected 302`)
    if (!client.cookieHeader().length) throw new Error('gateway callback set no session cookie')
    sessionIds = await listAllSessions(client, gateway)
  } catch (error) {
    fatal(`gateway login or session.list failed: ${error instanceof Error ? error.message : String(error)}`)
    return
  }

  const readOnly = await import('node:sqlite')
  const owners = []
  let dbHandle
  try {
    dbHandle = new readOnly.DatabaseSync(db, { readOnly: true })
    const rows = dbHandle.prepare('SELECT session_id, tenant_id, user_id FROM session_owners').all()
    for (const row of rows) {
      owners.push({ sessionId: row.session_id, tenantId: row.tenant_id, userId: row.user_id })
    }
  } catch (error) {
    fatal(`cannot read ${db}: ${error instanceof Error ? error.message : String(error)}`)
    return
  } finally {
    dbHandle?.close()
  }

  const plan = planMigration(sessionIds, owners, { tenantId: tenant, userId: user })
  let handle
  let result
  try {
    if (dryRun) {
      handle = new readOnly.DatabaseSync(db, { readOnly: true })
    } else {
      handle = new readOnly.DatabaseSync(db)
      handle.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`)
    }
    result = applyMigration(handle, plan, { dryRun })
  } catch (error) {
    fatal(`cannot open ${db}: ${error instanceof Error ? error.message : String(error)}`)
    return
  } finally {
    handle?.close()
  }

  const report = {
    tool: 'migrate-legacy-sessions',
    dryRun,
    db,
    gateway,
    target: { tenantId: tenant, userId: user },
    sessions: sessionIds.length,
    counts: { ...plan.counts, claimed: result.claimed.length, skippedOwned: result.skippedOwned.length, failed: result.failed.length },
    claimed: result.claimed,
    skippedOwned: result.skippedOwned,
    failed: result.failed,
  }
  console.log(JSON.stringify(report))

  const prefix = result.claimed.slice(0, SUMMARY_LIST_LIMIT)
  const mode = dryRun ? 'dry-run (nothing written)' : 'applied'
  console.log(`legacy session migration — ${mode}`)
  console.log(`  target principal : ${tenant}/${user}`)
  console.log(`  ownership db     : ${db}`)
  console.log(`  sessions listed  : ${String(sessionIds.length)}`)
  console.log(`  plan             : claim=${String(plan.counts.claim)} skip-owned=${String(plan.counts.skipOwned)} skip-unknown=${String(plan.counts.skipUnknown)}`)
  console.log(`  outcome          : ${dryRun ? 'would claim' : 'claimed'}=${String(result.claimed.length)} skipped-owned=${String(result.skippedOwned.length)} failed=${String(result.failed.length)}`)
  if (prefix.length > 0) {
    console.log(`  ${dryRun ? 'would-claim' : 'claimed'} list (first ${String(prefix.length)}${result.claimed.length > prefix.length ? ` of ${String(result.claimed.length)}` : ''}):`)
    for (const sessionId of prefix) console.log(`    - ${sessionId}`)
  }
  for (const failure of result.failed) console.error(`  failed: ${failure.sessionId}: ${failure.reason}`)
  if (result.failed.length > 0) process.exitCode = 2
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) await main()
