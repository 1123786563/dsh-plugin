#!/usr/bin/env node
/**
 * Zero-trust private-port guard rehearsal drill (ADR-0006): replays the full
 * guard behavior against REAL isolated instances — the read-only-reused
 * gateway (this worktree's services/casdoor-gateway/lib) and a second `dsh
 * web` in a patched host rehearsal worktree.
 *
 * Covered, in order:
 *   1. direct-connect negative matrix on the private port :38081 — every
 *      method/path vetoes 401 with the fixed hint (HTTP), raw-socket WS
 *      upgrades get no 101 and a torn connection, and four self-minted
 *      attack tokens (wrong key / expired / wrong iss / wrong aud) all veto;
 *   2. positive path through the gateway :30820 — real casdoor password
 *      login (acme/alice), index 200, JS asset 200, RPC non-401/403, WS 101;
 *   3. fail-closed — a short-TTL self-minted token passes observably, dies
 *      with the gateway, the matrix still vetoes with the gateway down, and
 *      a gateway restart recovers the logged-in session from SQLite;
 *   4. escape hatch — restarting dsh without DSH_CASDOOR_GUARD restores the
 *      pre-gate behavior, restoring it brings the veto back.
 *
 * Prerequisites (see README 演练手册 for the full rehearsal procedure):
 *   - casdoor seeded and listening on 127.0.0.1:8001
 *     (cd <dsh-plugin 主仓> && docker compose up -d casdoor postgres)
 *   - gateway built in THIS worktree (pnpm --filter dsh-casdoor-gateway build)
 *   - a host rehearsal worktree (baseline cd5ef814 + dsh-request-guard patch,
 *     pnpm install, full pnpm run build — the web profile demands every
 *     client bundle) with the web profile linked into $RT/dsh-home — the
 *     drill runs `pnpm dsh web --no-open` there itself.
 *
 * Private-port note: the drill pins the private port numerically through
 * the profile user patch layer ($RT/dsh-home/profiles/web/cordis.patch.yml,
 * applied after every bundle layer) for a deterministic isolated port it
 * owns itself. The DSH_CASDOOR_DSH_PORT env seam is usable too (the bundle
 * patch coerces it with Number()), but the drill leaves it unset so the
 * isolated port never rides on env coordination — same isolated 38081
 * semantics, no file outside $RT touched.
 *
 * Usage:
 *   node plugins/dsh-casdoor-auth/scripts/zero-trust-drill.mjs \
 *     --host-worktree <patched host checkout> --rt <rehearsal temp root>
 *
 * --rt MUST be the same directory the plugins were linked into (the isolated
 * profile lives at $RT/dsh-home) and live under /tmp/zero-trust-g18- — it is
 * removed recursively on every exit path. The drill spawns and later kills
 * its own gateway + dsh subprocesses and removes $RT before exiting, also on
 * SIGINT/SIGTERM (same reverse-order group kill + removal, exit 130/143):
 * the children run detached in their own process groups and never see a
 * terminal Ctrl-C themselves. Ports used: 38081 (private), 30820 (gateway),
 * 8001 (casdoor) — never the live 3080/38080, and both drill ports are
 * preflight-checked for leftovers before anything is spawned.
 * Exit 0 + `ALL PASS` = every step passed.
 */

import { spawn } from 'node:child_process'
import { generateKeyPairSync, createPrivateKey, randomBytes, webcrypto } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKTREE_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'))
const GATEWAY_SERVER = join(WORKTREE_ROOT, 'services', 'casdoor-gateway', 'lib', 'server.js')
const PRIVATE_PORT = 38081
const GATEWAY_PORT = 30820
const GATEWAY = `http://127.0.0.1:${GATEWAY_PORT}`
const UPSTREAM = `http://127.0.0.1:${PRIVATE_PORT}`
const CASDOOR = 'http://127.0.0.1:8001'
const CLIENT_ID = process.env.CASDOOR_CLIENT_ID ?? 'dsh-gateway'
const CLIENT_SECRET = process.env.CASDOOR_CLIENT_SECRET ?? 'change-me-64-hex'
const GUARD_HINT = '请走 http://127.0.0.1:3080'
const IDENTITY_ISSUER = 'dsh-casdoor-gateway'
const IDENTITY_AUDIENCE = 'dsh-casdoor-auth'
const IDENTITY_HEADER = 'x-dsh-identity'
/**
 * The app's WebSocket downlink upgrade path. The rehearsal baseline host
 * (cd5ef814, dsh 0.1.2-alpha.1) registers it as /api/remote.mux
 * (REMOTE_STREAM_MUX_PATH); the /api/events.mux name in the gateway's
 * proxy comment belongs to a different core vintage, and an unregistered
 * upgrade path is destroyed by the webserver regardless of the guard — so
 * probing the registered path is what exercises the guard's upgrade veto.
 */
const WS_PATH = '/api/remote.mux'
const T0_TTL_SEC = 5
// T0 TTL (5s) + settle margin, so the replay probe observes the expiry.
const FAIL_CLOSED_WAIT_MS = 6500
/** --rt is removed recursively on every exit path; only this prefix is allowed. */
const RT_PREFIX = '/tmp/zero-trust-g18-'

const results = []
function record (name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail.length > 0 ? ` — ${detail}` : ''}`)
}

/** Record-only observation: printed, never counted as a failure. */
function note (name, detail = '') {
  console.log(`📝 ${name}${detail.length > 0 ? ` — ${detail}` : ''}`)
}

function phase (title) {
  console.log(`\n—— ${title} ——`)
}

function usage () {
  console.log([
    'Usage: node plugins/dsh-casdoor-auth/scripts/zero-trust-drill.mjs \\',
    '         --host-worktree <patched deepseek-harness checkout> \\',
    '         --rt <rehearsal temp root (the one the web profile is linked in)>',
  ].join('\n'))
}

function parseArgs (argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    if ((flag !== '--host-worktree' && flag !== '--rt') || i + 1 >= argv.length) {
      usage()
      throw new Error(`unknown or incomplete argument: ${flag} ${argv[i + 1] ?? ''}`)
    }
    out[flag === '--host-worktree' ? 'hostWorktree' : 'rt'] = argv[i + 1]
  }
  if (out.hostWorktree === undefined || out.rt === undefined) {
    usage()
    throw new Error('--host-worktree and --rt are both required')
  }
  return out
}

/** fetch wrapper with a hard timeout, for local loopback probing. */
async function timedFetch (url, options = {}) {
  return await fetch(url, { ...options, signal: AbortSignal.timeout(8000) })
}

/**
 * Errno-ish label of a fetch failure: undici wraps the socket error as
 * `cause` (the outer TypeError carries no code), and an AbortSignal timeout
 * is a DOMException whose legacy numeric `code` says nothing — fall back to
 * its name.
 */
function errorCode (error) {
  const code = error?.cause?.code ?? error?.code
  if (typeof code === 'string' && code.length > 0) return code
  return error?.cause?.name ?? error?.name ?? String(error)
}

async function waitFor (url, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (res.status < 500) return res.status
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error(`timeout waiting for ${label} at ${url}`)
}

/** Poll the private port until it answers any HTTP status; returns that status. */
async function waitForPrivatePort (timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await timedFetch(`${UPSTREAM}/`, { headers: { accept: 'text/html' } })
      return res.status
    } catch { /* not up yet */ }
    await sleep(1000)
  }
  throw new Error(`timeout waiting for the isolated dsh private port at ${UPSTREAM}`)
}

/** True when something already listens on the loopback port (spawn preflight). */
function portInUse (port) {
  return new Promise(resolveProbe => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const done = inUse => {
      socket.destroy()
      resolveProbe(inUse)
    }
    socket.setTimeout(1500, () => done(false))
    socket.on('connect', () => done(true))
    socket.on('error', () => done(false))
  })
}

/** Wait for a file to appear (bounded), for cross-process handoffs. */
async function waitForFile (path, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await sleep(250)
  }
  throw new Error(`timeout waiting for ${label} at ${path}`)
}

/**
 * Poll direct GET / on the private port until the answer settles: right
 * after boot the webserver can briefly answer unmatched-route 404s before
 * the SPA row mounts, and the no-guard probe must observe the settled
 * behavior, not the race.
 */
async function settledRootProbe (timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await timedFetch(`${UPSTREAM}/`, { headers: { accept: 'text/html' } }).catch(error => error)
    if (!(last instanceof Error) && last.status !== 404) return last
    await sleep(1000)
  }
  return last
}

function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

/** fetch that keeps a cookie jar and never auto-follows redirects. */
function makeClient () {
  const jar = new Map()
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  const store = (res) => {
    for (const set of res.headers.getSetCookie?.() ?? []) {
      const [pair] = set.split(';')
      const eq = pair.indexOf('=')
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }
  return {
    cookieHeader,
    async call (url, options = {}) {
      const headers = { ...(options.headers ?? {}) }
      const cookie = cookieHeader()
      if (cookie.length > 0) headers.cookie = cookie
      const res = await timedFetch(url, { ...options, headers, redirect: 'manual' })
      store(res)
      return res
    },
  }
}

/**
 * Casdoor password login over its API (the SPA's own flow, see
 * services/casdoor-gateway/scripts/e2e.mjs): pass the OAuth authorize query
 * through gateway /login into POST /api/login; `data` IS the code.
 */
async function casdoorLoginAndGetCode (client, username, organization, password) {
  const loginPage = await client.call(`${GATEWAY}/login`)
  const authorize = loginPage.headers.get('location') ?? ''
  if (!authorize.startsWith(CASDOOR)) throw new Error(`gateway /login did not redirect to casdoor: ${authorize}`)
  const authorizeUrl = new URL(authorize)
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
  const login = await client.call(`${CASDOOR}/api/login${loginQuery}`, {
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
  const code = body.data
  const concat = redirectUri.includes('?') ? '&' : '?'
  return `${redirectUri}${concat}code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
}

/**
 * Subprocess bookkeeping: detached process groups so one kill(-pid) reaps the
 * whole tree (pnpm → node), captured output for post-mortem dumps.
 */
function spawnChild (name, command, args, options) {
  const logs = []
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const collect = stream => {
    let buffer = ''
    stream.on('data', chunk => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) logs.push(`[${name}] ${line}`)
      while (logs.length > 400) logs.shift()
    })
  }
  collect(child.stdout)
  collect(child.stderr)
  return { name, child, logs }
}

function waitForExit (entry, timeoutMs = 8000) {
  if (entry.child.exitCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(resolve, timeoutMs)
    entry.child.once('exit', () => { clearTimeout(timer); resolve() })
  })
}

async function killChild (entry) {
  if (entry.child.exitCode !== null) return
  try { process.kill(-entry.child.pid, 'SIGTERM') } catch { /* already gone */ }
  await waitForExit(entry, 5000)
  if (entry.child.exitCode === null) {
    try { process.kill(-entry.child.pid, 'SIGKILL') } catch { /* already gone */ }
    await waitForExit(entry, 2000)
  }
}

/**
 * Delete the rehearsal root. Refuses anything not resolving under
 * /tmp/zero-trust-g18-, so a mistyped --rt can never aim the recursive
 * removal at unrelated data.
 */
function removeRt (rt) {
  const resolved = resolve(rt)
  if (!resolved.startsWith(RT_PREFIX)) {
    throw new Error(`refusing to remove --rt outside ${RT_PREFIX}: ${resolved}`)
  }
  rmSync(resolved, { recursive: true, force: true })
}

/**
 * Signal-driven cleanup: the detached children are in their own process
 * groups and never see a terminal Ctrl-C, so the drill itself must reap
 * them — same reverse-order kill + $RT removal as the finally block, then
 * exit 130 (SIGINT) / 143 (SIGTERM).
 */
let interrupting = false
async function interruptCleanup (signal, children, rt) {
  if (interrupting) return
  interrupting = true
  console.error(`\n收到 ${signal}：逆序杀子进程并清理 ${rt} 后退出…`)
  for (const entry of children.slice().reverse()) await killChild(entry)
  try {
    removeRt(rt)
    console.error(`已清理 ${rt}（子进程全停）`)
  } catch (error) {
    console.error(`清理 ${rt} 失败：${String(error)}`)
  }
  process.exit(signal === 'SIGINT' ? 130 : 143)
}

function dumpLogs (entries) {
  for (const entry of entries) {
    if (entry.logs.length === 0) continue
    console.error(`\n<<< last output of ${entry.name} >>>`)
    for (const line of entry.logs.slice(-30)) console.error(line)
  }
}

/**
 * Raw-socket WebSocket upgrade probe: one GET with standard upgrade headers,
 * resolves at headers-complete / close / error / timeout with the status
 * line and how the connection ended.
 */
function wsProbe (port, path, extraHeaders = {}) {
  return new Promise(resolve => {
    const key = randomBytes(16).toString('base64')
    const socket = net.connect(port, '127.0.0.1')
    let data = Buffer.alloc(0)
    let settled = false
    const finish = ended => {
      if (settled) return
      settled = true
      const firstLine = data.length > 0 ? data.toString('latin1').split('\r\n', 1)[0] : ''
      socket.destroy()
      resolve({ firstLine, bytes: data.length, ended })
    }
    socket.setTimeout(8000, () => finish('timeout'))
    socket.on('connect', () => {
      let request = `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n`
      for (const [name, value] of Object.entries(extraHeaders)) request += `${name}: ${value}\r\n`
      request += 'Connection: Upgrade\r\nUpgrade: websocket\r\n'
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      socket.write(request)
    })
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk])
      if (data.includes('\r\n\r\n')) finish('headers')
    })
    socket.on('close', () => finish('close'))
    socket.on('error', () => finish('error'))
  })
}

// ---- self-minted DshIdentityTokens (jose-free compact JWS, Ed25519) ----

const subtle = webcrypto.subtle

function b64url (value) { return Buffer.from(value).toString('base64url') }

async function mintJwt (pkcs8Der, claims) {
  const key = await subtle.importKey('pkcs8', pkcs8Der, 'Ed25519', false, ['sign'])
  const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }))
  const payload = b64url(JSON.stringify(claims))
  const signature = await subtle.sign('Ed25519', key, new TextEncoder().encode(`${header}.${payload}`))
  return `${header}.${payload}.${b64url(signature)}`
}

function identityClaims (overrides = {}) {
  const now = Math.floor(Date.now() / 1000)
  return {
    tenant: 'acme',
    user: 'alice',
    name: 'drill',
    roles: [],
    iss: IDENTITY_ISSUER,
    aud: IDENTITY_AUDIENCE,
    iat: now,
    exp: now + T0_TTL_SEC,
    ...overrides,
  }
}

/** The guard's full veto observable on one HTTP response. */
function isGuardVeto (status, body, contentType) {
  return status === 401 && body === GUARD_HINT && contentType.startsWith('text/plain')
}

// ---- drill phases ----

/** Spawn the gateway (this worktree's build, read-only reuse). */
function startGateway (rt) {
  return spawnChild('gateway', process.execPath, [GATEWAY_SERVER], {
    cwd: join(WORKTREE_ROOT, 'services', 'casdoor-gateway'),
    env: {
      ...process.env,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GATEWAY_PORT),
      GATEWAY_PUBLIC_URL: GATEWAY,
      DSH_UPSTREAM_URL: UPSTREAM,
      CASDOOR_ISSUER: CASDOOR,
      CASDOOR_CLIENT_ID: CLIENT_ID,
      CASDOOR_CLIENT_SECRET: CLIENT_SECRET,
      GATEWAY_DATA_DIR: join(rt, 'gw-data'),
      GATEWAY_IDENTITY_TTL_SEC: String(T0_TTL_SEC),
      LOG_LEVEL: 'warn',
    },
  })
}

/** Spawn the isolated second dsh instance in the rehearsal worktree. */
function startDsh (rt, hostWorktree, publicKeyPem, withGuard) {
  // Numeric private port through the profile user patch layer: the drill
  // owns its deterministic isolated port there (see the header note). The
  // user patch is applied after every bundle layer, so the literal wins.
  const profilePatch = join(rt, 'dsh-home', 'profiles', 'web', 'cordis.patch.yml')
  writeFileSync(profilePatch, [
    '# written by zero-trust-drill.mjs: numeric private port 38081',
    '# (drill-owned deterministic isolated port; DSH_CASDOOR_DSH_PORT stays unset)',
    '- id: webserver',
    '  config:',
    '    host: 127.0.0.1',
    `    port: ${PRIVATE_PORT}`,
    '',
  ].join('\n'))
  const env = {
    ...process.env,
    DSH_HOME: join(rt, 'dsh-home'),
    DSH_CASDOOR_GATEWAY_JWKS_URL: `${GATEWAY}/.well-known/jwks.json`,
    DSH_CASDOOR_GATEWAY_DATA_DIR: join(rt, 'gw-data'),
    DSH_CASDOOR_IDENTITY_PUBLIC_KEY: publicKeyPem,
  }
  delete env.DSH_CASDOOR_DSH_PORT
  if (withGuard) env.DSH_CASDOOR_GUARD = '1'
  else delete env.DSH_CASDOOR_GUARD
  return spawnChild('dsh', 'pnpm', ['dsh', 'web', '--no-open'], { cwd: hostWorktree, env })
}

/**
 * The direct-connect negative matrix: HTTP methods/paths (veto 401 + fixed
 * hint + text/plain), raw-socket WS upgrades (no 101, torn), self-minted
 * attack tokens (four arms). Runnable repeatedly (fail-closed rerun).
 */
async function runNegativeMatrix (label, gatewayKeyDer, fakeKeyDer) {
  phase(`负路径矩阵（直连 38081${label.length > 0 ? `，${label}` : ''}）`)
  const cases = [
    { label: 'GET /', method: 'GET', path: '/' },
    { label: 'GET /manifest.webmanifest', method: 'GET', path: '/manifest.webmanifest' },
    { label: 'GET /favicon.svg', method: 'GET', path: '/favicon.svg' },
    { label: 'GET /assets/*.js（任一资产）', method: 'GET', path: '/assets/index-drill.js' },
    { label: 'GET /plugins/<id>/client.js', method: 'GET', path: '/plugins/casdoor-auth/client.js' },
    { label: 'POST /api/session.list', method: 'POST', path: '/api/session.list', body: '{"rpcId":"drill"}', contentType: 'application/json' },
    { label: 'HEAD /', method: 'HEAD', path: '/' },
    { label: 'OPTIONS /api/session.list', method: 'OPTIONS', path: '/api/session.list' },
    { label: 'PUT /anything', method: 'PUT', path: '/anything', body: 'x=1', contentType: 'application/x-www-form-urlencoded' },
    { label: 'DELETE /api/session.export', method: 'DELETE', path: '/api/session.export' },
    { label: 'GET /export/...', method: 'GET', path: '/export/session-drill.json' },
    { label: 'GET /no/such/route（未注册路径）', method: 'GET', path: '/no/such/route' },
  ]
  for (const item of cases) {
    const res = await timedFetch(`${UPSTREAM}${item.path}`, {
      method: item.method,
      headers: {
        ...(item.body === undefined ? {} : { 'content-type': item.contentType ?? 'text/plain' }),
      },
      ...(item.body === undefined ? {} : { body: item.body }),
      redirect: 'manual',
    })
    const contentType = res.headers.get('content-type') ?? ''
    if (item.method === 'HEAD') {
      // HTTP semantics make the veto body unreadable on HEAD, and the veto
      // path emits no content-length either: assert the observable veto
      // (401 + text/plain) and, whenever a length is present, byte exactness.
      const expected = String(Buffer.byteLength(GUARD_HINT))
      const length = res.headers.get('content-length')
      const lengthOk = length === null || length === expected
      record(`直连 ${item.label} → 401 固定文案（HEAD 无 body，content-length 如有须逐字）`,
        res.status === 401 && contentType.startsWith('text/plain') && lengthOk,
        `HTTP ${String(res.status)} ${contentType} content-length=${length ?? 'absent'}（文案 ${expected}B）`)
      continue
    }
    const body = await res.text().catch(() => '')
    record(`直连 ${item.label} → 401 固定文案`,
      isGuardVeto(res.status, body, contentType),
      `HTTP ${String(res.status)} ${contentType} body=${JSON.stringify(body.slice(0, 40))}`)
  }

  // WS direct connect on the registered downlink path: raw upgrade without
  // a credential, and with a fake one. The guard's upgrade veto destroys the
  // socket before any 101.
  for (const arm of [
    { label: 'WS 直连 /api/remote.mux 无 token', headers: {} },
    { label: 'WS 直连 /api/remote.mux 伪 token', headers: { [IDENTITY_HEADER]: 'not.a.jwt' } },
  ]) {
    const probe = await wsProbe(PRIVATE_PORT, WS_PATH, arm.headers)
    record(`${arm.label} → 无 101 且连接被拆`,
      !probe.firstLine.startsWith('HTTP/1.1 101'),
      `${probe.ended} ${String(probe.bytes)}B "${probe.firstLine}"`)
  }

  // Self-minted attack tokens: the private key never travels, but an attacker
  // holding it (or the claims) still cannot pass verification.
  const attackArms = [
    { label: '自铸攻击 token：伪造（错 key 签名）', key: () => fakeKeyDer, claims: {} },
    { label: '自铸攻击 token：过期（exp -10s）', key: () => gatewayKeyDer, claims: { exp: Math.floor(Date.now() / 1000) - 10 } },
    { label: '自铸攻击 token：错 iss', key: () => gatewayKeyDer, claims: { iss: 'attacker-issuer' } },
    { label: '自铸攻击 token：错 aud', key: () => gatewayKeyDer, claims: { aud: 'attacker-audience' } },
  ]
  for (const arm of attackArms) {
    const token = await mintJwt(arm.key(), identityClaims(arm.claims))
    const res = await timedFetch(`${UPSTREAM}/`, { headers: { [IDENTITY_HEADER]: token } })
    const contentType = res.headers.get('content-type') ?? ''
    const body = await res.text().catch(() => '')
    record(`${arm.label} → 401 固定文案`,
      isGuardVeto(res.status, body, contentType),
      `HTTP ${String(res.status)} ${contentType} body=${JSON.stringify(body.slice(0, 40))}`)
  }
}

async function main () {
  const { hostWorktree, rt } = parseArgs(process.argv.slice(2))
  console.log(`zero-trust guard drill\n  host worktree: ${hostWorktree}\n  rehearsal root: ${rt}\n  ports: private ${PRIVATE_PORT} / gateway ${GATEWAY_PORT} / casdoor 8001`)

  // The detached children never see a terminal Ctrl-C; from here on the
  // drill itself owns reaping them and removing $RT on interrupt.
  const children = []
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { void interruptCleanup(signal, children, rt) })
  }

  // Preconditions.
  if (!existsSync(GATEWAY_SERVER)) {
    throw new Error(`gateway build missing: ${GATEWAY_SERVER} — run pnpm --filter dsh-casdoor-gateway build in this worktree`)
  }
  if (!existsSync(join(hostWorktree, 'package.json')) || !existsSync(join(hostWorktree, 'apps', 'cli'))) {
    throw new Error(`--host-worktree is not a deepseek-harness checkout: ${hostWorktree}`)
  }
  if (!existsSync(join(rt, 'dsh-home'))) {
    throw new Error(`--rt must be the rehearsal root the web profile is linked into (expected ${join(rt, 'dsh-home')}; see README 演练手册 step 2)`)
  }
  if (!resolve(rt).startsWith(RT_PREFIX)) {
    throw new Error(`--rt must live under ${RT_PREFIX} (got ${resolve(rt)}): the drill removes it recursively on every exit path`)
  }
  phase('前置校验')
  try {
    await waitFor(`${CASDOOR}/.well-known/openid-configuration`, 'casdoor', 20_000)
  } catch {
    record('casdoor@8001 可达', false, `${CASDOOR} 无应答`)
    console.log('先起 casdoor：cd /Users/wuyongjun/trea/dsh-plugin && docker compose up -d casdoor postgres')
    removeRt(rt)
    process.exit(1)
  }
  record('casdoor@8001 可达', true)
  for (const [label, port] of [['私口', PRIVATE_PORT], ['网关', GATEWAY_PORT]]) {
    if (await portInUse(port)) {
      console.error(`❌ ${label}端口 ${port} 已被占用 —— 上次中断残留？见 README 演练手册「清理」节的中断恢复`)
      removeRt(rt)
      process.exit(1)
    }
    note(`${label}端口 ${port} 空闲`)
  }

  let gateway = null
  let dsh = null
  const client = makeClient()
  try {
    // Start the gateway first: it generates the identity key pair the dsh
    // instance pins.
    phase('起网关（30820，TTL 5s 压缩 fail-closed 等待）')
    gateway = startGateway(rt)
    children.push(gateway)
    await waitFor(`${GATEWAY}/healthz`, 'gateway')
    record('网关 /healthz 就绪', true)
    const publicKeyPem = readFileSync(join(rt, 'gw-data', 'identity_ed25519.pub.pem'), 'utf8')
    const gatewayKeyDer = new Uint8Array(
      createPrivateKey(readFileSync(join(rt, 'gw-data', 'identity_ed25519.pem'), 'utf8'))
        .export({ type: 'pkcs8', format: 'der' }),
    )
    const fakeKeyDer = new Uint8Array(
      generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' }),
    )

    // Isolated second dsh instance: guarded private port 38081.
    phase('起 dsh 第二实例（38081，guard=1，钉公钥）')
    dsh = startDsh(rt, hostWorktree, publicKeyPem, true)
    children.push(dsh)
    const bootStatus = await waitForPrivatePort()
    await waitForFile(join(rt, 'gw-data', 'webserver-token.json'), 'dsh launch-token handoff')
    record('dsh 第二实例私口应答（401 即守卫存活）', bootStatus === 401, `HTTP ${String(bootStatus)}`)

    await runNegativeMatrix('', gatewayKeyDer, fakeKeyDer)

    // Positive path through the gateway.
    phase('正向路径（经 30820）')
    const back = await casdoorLoginAndGetCode(client, 'alice', 'acme', 'alice-Acme1')
    const callback = await client.call(back)
    const hasSid = client.cookieHeader().includes('dsh_sid=')
    record('acme/alice 真实 casdoor 登录取 code 换 dsh_sid', callback.status === 302 && hasSid,
      `callback=${String(callback.status)} cookie=${hasSid}`)

    const home = await client.call(`${GATEWAY}/`, { headers: { accept: 'text/html' } })
    const homeBody = await home.text().catch(() => '')
    record('已登录 GET / 经网关命中真实 index', home.status === 200 && homeBody.includes('<'),
      `HTTP ${String(home.status)} ${String(homeBody.length)} bytes`)

    const assetMatch = homeBody.match(/(?:src|href)="([^"]*assets\/[^"]+\.js)"/)?.[1]
    if (assetMatch === undefined) {
      record('任一 JS 资产经网关 200', false, 'index 未引用 assets/*.js')
    } else {
      // The SPA references assets relatively (./assets/index-*.js); probe the
      // site-absolute path through the gateway.
      const assetPath = new URL(assetMatch, `${GATEWAY}/`).pathname
      const asset = await client.call(`${GATEWAY}${assetPath}`)
      record('任一 JS 资产经网关 200', asset.status === 200, `${assetPath} → HTTP ${String(asset.status)}`)
    }

    const rpc = await client.call(`${GATEWAY}/api/session.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"rpcId":"drill"}',
    })
    record('已登录 POST /api/session.list 非 401/403', rpc.status === 200 || rpc.status === 404,
      `HTTP ${String(rpc.status)}`)

    // A browser WebSocket upgrade always carries Origin; /api sits behind the
    // host's browser-trust fence, so the standard header set is part of the
    // contract. The gateway rewrites Origin onto the upstream origin.
    const wsUp = await wsProbe(GATEWAY_PORT, WS_PATH, {
      Cookie: client.cookieHeader(),
      Origin: GATEWAY,
    })
    record('已登录 WS 升级（dsh_sid cookie）得 101', wsUp.firstLine.startsWith('HTTP/1.1 101'),
      `${wsUp.ended} "${wsUp.firstLine}"`)

    // Record-only open question (ADR-0006 / #19): the browser fetches
    // webmanifests without cookies; the gateway forwards anonymously and the
    // guard vetoes. Expected behavior — recorded, never failing the drill.
    const manifestClient = makeClient()
    const manifest = await manifestClient.call(`${GATEWAY}/manifest.webmanifest`)
    const manifestBody = await manifest.text().catch(() => '')
    note('GET /manifest.webmanifest 经网关匿名转发 → 私口守卫 401（预期行为，开放问题）',
      `HTTP ${String(manifest.status)} body=${JSON.stringify(manifestBody.slice(0, 40))}`)

    // Fail-closed drill.
    phase('fail-closed 演练（TTL 5s）')
    const t0 = await mintJwt(gatewayKeyDer, identityClaims())
    const t0Live = await timedFetch(`${UPSTREAM}/`, { headers: { [IDENTITY_HEADER]: t0 } })
    const t0LiveBody = await t0Live.text().catch(() => '')
    const t0LiveCt = t0Live.headers.get('content-type') ?? ''
    record('自铸短 TTL 合法 token T0 直连 → 放行可观察（非守卫 401 文案）',
      !isGuardVeto(t0Live.status, t0LiveBody, t0LiveCt),
      `HTTP ${String(t0Live.status)} ${t0LiveCt} body=${JSON.stringify(t0LiveBody.slice(0, 40))}`)

    await killChild(gateway)
    children.splice(children.indexOf(gateway), 1)
    console.log(`（网关已 SIGTERM，等 ${String(FAIL_CLOSED_WAIT_MS)}ms 过 T0 的 TTL）`)
    await sleep(FAIL_CLOSED_WAIT_MS)
    const t0Replay = await timedFetch(`${UPSTREAM}/`, { headers: { [IDENTITY_HEADER]: t0 } })
    const t0ReplayBody = await t0Replay.text().catch(() => '')
    const t0ReplayCt = t0Replay.headers.get('content-type') ?? ''
    record('网关死亡后 T0 重放 → 401 固定文案（本地钉钥验签，过期即拒）',
      isGuardVeto(t0Replay.status, t0ReplayBody, t0ReplayCt),
      `HTTP ${String(t0Replay.status)} ${t0ReplayCt} body=${JSON.stringify(t0ReplayBody.slice(0, 40))}`)

    await runNegativeMatrix('网关已死，fail-closed 复跑', gatewayKeyDer, fakeKeyDer)

    let refusedCode = ''
    try {
      await timedFetch(`${GATEWAY}/healthz`)
    } catch (error) {
      refusedCode = errorCode(error)
    }
    record(`${GATEWAY_PORT} 连接拒绝（网关已死）`, refusedCode.length > 0,
      refusedCode.length > 0 ? refusedCode : '仍有应答')

    gateway = startGateway(rt)
    children.push(gateway)
    await waitFor(`${GATEWAY}/healthz`, 'gateway restart')
    const homeAgain = await client.call(`${GATEWAY}/`, { headers: { accept: 'text/html' } })
    record('重启网关 → 正向路径恢复（登录 cookie 仍在 SQLite，不掉线）', homeAgain.status === 200,
      `HTTP ${String(homeAgain.status)}（dsh_sid 未重登）`)

    // Escape hatch drill.
    phase('逃生门演练（DSH_CASDOOR_GUARD）')
    await killChild(dsh)
    children.splice(children.indexOf(dsh), 1)
    record('dsh 实例 SIGTERM 退出', dsh.child.exitCode !== null || dsh.child.signalCode === 'SIGTERM',
      `exitCode=${String(dsh.child.exitCode)} signal=${String(dsh.child.signalCode)}`)
    await sleep(500)

    dsh = startDsh(rt, hostWorktree, publicKeyPem, false)
    children.push(dsh)
    const noGuardStatus = await waitForPrivatePort()
    const noGuard = await settledRootProbe()
    if (noGuard instanceof Error) {
      record('同 env 去掉 DSH_CASDOOR_GUARD 重启 → 直连 GET / 不再是守卫 401（回到门禁前形态）',
        false, `私口无稳定应答（首应 ${String(noGuardStatus)}）：${String(noGuard)}`)
    } else {
      const noGuardBody = await noGuard.text().catch(() => '')
      const noGuardCt = noGuard.headers.get('content-type') ?? ''
      record('同 env 去掉 DSH_CASDOOR_GUARD 重启 → 直连 GET / 不再是守卫 401（回到门禁前形态）',
        !isGuardVeto(noGuard.status, noGuardBody, noGuardCt),
        `HTTP ${String(noGuard.status)}（私口首应 ${String(noGuardStatus)}）${noGuardCt} body=${JSON.stringify(noGuardBody.slice(0, 40))}`)
    }

    await killChild(dsh)
    children.splice(children.indexOf(dsh), 1)
    await sleep(500)
    dsh = startDsh(rt, hostWorktree, publicKeyPem, true)
    children.push(dsh)
    await waitForPrivatePort()
    const guardBack = await settledRootProbe()
    if (guardBack instanceof Error) {
      record('恢复 DSH_CASDOOR_GUARD=1 重启 → 401 固定文案回归', false, `私口无稳定应答：${String(guardBack)}`)
    } else {
      const guardBackBody = await guardBack.text().catch(() => '')
      const guardBackCt = guardBack.headers.get('content-type') ?? ''
      record('恢复 DSH_CASDOOR_GUARD=1 重启 → 401 固定文案回归',
        isGuardVeto(guardBack.status, guardBackBody, guardBackCt),
        `HTTP ${String(guardBack.status)} ${guardBackCt} body=${JSON.stringify(guardBackBody.slice(0, 40))}`)
    }
  } catch (error) {
    record('drill 执行', false, String(error))
    dumpLogs(children)
  } finally {
    phase('清理')
    for (const entry of children.slice().reverse()) await killChild(entry)
    try {
      removeRt(rt)
      console.log(`已清理 ${rt}（子进程全停）`)
    } catch (error) {
      console.error(`清理 ${rt} 失败：${String(error)}`)
    }
  }
  const failed = results.filter(r => !r.ok).length
  console.log(`\n${failed === 0 ? 'ALL PASS' : String(failed) + ' FAILED'} (${String(results.length)} steps)`)
  process.exit(failed === 0 ? 0 : 1)
}

/**
 * Rejections reaching here are precondition/argument failures thrown before
 * the try/finally drill body — print them as a clean one-line error instead
 * of a raw stack.
 */
main().catch(error => {
  console.error(`drill 未启动：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
