import http, { type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { FastifyInstance } from 'fastify'
import { loadGatewayConfig, type GatewayConfig } from '../src/config.ts'
import { IdentityIssuer } from '../src/identity-token.ts'
import type { OidcClient, OidcIdentity } from '../src/oidc.ts'
import { installUpgradeProxy } from '../src/proxy.ts'
import { buildApp } from '../src/server.ts'
import { SessionStore, type LoginSession } from '../src/sessions.ts'

const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-app-'))

/** Recording upstream: captures what the gateway actually forwarded. */
let upstream: Server
let upstreamPort = 0
const upstreamSeen: Array<{ method: string, url: string, headers: http.IncomingHttpHeaders, bodyBytes: number }> = []

/** Deterministic OIDC stub. */
let lastBeginReturnTo: string | undefined
const stubIdentity: OidcIdentity = { tenantId: 'acme', userId: 'user-1', displayName: 'Alice', roles: [] }
const oidc: OidcClient = {
  async beginLogin(returnTo: string): Promise<string> {
    lastBeginReturnTo = returnTo
    return 'http://idp.test/authorize?state=st1'
  },
  async completeLogin(): Promise<{ identity: OidcIdentity, returnTo: string, idToken: string }> {
    return { identity: stubIdentity, returnTo: '/', idToken: 'idt' }
  },
  idpLogoutUrl(): string {
    return 'http://idp.test/login/oauth/logout?post_logout_redirect_uri=x'
  },
}

let app: FastifyInstance
let gatewayOrigin = ''
const store = new SessionStore(join(dir, 'sessions.sqlite'))
const issuer = new IdentityIssuer(dir)
let config: GatewayConfig

function makeSession(roles: string[]): LoginSession {
  return store.create({ tenantId: 'acme', userId: 'u1', displayName: 'Alice', roles, idToken: 'idt', ttlMs: 600_000 })
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let bodyBytes = 0
    req.on('data', chunk => { bodyBytes += chunk.length })
    req.on('end', () => {
      upstreamSeen.push({ method: req.method ?? '', url: req.url ?? '', headers: { ...req.headers }, bodyBytes })
      if (req.url === '/api/settings.describe' || req.url === '/api/session.list' || req.url === '/') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      res.writeHead(404)
      res.end()
    })
  })
  upstream.on('upgrade', (_req, socket) => {
    // A realistic 101: llhttp only treats the response as an upgrade when the
    // Connection/Upgrade response headers are present (mirrors what the ws
    // library on the real dsh side answers).
    socket.write('HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-accept: sRA13TgOUqUvJdqWFuyzPK2X8tE=\r\n\r\n')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  upstreamPort = (upstream.address() as AddressInfo).port

  config = loadGatewayConfig(
    {
      CASDOOR_CLIENT_ID: 'cid',
      CASDOOR_CLIENT_SECRET: 'csecret',
      GATEWAY_PUBLIC_URL: 'http://127.0.0.1:39997',
      DSH_UPSTREAM_URL: 'http://127.0.0.1:' + String(upstreamPort),
      GATEWAY_DATA_DIR: dir,
      GATEWAY_PORT: '39998',
    },
  )
  app = buildApp({ config, store, issuer, oidc }, { logger: false })
  await app.ready()
  installUpgradeProxy<LoginSession>(app.server, {
    target: { upstream: config.upstream, identityHeader: config.identityHeader },
    resolveSession: async headers => {
      const raw = headers.cookie
      if (typeof raw !== 'string') return undefined
      for (const part of raw.split(';')) {
        const index = part.indexOf('=')
        if (index < 0) continue
        if (part.slice(0, index).trim() === config.cookieName) {
          return store.get(part.slice(index + 1).trim())
        }
      }
      return undefined
    },
    mint: session => issuer.mint(session, {
      issuer: config.identityIssuer,
      audience: config.identityAudience,
      ttlSec: config.identityTtlSec,
    }),
    onError: () => {},
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  gatewayOrigin = 'http://127.0.0.1:' + String((app.server.address() as AddressInfo).port)
})

afterAll(() => {
  // Fire-and-forget teardown: avvio's close can outlive the runner when a
  // proxied keep-alive socket lingers; the sockets are force-closed and the
  // process exits with the run.
  app.server.closeIdleConnections()
  app.server.closeAllConnections()
  void app.close(() => {})
  upstream.closeAllConnections()
  upstream.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('auth plane', () => {
  it('serves /healthz without a session', async () => {
    const res = await fetch(`${gatewayOrigin}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('serves the public JWKS without a session', async () => {
    const res = await fetch(`${gatewayOrigin}/.well-known/jwks.json`)
    expect(res.status).toBe(200)
    const body = await res.json() as { keys: Array<{ kty: string }> }
    expect(body.keys[0]?.kty).toBe('OKP')
  })
})

describe('unauthenticated gate', () => {
  it('redirects browser navigations to /login with the return path', async () => {
    const res = await fetch(`${gatewayOrigin}/some/page?x=1`, {
      redirect: 'manual',
      headers: { accept: 'text/html,application/xhtml+xml' },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(`/login?returnTo=${encodeURIComponent('/some/page?x=1')}`)
  })

  it('answers API/fetch clients with a bare 401 JSON', async () => {
    const res = await fetch(`${gatewayOrigin}/api/session.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"rpcId":"1"}',
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthenticated' })
  })

  it('redirects /login to the IdP authorize URL and hardens returnTo', async () => {
    const res = await fetch(`${gatewayOrigin}/login?returnTo=${encodeURIComponent('https://evil.example.com')}`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('http://idp.test/authorize?state=st1')
    expect(lastBeginReturnTo).toBe('/')
  })
})

describe('authenticated proxying', () => {
  it('forwards proxied requests with the full body, rewritten host/origin, and the identity header', async () => {
    const session = makeSession([])
    upstreamSeen.length = 0
    const res = await fetch(`${gatewayOrigin}/api/session.list`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${config.cookieName}=${session.sid}`,
        origin: gatewayOrigin,
      },
      body: '{"rpcId":"2"}',
    })
    expect(res.status).toBe(200)
    const seen = upstreamSeen.at(-1)
    expect(seen?.url).toBe('/api/session.list')
    expect(seen?.bodyBytes).toBe(Buffer.byteLength('{"rpcId":"2"}'))
    expect(seen?.headers.host).toBe('127.0.0.1:' + String(upstreamPort))
    expect(seen?.headers.origin).toBe('http://127.0.0.1:' + String(upstreamPort))
    expect(typeof seen?.headers[config.identityHeader]).toBe('string')
    expect(seen?.headers.cookie).toBeUndefined()
  })

  it('proxies two consecutive requests on one keep-alive connection (body framing regression)', async () => {
    const session = makeSession([])
    upstreamSeen.length = 0
    const first = await fetch(`${gatewayOrigin}/api/session.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${config.cookieName}=${session.sid}` },
      body: '{"rpcId":"a"}',
    })
    expect(first.status).toBe(200)
    await first.text()
    const second = await fetch(`${gatewayOrigin}/api/session.list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${config.cookieName}=${session.sid}` },
      body: '{"rpcId":"b"}',
    })
    expect(second.status).toBe(200)
    await second.text()
    expect(upstreamSeen.filter(seen => seen.url === '/api/session.list')).toHaveLength(2)
  })

  it('blocks privileged methods for non-admins', async () => {
    const session = makeSession([])
    const res = await fetch(`${gatewayOrigin}/api/settings.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${config.cookieName}=${session.sid}` },
      body: '{"rpcId":"3"}',
    })
    expect(res.status).toBe(403)
    const body = await res.json() as { error: string, method: string }
    expect(body.error).toBe('forbidden')
    expect(body.method).toBe('settings.describe')
  })

  it('lets admins through the privileged gate', async () => {
    const session = makeSession(['dsh-admin'])
    const res = await fetch(`${gatewayOrigin}/api/settings.describe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${config.cookieName}=${session.sid}` },
      body: '{"rpcId":"4"}',
    })
    expect(res.status).toBe(200)
  })

  it('serves the SPA root to an authenticated browser', async () => {
    const session = makeSession([])
    const res = await fetch(`${gatewayOrigin}/`, {
      headers: { accept: 'text/html', cookie: `${config.cookieName}=${session.sid}` },
    })
    expect(res.status).toBe(200)
  })
})

describe('login callback and logout', () => {
  it('establishes a session cookie on callback', async () => {
    const res = await fetch(`${gatewayOrigin}/casdoor/callback?code=c&state=st1`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`${config.cookieName}=`)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
  })

  it('logs out: clears cookie, deletes the row, redirects to the IdP logout', async () => {
    const session = makeSession([])
    const res = await fetch(`${gatewayOrigin}/logout`, {
      redirect: 'manual',
      headers: { cookie: `${config.cookieName}=${session.sid}` },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('idp.test')
    expect((res.headers.get('set-cookie') ?? '')).toContain(`${config.cookieName}=`)
    expect(store.get(session.sid)).toBeUndefined()
  })
})

describe('websocket upgrade proxy', () => {
  function upgradeRequest(sid: string | undefined): Promise<{ status: number | 'upgraded' }> {
    return new Promise((resolve, reject) => {
      const req = http.request(`${gatewayOrigin}/api/events.mux`, {
        method: 'GET',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
          ...(sid === undefined ? {} : { cookie: `${config.cookieName}=${sid}` }),
        },
      })
      req.on('upgrade', (_res, socket) => {
        socket.destroy()
        resolve({ status: 'upgraded' })
      })
      req.on('response', res => {
        res.resume()
        resolve({ status: res.statusCode ?? 0 })
      })
      req.on('error', reject)
      req.end()
    })
  }

  it('rejects unauthenticated upgrades with 401', async () => {
    const result = await upgradeRequest(undefined)
    expect(result.status).toBe(401)
  })

  it('proxies authenticated upgrades to the upstream', async () => {
    const session = makeSession([])
    const result = await upgradeRequest(session.sid)
    expect(result.status).toBe('upgraded')
  })
})
