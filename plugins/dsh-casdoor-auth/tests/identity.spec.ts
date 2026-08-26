import { generateKeyPairSync } from 'node:crypto'
import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
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
