/**
 * Read-only web routes for the plane sidebar panel and the settings card's
 * connection hints. Mounted through dynamic webServer inject (sentinel
 * pattern), so headless profiles without a webServer service still load the
 * tools. The server holds the API key; the browser never sees it.
 *
 * @module dsh-plane/routes
 */

import { PlaneApiError } from './client.ts'
import type { PlaneBackend } from './backend.ts'
import { createV1Router } from './api/router.ts'
import type { RouterRequest, RouterResult } from './api/router.ts'
import { keyMatches } from './engine/key.ts'
import type { PlaneEngine } from './engine/engine.ts'
import type { Config } from './config.ts'

/** Connection-status route the settings card and panel both read. */
export const STATE_PATH = '/plugins/dsh-plane/state'

/** Panel-data route: projects plus one page of the selected project's work items. */
export const PANEL_PATH = '/plugins/dsh-plane/panel'

/** X-API-Key-guarded v1-compatible surface external tools (SDKs, MCP servers) call. */
export const API_PREFIX = '/plugins/dsh-plane/api/'

/** Same-origin engine surface the browser half calls (no key in the browser). */
export const UI_PREFIX = '/plugins/dsh-plane/ui/'

/** Where the standalone board page lives (M6). */
export const APP_PATH = '/plugins/dsh-plane/app'

/** How long the project list stays fresh before the next panel load refetches it. */
const PROJECT_CACHE_MS = 60_000

/** Projects per panel load. */
const PROJECT_LIMIT = 30

/** Work items per panel page. */
const ISSUE_LIMIT = 25

/** One cached project-list answer. */
interface ProjectCache {
  at: number
  workspace: string
  projects: { id: string, name: string, identifier: string }[]
  error: string | undefined
}

/** The webServer registration surface the routes mount through. */
export interface PlaneWebServer {
  register(route:
    | { kind: 'exact', path: string, handler: (req: PlaneIncomingMessage, res: PlaneServerResponse) => void }
    | { kind: 'prefix', path: string, handler: (req: PlaneIncomingMessage, res: PlaneServerResponse) => void }): () => void
}

/** Minimal Node http shapes the handlers use. */
export interface PlaneIncomingMessage extends NodeJS.ReadableStream {
  method?: string | undefined
  url?: string | undefined
  headers?: Record<string, string | string[] | undefined> | undefined
}

/** Minimal Node http ServerResponse the handlers use. */
export interface PlaneServerResponse {
  writeHead(status: number, headers: Record<string, string>): void
  end(body: string): void
}

/** A JSON-responding helper over the raw handler pair. */
type JsonHandler = (query: URLSearchParams) => Record<string, unknown> | Promise<Record<string, unknown>>

/**
 * Mount the plane routes on one webServer: state + panel (exact), the
 * v1-compatible API behind X-API-Key and the keyless same-origin ui surface
 * (prefix) when a local engine accessor is supplied.
 * @param webServer - the host webServer service.
 * @param getConfig - live config accessor (settings-resolved when attached).
 * @param getBackend - live backend factory (local engine or remote client).
 * @param getEngine - optional local engine accessor for the HTTP surfaces.
 * @returns the disposer unregistering every route.
 */
export function mountPlaneRoutes(
  webServer: PlaneWebServer,
  getConfig: () => Config,
  getBackend: () => PlaneBackend | Promise<PlaneBackend>,
  getEngine?: (() => Promise<PlaneEngine>) | undefined,
): () => void {
  let cache: ProjectCache | undefined
  const stopState = webServer.register({ kind: 'exact', path: STATE_PATH, handler: json(() => stateHandler(getConfig, getEngine)) })
  const stopPanel = webServer.register({ kind: 'exact', path: PANEL_PATH, handler: json(query => panelHandler(query, getConfig, getBackend, () => {
    if (cache !== undefined && Date.now() - cache.at < PROJECT_CACHE_MS) return cache
    return undefined
  }, next => { cache = next })) })
  const stops: (() => void)[] = [stopState, stopPanel]
  if (getEngine !== undefined) {
    stops.push(webServer.register({ kind: 'prefix', path: API_PREFIX, handler: engineSurfaceHandler(getEngine, true) }))
    stops.push(webServer.register({ kind: 'prefix', path: UI_PREFIX, handler: engineSurfaceHandler(getEngine, false) }))
    stops.push(webServer.register({ kind: 'prefix', path: APP_PATH, handler: appPageHandler() }))
  }
  return () => {
    for (const stop of stops) stop()
  }
}

/**
 * Serve the standalone board page: the HTML shell on the page path and the
 * bundled script one suffix over. The bundle is read once per activation.
 * @returns the raw webServer handler.
 */
function appPageHandler(): (req: PlaneIncomingMessage, res: PlaneServerResponse) => void {
  let script: string | undefined
  const readScript = async (): Promise<string> => {
    if (script !== undefined) return script
    const { readFile } = await import('node:fs/promises')
    const { URL } = await import('node:url')
    const fileUrl = new URL('./app.js', import.meta.url)
    script = await readFile(fileUrl, 'utf8')
    return script
  }
  return (req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const isScript = url.pathname === APP_PATH + '.js'
        const body = isScript ? await readScript() : APP_HTML
        res.writeHead(200, { 'content-type': isScript ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(body)
      } catch (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('dsh-plane board failed to load: ' + describeError(error))
      }
    })()
  }
}

/** The board page's HTML shell. */
const APP_HTML = '<!doctype html>' +
  '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>Plane board</title><style>html,body{margin:0;padding:0}</style></head>' +
  '<body><div id="root"></div><script src="/plugins/dsh-plane/app.js"></script></body></html>'

/**
 * Build one prefix handler routing requests into the engine's v1 router,
 * optionally guarding them with the engine's X-API-Key.
 * @param getEngine - local engine accessor.
 * @param guarded - whether the surface requires the X-API-Key header.
 * @returns the raw webServer handler.
 */
function engineSurfaceHandler(getEngine: () => Promise<PlaneEngine>, guarded: boolean): (req: PlaneIncomingMessage, res: PlaneServerResponse) => void {
  return (req, res) => {
    void (async () => {
      try {
        const engine = await getEngine()
        const router = createV1Router(engine)
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        const prefix = guarded ? API_PREFIX : UI_PREFIX
        const subPath = url.pathname.slice(url.pathname.indexOf(prefix) + prefix.length).replace(/^v1/, '')
        if (guarded) {
          const presented = header(req, 'x-api-key')
          if (!keyMatches(presented, engine.apiKey)) {
            respond(res, 401, { error: 'invalid or missing X-API-Key for the dsh-plane local engine' })
            return
          }
        }
        const body = await readJsonBody(req)
        const result: RouterResult = router({
          method: (req.method ?? 'GET').toUpperCase(),
          path: subPath,
          query: scalarQuery(url.searchParams),
          body,
        })
        respond(res, result.status, result.body)
      } catch (error) {
        respond(res, 500, { error: describeError(error) })
      }
    })()
  }
}

/**
 * Read one header value case-insensitively.
 * @param req - the incoming request.
 * @param name - the lowercase header name.
 * @returns the first value or undefined.
 */
function header(req: PlaneIncomingMessage, name: string): string | undefined {
  const value = req.headers?.[name]
  return Array.isArray(value) ? value[0] : value
}

/**
 * Read and decode one JSON request body (empty bodies decode to undefined).
 * @param req - the incoming request stream.
 * @returns the decoded body.
 */
async function readJsonBody(req: PlaneIncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer)
    if (chunks.reduce((total, entry) => total + entry.length, 0) > 1_000_000) {
      throw new Error('request body too large (1 MiB cap)')
    }
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/**
 * Collect single-value query parameters.
 * @param params - the parsed query string.
 * @returns the scalar query record.
 */
function scalarQuery(params: URLSearchParams): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [key, value] of params.entries()) out[key] ??= value
  return out
}

/**
 * Write one JSON answer.
 * @param res - the response.
 * @param status - the HTTP status.
 * @param body - the decoded body (null renders an empty body).
 */
function respond(res: PlaneServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body === null || body === undefined ? '' : JSON.stringify(body))
}

/**
 * Wrap one JSON handler with method parsing and error containment.
 * @param handler - the query-to-payload handler.
 * @returns a raw webServer handler.
 */
function json(handler: JsonHandler): (req: PlaneIncomingMessage, res: PlaneServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    Promise.resolve(handler(url.searchParams)).then(
      payload => {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(payload))
      },
      error => {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: describeError(error) }))
      },
    )
  }
}

/**
 * Compose the connection-status payload: cheap, no network; on the local
 * backend it also carries the engine's key and row counts for the card.
 * @param getConfig - live config accessor.
 * @param getEngine - optional local engine accessor.
 * @returns the state payload.
 */
async function stateHandler(getConfig: () => Config, getEngine?: (() => Promise<PlaneEngine>) | undefined): Promise<Record<string, unknown>> {
  const config = getConfig()
  const base: Record<string, unknown> = {
    ok: true,
    backend: config.backend,
    configured: config.backend === 'local' || config.apiKey.length > 0,
    baseUrl: config.baseUrl,
    workspace: config.workspaceSlug,
    defaultProjectId: config.defaultProjectId,
  }
  if (config.backend === 'local' && getEngine !== undefined) {
    try {
      const engine = await getEngine()
      base.engine = { ...engine.health(), apiKey: engine.apiKey }
    } catch (error) {
      base.engineError = describeError(error)
    }
  }
  return base
}

/**
 * Compose the panel payload: projects plus one page of the selected project's
 * work items, through the live-config backend.
 * @param query - panel query: projectId, cursor.
 * @param getConfig - live config accessor.
 * @param getBackend - live backend factory.
 * @param readCache - projects cache read.
 * @param writeCache - projects cache write.
 * @returns the panel payload.
 */
async function panelHandler(
  query: URLSearchParams,
  getConfig: () => Config,
  getBackend: () => PlaneBackend | Promise<PlaneBackend>,
  readCache: () => ProjectCache | undefined,
  writeCache: (next: ProjectCache) => void,
): Promise<Record<string, unknown>> {
  const config = getConfig()
  const client = await getBackend()
  if (config.backend === 'remote' && config.apiKey.length === 0) {
    return { ok: false, error: 'not-configured', baseUrl: config.baseUrl }
  }
  if (config.workspaceSlug.trim().length === 0) {
    return { ok: false, error: 'no-workspace' }
  }
  let projects: ProjectCache | undefined = readCache()
  if (projects === undefined) {
    const payload = await client.request('GET', '/workspaces/' + encodeURIComponent(config.workspaceSlug) + '/projects/', {
      query: { per_page: PROJECT_LIMIT, order_by: '-created_at' },
    })
    const rows = client.pageOf(payload).results
    projects = {
      at: Date.now(),
      workspace: config.workspaceSlug,
      projects: rows.map(row => ({
        id: String(row.id ?? ''),
        name: String(row.name ?? ''),
        identifier: typeof row.identifier === 'string' ? row.identifier : '',
      })).filter(row => row.id.length > 0),
      error: undefined,
    }
    writeCache(projects)
  }
  const requested = query.get('projectId') ?? ''
  const projectId = requested.length > 0
    ? requested
    : config.defaultProjectId.trim().length > 0 ? config.defaultProjectId.trim() : projects.projects[0]?.id ?? ''
  const cursor = query.get('cursor') ?? undefined
  let issues: Record<string, unknown>[] = []
  let issueError: string | undefined
  let totalCount: number | undefined
  let nextCursor: string | undefined
  let states: { id: string, name: string, group: string }[] = []
  if (projectId.length > 0) {
    try {
      const payload = await client.requestItems('GET', { workspace: config.workspaceSlug, project: projectId }, {
        query: { per_page: ISSUE_LIMIT, order_by: '-created_at', ...(cursor === undefined ? {} : { cursor }) },
      })
      const page = client.pageOf(payload)
      issues = page.results.map(issueRow)
      totalCount = page.totalCount
      nextCursor = page.nextCursor
      if (cursor === undefined) {
        const statePayload = await client.request(
          'GET',
          '/workspaces/' + encodeURIComponent(config.workspaceSlug) + '/projects/' + encodeURIComponent(projectId) + '/states/',
          { query: { per_page: 100 } },
        )
        states = client.pageOf(statePayload).results
          .map(row => ({ id: String(row.id ?? ''), name: String(row.name ?? ''), group: String(row.group ?? '') }))
          .filter(row => row.id.length > 0)
      }
    } catch (error) {
      issueError = describeError(error)
    }
  }
  return {
    ok: true,
    backend: config.backend,
    baseUrl: config.baseUrl,
    workspace: config.workspaceSlug,
    projects: projects.projects,
    projectId,
    issues,
    states,
    ...(totalCount === undefined ? {} : { totalCount }),
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...(issueError === undefined ? {} : { issueError }),
    fetchedAt: Date.now(),
  }
}

/**
 * Project one Plane work-item row for the panel list.
 * @param row - the decoded Plane row.
 * @returns the panel row.
 */
function issueRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id ?? ''),
    identifier: typeof row.identifier === 'string' ? row.identifier : '',
    name: String(row.name ?? ''),
    priority: typeof row.priority === 'string' ? row.priority : 'none',
    state: nestedName(row.state),
    stateId: typeof row.state === 'string' ? row.state : '',
    assignees: Array.isArray(row.assignees) ? row.assignees.map(nestedName).filter(name => name.length > 0) : [],
    targetDate: typeof row.target_date === 'string' ? row.target_date : undefined,
  }
}

/**
 * Extract a display name from a nested relation value.
 * @param value - relation value from a Plane row.
 * @returns the display name, the id, or the empty string.
 */
function nestedName(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const row = value as Record<string, unknown>
    for (const key of ['display_name', 'name', 'id']) {
      if (typeof row[key] === 'string') return row[key] as string
    }
  }
  return ''
}

/**
 * Describe one thrown error on one line.
 * @param error - the thrown value.
 * @returns a short message.
 */
function describeError(error: unknown): string {
  if (error instanceof PlaneApiError) return error.message
  return error instanceof Error ? error.message : String(error)
}