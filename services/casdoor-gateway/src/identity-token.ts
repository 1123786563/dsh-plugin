/**
 * DshIdentityToken: the short-lived Ed25519 JWT the gateway mints per proxied
 * request. The private key never leaves the gateway's data directory; the dsh
 * plugin verifies with the public JWKS exposed at /.well-known/jwks.json
 * (public keys are public — the endpoint sits in the auth-plane whitelist).
 *
 * The term is deliberately NOT "ID token": that already names the casdoor
 * OIDC id_token. This is the gateway's own forwarded-identity assertion.
 *
 * @module dsh-casdoor-gateway/identity-token
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  type webcrypto,
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SignJWT, type JWK } from 'jose'
import type { LoginSession } from './sessions.js'

/** Claims minted into every DshIdentityToken. */
export interface IdentityClaims {
  readonly tenantId: string
  readonly userId: string
  readonly displayName: string
  readonly roles: readonly string[]
}

export interface JsonWebKeySet {
  readonly keys: readonly JWK[]
}

export interface IdentitySignOptions {
  readonly issuer: string
  readonly audience: string
  readonly ttlSec: number
  readonly nowMs?: number
}

const ALG = 'EdDSA'
const SPKI_ED25519_LENGTH = 44

export class IdentityIssuer {
  private readonly privateKey: KeyObject
  private readonly jwk: JWK
  private cryptoKeyPromise: Promise<webcrypto.CryptoKey> | undefined

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    const privateKeyPath = join(dataDir, 'identity_ed25519.pem')
    const publicKeyPath = join(dataDir, 'identity_ed25519.pub.pem')
    if (existsSync(privateKeyPath) && existsSync(publicKeyPath)) {
      this.privateKey = createPrivateKey(readFileSync(privateKeyPath, 'utf8'))
    } else {
      const pair = generateKeyPairSync('ed25519')
      this.privateKey = pair.privateKey
      writeFileSync(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
      writeFileSync(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }))
    }
    // jose v6 speaks WebCrypto only, so the public JWK is derived from the
    // SPKI DER by hand (fixed 44-byte Ed25519 structure; x = last 32 bytes).
    const spki = this.publicSpki()
    if (spki.length !== SPKI_ED25519_LENGTH) {
      throw new Error(`identity key: unexpected Ed25519 SPKI length ${String(spki.length)}`)
    }
    // kid = fingerprint of the public key: stable across restarts, distinct
    // per key material, so JWKS consumers rotate without ambiguity.
    const kid = createHash('sha256').update(spki).digest('hex').slice(0, 16)
    this.jwk = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(spki.subarray(spki.length - 32)).toString('base64url'),
      kid,
      alg: ALG,
      use: 'sig',
    }
  }

  private publicSpki(): Uint8Array {
    const publicKey = createPublicKey(this.privateKey)
    return new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
  }

  private signingKey(): Promise<webcrypto.CryptoKey> {
    this.cryptoKeyPromise ??= crypto.subtle.importKey(
      'pkcs8',
      new Uint8Array(this.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer),
      'Ed25519',
      false,
      ['sign'],
    )
    return this.cryptoKeyPromise
  }

  /** Mint one DshIdentityToken for an authenticated session. */
  async mint(session: LoginSession, options: IdentitySignOptions): Promise<string> {
    return this.sign(
      { tenantId: session.tenantId, userId: session.userId, displayName: session.displayName, roles: session.roles },
      options,
    )
  }

  async sign(claims: IdentityClaims, options: IdentitySignOptions): Promise<string> {
    const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000)
    const kid = typeof this.jwk.kid === 'string' ? this.jwk.kid : undefined
    return await new SignJWT({
      tenant: claims.tenantId,
      user: claims.userId,
      name: claims.displayName,
      roles: [...claims.roles],
    })
      .setProtectedHeader(kid === undefined ? { alg: ALG } : { alg: ALG, kid })
      .setIssuer(options.issuer)
      .setAudience(options.audience)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + options.ttlSec)
      .sign(await this.signingKey())
  }

  /** The public JWKS document served at /.well-known/jwks.json. */
  jwks(): JsonWebKeySet {
    return { keys: [this.jwk] }
  }
}
