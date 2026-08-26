#!/usr/bin/env node
/**
 * Bootstrap the NocoBase ↔ casdoor login wiring (idempotent).
 *
 *   1. casdoor:  create the `nocobase` OAuth application when missing
 *                (isShared — every org may sign in) and keep the NocoBase
 *                callback registered in its redirectUris.
 *   2. NocoBase: create the `casdoor` authenticator when missing (authType
 *                from @dsh/plugin-auth-casdoor) and keep its options/enabled
 *                in sync.
 *
 * Usage: node scripts/bootstrap.mjs
 *   env: NOCOBASE_URL (default http://127.0.0.1:13000)
 *        CASDOOR_URL (default http://127.0.0.1:8001)
 *        CASDOOR_SERVER_URL (default http://casdoor:8000 — server-to-server
 *          origin as seen from the NocoBase container)
 *        CASDOOR_ADMIN_CLIENT_ID / CASDOOR_ADMIN_CLIENT_SECRET (Basic auth for
 *          the casdoor admin API; defaults are the dsh-gateway seed app)
 *        CASDOOR_NOCOBASE_CLIENT_SECRET (default: the dev secret from compose)
 *        NOCOBASE_ADMIN_EMAIL / NOCOBASE_ADMIN_PASSWORD (root account;
 *          defaults mirror docker-compose.yml INIT_ROOT_*)
 */

const NOCOBASE_URL = (process.env.NOCOBASE_URL ?? 'http://127.0.0.1:13000').replace(/\/+$/, '')
const CASDOOR_URL = (process.env.CASDOOR_URL ?? 'http://127.0.0.1:8001').replace(/\/+$/, '')
const CASDOOR_SERVER_URL = (process.env.CASDOOR_SERVER_URL ?? 'http://casdoor:8000').replace(/\/+$/, '')
const CASDOOR_CLIENT_ID = process.env.CASDOOR_ADMIN_CLIENT_ID ?? 'dsh-gateway'
const CASDOOR_CLIENT_SECRET = process.env.CASDOOR_ADMIN_CLIENT_SECRET ?? 'change-me-64-hex'
const NOCOBASE_CLIENT_ID = 'nocobase'
const NOCOBASE_CLIENT_SECRET = process.env.CASDOOR_NOCOBASE_CLIENT_SECRET ?? 'nocobase-dsh-secret-2026'
const ADMIN_EMAIL = process.env.NOCOBASE_ADMIN_EMAIL ?? 'nocobase-admin@local.dev'
const ADMIN_PASSWORD = process.env.NOCOBASE_ADMIN_PASSWORD ?? 'NocoBase-Admin1'
const CALLBACK = `${NOCOBASE_URL.replace('casdoor:8000', '127.0.0.1:13000')}/api/casdoorAuth:redirect`

const casdoorAuth = 'Basic ' + Buffer.from(`${CASDOOR_CLIENT_ID}:${CASDOOR_CLIENT_SECRET}`).toString('base64')

async function call(method, url, { headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  })
  const payload = await response.json().catch(() => ({}))
  return { status: response.status, payload }
}

function step(label, detail) {
  console.log(`✓ ${label}${detail === undefined ? '' : ` (${detail})`}`)
}

async function waitForNocobase() {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${NOCOBASE_URL}/__health_check`, { signal: AbortSignal.timeout(5_000) })
      if (response.ok) return
    } catch { /* not up yet */ }
    process.stdout.write('.')
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }
  throw new Error(`NocoBase not healthy at ${NOCOBASE_URL} within 180s`)
}

/** casdoor application object modeled on the dsh-gateway seed app. */
function nocobaseApp(existing) {
  const base = existing ?? {
    owner: 'admin',
    name: NOCOBASE_CLIENT_ID,
    clientId: NOCOBASE_CLIENT_ID,
    clientSecret: NOCOBASE_CLIENT_SECRET,
    cert: 'cert-dsh-gateway',
    providers: [],
    signupFields: [],
    signinMethods: [{ name: 'Password', rule: 'All' }],
  }
  return {
    ...base,
    displayName: base.displayName || 'NocoBase',
    logo: base.logo || 'https://cdn.casbin.org/img/casdoor-logo_1185x256.png',
    homepageUrl: base.homepageUrl || NOCOBASE_URL,
    description: base.description || 'NocoBase low-code platform login (OIDC authorization code)',
    organization: 'built-in',
    isShared: true,
    orgChoiceMode: base.orgChoiceMode || 'Select',
    enablePassword: true,
    enableSignUp: false,
    enableSigninSession: true,
    tokenFormat: 'JWT',
    tokenSigningMethod: base.tokenSigningMethod || 'RS256',
    expireInHours: base.expireInHours || 168,
    redirectUris: Array.from(new Set([...(base.redirectUris ?? []), CALLBACK])),
  }
}

async function bootstrapCasdoor() {
  const { payload } = await call('GET', `${CASDOOR_URL}/api/get-application?id=admin/${NOCOBASE_CLIENT_ID}`, { headers: { authorization: casdoorAuth } })
  const existing = payload?.data ?? null
  if (existing === null) {
    const created = await call('POST', `${CASDOOR_URL}/api/add-application`, {
      headers: { authorization: casdoorAuth },
      body: nocobaseApp(null),
    })
    if (created.payload?.status !== 'ok') {
      throw new Error(`casdoor add-application failed: ${JSON.stringify(created.payload).slice(0, 200)}`)
    }
    step('casdoor application created', `${NOCOBASE_CLIENT_ID} (isShared)`)
  } else if (!(existing.redirectUris ?? []).includes(CALLBACK)) {
    const updated = await call('POST', `${CASDOOR_URL}/api/update-application?id=admin/${NOCOBASE_CLIENT_ID}`, {
      headers: { authorization: casdoorAuth },
      body: nocobaseApp(existing),
    })
    if (updated.payload?.status !== 'ok') {
      throw new Error(`casdoor update-application failed: ${JSON.stringify(updated.payload).slice(0, 200)}`)
    }
    step('casdoor application redirect registered', CALLBACK)
  } else {
    step('casdoor application already configured', `${NOCOBASE_CLIENT_ID}`)
  }
}

async function nocobaseToken() {
  const { status, payload } = await call('POST', `${NOCOBASE_URL}/api/auth:signIn`, {
    headers: { 'X-Authenticator': 'basic' },
    body: { account: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  })
  const token = payload?.data?.token
  if (status !== 200 || !token) {
    throw new Error(`NocoBase admin sign-in failed (${ADMIN_EMAIL}): HTTP ${status} ${JSON.stringify(payload).slice(0, 200)}`)
  }
  return token
}

async function bootstrapNocobase() {
  const token = await nocobaseToken()
  const headers = { authorization: `Bearer ${token}`, 'X-Role': 'admin' }
  // Org list for the sign-in button's chooser (casdoor shared-app client-id
  // suffix selects the login page per org).
  const orgsResponse = await call('GET', `${CASDOOR_URL}/api/get-organizations`, { headers: { authorization: casdoorAuth } })
  const orgs = (orgsResponse.payload?.data ?? [])
    .map(row => String(row?.name ?? '').trim())
    .filter(name => name.length > 0)
  const { payload } = await call('GET', `${NOCOBASE_URL}/api/authenticators:list?filter=%7B%22authType%22%3A%22casdoor%22%7D`, { headers })
  const rows = payload?.data ?? []
  const options = {
    issuer: CASDOOR_URL,
    serverIssuer: CASDOOR_SERVER_URL,
    clientId: NOCOBASE_CLIENT_ID,
    clientSecret: NOCOBASE_CLIENT_SECRET,
    public: { autoSignup: true, buttonText: 'Sign in with Casdoor', orgs },
  }
  if (rows.length === 0) {
    const created = await call('POST', `${NOCOBASE_URL}/api/authenticators:create`, {
      headers,
      body: { name: 'casdoor', authType: 'casdoor', title: 'Casdoor', sort: 2, enabled: true, options },
    })
    if (created.payload?.data?.id === undefined) {
      throw new Error(`NocoBase authenticator create failed: ${JSON.stringify(created.payload).slice(0, 200)}`)
    }
    step('NocoBase authenticator created', `name=casdoor enabled=true`)
  } else {
    const row = rows[0]
    const stored = row.options ?? {}
    const inSync =
      row.enabled === true &&
      stored.issuer === options.issuer &&
      stored.serverIssuer === options.serverIssuer &&
      stored.clientId === options.clientId &&
      stored.clientSecret === options.clientSecret &&
      JSON.stringify(stored.public?.orgs ?? []) === JSON.stringify(options.public.orgs)
    if (inSync) {
      step('NocoBase authenticator already configured', `name=${row.name}`)
    } else {
      const updated = await call('POST', `${NOCOBASE_URL}/api/authenticators:update?filterByTk=${row.id}`, {
        headers,
        body: { enabled: true, options: { ...stored, ...options } },
      })
      const ok = Array.isArray(updated.payload?.data) || updated.payload?.data?.id !== undefined
      if (!ok) {
        throw new Error(`NocoBase authenticator update failed: ${JSON.stringify(updated.payload).slice(0, 200)}`)
      }
      step('NocoBase authenticator updated', `name=${row.name} enabled=true`)
    }
  }
}

async function main() {
  console.log(`bootstrap → nocobase ${NOCOBASE_URL} / casdoor ${CASDOOR_URL} (server ${CASDOOR_SERVER_URL})`)
  process.stdout.write('waiting for NocoBase health')
  await waitForNocobase()
  console.log(' healthy')
  await bootstrapCasdoor()
  await bootstrapNocobase()
  console.log('bootstrap complete. Open %s and use the Casdoor button to sign in.', NOCOBASE_URL)
}

main().catch(error => {
  console.error('bootstrap failed:', error.message)
  process.exitCode = 1
})
