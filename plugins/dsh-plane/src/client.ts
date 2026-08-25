/**
 * Minimal Plane REST API client: authentication, error mapping, cursor
 * pagination normalization, and work-items path negotiation.
 *
 * Plane moved the issue resource from /issues/ to /work-items/; current cloud
 * and recent self-hosted releases serve work-items, older community editions
 * only issues. The client probes once per activation and caches the working
 * segment, so both generations work through one configuration.
 *
 * @module dsh-plane/client
 */

import type { Config } from './config.ts'

/** Plane API generations that name the issue resource differently. */
const ITEM_SEGMENTS = ['work-items', 'issues'] as const

/** Cap for error-body excerpts embedded in failure messages. */
const ERROR_EXCERPT_LIMIT = 600

/** A Plane API call failed (transport, authentication, or HTTP error status). */
export class PlaneApiError extends Error {
  /** HTTP status when a response arrived; undefined for transport failures. */
  readonly status: number | undefined
  /** The request path that failed, always /api/v1 rooted. */
  readonly path: string

  constructor(message: string, status: number | undefined, path: string) {
    super(message)
    this.name = 'PlaneApiError'
    this.status = status
    this.path = path
  }
}

/** One normalized Plane cursor-paginated envelope. */
export interface Page<T> {
  /** The decoded payload rows in page order. */
  results: T[]
  /** Reported total row count when the server supplies one. */
  totalCount: number | undefined
  /** Cursor for the next page; absent on the last page. */
  nextCursor: string | undefined
  /** Whether the server reports more pages after this one. */
  hasNextPage: boolean
}

/** Shape shared by every Plane cursor envelope; extras stay ignored. */
interface PlaneEnvelope {
  results?: unknown
  total_count?: number
  next_cursor?: string | null
  next_page_results?: boolean
}

/** Query string values; arrays repeat the key per element. */
export type QueryValue = string | number | boolean | undefined | readonly string[]

/** Where the item-resource request points inside one workspace. */
export interface ItemScope {
  /** Workspace slug. */
  workspace: string
  /** Project id; omit for workspace-scoped item endpoints such as search. */
  project?: string
  /** Path below the item segment, e.g. an id, or id/comments; '/' when empty. */
  tail?: string
}

/**
 * HTTP-facing Plane client. One instance per plugin activation; holds the
 * negotiated item segment so the 404 probe happens at most once, and reads
 * its configuration through a live accessor so settings commits reconfigure
 * in-flight activations without a restart.
 */
export class PlaneClient {
  private readonly getConfig: () => Config
  private itemSegment: string | undefined

  constructor(getConfig: () => Config) {
    this.getConfig = getConfig
  }

  /**
   * Issue a request against a /api/v1 rooted path.
   * @param method - HTTP verb.
   * @param path - API path starting with /api/v1, or a suffix appended to it.
   * @param options - query parameters, JSON body, and a cancellation signal.
   * @returns the decoded JSON body (null for 204 or an empty body).
   */
  async request(
    method: string,
    path: string,
    options: { query?: Record<string, QueryValue>; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const apiPath = normalizeApiPath(path)
    const config = this.getConfig()
    if (config.apiKey.length === 0) {
      throw new PlaneApiError(
        'dsh-plane is not configured: set apiKey in the plugin config (or PLANE_API_KEY in the dsh process '
          + 'environment). Create a token in Plane under Profile Settings, Personal Access Tokens.',
        undefined,
        apiPath,
      )
    }
    const timeout = AbortSignal.timeout(config.timeoutMs)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    let response: Response
    try {
      response = await fetch(this.buildUrl(apiPath, options.query), {
        method,
        headers: {
          'X-API-Key': config.apiKey,
          Accept: 'application/json',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal,
      })
    } catch (error) {
      throw new PlaneApiError(
        'Plane request failed before a response arrived (' + describeCause(error) + '): ' + method + ' ' + apiPath,
        undefined,
        apiPath,
      )
    }
    if (!response.ok) throw await httpError(response, method, apiPath)
    if (response.status === 204) return null
    const text = await response.text()
    if (text.trim().length === 0) return null
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new PlaneApiError(
        'Plane returned a non-JSON body for ' + method + ' ' + apiPath + ': ' + excerpt(text),
        response.status,
        apiPath,
      )
    }
  }

  /**
   * Request the issue resource, negotiating the work-items vs issues segment
   * once per activation. A 404 on the first segment retries the second; the
   * first error resurfaces when both miss.
   * @param method - HTTP verb.
   * @param scope - workspace, optional project, and path below the item segment.
   * @param options - query parameters, JSON body, and a cancellation signal.
   * @returns the decoded JSON body.
   */
  async requestItems(
    method: string,
    scope: ItemScope,
    options: { query?: Record<string, QueryValue>; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const segments = this.itemSegment === undefined ? ITEM_SEGMENTS : [this.itemSegment]
    let firstError: unknown
    for (const segment of segments) {
      try {
        const value = await this.request(method, itemPath(segment, scope), options)
        this.itemSegment = segment
        return value
      } catch (error) {
        if (!(error instanceof PlaneApiError) || error.status !== 404) throw error
        firstError ??= error
      }
    }
    throw firstError
  }

  /**
   * Normalize a decoded Plane list payload into a Page regardless of envelope
   * generation (cursor envelope or plain array).
   * @param payload - the decoded list body.
   * @returns the normalized page.
   */
  pageOf(payload: unknown): Page<Record<string, unknown>> {
    if (Array.isArray(payload)) {
      return { results: payload.filter(isRow), totalCount: payload.length, nextCursor: undefined, hasNextPage: false }
    }
    if (!isRow(payload)) {
      throw new PlaneApiError('Plane returned an unexpected list payload', undefined, '/api/v1')
    }
    const rows = Array.isArray(payload.results) ? payload.results.filter(isRow) : []
    const nextCursor = typeof payload.next_cursor === 'string' && payload.next_cursor.length > 0
      ? payload.next_cursor
      : undefined
    return {
      results: rows,
      totalCount: typeof payload.total_count === 'number' ? payload.total_count : undefined,
      nextCursor,
      hasNextPage: payload.next_page_results === true
        || (nextCursor !== undefined && payload.next_page_results === undefined),
    }
  }

  /**
   * Compose the absolute request URL for an API path.
   * @param apiPath - normalized /api/v1 rooted path.
   * @param query - query parameters; undefined and empty-array values are dropped.
   * @returns the full URL.
   */
  private buildUrl(apiPath: string, query: Record<string, QueryValue> | undefined): string {
    const url = new URL(this.getConfig().baseUrl + apiPath)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        url.searchParams.set(key, String(value))
      } else {
        for (const element of value) url.searchParams.append(key, element)
      }
    }
    return url.toString()
  }
}

/**
 * Build the item-resource path for one segment and scope.
 * @param segment - work-items or issues.
 * @param scope - workspace, optional project, and optional tail below the item segment.
 * @returns the rooted API path with a trailing slash.
 */
function itemPath(segment: string, scope: ItemScope): string {
  let path = '/api/v1/workspaces/' + encodeURIComponent(scope.workspace)
  if (scope.project !== undefined && scope.project.length > 0) {
    path += '/projects/' + encodeURIComponent(scope.project)
  }
  path += '/' + segment
  const tail = scope.tail ?? ''
  path += tail.length === 0 ? '/' : tail.startsWith('/') ? tail : '/' + tail
  return path.endsWith('/') ? path : path + '/'
}

/**
 * Root a caller-supplied path under /api/v1, rejecting anything that is not a
 * relative API path.
 * @param path - a path starting with /api/v1, or a suffix to append to it.
 * @returns the normalized slash-joined path.
 */
function normalizeApiPath(path: string): string {
  if (path.includes('://')) {
    throw new PlaneApiError('plane paths are API-relative; absolute URLs are not accepted', undefined, path)
  }
  const rooted = path.startsWith('/api/v1') ? path : '/api/v1' + (path.startsWith('/') ? path : '/' + path)
  const segments: string[] = []
  for (const segment of rooted.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      throw new PlaneApiError('plane paths may not traverse upward', undefined, path)
    }
    segments.push(segment)
  }
  return '/' + segments.join('/') + (path.endsWith('/') ? '/' : '')
}

/**
 * Map one non-2xx response onto a descriptive error.
 * @param response - the failed response with its body still unread.
 * @param method - HTTP verb for the message.
 * @param apiPath - rooted API path for the message.
 * @returns the error to throw.
 */
async function httpError(response: Response, method: string, apiPath: string): Promise<PlaneApiError> {
  const body = await response.text()
  let detail = excerpt(body)
  if (response.status === 401 || response.status === 403) {
    detail = 'Plane rejected the API key (check that it is valid, unexpired, and issued by this instance). ' + detail
  }
  return new PlaneApiError(
    'Plane API ' + response.status + ' on ' + method + ' ' + apiPath + ': ' + detail,
    response.status,
    apiPath,
  )
}

/**
 * Trim an error body to the excerpt limit on one line.
 * @param text - raw body text.
 * @returns the trimmed single-line excerpt.
 */
function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > ERROR_EXCERPT_LIMIT ? flat.slice(0, ERROR_EXCERPT_LIMIT) + '…' : flat
}

/**
 * Describe a transport failure cause without leaking stack noise.
 * @param error - the thrown fetch error.
 * @returns a short cause description.
 */
function describeCause(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'timeout'
    if (error.name === 'AbortError') return 'aborted'
    return error.message.slice(0, 200)
  }
  return String(error)
}

/**
 * Narrow one decoded value to a JSON object row.
 * @param value - decoded JSON value.
 * @returns true when the value is a non-null non-array object.
 */
function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
