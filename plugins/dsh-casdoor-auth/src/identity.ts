/**
 * Verification of the gateway's DshIdentityToken (Ed25519 JWT) into the
 * canonical CasdoorIdentity. Verification failures read as "no identity"
 * (undefined) — the multi-tenant bridge then answers 401, and the stock
 * surfaces behind the gateway never see the request at all.
 *
 * @module dsh-casdoor-auth/identity
 */

import type { IncomingHttpHeaders } from 'node:http'
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
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
  /** Test seam: verify against a fixed key set instead of the remote JWKS. */
  readonly staticJwks?: JsonWebKeySet
  readonly identityHeader: string
  readonly issuer: string
  readonly audience: string
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export class IdentityVerifier {
  private readonly getKey: JWTVerifyGetKey
  private readonly headerName: string
  private readonly issuer: string
  private readonly audience: string

  constructor(options: IdentityVerifierOptions) {
    this.headerName = options.identityHeader.toLowerCase()
    this.issuer = options.issuer
    this.audience = options.audience
    if (options.staticJwks !== undefined) {
      this.getKey = createLocalJWKSet(options.staticJwks)
    } else {
      this.getKey = createRemoteJWKSet(
        new URL(options.gatewayJwksUrl ?? 'http://127.0.0.1:3080/.well-known/jwks.json'),
        { cooldownDuration: 30_000 },
      )
    }
  }

  /** Verify one token; invalid/expired/malformed tokens resolve to undefined. */
  async verifyToken(token: string): Promise<CasdoorIdentity | undefined> {
    try {
      const { payload } = await jwtVerify(token, this.getKey, {
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
    } catch {
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
