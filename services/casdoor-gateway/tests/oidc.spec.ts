import http, { type Server } from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { CasdoorOidc, LoginError } from '../src/oidc.ts'

const CLIENT_ID = 'cid'
const CLIENT_SECRET = 'csecret'
const REDIRECT_URI = new URL('http://127.0.0.1:39997/casdoor/callback')
const KID = 'gw-test-key'
const TOKEN_PATH = '/api/login/oauth/access_token'
const JWKS_PATH = '/api/certs'
const EXPECTED_IDENTITY = { tenantId: 'acme', userId: 'user-1', displayName: 'Alice', roles: ['dsh-admin'] }

/** Requests the stub IdP actually received, by endpoint class. */
interface StubHits {
  readonly discovery: Array<{ host: string, path: string }>
  readonly token: Array<{ host: string, path: string }>
  readonly jwks: Array<{ host: string, path: string }>
}

/** Fixture knobs the stub reads at request time. */
interface StubOptions {
  /** Origin every discovery endpoint is pinned to (casdoor's `origin` pin); defaults to the stub's own origin. */
  externalOrigin?: string
  /** Discovery metadata `issuer` override; the id_token `iss` follows it minus trailing slashes. */
  metadataIssuer?: string
  /** Serve discovery without `jwks_uri` (exercises the fallback construction). */
  omitJwksUri?: boolean
}

interface StubIdp {
  readonly port: number
  readonly hits: StubHits
  readonly options: StubOptions
  close(): Promise<void>
}

type Ed25519Keys = Awaited<ReturnType<typeof generateKeyPair<'Ed25519'>>>

let keys: Ed25519Keys
let publicJwk: Record<string, unknown>

beforeAll(async () => {
  keys = await generateKeyPair('Ed25519', { extractable: true })
  publicJwk = { ...(await exportJWK(keys.publicKey)), kid: KID }
})

/** A loopback port with no listener: connecting to it fails fast with ECONNREFUSED. */
function deadPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port
      probe.close(() => { resolve(port) })
    })
  })
}

/**
 * Local casdoor stand-in: discovery pins every endpoint to the external
 * origin no matter which address the fetch came from (mirroring casdoor's
 * `origin` config), the token endpoint hands out a jose-signed id_token,
 * and the jwks endpoints serve the verifying key.
 */
async function startStubIdp(options: StubOptions = {}): Promise<StubIdp> {
  const hits: StubHits = { discovery: [], token: [], jwks: [] }
  const server: Server = http.createServer((req, res) => {
    req.resume()
    const host = req.headers.host ?? ''
    const path = (req.url ?? '').split('?')[0] ?? ''
    const externalOrigin = (): string =>
      options.externalOrigin ?? `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
    const sendJson = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && path === '/.well-known/openid-configuration') {
      hits.discovery.push({ host, path })
      const metadata: Record<string, unknown> = {
        issuer: options.metadataIssuer ?? externalOrigin(),
        authorization_endpoint: `${externalOrigin()}/login/oauth/authorize`,
        token_endpoint: `${externalOrigin()}${TOKEN_PATH}`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['Ed25519'],
        code_challenge_methods_supported: ['S256'],
      }
      if (!options.omitJwksUri) metadata.jwks_uri = `${externalOrigin()}${JWKS_PATH}`
      sendJson(200, metadata)
      return
    }
    if (req.method === 'POST' && path === TOKEN_PATH) {
      hits.token.push({ host, path })
      const idToken = new SignJWT({ name: 'Alice', organization: 'acme', roles: ['dsh-admin'] })
        .setProtectedHeader({ alg: 'Ed25519', kid: KID })
        .setIssuer((options.metadataIssuer ?? externalOrigin()).replace(/\/+$/, ''))
        .setAudience(CLIENT_ID)
        .setSubject('user-1')
        .setIssuedAt()
        .setExpirationTime('30m')
        .sign(keys.privateKey)
      void idToken.then(
        token => { sendJson(200, { token_type: 'Bearer', access_token: 'at', expires_in: 3600, id_token: token }) },
        error => { sendJson(500, { error: String(error) }) },
      )
      return
    }
    if (req.method === 'GET' && (path === JWKS_PATH || path === '/.well-known/jwks')) {
      hits.jwks.push({ host, path })
      sendJson(200, { keys: [publicJwk] })
      return
    }
    sendJson(404, { error: 'not stubbed', path })
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    options,
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections()
      server.close(error => { error === undefined ? resolve() : reject(error) })
    }),
  }
}

function makeOidc(issuer: URL, internalIssuer: URL): CasdoorOidc {
  return new CasdoorOidc({
    issuer,
    internalIssuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    organizationClaim: 'organization',
    rolesClaim: 'roles',
  })
}

/** Drive one full authorization-code flow against the stub. */
async function loginFlow(oidc: CasdoorOidc): Promise<{ authorize: URL, identity: unknown }> {
  const authorize = new URL(await oidc.beginLogin('/'))
  const state = authorize.searchParams.get('state') ?? ''
  const callback = `${REDIRECT_URI.href}?code=code-1&state=${encodeURIComponent(state)}`
  const { identity } = await oidc.completeLogin(callback)
  return { authorize, identity }
}

describe('CasdoorOidc discovery base splitting', () => {
  it('keeps discovery, authorize, token, and jwks on the issuer when internalIssuer equals issuer (default zero difference)', async () => {
    const stub = await startStubIdp()
    try {
      const issuer = new URL(`http://127.0.0.1:${String(stub.port)}`)
      const oidc = makeOidc(issuer, issuer)
      const { authorize, identity } = await loginFlow(oidc)
      expect(authorize.origin).toBe(issuer.origin)
      expect(stub.hits.discovery.map(hit => hit.host)).toEqual([issuer.host])
      expect(stub.hits.token.map(hit => hit.host)).toEqual([issuer.host])
      expect(stub.hits.jwks.map(hit => hit.host)).toEqual([issuer.host])
      expect(identity).toEqual(EXPECTED_IDENTITY)
      const logout = new URL(oidc.idpLogoutUrl('idt', new URL('http://127.0.0.1:39997/login')))
      expect(logout.origin).toBe(issuer.origin)
    } finally {
      await stub.close()
    }
  })

  it('splits the bases: discovery/token/jwks go to the internal base, authorize and logout stay on the external issuer', async () => {
    const stub = await startStubIdp({ externalOrigin: `http://127.0.0.1:${String(await deadPort())}` })
    try {
      const issuer = new URL(stub.options.externalOrigin ?? 'http://invalid')
      const internal = new URL(`http://127.0.0.1:${String(stub.port)}`)
      const oidc = makeOidc(issuer, internal)
      const { authorize, identity } = await loginFlow(oidc)
      expect(authorize.origin).toBe(issuer.origin)
      expect(stub.hits.discovery.map(hit => hit.host)).toEqual([internal.host])
      expect(stub.hits.token.map(hit => hit.host)).toEqual([internal.host])
      expect(stub.hits.jwks.map(hit => hit.host)).toEqual([internal.host])
      expect(identity).toEqual(EXPECTED_IDENTITY)
      const logout = new URL(oidc.idpLogoutUrl('idt', new URL('http://127.0.0.1:39997/login')))
      expect(logout.origin).toBe(issuer.origin)
    } finally {
      await stub.close()
    }
  })

  it('fails loud with a LoginError when discovery serves a different issuer', async () => {
    const stub = await startStubIdp()
    stub.options.metadataIssuer = 'http://wrong.issuer.example'
    try {
      const issuer = new URL(`http://127.0.0.1:${String(stub.port)}`)
      const promise = makeOidc(issuer, issuer).beginLogin('/')
      await expect(promise).rejects.toBeInstanceOf(LoginError)
      await expect(promise).rejects.toThrowError('wrong.issuer.example')
      await expect(promise).rejects.toThrowError(`http://127.0.0.1:${String(stub.port)}/`)
      await expect(promise).rejects.toThrowError(/CASDOOR_ISSUER/)
      await expect(promise).rejects.toThrowError(/CASDOOR_INTERNAL_ISSUER/)
    } finally {
      await stub.close()
    }
  })

  it('accepts a trailing-slash metadata issuer (href-normalized comparison)', async () => {
    const stub = await startStubIdp()
    stub.options.metadataIssuer = `http://127.0.0.1:${String(stub.port)}/`
    try {
      const issuer = new URL(`http://127.0.0.1:${String(stub.port)}`)
      const { identity } = await loginFlow(makeOidc(issuer, issuer))
      expect(identity).toEqual(EXPECTED_IDENTITY)
    } finally {
      await stub.close()
    }
  })

  it('builds the jwks fallback URL from the internal base when discovery has no jwks_uri', async () => {
    const stub = await startStubIdp()
    stub.options.omitJwksUri = true
    stub.options.externalOrigin = `http://127.0.0.1:${String(await deadPort())}`
    try {
      const issuer = new URL(stub.options.externalOrigin)
      const internal = new URL(`http://127.0.0.1:${String(stub.port)}`)
      const { identity } = await loginFlow(makeOidc(issuer, internal))
      expect(stub.hits.jwks).toEqual([{ host: internal.host, path: '/.well-known/jwks' }])
      expect(identity).toEqual(EXPECTED_IDENTITY)
    } finally {
      await stub.close()
    }
  })
})

describe('callback validation (existing behavior)', () => {
  const oidc = makeOidc(new URL('http://127.0.0.1:9'), new URL('http://127.0.0.1:9'))

  it('rejects an IdP error response', async () => {
    await expect(oidc.completeLogin(`${REDIRECT_URI.href}?error=access_denied&state=x`))
      .rejects.toThrowError('casdoor returned error: access_denied')
  })

  it('rejects a callback missing code or state', async () => {
    await expect(oidc.completeLogin(`${REDIRECT_URI.href}?state=x`))
      .rejects.toThrowError('callback missing code/state')
  })

  it('rejects an unknown login state', async () => {
    await expect(oidc.completeLogin(`${REDIRECT_URI.href}?code=c&state=nope`))
      .rejects.toThrowError('login state is unknown or expired')
  })
})
