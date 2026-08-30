#!/usr/bin/env node
/**
 * Manual three-perspective drill for the tenant-scoped mux frame filter
 * (issue #25, ADR-0005): two tenant users (acme/alice, globex/bob) and one
 * admin (dsh-ops/dsh-admin) log in through the REAL gateway, each opens the
 * $events stream on /api/remote.mux, alice and bob each create a session and
 * run one turn, and the collected frames are judged:
 *
 *   1. alice's stream references NONE of bob's session; bob's references
 *      NONE of alice's (the same-tenant cross-user perspective has no second
 *      seeded user in the same org — that judgment is pinned by the
 *      frame-filter unit suite instead);
 *   2. each user still sees frames for their OWN session (baseline +
 *      realtime completeness);
 *   3. the admin sees frames for BOTH sessions.
 *
 * Best-effort leg: the SSE control stream on /api/events.mux (baseline
 * session list). When its shape cannot be parsed, the leg reports
 * FAIL-TO-VERIFY without failing the other assertions.
 *
 * External mode only — the full stack (casdoor + patched gateway + patched
 * dsh web with this plugin, guardEnabled) must already be running:
 *
 *   docker compose up -d casdoor postgres   # repo services/casdoor-gateway, casdoor on :8001
 *   # patched dsh web on the private port + gateway per README 演练手册
 *   DRILL_GATEWAY_URL=http://127.0.0.1:3080 node scripts/ws-frame-drill.mjs
 *
 * Exit codes: 0 all pass · 1 assertion failure (real regression) ·
 * 2 STACK-UNFILTERED (seats not registered: unpatched host / plugin not
 * active / guardEnabled off — distinct from a filtering regression) ·
 * 3 environment unreachable (nothing proven).
 *
 * Seeded accounts (services/casdoor-gateway/docker/init_data.json).
 */

const GATEWAY = process.env.DRILL_GATEWAY_URL ?? 'http://127.0.0.1:3080'
const CASDOOR = process.env.DRILL_CASDOOR_URL ?? 'http://127.0.0.1:8001'
const CLIENT_ID = process.env.CASDOOR_CLIENT_ID ?? 'dsh-gateway'
const CLIENT_SECRET = process.env.CASDOOR_CLIENT_SECRET ?? 'change-me-64-hex'
const SETTLE_MS = Number(process.env.DRILL_SETTLE_MS ?? 12_000)
const PROMPT_TEXT = process.env.DRILL_PROMPT_TEXT ?? 'reply with the single word pong'

const ACCOUNTS = {
  alice: { username: 'alice', organization: 'acme', password: 'alice-Acme1' },
  bob: { username: 'bob', organization: 'globex', password: 'bob-Globex1' },
  admin: { username: 'dsh-admin', organization: 'dsh-ops', password: 'dsh-Admin1' },
}

const results = []
function record (name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail.length > 0 ? ` — ${detail}` : ''}`)
}

function makeClient () {
  const jar = new Map()
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  const store = res => {
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
      const res = await fetch(url, { ...options, headers, redirect: 'manual' })
      store(res)
      return res
    },
  }
}

async function waitFor (url, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'unreachable'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.status < 500) return true
      lastError = `HTTP ${String(res.status)}`
    } catch (error) { lastError = error.message }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`${label} unreachable at ${url}: ${lastError}`)
}

/** Casdoor password login over its API (same mechanics as scripts/e2e.mjs). */
async function login (client, { username, organization, password }) {
  const loginPage = await client.call(`${GATEWAY}/login`)
  const authorize = loginPage.headers.get('location') ?? ''
  if (!authorize.startsWith(CASDOOR)) throw new Error(`gateway /login did not redirect to casdoor: ${authorize.slice(0, 80)}`)
  const authorizeUrl = new URL(authorize)
  const q = name => authorizeUrl.searchParams.get(name) ?? ''
  const loginQuery = `?clientId=${encodeURIComponent(q('client_id'))}&responseType=code`
    + `&redirectUri=${encodeURIComponent(q('redirect_uri'))}&type=code`
    + `&scope=${encodeURIComponent(q('scope') || 'openid profile')}&state=${encodeURIComponent(q('state'))}`
    + `&nonce=&code_challenge_method=${encodeURIComponent(q('code_challenge_method') || 'S256')}`
    + `&code_challenge=${encodeURIComponent(q('code_challenge'))}`
  const loginRes = await client.call(`${CASDOOR}/api/login${loginQuery}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'code', organization, username, password,
      application: q('client_id') || CLIENT_ID, autoLogin: true,
    }),
  })
  const body = await loginRes.json().catch(() => ({}))
  if (loginRes.status !== 200 || body.status !== 'ok' || typeof body.data !== 'string' || body.data.length === 0) {
    throw new Error(`casdoor login failed for ${organization}/${username}: HTTP ${String(loginRes.status)} ${JSON.stringify(body).slice(0, 160)}`)
  }
  const concat = q('redirect_uri').includes('?') ? '&' : '?'
  const callback = await client.call(`${q('redirect_uri')}${concat}code=${encodeURIComponent(body.data)}&state=${encodeURIComponent(q('state'))}`)
  if (!client.cookieHeader().includes('dsh_sid=') || callback.status !== 302) {
    throw new Error(`gateway callback did not establish dsh_sid for ${organization}/${username}: HTTP ${String(callback.status)}`)
  }
}

/** Stock RPC over the gateway: POST /api/<method> with the full client-request envelope. */
async function rpc (client, method, payload) {
  const rpcId = `drill-${crypto.randomUUID()}`
  const res = await client.call(`${GATEWAY}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: payload } }),
  })
  const envelope = await res.json().catch(() => { throw new Error(`${method}: non-JSON HTTP ${String(res.status)}`) })
  if (envelope?.result?.ok !== true) {
    throw new Error(`${method} failed: HTTP ${String(res.status)} ${JSON.stringify(envelope).slice(0, 600)}`)
  }
  return envelope.result.value
}

/** Deep-collect session references from a frame value: sessionId / agentId string fields. */
function sessionReferences (value, found = new Set(), depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return found
  if (Array.isArray(value)) {
    for (const item of value) {
      // api-session/* emits carry the session id as a POSITIONAL argument
      // (args[0]); key-based extraction alone would false-negative them.
      if (typeof item === 'string' && /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item)) found.add(item)
      else sessionReferences(item, found, depth + 1)
    }
    return found
  }
  for (const [key, inner] of Object.entries(value)) {
    if ((key === 'sessionId' || key === 'agentId') && typeof inner === 'string' && inner.length > 0) found.add(inner)
    else sessionReferences(inner, found, depth + 1)
  }
  return found
}

/** Open the $events stream on /api/remote.mux with the account's cookie. */
async function openEventsStream (cookie, label) {
  const socket = new WebSocket(`${GATEWAY.replace('http:', 'ws:')}/api/remote.mux`, { headers: { cookie } })
  const frames = []
  const events = new Set()
  let ready = false
  socket.addEventListener('message', event => {
    let frame
    try { frame = JSON.parse(typeof event.data === 'string' ? event.data : '') } catch { return }
    frames.push(frame)
    if (frame?.type === 'item' && typeof frame.value === 'object' && frame.value !== null) {
      if (frame.value.type === 'ready') ready = true
      else if (typeof frame.value.type === 'string') events.add(frame.value.type)
      else if (typeof frame.value.event === 'string') events.add(frame.value.event)
    }
  })
  const failure = new Promise((_, reject) => {
    socket.addEventListener('error', () => reject(new Error(`${label}: /api/remote.mux socket error (upgrade rejected?)`)))
    socket.addEventListener('close', () => { if (!ready) reject(new Error(`${label}: socket closed before ready`)) })
  })
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    setTimeout(() => reject(new Error(`${label}: /api/remote.mux connect timeout`)), 15_000)
    failure.catch(reject)
  })
  socket.send(JSON.stringify({ type: 'open', streamId: 'drill', endpoint: '$events', payload: { args: {} } }))
  const deadline = Date.now() + 15_000
  while (!ready && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
  if (!ready) throw new Error(`${label}: $events stream never delivered its ready frame`)
  return {
    label,
    socket,
    get frames () { return frames },
    get events () { return events },
    referenced: () => {
      const refs = new Set()
      for (const frame of frames) {
        if (frame?.type === 'item' && frame.streamId === 'drill') sessionReferences(frame.value, refs)
      }
      return refs
    },
    close: () => { try { socket.close() } catch { /* already closed */ } },
  }
}

/** Best-effort SSE control-stream leg: baseline session ids as the connection sees them. */
async function controlBaselineSessionIds (cookie, label) {
  const controller = new AbortController()
  const text = await Promise.race([
    (async () => {
      const res = await fetch(`${GATEWAY}/api/events.mux`, { headers: { cookie, accept: 'text/event-stream' }, signal: controller.signal })
      if (res.status !== 200 || res.body === null) return { status: res.status }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const ids = new Set()
      const scanDeadline = Date.now() + 5_000
      while (Date.now() < scanDeadline) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const events = buffer.split('\n\n')
        buffer = events.pop() ?? ''
        for (const blob of events) {
          for (const line of blob.split('\n')) {
            if (!line.startsWith('data:')) continue
            try { sessionReferences(JSON.parse(line.slice(5).trim()), ids) } catch { /* non-JSON frame */ }
          }
        }
        if (ids.size > 0 && Date.now() - scanDeadline > -4_000) break
      }
      return { status: res.status, ids }
    })(),
    new Promise(resolve => setTimeout(() => resolve({ status: 'timeout' }), 9_000)).then(r => { controller.abort(); return r }),
  ])
  return text.status === 200 ? text : { status: typeof text.status === 'number' ? text.status : 0, note: `${label}: control stream leg not verifiable (${String(text.status)})` }
}

async function main () {
  const missing = []
  try { await waitFor(`${GATEWAY}/healthz`, 'gateway') } catch (error) { missing.push(error.message) }
  try { await waitFor(`${CASDOOR}/.well-known/openid-configuration`, 'casdoor') } catch (error) { missing.push(error.message) }
  // A reachable healthz is not proof of the casdoor gateway: a plain dsh web
  // also answers /healthz. The JWKS endpoint is the gateway's own marker.
  try {
    const res = await fetch(`${GATEWAY}/.well-known/jwks.json`)
    if (res.status !== 200) missing.push(`gateway identity: ${GATEWAY}/.well-known/jwks.json answered HTTP ${String(res.status)} — DRILL_GATEWAY_URL must point at the casdoor gateway, not a plain dsh instance`)
  } catch (error) {
    missing.push(`gateway identity: ${GATEWAY}/.well-known/jwks.json unreachable (${error.message}) — DRILL_GATEWAY_URL must point at the casdoor gateway`)
  }
  if (missing.length > 0) {
    console.error(`environment unreachable — nothing proven:\n  - ${missing.join('\n  - ')}\nrunbook: docker compose up -d casdoor postgres; start the patched gateway + patched dsh web (guardEnabled), then DRILL_GATEWAY_URL=... node scripts/ws-frame-drill.mjs`)
    process.exit(3)
  }
  console.log(`(drilling against ${GATEWAY}, casdoor ${CASDOOR})`)

  const clients = {}
  for (const [name, account] of Object.entries(ACCOUNTS)) {
    const client = makeClient()
    await login(client, account)
    clients[name] = client
  }
  record('三账号经真实网关登录成功（alice/bob/dsh-admin）', true)

  const streams = {}
  for (const name of Object.keys(ACCOUNTS)) {
    streams[name] = await openEventsStream(clients[name].cookieHeader(), name)
  }
  record('三条 $events 流（/api/remote.mux）均收到 ready 帧', true)

  // Each tenant user creates one session and runs one turn; sessions created
  // after the connections opened must still flow to their owner (per-frame
  // authority) and must NEVER flow to the other tenant.
  const own = {}
  for (const name of ['alice', 'bob']) {
    const created = await rpc(clients[name], 'session/create', { request: { cwd: `/tmp/ws-frame-drill-${name}` } })
    if (typeof created?.sessionId !== 'string' || created.sessionId.length === 0) throw new Error(`session/create returned no sessionId for ${name}`)
    own[name] = created.sessionId
    await rpc(clients[name], 'session/prompt', {
      request: {
        requestId: crypto.randomUUID(),
        sessionId: own[name], mode: 'queue', content: [{ type: 'text', text: `${PROMPT_TEXT} (${name})` }],
      },
    })
  }
  record('alice/bob 各自 session/create + session/prompt 成功（经网关自动认领）', true, `alice=${own.alice.slice(0, 8)}… bob=${own.bob.slice(0, 8)}…`)

  await new Promise(resolve => setTimeout(resolve, SETTLE_MS))
  for (const stream of Object.values(streams)) stream.close()

  const refs = {}
  for (const [name, stream] of Object.entries(streams)) {
    refs[name] = stream.referenced()
    console.log(`  ${name}: ${String(stream.frames.length)} 帧类型集合 [${[...stream.events].slice(0, 8).join(', ')}] 引用会话 ${String(refs[name].size)} 个`)
    for (const id of refs[name]) console.log(`    ref: ${id}`)
  }

  const aliceLeak = refs.alice.has(own.bob)
  const bobLeak = refs.bob.has(own.alice)
  record('视角① alice 流零 bob 会话帧（跨租户隔离）', !aliceLeak, aliceLeak ? `泄露 ${own.bob}` : '')
  record('视角① bob 流零 alice 会话帧（跨租户隔离）', !bobLeak, bobLeak ? `泄露 ${own.alice}` : '')
  record('视角② alice 流含自己会话的帧（基线+实时完整）', refs.alice.has(own.alice), [...refs.alice].size > 0 ? `own=${own.alice.slice(0, 8)}…` : '无任何会话引用帧')
  record('视角② bob 流含自己会话的帧（基线+实时完整）', refs.bob.has(own.bob), `own=${own.bob.slice(0, 8)}…`)
  record('视角③ dsh-admin 收全量（alice 与 bob 会话帧均在）', refs.admin.has(own.alice) && refs.admin.has(own.bob),
    `alice=${String(refs.admin.has(own.alice))} bob=${String(refs.admin.has(own.bob))}`)

  // Best-effort control-stream baseline leg (never flips the verdict alone).
  try {
    const baseline = await controlBaselineSessionIds(clients.alice.cookieHeader(), 'alice')
    if (baseline.ids instanceof Set) {
      record('控制流腿：alice 的 events.mux baseline 不含 bob 会话', !baseline.ids.has(own.bob), `baseline 引用 ${String(baseline.ids.size)} 个会话`)
    } else {
      console.log(`⚠️ FAIL-TO-VERIFY 控制流腿 — ${baseline.note ?? `HTTP ${String(baseline.status)}`}（不影响其余断言）`)
    }
  } catch (error) {
    console.log(`⚠️ FAIL-TO-VERIFY 控制流腿 — ${error.message}（不影响其余断言）`)
  }

  const failed = results.filter(r => !r.ok)
  console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${String(failed.length)} FAILED`} (${String(results.length)} checks)`)
  if (failed.length === 0) process.exit(0)

  const isolation = results.filter(r => r.name.includes('隔离'))
  const adminOk = results.find(r => r.name.includes('dsh-admin'))?.ok === true
  if ((aliceLeak || bobLeak) && isolation.some(r => !r.ok) && adminOk) {
    console.error('\nSTACK-UNFILTERED: tenants see each other\'s frames while the admin leg works — the frame-filter seats are not active (unpatched host / plugin inactive / guardEnabled off). Not a filtering regression.')
    process.exit(2)
  }
  process.exit(1)
}

main().catch(error => {
  console.error(`drill aborted before assertions (environment/login/protocol — nothing proven): ${error.message}`)
  process.exit(3)
})
