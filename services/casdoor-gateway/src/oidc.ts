/**
 * Casdoor OIDC client (authorization code + PKCE) and the pending-login
 * state machine. The discovery URL, client credentials, and claim names are
 * operator configuration; the only user-influenced value (returnTo) rides
 * inside server-held state and is hardened in gate.ts.
 *
 * @module dsh-casdoor-gateway/oidc
 */

import { createHash, randomBytes } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import * as oidc from 'openid-client'

export class LoginError extends Error {
  override name = 'LoginError'
}

/** The identity resolved from a completed OIDC login. */
export interface OidcIdentity {
  readonly tenantId: string
  readonly userId: string
  readonly displayName: string
  readonly roles: readonly string[]
}

interface PendingLogin {
  readonly state: string
  readonly verifier: string
  readonly returnTo: string
  readonly expiresAtMs: number
}

export interface CasdoorOidcOptions {
  readonly issuer: URL
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: URL
  readonly organizationClaim: string
  readonly rolesClaim: string
}

/** Tenant (casdoor organization) safe to embed in a shared-app clientId suffix. */
export function safeOrgParam(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(trimmed) ? trimmed : undefined
}

const PENDING_TTL_MS = 10 * 60 * 1000
const SCOPES = 'openid profile'
/** Dev deployments run casdoor over loopback HTTP; openid-client refuses that unless allowed explicitly. */
const INSECURE = { execute: [oidc.allowInsecureRequests] }

function base64url(bytes: number): string {
  return Buffer.from(randomBytes(bytes)).toString('base64url')
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** casdoor roles arrive as strings ("role" or "org/role"), objects with `name`, or a comma list — normalize to bare role names. */
function rolesOf(value: unknown): string[] | undefined {
  const bare = (item: string): string => {
    const slash = item.lastIndexOf('/')
    return slash >= 0 ? item.slice(slash + 1) : item
  }
  if (Array.isArray(value)) {
    const roles = value
      .map(item => (typeof item === 'string'
        ? bare(item)
        : str((item as { name?: unknown })?.name) ?? undefined))
      .filter((item): item is string => item !== undefined)
    return roles
  }
  const asString = str(value)
  if (asString === undefined) return undefined
  return asString.split(',').map(part => bare(part.trim())).filter(part => part.length > 0)
}

/** The surface server.ts and tests depend on (tests stub this interface). */
export interface OidcClient {
  beginLogin(returnTo: string, org?: string): Promise<string>
  completeLogin(callbackUrl: string): Promise<{ identity: OidcIdentity, returnTo: string, idToken: string }>
  idpLogoutUrl(idToken: string | undefined, postLogoutUri: URL): string
}

export class CasdoorOidc implements OidcClient {
  private readonly pending = new Map<string, PendingLogin>()
  private discoveryPromise: Promise<oidc.Configuration> | undefined
  private jwksKey: JWTVerifyGetKey | undefined
  /** WHATWG normalization appends '/' to the empty path; casdoor's iss carries no slash. */
  private readonly issuerString: string

  constructor(private readonly options: CasdoorOidcOptions) {
    this.issuerString = options.issuer.href.replace(/\/+$/, '')
  }

  private configuration(): Promise<oidc.Configuration> {
    this.discoveryPromise ??= oidc.discovery(
      this.options.issuer,
      this.options.clientId,
      this.options.clientSecret,
      undefined,
      INSECURE,
    )
    return this.discoveryPromise
  }

  private async verifyKey(): Promise<JWTVerifyGetKey> {
    const conf = await this.configuration()
    const jwksUri = conf.serverMetadata().jwks_uri
    const url = jwksUri !== undefined && jwksUri.length > 0
      ? new URL(jwksUri)
      : new URL('/.well-known/jwks', this.options.issuer)
    this.jwksKey ??= createRemoteJWKSet(url, { cooldownDuration: 30_000 })
    return this.jwksKey
  }

  private purge(nowMs: number): void {
    for (const [state, pending] of this.pending) {
      if (pending.expiresAtMs <= nowMs) this.pending.delete(state)
    }
  }

  /**
   * Build the authorize redirect and remember {state, verifier, returnTo}.
   * `org` pins the casdoor organization through the shared-app clientId
   * suffix convention (`<clientId>-org-<org>`): the authorize page itself
   * never offers an organization picker.
   */
  async beginLogin(returnTo: string, org?: string): Promise<string> {
    const now = Date.now()
    this.purge(now)
    const conf = await this.configuration()
    const state = base64url(24)
    const verifier = base64url(32)
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    this.pending.set(state, { state, verifier, returnTo, expiresAtMs: now + PENDING_TTL_MS })
    const clientId = org === undefined
      ? this.options.clientId
      : `${this.options.clientId}-org-${org}`
    return oidc.buildAuthorizationUrl(conf, {
      client_id: clientId,
      redirect_uri: this.options.redirectUri.href,
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).href
  }

  /** Exchange the callback code for tokens and resolve the tenant identity. */
  async completeLogin(
    callbackUrl: string,
  ): Promise<{ identity: OidcIdentity, returnTo: string, idToken: string }> {
    const current = new URL(callbackUrl)
    const error = current.searchParams.get('error')
    if (error !== null) throw new LoginError(`casdoor returned error: ${error}`)
    const code = current.searchParams.get('code')
    const state = current.searchParams.get('state')
    if (code === null || state === null) throw new LoginError('callback missing code/state')
    const pending = this.pending.get(state)
    if (pending === undefined || pending.expiresAtMs <= Date.now()) {
      throw new LoginError('login state is unknown or expired; restart the login')
    }
    this.pending.delete(state)

    const conf = await this.configuration()
    // casdoor's shared-application convention sets the ID-token aud to
    // "<clientId>-org-<organization>" (the org is only known after login),
    // which the stock openid-client grant refuses (aud === clientId). The
    // exchange is therefore manual, and the ID token is verified with jose
    // under an audience rule that accepts the org-suffixed form.
    const tokenEndpointHref = conf.serverMetadata().token_endpoint
    if (tokenEndpointHref === undefined || tokenEndpointHref.length === 0) {
      throw new LoginError('casdoor discovery returned no token_endpoint')
    }
    const tokenEndpoint = new URL(tokenEndpointHref)
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      code,
      redirect_uri: this.options.redirectUri.href,
      code_verifier: pending.verifier,
    })
    const tokenResponse = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    })
    if (!tokenResponse.ok) {
      const detail = (await tokenResponse.text()).slice(0, 200)
      throw new LoginError(`token endpoint answered HTTP ${String(tokenResponse.status)}: ${detail}`)
    }
    const tokens = await tokenResponse.json() as { id_token?: string }
    const idToken = tokens.id_token ?? ''
    if (idToken.length === 0) throw new LoginError('token endpoint returned no id_token')

        const verified = await jwtVerify(idToken, await this.verifyKey(), {
            issuer: this.issuerString,
        })
    const claims = verified.payload as Record<string, unknown>
    const sub = str(claims.sub)
    if (sub === undefined) throw new LoginError('ID token carries no subject')

    const ORG_SUFFIX = '-org-'
    const audience = Array.isArray(claims.aud)
      ? claims.aud.map(String)
      : typeof claims.aud === 'string' ? [claims.aud] : []
    let tenantFromAud: string | undefined
    const audienceOk = audience.some(value => {
      if (value === this.options.clientId) return true
      if (value.startsWith(this.options.clientId + ORG_SUFFIX)) {
        tenantFromAud = value.slice(this.options.clientId.length + ORG_SUFFIX.length)
        return true
      }
      return false
    })
    if (!audienceOk) {
      throw new LoginError(`ID token audience mismatch: ${JSON.stringify(audience)}`)
    }

    const tenantId = str(claims[this.options.organizationClaim]) ?? tenantFromAud
    if (tenantId === undefined) {
      throw new LoginError(
        `neither the ID token audience nor the claim ${JSON.stringify(this.options.organizationClaim)} carried the tenant (casdoor organization)`,
      )
    }
    const roles = rolesOf(claims[this.options.rolesClaim]) ?? []
    const displayName = str(claims.name) ?? str(claims.preferred_username) ?? str(claims.display) ?? ''
    return {
      identity: { tenantId, userId: sub, displayName, roles },
      returnTo: pending.returnTo,
      idToken,
    }
  }

  /**
   * casdoor RP-initiated logout. Falls back to the plain logout page when no
   * ID token is available (the casdoor session still ends; the redirect is
   * simply not honored).
   */
  idpLogoutUrl(idToken: string | undefined, postLogoutUri: URL): string {
    const base = new URL('/login/oauth/logout', this.options.issuer)
    if (idToken !== undefined && idToken.length > 0) {
      base.searchParams.set('id_token_hint', idToken)
      base.searchParams.set('post_logout_redirect_uri', postLogoutUri.href)
    }
    return base.href
  }
}
