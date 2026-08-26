/**
 * Gateway configuration: everything is operator-supplied through the
 * environment (never through request input), validated loudly at boot.
 *
 * The upstream and the IdP are deliberately allowed to be loopback — this
 * service IS the trust boundary that sits in front of a loopback-only dsh
 * webserver; user-controlled values (returnTo) are validated separately in
 * gate.ts and never reach outbound request URLs.
 *
 * @module dsh-casdoor-gateway/config
 */

export interface GatewayConfig {
  /** Public listen host. Loopback for dev; 0.0.0.0 for production. */
  readonly host: string
  /** Public listen port (the port users visit). */
  readonly port: number
  /** The origin users type into the browser; builds redirect URIs and cookie scope. */
  readonly publicUrl: URL
  /** The loopback-only dsh webserver everything is proxied into. */
  readonly upstream: URL
  /** The casdoor OIDC issuer origin. */
  readonly casdoorIssuer: URL
  readonly casdoorClientId: string
  readonly casdoorClientSecret: string
  readonly cookieName: string
  readonly cookieSecure: boolean
  /** Absolute login-session lifetime, milliseconds. */
  readonly sessionTtlMs: number
  /** Directory holding the SQLite session DB and the identity signing key. */
  readonly dataDir: string
  readonly identityIssuer: string
  readonly identityAudience: string
  readonly identityHeader: string
  readonly identityTtlSec: number
  /** casdoor role names treated as gateway administrators. */
  readonly adminRoles: readonly string[]
  /** /api RPC methods gated to administrators (mirrors the host's PRIVILEGED_METHODS pin). */
  readonly privilegedMethods: ReadonlySet<string>
  /** Also end the casdoor session on logout (RP-initiated style). */
  readonly idpLogout: boolean
  /** ID-token claim naming the tenant (casdoor organization). */
  readonly organizationClaim: string
  /** ID-token claim naming the roles array. */
  readonly rolesClaim: string
}

/** The host's loopback-pinned privileged RPC methods, mirrored at the gateway (see ADR-0002). */
export const DEFAULT_PRIVILEGED_METHODS: readonly string[] = Object.freeze([
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.discoverModels',
])

export const DEFAULT_IDENTITY_ISSUER = 'dsh-casdoor-gateway'
export const DEFAULT_IDENTITY_AUDIENCE = 'dsh-casdoor-auth'

function parseUrl(env: string | undefined, fallback: string, field: string): URL {
  const value = env !== undefined && env.length > 0 ? env : fallback
  const url = new URL(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`gateway config ${field} must be an http(s) URL, got ${JSON.stringify(value)}`)
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`gateway config ${field} must be a bare origin, got ${JSON.stringify(value)}`)
  }
  return url
}

function parseInt_(env: string | undefined, field: string, fallback: number): number {
  if (env === undefined || env.length === 0) return fallback
  const value = Number(env)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`gateway config ${field} must be a positive integer, got ${JSON.stringify(env)}`)
  }
  return value
}

function csv(env: string | undefined): string[] | undefined {
  if (env === undefined || env.trim().length === 0) return undefined
  return env.split(',').map(part => part.trim()).filter(part => part.length > 0)
}

function bool(env: string | undefined): boolean | undefined {
  if (env === undefined || env.length === 0) return undefined
  if (env === '1' || env.toLowerCase() === 'true') return true
  if (env === '0' || env.toLowerCase() === 'false') return false
  throw new Error(`gateway config boolean flag must be 0/1/true/false, got ${JSON.stringify(env)}`)
}

/**
 * Build the resolved configuration from an environment (injectable for tests).
 * @param env - the process environment (or a test fixture).
 * @param overrides - test hook for dataDir/ports without env ceremony.
 */
export function loadGatewayConfig(
  env: NodeJS.ProcessEnv,
  overrides: { dataDir?: string } = {},
): GatewayConfig {
  const casdoorClientId = env.CASDOOR_CLIENT_ID ?? ''
  const casdoorClientSecret = env.CASDOOR_CLIENT_SECRET ?? ''
  if (casdoorClientId.length === 0 || casdoorClientSecret.length === 0) {
    throw new Error(
      'gateway config requires CASDOOR_CLIENT_ID and CASDOOR_CLIENT_SECRET (create the application in casdoor, see docker/README)',
    )
  }
  const home = env.HOME ?? process.cwd()
  return {
    host: env.GATEWAY_HOST ?? '127.0.0.1',
    port: parseInt_(env.GATEWAY_PORT, 'GATEWAY_PORT', 3080),
    publicUrl: parseUrl(env.GATEWAY_PUBLIC_URL, 'http://127.0.0.1:3080', 'GATEWAY_PUBLIC_URL'),
    upstream: parseUrl(env.DSH_UPSTREAM_URL, 'http://127.0.0.1:38080', 'DSH_UPSTREAM_URL'),
    casdoorIssuer: parseUrl(env.CASDOOR_ISSUER, 'http://127.0.0.1:8001', 'CASDOOR_ISSUER'),
    casdoorClientId,
    casdoorClientSecret,
    cookieName: env.GATEWAY_COOKIE_NAME ?? 'dsh_sid',
    cookieSecure: bool(env.GATEWAY_COOKIE_SECURE) ?? false,
    sessionTtlMs: parseInt_(env.GATEWAY_SESSION_TTL_MS, 'GATEWAY_SESSION_TTL_MS', 24 * 60 * 60 * 1000),
    dataDir: overrides.dataDir ?? env.GATEWAY_DATA_DIR ?? `${home}/.dsh-casdoor-gateway`,
    identityIssuer: env.GATEWAY_IDENTITY_ISSUER ?? DEFAULT_IDENTITY_ISSUER,
    identityAudience: env.GATEWAY_IDENTITY_AUDIENCE ?? DEFAULT_IDENTITY_AUDIENCE,
    identityHeader: (env.GATEWAY_IDENTITY_HEADER ?? 'x-dsh-identity').toLowerCase(),
    identityTtlSec: parseInt_(env.GATEWAY_IDENTITY_TTL_SEC, 'GATEWAY_IDENTITY_TTL_SEC', 60),
    adminRoles: Object.freeze(csv(env.GATEWAY_ADMIN_ROLES) ?? ['dsh-admin']),
    privilegedMethods: new Set(
      csv(env.GATEWAY_PRIVILEGED_METHODS) ?? DEFAULT_PRIVILEGED_METHODS,
    ),
    idpLogout: bool(env.GATEWAY_IDP_LOGOUT) ?? true,
    organizationClaim: env.CASDOOR_ORGANIZATION_CLAIM ?? 'organization',
    rolesClaim: env.CASDOOR_ROLES_CLAIM ?? 'roles',
  }
}
