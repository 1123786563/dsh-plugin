import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { SignJWT } from 'jose'
import { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from '../src/config.ts'
import { PinMisconfigurationError } from '../src/identity.ts'
import { CasdoorAuthService } from '../src/index.ts'
import {
  GUARD_HINT,
  applyGuard,
  createCasdoorRequestGuard,
  type WebRequestGuard,
  type WebRequestGuardSeat,
} from '../src/guard.ts'

// Ed25519 minting fixture (identity.spec.ts paradigm): the test forges the
// gateway's key pair and pins its PEM, so verification runs fully offline.
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const otherKeys = generateKeyPairSync('ed25519')
const pinnedPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
// Port 1 is never listened on: any JWKS fetch fails ECONNREFUSED, proving the
// pinned path never touches the network.
const offlineJwksUrl = 'http://127.0.0.1:1/.well-known/jwks.json'

const veto = { allow: false as const, status: 401, body: GUARD_HINT }

/** One CasdoorAuthService over the pinned test key (a fresh context per service keeps registrations independent). */
function makeService(identityPublicKey: string = pinnedPem): CasdoorAuthService {
  return new CasdoorAuthService(
    new Context(),
    resolveConfig({ identityPublicKey, gatewayJwksUrl: offlineJwksUrl }),
  )
}

/** Mint one DshIdentityToken with the gateway's claim format (tenant/user/name/roles). */
async function mint(
  payload: Record<string, unknown>,
  options: { iss?: string, aud?: string, ttlSec?: number, key?: KeyObject } = {},
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid: 'test-key' })
    .setIssuer(options.iss ?? 'dsh-casdoor-gateway')
    .setAudience(options.aud ?? 'dsh-casdoor-auth')
    .setIssuedAt(nowSec)
    .setExpirationTime(nowSec + (options.ttlSec ?? 60))
    .sign(options.key ?? privateKey)
}

/** Minimal request double: transport headers plus the raw request URL. */
function request(headers: Record<string, string | readonly string[]> = {}, url = '/'): IncomingMessage {
  return { headers, url } as unknown as IncomingMessage
}

describe('createCasdoorRequestGuard', () => {
  it('admits a valid DshIdentityToken on http and upgrade with the three-field principal', async () => {
    const guard = createCasdoorRequestGuard(makeService(), () => 'launch-secret')
    const token = await mint({ tenant: 'acme', user: 'user-1', name: 'Alice', roles: ['ops'] })
    for (const kind of ['http', 'upgrade'] as const) {
      await expect(guard(request({ 'x-dsh-identity': token }), kind)).resolves.toEqual({
        allow: true,
        principal: { tenantId: 'acme', userId: 'user-1', roles: ['ops'] },
      })
    }
  })

  it('pins the operator hint to the literal port-3080 URL (not 38080)', () => {
    expect(GUARD_HINT).toBe('请走 http://127.0.0.1:3080')
  })

  it('vetoes 401 with the fixed hint for every uncredentialed or invalid request', async () => {
    const guard = createCasdoorRequestGuard(makeService(), () => 'launch-secret')
    const expired = await mint({ tenant: 't', user: 'u' }, { ttlSec: -10 })
    const wrongIss = await mint({ tenant: 't', user: 'u' }, { iss: 'other' })
    const wrongAud = await mint({ tenant: 't', user: 'u' }, { aud: 'other' })
    const forged = await mint({ tenant: 't', user: 'u' }, { key: otherKeys.privateKey })
    const arms: Array<[string, Record<string, string | readonly string[]>]> = [
      ['missing header', {}],
      ['empty header', { 'x-dsh-identity': '' }],
      ['array header', { 'x-dsh-identity': ['two', 'tokens'] }],
      ['garbage jwt', { 'x-dsh-identity': 'not-a-jwt' }],
      ['wrong-key forged token', { 'x-dsh-identity': forged }],
      ['expired token', { 'x-dsh-identity': expired }],
      ['wrong issuer', { 'x-dsh-identity': wrongIss }],
      ['wrong audience', { 'x-dsh-identity': wrongAud }],
    ]
    for (const [name, headers] of arms) {
      await expect(guard(request(headers), 'http'), name).resolves.toEqual(veto)
    }
    // No credential admits nothing, regardless of path or carrier.
    await expect(guard(request({}, '/'), 'http')).resolves.toEqual(veto)
    await expect(guard(request({}, '/assets/app.js'), 'http')).resolves.toEqual(veto)
    await expect(guard(request({}, '/api/session.list'), 'upgrade')).resolves.toEqual(veto)
  })

  it('propagates pin misconfiguration instead of swallowing it into a 401', async () => {
    // Structurally an OKP/Ed25519 JWK, but `x` is not a valid 32-byte point:
    // construction succeeds and the WebCrypto import rejects lazily.
    const badPoint = JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'short', alg: 'EdDSA' })
    const guard = createCasdoorRequestGuard(makeService(badPoint), () => undefined)
    const token = await mint({ tenant: 't', user: 'u' })
    await expect(guard(request({ 'x-dsh-identity': token }), 'http')).rejects.toThrow(PinMisconfigurationError)
  })

  it('admits the matching launch-token query parameter without a principal', async () => {
    const guard = createCasdoorRequestGuard(makeService(), () => 'launch-secret')
    await expect(guard(request({}, '/?token=launch-secret'), 'http')).resolves.toEqual({ allow: true })
    await expect(guard(request({}, '/?x=1&token=launch-secret'), 'upgrade')).resolves.toEqual({ allow: true })
  })

  it('vetoes wrong, length-anomalous, and empty launch tokens', async () => {
    const guard = createCasdoorRequestGuard(makeService(), () => 'launch-secret')
    for (const url of ['/?token=wrong', '/?token=launch-secret-with-tail', '/?token=x', '/?token=', '/?token']) {
      await expect(guard(request({}, url), 'http'), url).resolves.toEqual(veto)
    }
  })

  it('materializes the principal when both credentials are valid', async () => {
    const guard = createCasdoorRequestGuard(makeService(), () => 'launch-secret')
    const token = await mint({ tenant: 'acme', user: 'user-1', roles: [] })
    await expect(guard(request({ 'x-dsh-identity': token }, '/?token=launch-secret'), 'http')).resolves.toEqual({
      allow: true,
      principal: { tenantId: 'acme', userId: 'user-1', roles: [] },
    })
  })

  it('still admits the launch token when a present identity token fails verification', async () => {
    const guard = createCasdoorRequestGuard(makeService(), () => 'launch-secret')
    const expired = await mint({ tenant: 't', user: 'u' }, { ttlSec: -10 })
    await expect(guard(request({ 'x-dsh-identity': expired }, '/?token=launch-secret'), 'http'))
      .resolves.toEqual({ allow: true })
  })

  it('vetoes every ?token= request when no launch token was recorded', async () => {
    const guard = createCasdoorRequestGuard(makeService(), () => undefined)
    await expect(guard(request({}, '/?token=launch-secret'), 'http')).resolves.toEqual(veto)
    await expect(guard(request({}, '/?token='), 'http')).resolves.toEqual(veto)
  })
})

describe('applyGuard', () => {
  /** A fake guard seat counting registrations; the disposer unregisters. */
  function fakeSeat(): {
    seat: WebRequestGuardSeat
    calls: () => number
    seated: () => number
  } {
    let calls = 0
    let seated = 0
    const seat: WebRequestGuardSeat = {
      registerGuard(_guard: WebRequestGuard): () => void {
        calls += 1
        seated += 1
        return () => { seated -= 1 }
      },
    }
    return { seat, calls: () => calls, seated: () => seated }
  }

  it('never touches the seat when the guard is disabled (zero behavior difference)', () => {
    const { seat, calls } = fakeSeat()
    const dispose = applyGuard(seat, resolveConfig({ guardEnabled: false }), makeService(), () => undefined)
    expect(dispose).toBeUndefined()
    expect(calls()).toBe(0)
  })

  it('registers exactly once and releases through the disposer when enabled', () => {
    const { seat, calls, seated } = fakeSeat()
    const dispose = applyGuard(seat, resolveConfig({ guardEnabled: true }), makeService(), () => undefined)
    expect(dispose).toBeTypeOf('function')
    expect(calls()).toBe(1)
    expect(seated()).toBe(1)
    dispose?.()
    expect(seated()).toBe(0)
    expect(calls()).toBe(1)
  })

  it('fails loud on cores without the guard-seat patch', () => {
    expect(() => applyGuard({}, resolveConfig({ guardEnabled: true }), makeService(), () => undefined))
      .toThrow('scripts/host-patches/deepseek-harness.dsh-request-guard.patch')
  })
})
