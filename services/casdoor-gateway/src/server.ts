/**
 * dsh-casdoor-gateway entrypoint: the fastify application (auth plane + the
 * gated wildcard proxy) and the process lifecycle wiring.
 *
 * Auth plane (session-free): /healthz, /.well-known/jwks.json, /login,
 * /casdoor/callback, /logout. Everything else passes the gate first:
 *  - no login session → 302 to /login (browser navigations) or 401 JSON
 *    (fetch/XHR — the SPA's tapIndex watcher turns it into a redirect);
 *  - privileged /api RPC method without an admin role → 403;
 *  - accepted → mint a DshIdentityToken, hijack the reply, stream-pipe into
 *    the loopback dsh webserver (WebSocket upgrades likewise, in proxy.ts).
 *
 * @module dsh-casdoor-gateway/server
 */

import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { IncomingHttpHeaders } from 'node:http'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import type { GatewayConfig } from './config.js'
import { loadGatewayConfig } from './config.js'
import { isAdmin, isCredentiallessAsset, privilegedMethodOf, safeReturnTo, wantsHtml } from './gate.js'
import { IdentityIssuer } from './identity-token.js'
import { CasdoorOidc, safeOrgParam, type OidcClient } from './oidc.js'
import { installUpgradeProxy, proxyHttpRequest } from './proxy.js'
import { SessionStore, type LoginSession } from './sessions.js'
import { UpstreamAuth } from './upstream-auth.js'

export interface AppDeps {
  readonly config: GatewayConfig
  readonly store: SessionStore
  readonly issuer: IdentityIssuer
  readonly oidc: OidcClient
  /** Upstream browser-auth session; absent on dsh cores without browser auth. */
  readonly auth?: UpstreamAuth
}

function cookieValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers.cookie
  if (typeof raw !== 'string') return undefined
  for (const part of raw.split(';')) {
    const index = part.indexOf('=')
    if (index < 0 || part.slice(0, index).trim() !== name) continue
    return part.slice(index + 1).trim()
  }
  return undefined
}

/**
 * Minimal .env loader (KEY=VALUE lines, '#' comments): real env vars win,
 * nothing is overwritten. Operators get `pnpm dev`-works-out-of-the-box
 * without a dotenv dependency.
 */
function loadDotEnv(path: string): void {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (process.env[key] === undefined) process.env[key] = value
  }
}

/** fastify buffers request bodies (parser design), so the limit must cover the dsh /api envelope: 300 MiB attachment allowance plus headroom. */
const REQUEST_BODY_LIMIT_BYTES = 320 * 1024 * 1024

/**
 * Assemble the gateway fastify application (no listening, no side effects
 * beyond the session store the caller owns).
 */
export function buildApp(deps: AppDeps, options: { logger?: boolean | object } = {}): FastifyInstance {
  const { config, store, issuer, oidc } = deps
  const app = Fastify({
    logger: options.logger ?? { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: REQUEST_BODY_LIMIT_BYTES,
  })
  void app.register(cookie)
  // Every proxied content type must reach the handler as the assembled raw
  // Buffer: registering the catch-all '*' is not enough — exact registrations
  // (fastify's default JSON/text parsers) win over it, so those are replaced
  // with buffer pass-throughs too. Parsed bodies cannot be re-serialized
  // byte-faithfully, and the forwarded content-length must match the bytes.
  const bufferPassThrough = (_request: unknown, body: Buffer, done: (err: Error | null, body?: Buffer) => void): void => {
    done(null, body)
  }
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, bufferPassThrough)
  app.addContentTypeParser('text/plain', { parseAs: 'buffer' }, bufferPassThrough)
  app.addContentTypeParser('*', { parseAs: 'buffer' }, bufferPassThrough)

  const sessionOf = (req: FastifyRequest): LoginSession | undefined => {
    const sid = req.cookies?.[config.cookieName]
    return sid === undefined || sid.length === 0 ? undefined : store.get(sid)
  }
  const identityOptions = {
    issuer: config.identityIssuer,
    audience: config.identityAudience,
    ttlSec: config.identityTtlSec,
  }

  app.get('/healthz', async () => ({ ok: true }))

  app.get('/.well-known/jwks.json', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=300')
    return issuer.jwks() as unknown as Record<string, unknown>
  })

  app.get('/login', async (req, reply) => {
    const query = req.query as { returnTo?: unknown, org?: unknown }
    const returnTo = safeReturnTo(typeof query.returnTo === 'string' ? query.returnTo : undefined)
    // /login?org=<casdoor organization> pins the tenant via the shared-app
    // clientId suffix; without it the app's default organization applies.
    const org = safeOrgParam(query.org)
    if (sessionOf(req) !== undefined) return reply.redirect(returnTo)
    return reply.redirect(await oidc.beginLogin(returnTo, org))
  })

  app.get('/casdoor/callback', async (req, reply) => {
    const callbackUrl = new URL(req.raw.url ?? '/casdoor/callback', config.publicUrl).href
    try {
      const { identity, returnTo, idToken } = await oidc.completeLogin(callbackUrl)
      const session = store.create({ ...identity, idToken, ttlMs: config.sessionTtlMs })
      reply.setCookie(config.cookieName, session.sid, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.cookieSecure,
        maxAge: Math.floor(config.sessionTtlMs / 1000),
      })
      return reply.redirect(returnTo)
    } catch (error) {
      req.log.warn({ err: error }, 'casdoor login failed')
      return reply.code(502).send({ error: 'login-failed' })
    }
  })

  app.route({
    method: ['GET', 'POST'],
    url: '/logout',
    handler: async (req, reply) => {
      const session = sessionOf(req)
      if (session !== undefined) store.delete(session.sid)
      reply.clearCookie(config.cookieName, { path: '/' })
      if (config.idpLogout) {
        return reply.redirect(
          oidc.idpLogoutUrl(session?.idToken, new URL('/login', config.publicUrl)),
        )
      }
      return reply.redirect('/')
    },
  })

  app.all('/*', async (req, reply) => {
    const url = new URL(req.raw.url ?? '/', 'http://gateway.invalid')
    const session = sessionOf(req)
    const target = { upstream: config.upstream, identityHeader: config.identityHeader }
    if (session === undefined) {
      // Public static descriptors the browser fetches without cookies.
      if (isCredentiallessAsset(url.pathname)) {
        reply.hijack()
        proxyHttpRequest(req.raw, reply.raw, target, '', undefined, deps.auth)
        return
      }
      if (wantsHtml(req.method, req.headers.accept)) {
        const returnTo = safeReturnTo(`${url.pathname}${url.search}`)
        return reply.redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`)
      }
      return reply.code(401).send({ error: 'unauthenticated' })
    }
    const privileged = privilegedMethodOf(url.pathname, req.method, config.privilegedMethods)
    if (privileged !== undefined && !isAdmin(session, config.adminRoles)) {
      return reply.code(403).send({
        error: 'forbidden',
        method: privileged,
        message: `RPC method ${JSON.stringify(privileged)} is privileged; one of roles [${config.adminRoles.join(', ')}] is required`,
      })
    }
    const token = await issuer.mint(session, identityOptions)
    const body = Buffer.isBuffer(req.body) ? req.body : undefined
    reply.hijack()
    proxyHttpRequest(req.raw, reply.raw, target, token, body, deps.auth)
  })

  return app
}

/** Boot the gateway process: config, stores, app, upgrade proxy, lifecycle. */
export async function main(): Promise<void> {
  loadDotEnv('.env')
  const config = loadGatewayConfig(process.env)
  const store = new SessionStore(join(config.dataDir, 'sessions.sqlite'))
  const issuer = new IdentityIssuer(config.dataDir)
  const oidc = new CasdoorOidc({
    issuer: config.casdoorIssuer,
    internalIssuer: config.casdoorInternalIssuer,
    clientId: config.casdoorClientId,
    clientSecret: config.casdoorClientSecret,
    redirectUri: new URL('/casdoor/callback', config.publicUrl),
    organizationClaim: config.organizationClaim,
    rolesClaim: config.rolesClaim,
  })
  // Upstream browser-auth warnings should reach the app logger, but the
  // UpstreamAuth instance must exist before buildApp needs it; the closure
  // forwards once the app (and its logger) exist.
  let logWarn: (message: string, extra?: Record<string, unknown>) => void = () => {}
  const auth = new UpstreamAuth(
    join(config.dataDir, 'webserver-token.json'),
    config.upstream,
    { warn: (message, extra) => { logWarn(message, extra) } },
  )
  const app = buildApp({ config, store, issuer, oidc, auth })
  logWarn = (message, extra) => { app.log.warn(extra ?? {}, message) }
  await app.ready()
  installUpgradeProxy<LoginSession>(app.server, {
    target: { upstream: config.upstream, identityHeader: config.identityHeader },
    auth,
    resolveSession: async headers => {
      const sid = cookieValue(headers, config.cookieName)
      return sid === undefined ? undefined : store.get(sid)
    },
    mint: session => issuer.mint(session, {
      issuer: config.identityIssuer,
      audience: config.identityAudience,
      ttlSec: config.identityTtlSec,
    }),
    onError: error => { app.log.warn({ err: error }, 'websocket upgrade proxy error') },
  })
  await app.listen({ host: config.host, port: config.port })
  app.log.info(
    `dsh-casdoor-gateway: http://${config.host}:${String(config.port)} → ${config.upstream.href} (casdoor ${config.casdoorIssuer.href})`,
  )
  if (config.casdoorInternalIssuer.href !== config.casdoorIssuer.href) {
    app.log.info(
      `casdoor discovery via ${config.casdoorInternalIssuer.href} (browser issuer stays ${config.casdoorIssuer.href})`,
    )
  }
  const purge = setInterval(() => {
    try {
      store.purgeExpired()
    } catch (error) {
      app.log.warn({ err: error }, 'session purge failed')
    }
  }, 60_000)
  purge.unref()
  let closing = false
  const shutdown = (signal: string): void => {
    if (closing) return
    closing = true
    app.log.info({ signal }, 'shutting down')
    void app.close().finally(() => {
      store.close()
      process.exit(0)
    })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
