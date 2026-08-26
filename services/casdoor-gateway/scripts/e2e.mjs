#!/usr/bin/env node
/**
 * Manual end-to-end walk of the casdoor login gate (Q15: vitest units cover
 * the app; this exercises the REAL casdoor + gateway + upstream chain).
 *
 * Prerequisites:
 *   - docker compose up -d in services/casdoor-gateway/docker (casdoor :8000)
 *   - something on the dsh private port :38080 — the real `dsh web`, or this
 *     script spawns a stub upstream automatically when nothing listens
 *   - gateway built (pnpm build) — the script spawns lib/server.js itself
 *
 * Usage:  node scripts/e2e.mjs
 * Exit 0 = every step passed.
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GATEWAY = 'http://127.0.0.1:30820'
const UPSTREAM = 'http://127.0.0.1:38080'
const CASDOOR = 'http://127.0.0.1:8001'
const CLIENT_ID = process.env.CASDOOR_CLIENT_ID ?? 'dsh-gateway'
const CLIENT_SECRET = process.env.CASDOOR_CLIENT_SECRET ?? 'change-me-64-hex'

function dirname (p) { return p.slice(0, p.lastIndexOf('/')) }

const results = []
function record (name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail.length > 0 ? ` — ${detail}` : ''}`)
}

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
      const res = await fetch(url, { ...options, headers, redirect: 'manual' })
      store(res)
      return res
    },
  }
}

async function waitFor (url, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.status < 500) return true
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`timeout waiting for ${label} at ${url}`)
}

async function listening (url) {
  try { await fetch(url); return true } catch { return false }
}

/**
 * Casdoor password login over its API. The SPA's own flow passes the OAuth
 * authorize parameters as a query on /api/login, and the response's `data`
 * IS the authorization code — no browser needed (AuthBackend.js
 * oAuthParamsToQuery + LoginPage.js postCodeLoginAction).
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

async function main () {
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-gw-e2e-'))
  let stubUpstream = null
  let gateway = null
  try {
    await waitFor(`${CASDOOR}/.well-known/openid-configuration`, 'casdoor')
    if (!(await listening(UPSTREAM))) {
      stubUpstream = http.createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<!doctype html><html><head><title>stub-dsh</title></head><body>stub upstream</body></html>')
      })
      stubUpstream.on('upgrade', (_req, socket) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-accept: sRA13TgOUqUvJdqWFuyzPK2X8tE=\r\n\r\n')
      })
      await new Promise(r => stubUpstream.listen(38080, '127.0.0.1', r))
      console.log('(no dsh on :38080 — spawned stub upstream)')
    }
    gateway = spawn(process.execPath, [join(ROOT, 'lib', 'server.js')], {
      env: {
        ...process.env,
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_PORT: '30820',
        GATEWAY_PUBLIC_URL: GATEWAY,
        DSH_UPSTREAM_URL: UPSTREAM,
        CASDOOR_ISSUER: CASDOOR,
        CASDOOR_CLIENT_ID: CLIENT_ID,
        CASDOOR_CLIENT_SECRET: CLIENT_SECRET,
        GATEWAY_DATA_DIR: dataDir,
        GATEWAY_COOKIE_NAME: 'dsh_sid',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    await waitFor(`${GATEWAY}/healthz`, 'gateway')

    // 1. Unauthenticated navigation bounces to the IdP.
    {
      const client = makeClient()
      const nav = await client.call(`${GATEWAY}/`, { headers: { accept: 'text/html' } })
      const toLogin = nav.headers.get('location') ?? ''
      const loginHop = toLogin.startsWith('/login')
        ? await client.call(`${GATEWAY}${toLogin}`)
        : null
      const authorize = loginHop?.headers.get('location') ?? ''
      record('未登录导航 302 → /login → casdoor authorize',
        nav.status === 302 && loginHop?.status === 302 && authorize.startsWith(CASDOOR),
        `${String(nav.status)} → ${toLogin} → ${authorize.slice(0, 60)}`)
    }
    // 2. Unauthenticated API is a bare 401.
    {
      const client = makeClient()
      const res = await client.call(`${GATEWAY}/api/session.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"rpcId":"e2e"}',
      })
      const body = await res.json().catch(() => ({}))
      record('未登录 /api 返回 401 JSON', res.status === 401 && body.error === 'unauthenticated')
    }
    // 3. Full login for a tenant user, then authenticated proxying.
    {
      const client = makeClient()
      const back = await casdoorLoginAndGetCode(client, 'alice', 'acme', 'alice-Acme1')
      const callback = await client.call(back)
      const hasSid = client.cookieHeader().includes('dsh_sid=')
      const home = await client.call(`${GATEWAY}/`, { headers: { accept: 'text/html' } })
      const homeBody = await home.text()
      record('acme/alice 登录回调建立会话并 302 回站', callback.status === 302 && hasSid,
        `callback=${String(callback.status)} cookie=${hasSid}`)
      record('已登录导航经代理命中上游', home.status === 200 && homeBody.length > 0,
        `HTTP ${String(home.status)}, ${String(homeBody.length)} bytes`)

      const rpc = await client.call(`${GATEWAY}/api/session.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"rpcId":"e2e2"}',
      })
      record('已登录 /api 经代理转发（非 401/403）', rpc.status === 200 || rpc.status === 404,
        `HTTP ${String(rpc.status)}`)

      const priv = await client.call(`${GATEWAY}/api/settings.describe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"rpcId":"e2e3"}',
      })
      record('普通用户调特权方法被 403', priv.status === 403)

      const logout = await client.call(`${GATEWAY}/logout`)
      record('登出 302 到 IdP 且清 cookie', logout.status === 302 && (logout.headers.get('location') ?? '').includes(CASDOOR),
        logout.headers.get('location')?.slice(0, 60) ?? '')
      const after = await client.call(`${GATEWAY}/api/session.list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"rpcId":"e2e4"}',
      })
      record('登出后 /api 恢复 401', after.status === 401)
    }
    // 4. Admin passes the privileged gate.
    {
      const client = makeClient()
      const back = await casdoorLoginAndGetCode(client, 'dsh-admin', 'dsh-ops', 'dsh-Admin1')
      await client.call(back)
      const priv = await client.call(`${GATEWAY}/api/settings.describe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"rpcId":"e2e5"}',
      })
      record('dsh-admin 调特权方法放行（非 401/403）', priv.status === 200 || priv.status === 404,
        `HTTP ${String(priv.status)}`)
    }
  } catch (error) {
    record('e2e 执行', false, String(error))
  } finally {
    gateway?.kill('SIGTERM')
    stubUpstream?.close()
    setTimeout(() => rmSync(dataDir, { recursive: true, force: true }), 200)
  }
  const failed = results.filter(r => !r.ok).length
  console.log(`\n${failed === 0 ? 'ALL PASS' : String(failed) + ' FAILED'} (${String(results.length)} steps)`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
