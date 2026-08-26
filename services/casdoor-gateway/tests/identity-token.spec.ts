import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { afterAll, describe, expect, it } from 'vitest'
import { IdentityIssuer } from '../src/identity-token.ts'

const dir = mkdtempSync(join(tmpdir(), 'dsh-gw-identity-'))
const issuer = new IdentityIssuer(dir)

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

const options = { issuer: 'dsh-casdoor-gateway', audience: 'dsh-casdoor-auth', ttlSec: 60 }

describe('IdentityIssuer', () => {
  it('mints a DshIdentityToken verifiable against the exposed JWKS', async () => {
    const token = await issuer.sign(
      { tenantId: 'acme', userId: 'user-1', displayName: 'Alice', roles: ['ops'] },
      options,
    )
    const { payload } = await jwtVerify(token, createLocalJWKSet(issuer.jwks()), {
      algorithms: ['EdDSA'],
      issuer: options.issuer,
      audience: options.audience,
    })
    expect(payload.tenant).toBe('acme')
    expect(payload.user).toBe('user-1')
    expect(payload.name).toBe('Alice')
    expect(payload.roles).toEqual(['ops'])
  })

  it('keeps the same key across restarts (kid and JWKS stable)', () => {
    const second = new IdentityIssuer(dir)
    expect(second.jwks()).toEqual(issuer.jwks())
  })

  it('embeds the declared expiry', async () => {
    const token = await issuer.sign(
      { tenantId: 't', userId: 'u', displayName: '', roles: [] },
      { ...options, ttlSec: 5, nowMs: 1_000_000 },
    )
    // Decode the payload directly: the 1970-anchored mint would fail a real
    // clock's exp check by construction (covered by the test below).
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp: number }
    expect(payload.exp).toBe(Math.floor(1_000_000 / 1000) + 5)
  })

  it('produces tokens that fail verification after expiry', async () => {
    const token = await issuer.sign(
      { tenantId: 't', userId: 'u', displayName: '', roles: [] },
      { ...options, ttlSec: 1, nowMs: Date.now() - 120_000 },
    )
    await expect(jwtVerify(token, createLocalJWKSet(issuer.jwks()), {
      algorithms: ['EdDSA'],
      issuer: options.issuer,
      audience: options.audience,
    })).rejects.toThrow()
  })

  it('rejects wrong audience at verification time', async () => {
    const token = await issuer.sign(
      { tenantId: 't', userId: 'u', displayName: '', roles: [] },
      { ...options, audience: 'someone-else' },
    )
    await expect(jwtVerify(token, createLocalJWKSet(issuer.jwks()), {
      algorithms: ['EdDSA'],
      issuer: options.issuer,
      audience: options.audience,
    })).rejects.toThrow()
  })
})
