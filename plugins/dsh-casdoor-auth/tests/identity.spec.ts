import { generateKeyPairSync } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'
import { SignJWT } from 'jose'
import { IdentityVerifier } from '../src/identity.ts'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
// jose v6 speaks WebCrypto only: exportJWK(KeyObject) returns {}, so the
// public JWK is derived from the fixed 44-byte Ed25519 SPKI by hand
// (x = last 32 bytes) — same derivation the gateway itself uses.
const spki = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
const staticJwks = {
  keys: [{
    kty: 'OKP',
    crv: 'Ed25519',
    x: spki.subarray(spki.length - 32).toString('base64url'),
    kid: 'test-key',
    alg: 'EdDSA',
    use: 'sig',
  }],
}
const verifier = new IdentityVerifier({
  staticJwks,
  identityHeader: 'x-dsh-identity',
  issuer: 'dsh-casdoor-gateway',
  audience: 'dsh-casdoor-auth',
})

async function mint(
  payload: Record<string, unknown>,
  options: { iss?: string, aud?: string, ttlSec?: number } = {},
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' })
    .setIssuer(options.iss ?? 'dsh-casdoor-gateway')
    .setAudience(options.aud ?? 'dsh-casdoor-auth')
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + (options.ttlSec ?? 60))
    .sign(privateKey)
}

describe('IdentityVerifier', () => {
  it('verifies a well-formed DshIdentityToken', async () => {
    const token = await mint({ tenant: 'acme', user: 'user-1', name: 'Alice', roles: ['ops'] })
    const identity = await verifier.verifyToken(token)
    expect(identity).toEqual({ tenantId: 'acme', userId: 'user-1', displayName: 'Alice', roles: ['ops'] })
  })

  it('rejects tokens with the wrong audience or issuer', async () => {
    const wrongAud = await mint({ tenant: 't', user: 'u' }, { aud: 'other' })
    const wrongIss = await mint({ tenant: 't', user: 'u' }, { iss: 'other' })
    expect(await verifier.verifyToken(wrongAud)).toBeUndefined()
    expect(await verifier.verifyToken(wrongIss)).toBeUndefined()
  })

  it('rejects expired tokens and junk', async () => {
    const expired = await mint({ tenant: 't', user: 'u' }, { ttlSec: -10 })
    expect(await verifier.verifyToken(expired)).toBeUndefined()
    expect(await verifier.verifyToken('not-a-jwt')).toBeUndefined()
  })

  it('requires both tenant and user claims', async () => {
    expect(await verifier.verifyToken(await mint({ tenant: 't' }))).toBeUndefined()
    expect(await verifier.verifyToken(await mint({ user: 'u' }))).toBeUndefined()
  })

  it('filters non-string roles defensively', async () => {
    const token = await mint({ tenant: 't', user: 'u', roles: ['ok', 42, null, 'fine'] })
    const identity = await verifier.verifyToken(token)
    expect(identity?.roles).toEqual(['ok', 'fine'])
  })

  it('extracts the token from request headers (lowercased header name)', async () => {
    const token = await mint({ tenant: 'acme', user: 'user-1', name: 'Alice', roles: [] })
    const fromHeaders = await verifier.fromRequest({ 'x-dsh-identity': token })
    expect(fromHeaders?.tenantId).toBe('acme')
    expect(await verifier.fromRequest({})).toBeUndefined()
    expect(await verifier.fromRequest({ 'x-dsh-identity': ['array'] })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Pinned public key (Issue #14): local verification when the gateway key is
// pinned via config; remote JWKS fallback otherwise.
// ---------------------------------------------------------------------------

// A second, unrelated key pair: tokens minted with it must fail against a pin
// of the first key.
const other = generateKeyPairSync('ed25519')
const pinnedPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const pinnedJwkJson = JSON.stringify(staticJwks.keys[0])
// Port 1 is never listened on in the test environment: any JWKS fetch would
// fail with ECONNREFUSED, proving the pinned path never touches the network.
const offlineJwksUrl = 'http://127.0.0.1:1/.well-known/jwks.json'
const base = {
  identityHeader: 'x-dsh-identity',
  issuer: 'dsh-casdoor-gateway',
  audience: 'dsh-casdoor-auth',
}

// A local JWKS endpoint mock for the no-pin fallback regression.
let jwksHits = 0
const jwksServer = http.createServer((req, res) => {
  if (req.url === '/.well-known/jwks.json') {
    jwksHits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(staticJwks))
    return
  }
  res.writeHead(404)
  res.end()
})
void new Promise<void>(resolve => jwksServer.listen(0, '127.0.0.1', resolve))
const jwksPort = () => (jwksServer.address() as AddressInfo).port
afterAll(() => new Promise<void>(resolve => jwksServer.close(() => resolve())))

describe('IdentityVerifier pinned public key', () => {
  it('verifies offline with a pinned PEM public key (no network)', async () => {
    const pinned = new IdentityVerifier({ ...base, identityPublicKey: pinnedPem, gatewayJwksUrl: offlineJwksUrl })
    const token = await mint({ tenant: 'acme', user: 'user-1', name: 'Alice', roles: ['ops'] })
    expect(await pinned.verifyToken(token)).toEqual({ tenantId: 'acme', userId: 'user-1', displayName: 'Alice', roles: ['ops'] })
  })

  it('verifies offline with a pinned JSON JWK public key', async () => {
    const pinned = new IdentityVerifier({ ...base, identityPublicKey: pinnedJwkJson, gatewayJwksUrl: offlineJwksUrl })
    const token = await mint({ tenant: 't', user: 'u', roles: [] })
    expect(await pinned.verifyToken(token)).toEqual({ tenantId: 't', userId: 'u', displayName: '', roles: [] })
  })

  it('rejects tokens signed by a different key under pinning', async () => {
    const pinned = new IdentityVerifier({ ...base, identityPublicKey: pinnedPem, gatewayJwksUrl: offlineJwksUrl })
    const forged = await new SignJWT({ tenant: 't', user: 'u' })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer('dsh-casdoor-gateway')
      .setAudience('dsh-casdoor-auth')
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .sign(other.privateKey)
    expect(await pinned.verifyToken(forged)).toBeUndefined()
  })

  it('rejects a tampered token payload under pinning', async () => {
    const pinned = new IdentityVerifier({ ...base, identityPublicKey: pinnedPem, gatewayJwksUrl: offlineJwksUrl })
    const token = await mint({ tenant: 'acme', user: 'user-1' })
    const parts = token.split('.')
    // Flip one character of the payload segment: signature no longer matches.
    const payload = parts[1]
    const flipped = payload.charAt(0) === 'A' ? `B${payload.slice(1)}` : `A${payload.slice(1)}`
    const tampered = [parts[0], flipped, parts[2]].join('.')
    expect(await pinned.verifyToken(tampered)).toBeUndefined()
  })

  it('still enforces exp, iss and aud under pinning', async () => {
    const pinned = new IdentityVerifier({ ...base, identityPublicKey: pinnedPem, gatewayJwksUrl: offlineJwksUrl })
    expect(await pinned.verifyToken(await mint({ tenant: 't', user: 'u' }, { ttlSec: -10 }))).toBeUndefined()
    expect(await pinned.verifyToken(await mint({ tenant: 't', user: 'u' }, { iss: 'other' }))).toBeUndefined()
    expect(await pinned.verifyToken(await mint({ tenant: 't', user: 'u' }, { aud: 'other' }))).toBeUndefined()
  })

  it('fails loud on malformed pinned material instead of falling back to JWKS', () => {
    expect(() => new IdentityVerifier({ ...base, identityPublicKey: 'not a key at all' })).toThrow()
    expect(() => new IdentityVerifier({ ...base, identityPublicKey: '{broken json' })).toThrow()
    expect(() => new IdentityVerifier({ ...base, identityPublicKey: JSON.stringify({ kty: 'OKP', crv: 'P-256', x: 'AAAA' }) })).toThrow()
  })

  it('surfaces WebCrypto import failures of a pinned JWK as misconfiguration, not silent 401', async () => {
    // Structurally an OKP/Ed25519 JWK, but `x` is not a valid 32-byte point.
    const badPoint = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'short', alg: 'EdDSA' })
    const pinned = new IdentityVerifier({ ...base, identityPublicKey: badPoint, gatewayJwksUrl: offlineJwksUrl })
    const token = await mint({ tenant: 't', user: 'u' })
    await expect(pinned.verifyToken(token)).rejects.toThrow()
  })

  it('without a pin, falls back to the gateway JWKS endpoint (regression)', async () => {
    const before = jwksHits
    const verifier = new IdentityVerifier({ ...base, gatewayJwksUrl: `http://127.0.0.1:${jwksPort()}/.well-known/jwks.json` })
    const token = await mint({ tenant: 'acme', user: 'user-2' })
    expect(await verifier.verifyToken(token)).toEqual({ tenantId: 'acme', userId: 'user-2', displayName: '', roles: [] })
    expect(jwksHits).toBe(before + 1)
  })

  it('an empty-string pin behaves as unset (JWKS fallback)', async () => {
    const verifier = new IdentityVerifier({ ...base, identityPublicKey: '', gatewayJwksUrl: `http://127.0.0.1:${jwksPort()}/.well-known/jwks.json` })
    const token = await mint({ tenant: 'acme', user: 'user-3' })
    expect((await verifier.verifyToken(token))?.userId).toBe('user-3')
  })
})
