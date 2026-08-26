#!/usr/bin/env node
/**
 * End-to-end smoke for the NocoBase casdoor login (no browser needed):
 *
 *   1. health endpoint answers
 *   2. casdoor authenticator is exposed for the sign-in page
 *   3. getAuthUrl → casdoor authorize URL with the right client + callback
 *   4. scripted casdoor login (acme/alice) → code → callback → token → user
 *   5. second login reuses the same user (no duplicate)
 *   6. a second org (globex/bob) lands on a distinct user
 *   7. the local admin escape hatch (basic authenticator) still signs in
 *
 * Usage: node scripts/smoke.mjs
 *   env: same as bootstrap.mjs (NOCOBASE_URL, CASDOOR_URL, seed creds)
 */

const NOCOBASE_URL = (process.env.NOCOBASE_URL ?? 'http://127.0.0.1:13000').replace(/\/+$/, '')
const CASDOOR_URL = (process.env.CASDOOR_URL ?? 'http://127.0.0.1:8001').replace(/\/+$/, '')
const ADMIN_EMAIL = process.env.NOCOBASE_ADMIN_EMAIL ?? 'nocobase-admin@local.dev'
const ADMIN_PASSWORD = process.env.NOCOBASE_ADMIN_PASSWORD ?? 'NocoBase-Admin1'
const SEED_USERS = [
  { label: 'acme/alice', org: 'acme', user: 'alice', password: 'alice-Acme1' },
  { label: 'globex/bob', org: 'globex', user: 'bob', password: 'bob-Globex1' },
]

const results = []
function record(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail.length > 0 ? ` — ${detail}` : ''}`)
}

async function api(method, url, { headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  })
  return { status: response.status, headers: response.headers, payload: await response.json().catch(() => ({})) }
}

/** casdoor scripted login: the /api/login response's data IS the authorization code. */
async function casdoorLoginAndGetCode(authorizeUrl, { org, user, password }) {
  const q = Object.fromEntries(new URL(authorizeUrl).searchParams)
  const loginQuery = new URLSearchParams({
    clientId: q.client_id, responseType: 'code', redirectUri: q.redirect_uri, type: 'code',
    scope: q.scope, state: q.state, nonce: '', code_challenge_method: 'S256', code_challenge: '',
  })
  const { status, payload } = await api('POST', `${CASDOOR_URL}/api/login?${loginQuery}`, {
    body: { type: 'code', organization: org, username: user, password, application: 'nocobase', autoLogin: true },
  })
  if (status !== 200 || payload.status !== 'ok' || typeof payload.data !== 'string') {
    throw new Error(`casdoor login failed for ${org}/${user}: HTTP ${status} ${JSON.stringify(payload).slice(0, 200)}`)
  }
  return { code: payload.data, state: q.state, redirectUri: q.redirect_uri }
}

async function casdoorSignin(seed) {
  const { payload } = await api('POST', `${NOCOBASE_URL}/api/casdoorAuth:getAuthUrl`, { headers: { 'X-Authenticator': 'casdoor' } })
  const url = payload?.data?.url
  if (typeof url !== 'string') throw new Error(`getAuthUrl failed: ${JSON.stringify(payload).slice(0, 200)}`)
  const { code, state } = await casdoorLoginAndGetCode(url, seed)
  const callback = await api('GET', `${NOCOBASE_URL}/api/casdoorAuth:redirect?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`)
  const location = callback.headers.get('location') ?? ''
  if (callback.status !== 302 || !location.includes('token=')) {
    throw new Error(`callback failed: HTTP ${callback.status} ${location.slice(0, 120)} ${JSON.stringify(callback.payload).slice(0, 200)}`)
  }
  const token = new URL(location, NOCOBASE_URL).searchParams.get('token')
  const { payload: check } = await api('GET', `${NOCOBASE_URL}/api/auth:check`, {
    headers: { authorization: `Bearer ${token}`, 'X-Authenticator': 'casdoor' },
  })
  const user = check?.data
  if (!user?.id) throw new Error(`auth:check returned no user: ${JSON.stringify(check).slice(0, 200)}`)
  return user
}

async function main() {
  // 1. Health.
  try {
    const response = await fetch(`${NOCOBASE_URL}/__health_check`, { signal: AbortSignal.timeout(5_000) })
    record('健康端点 /__health_check 应答', response.ok, `HTTP ${response.status}`)
  } catch (error) {
    record('健康端点 /__health_check 应答', false, error.message)
  }

  // 2. Authenticator exposed.
  try {
    const { payload } = await api('GET', `${NOCOBASE_URL}/api/authenticators:publicList`)
    const rows = payload?.data ?? []
    const casdoorRow = rows.find(row => row.authType === 'casdoor' && row.enabled !== false)
    record('casdoor 认证器已启用并对登录页可见', Boolean(casdoorRow), `authenticators=${rows.length}`)
  } catch (error) {
    record('casdoor 认证器已启用并对登录页可见', false, error.message)
  }

  // 3-6. Full OIDC walks.
  try {
    const { payload } = await api('POST', `${NOCOBASE_URL}/api/casdoorAuth:getAuthUrl`, { headers: { 'X-Authenticator': 'casdoor' } })
    const url = payload?.data?.url ?? ''
    const parsed = new URL(url)
    record('getAuthUrl 生成 casdoor 授权 URL', url.startsWith(`${CASDOOR_URL}/login/oauth/authorize`)
      && parsed.searchParams.get('client_id') === 'nocobase'
      && parsed.searchParams.get('redirect_uri')?.startsWith(`${NOCOBASE_URL}/api/casdoorAuth:redirect`), url.slice(0, 90) + '…')
  } catch (error) {
    record('getAuthUrl 生成 casdoor 授权 URL', false, error.message)
  }

  try {
    const alice1 = await casdoorSignin(SEED_USERS[0])
    record('acme/alice JIT 开通并取回用户', Boolean(alice1.id), `id=${alice1.id} nickname=${alice1.nickname} email=${alice1.email}`)
    const alice2 = await casdoorSignin(SEED_USERS[0])
    record('二次登录复用同一用户（幂等）', alice1.id === alice2.id, `id=${alice2.id}`)
    const bob = await casdoorSignin(SEED_USERS[1])
    record('globex/bob 落到独立用户（跨组织）', bob.id !== alice1.id, `id=${bob.id}`)
  } catch (error) {
    record('OIDC 登录流', false, error.message)
  }

  // 7. Local admin escape hatch.
  try {
    const { status, payload } = await api('POST', `${NOCOBASE_URL}/api/auth:signIn`, {
      headers: { 'X-Authenticator': 'basic' },
      body: { account: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    })
    record('本地 admin 逃生通道可用（basic 认证器）', status === 200 && Boolean(payload?.data?.token), ADMIN_EMAIL)
  } catch (error) {
    record('本地 admin 逃生通道可用（basic 认证器）', false, error.message)
  }

  const failed = results.filter(row => !row.ok).length
  console.log(`\n${failed === 0 ? 'SMOKE PASSED ✓' : `SMOKE FAILED (${failed} steps)`} (${results.length} steps)`)
  process.exit(failed === 0 ? 0 : 1)
}

void main()
