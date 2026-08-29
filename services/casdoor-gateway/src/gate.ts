/**
 * Request-gate decisions: auth-plane whitelist, browser-vs-API unauthenticated
 * behavior, privileged-method detection, admin check, and returnTo hardening.
 *
 * @module dsh-casdoor-gateway/gate
 */

import type { LoginSession } from './sessions.js'

/** Exact paths the gateway answers itself, before any session check. */
export const AUTH_PLANE_PATHS: ReadonlySet<string> = new Set([
  '/healthz',
  '/.well-known/jwks.json',
  '/login',
  '/casdoor/callback',
  '/logout',
])

export function isAuthPlanePath(pathname: string): boolean {
  return AUTH_PLANE_PATHS.has(pathname)
}

/**
 * Normalize a user-supplied returnTo into a safe same-origin path.
 * Only site-relative, single-slash, non-backslash paths survive; anything
 * else (absolute URLs, protocol-relative, encoded tricks) becomes '/'.
 */
export function safeReturnTo(raw: string | undefined): string {
  if (typeof raw !== 'string' || raw.length === 0) return '/'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || raw.includes('\\')) {
    return '/'
  }
  try {
    // Reject anything that carries scheme/host semantics through a WHATWG parse.
    const parsed = new URL(raw, 'http://gateway.invalid')
    if (parsed.origin !== 'http://gateway.invalid') return '/'
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return '/'
  }
}

/**
 * Whether an unauthenticated request should be answered with a login
 * redirect (browser navigation) instead of a bare 401 (API/fetch client).
 * Browsers send `Accept: text/html...` on navigations only; fetch/XHR from
 * the SPA does not (its rpc layer throws on non-200 either way, and the
 * tapIndex-injected watcher turns the 401 into a redirect client-side).
 */
export function wantsHtml(method: string | undefined, accept: string | undefined): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false
  return typeof accept === 'string' && accept.includes('text/html')
}

const API_METHOD_PATTERN = /^\/api\/([A-Za-z0-9_$.-]+)$/

/**
 * The /api RPC method a request targets, when it names a privileged one.
 * The stock carrier is POST-only, so non-POST never matches (mirrors the
 * host's own dispatch).
 */
export function privilegedMethodOf(
  pathname: string,
  method: string | undefined,
  privileged: ReadonlySet<string>,
): string | undefined {
  if (method !== 'POST') return undefined
  const match = pathname.match(API_METHOD_PATTERN)
  const rpcMethod = match?.[1]
  if (rpcMethod === undefined || !privileged.has(rpcMethod)) return undefined
  return rpcMethod
}

/** Whether the session's casdoor roles intersect the configured admin roles. */
export function isAdmin(session: LoginSession, adminRoles: readonly string[]): boolean {
  return session.roles.some(role => adminRoles.includes(role))
}
