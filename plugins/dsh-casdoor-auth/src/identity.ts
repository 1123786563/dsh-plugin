/**
 * Verification of the gateway's DshIdentityToken (Ed25519 JWT) into the
 * canonical CasdoorIdentity. Verification failures read as "no identity"
 * (undefined) — the multi-tenant bridge then answers 401, and the stock
 * surfaces behind the gateway never see the request at all.
 *
 * @module dsh-casdoor-auth/identity
 */

import type { IncomingHttpHeaders } from 'node:http'
import { createPublicKey } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  importJWK,
  jwtVerify,
  type CryptoKey,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose'

/** Minimal JSON Web Key Set shape (jose v6 exports no JWKS type). */
export interface JsonWebKeySet {
  readonly keys: JWK[]
}

/** The authenticated identity, already mapped to the multi-tenant vocabulary. */
export interface CasdoorIdentity {
  readonly tenantId: string
  readonly userId: string
  readonly displayName: string
  readonly roles: readonly string[]
}

export interface IdentityVerifierOptions {
  /** JWKS endpoint of the gateway; fetched lazily and cached with cooldown. */
  readonly gatewayJwksUrl?: string
  /**
   * Pinned gateway public key (ADR-0004: pin first, JWKS fallback): either a
   * PEM SPKI string or a JSON-serialized JWK. Empty or absent disables the
   * pin. Malformed material throws at construction — a misconfigured pin
   * must never silently weaken into a JWKS fallback.
   */
  readonly identityPublicKey?: string
  /** Test seam: verify against a fixed key set instead of the remote JWKS. */
  readonly staticJwks?: JsonWebKeySet
  readonly identityHeader: string
  readonly issuer: string
  readonly audience: string
}

/** A pinned key: PEM resolves synchronously, a JWK is imported lazily. */
type PinnedKey =
  | { readonly kind: 'pem', readonly key: KeyObject }
  | { readonly kind: 'jwk', readonly jwk: JWK }

/**
 * Pin misconfiguration: the operator supplied key material we cannot use.
 * Surfaced loudly (never resolved to "no identity" and never answered by a
 * JWKS fallback) so the deployment failure is visible instead of every
 * request quietly degrading to 401.
 */
export class PinMisconfigurationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PinMisconfigurationError'
  }
}

/** Structural checks a pinned Ed25519 JWK must pass before WebCrypto sees it. */
function assertEd25519Jwk(jwk: JWK, source: string): void {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string' || jwk.x.length === 0) {
    throw new PinMisconfigurationError(`identityPublicKey: expected an OKP/Ed25519 JWK, got ${source.slice(0, 60)}`)
  }
}

/**
 * Parse pinned key material. PEM SPKI parses synchronously; a JSON JWK only
 * passes the structural checks here (WebCrypto itself is consulted lazily on
 * first verification, so its rejection is always awaited, never stray). Both
 * parse failures fail loud at construction.
 */
function parsePinnedKey(material: string): PinnedKey {
  if (material.startsWith('{')) {
    let jwk: unknown
    try {
      jwk = JSON.parse(material)
    } catch (cause) {
      throw new PinMisconfigurationError('identityPublicKey: JWK is not valid JSON', { cause })
    }
    if (typeof jwk !== 'object' || jwk === null) {
      throw new PinMisconfigurationError('identityPublicKey: JWK must be a JSON object')
    }
    assertEd25519Jwk(jwk as JWK, material)
    return { kind: 'jwk', jwk: jwk as JWK }
  }
  try {
    return { kind: 'pem', key: createPublicKey(material) }
  } catch (cause) {
    throw new PinMisconfigurationError('identityPublicKey: PEM could not be parsed', { cause })
  }
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export class IdentityVerifier {
  private readonly pinned: PinnedKey | undefined
  private readonly getKey: JWTVerifyGetKey
  private readonly headerName: string
  private readonly issuer: string
  private readonly audience: string
  /** Memoized WebCrypto import of a pinned JWK (created lazily, always awaited). */
  private jwkImport: Promise<CryptoKey | Uint8Array> | undefined

  constructor(options: IdentityVerifierOptions) {
    this.headerName = options.identityHeader.toLowerCase()
    this.issuer = options.issuer
    this.audience = options.audience
    const material = options.identityPublicKey?.trim()
    this.pinned = material !== undefined && material !== '' ? parsePinnedKey(material) : undefined
    if (this.pinned === undefined && options.staticJwks !== undefined) {
      this.getKey = createLocalJWKSet(options.staticJwks)
    } else if (this.pinned === undefined) {
      this.getKey = createRemoteJWKSet(
        new URL(options.gatewayJwksUrl ?? 'http://127.0.0.1:3080/.well-known/jwks.json'),
        { cooldownDuration: 30_000 },
      )
    } else {
      // Pinned mode never fetches; the JWKS seam stays unused.
      this.getKey = () => {
        throw new PinMisconfigurationError('pinned verifier resolved a key through the JWKS path')
      }
    }
  }

  /** The verification key: the pinned key when configured, else the JWKS seam. */
  private async resolveKey(): Promise<JWTVerifyGetKey | KeyObject | CryptoKey | Uint8Array> {
    const pinned = this.pinned
    if (pinned === undefined) return this.getKey
    if (pinned.kind === 'pem') return pinned.key
    this.jwkImport ??= importJWK(pinned.jwk, 'EdDSA').catch(cause => {
      throw new PinMisconfigurationError('identityPublicKey: WebCrypto rejected the pinned JWK', { cause })
    })
    return this.jwkImport
  }

  /** Verify one token; invalid/expired/malformed tokens resolve to undefined. */
  async verifyToken(token: string): Promise<CasdoorIdentity | undefined> {
    try {
      const { payload } = await jwtVerify(token, await this.resolveKey(), {
        algorithms: ['EdDSA'],
        issuer: this.issuer,
        audience: this.audience,
      })
      const tenantId = stringClaim(payload.tenant)
      const userId = stringClaim(payload.user)
      if (tenantId === undefined || userId === undefined) return undefined
      const roles = Array.isArray(payload.roles)
        ? payload.roles.filter((role): role is string => typeof role === 'string')
        : []
      return {
        tenantId,
        userId,
        displayName: stringClaim(payload.name) ?? '',
        roles,
      }
    } catch (error) {
      if (error instanceof PinMisconfigurationError) throw error
      return undefined
    }
  }

  /** Extract the token from transport headers and verify it. */
  async fromRequest(headers: IncomingHttpHeaders): Promise<CasdoorIdentity | undefined> {
    const raw = headers[this.headerName]
    if (typeof raw !== 'string' || raw.length === 0) return undefined
    return this.verifyToken(raw)
  }
}
