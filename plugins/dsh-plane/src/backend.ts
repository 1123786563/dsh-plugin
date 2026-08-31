/**
 * The backend seam between the tools and either Plane flavor: the in-process
 * engine (local) or an origin-speaking REST client (remote, Plane Cloud or a
 * self-hosted instance). Both expose request/requestItems/pageOf with the
 * same semantics, so every tool works unchanged against either.
 *
 * @module dsh-plane/backend
 */

import { normalizeApiPath, normalizePlanePage, itemPath } from './client.ts'
import type { ItemScope, Page, QueryValue } from './client.ts'
import { PlaneApiError } from './client.ts'
import type { RouterRequest, RouterResult } from './api/router.ts'

/** The request surface every plane_* tool talks to. */
export interface PlaneBackend {
  /**
   * Issue one request against a /api/v1 rooted path.
   * @param method - HTTP verb.
   * @param path - API path starting with /api/v1, or a suffix appended to it.
   * @param options - query parameters, JSON body, and a cancellation signal.
   * @returns the decoded JSON body (null for 204 or an empty body).
   */
  request(
    method: string,
    path: string,
    options?: { query?: Record<string, QueryValue>; body?: unknown; signal?: AbortSignal },
  ): Promise<unknown>

  /**
   * Request the work-item resource, scoped like PlaneClient.requestItems.
   * @param method - HTTP verb.
   * @param scope - workspace, optional project, and path below the item segment.
   * @param options - query parameters, JSON body, and a cancellation signal.
   * @returns the decoded JSON body.
   */
  requestItems(
    method: string,
    scope: ItemScope,
    options?: { query?: Record<string, QueryValue>; body?: unknown; signal?: AbortSignal },
  ): Promise<unknown>

  /**
   * Normalize a decoded list payload into a Page.
   * @param payload - the decoded list body.
   * @returns the normalized page.
   */
  pageOf(payload: unknown): Page<Record<string, unknown>>
}

/**
 * The local backend: routes requests through the in-process v1 router. No
 * sockets, no authentication — the caller is the trusted host process; the
 * HTTP mount applies X-API-Key checks before handing requests here.
 */
export class LocalBackend implements PlaneBackend {
  private readonly router: (request: RouterRequest) => RouterResult

  constructor(router: (request: RouterRequest) => RouterResult) {
    this.router = router
  }

  async request(
    method: string,
    path: string,
    options: { query?: Record<string, QueryValue>; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const apiPath = normalizeApiPath(path)
    if (options.signal?.aborted) throw new PlaneApiError('aborted before dispatch', undefined, apiPath)
    const result = this.router({
      method,
      path: stripPrefix(apiPath),
      query: stringifyQuery(options.query),
      body: options.body,
    })
    if (result.status >= 400) {
      throw new PlaneApiError(
        'Plane API ' + result.status + ' on ' + method + ' ' + apiPath + ': ' + describeBody(result.body),
        result.status,
        apiPath,
      )
    }
    return result.body
  }

  async requestItems(
    method: string,
    scope: ItemScope,
    options: { query?: Record<string, QueryValue>; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    return this.request(method, itemPath('work-items', scope), options)
  }

  pageOf(payload: unknown): Page<Record<string, unknown>> {
    return normalizePlanePage(payload)
  }
}

/**
 * Strip the /api/v1 prefix the router does not expect.
 * @param apiPath - a normalized /api/v1 rooted path.
 * @returns the path below /api/v1.
 */
function stripPrefix(apiPath: string): string {
  return apiPath.replace(/^\/api\/v1/, '')
}

/**
 * Narrow backend query values to the router's scalar strings.
 * @param query - the caller's query record.
 * @returns scalar query strings.
 */
function stringifyQuery(query: Record<string, QueryValue> | undefined): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue
    if (typeof value === 'string') out[key] = value
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value)
    else out[key] = value.join(',')
  }
  return out
}

/**
 * Describe one error body on a single line.
 * @param body - the router's error body.
 * @returns the trimmed description.
 */
function describeBody(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    return String((body as Record<string, unknown>).error)
  }
  return JSON.stringify(body)
}
