/**
 * Read-only web routes for the plane sidebar panel and the settings card's
 * connection hints. Mounted through dynamic webServer inject (sentinel
 * pattern), so headless profiles without a webServer service still load the
 * tools. The server holds the API key; the browser never sees it.
 *
 * @module dsh-plane/routes
 */

import { PlaneClient, PlaneApiError } from './client.ts'
import type { Config } from './config.ts'

/** Connection-status route the settings card and panel both read. */
export const STATE_PATH = '/plugins/dsh-plane/state'

/** Panel-data route: projects plus one page of the selected project's work items. */
export const PANEL_PATH = '/plugins/dsh-plane/panel'

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
  register(route: { kind: 'exact', path: string, handler: (req: PlaneIncomingMessage, res: PlaneServerResponse) => void }): () => void
}

/** Minimal Node http shapes the handlers use. */
export interface PlaneIncomingMessage {
  method?: string | undefined
  url?: string | undefined
}

/** Minimal Node http ServerResponse the handlers use. */
export interface PlaneServerResponse {
  writeHead(status: number, headers: Record<string, string>): void
  end(body: string): void
}

/** A JSON-responding helper over the raw handler pair. */
type JsonHandler = (query: URLSearchParams) => Record<string, unknown> | Promise<Record<string, unknown>>

/**
 * Mount the plane routes on one webServer.
 * @param webServer - the host webServer service.
 * @param getConfig - live config accessor (settings-resolved when attached).
 * @returns the disposer unregistering every route.
 */
export function mountPlaneRoutes(webServer: PlaneWebServer, getConfig: () => Config): () => void {
  let cache: ProjectCache | undefined
  const stopState = webServer.register({ kind: 'exact', path: STATE_PATH, handler: json(() => stateHandler(getConfig)) })
  const stopPanel = webServer.register({ kind: 'exact', path: PANEL_PATH, handler: json(query => panelHandler(query, getConfig, () => {
    if (cache !== undefined && Date.now() - cache.at < PROJECT_CACHE_MS) return cache
    return undefined
  }, next => { cache = next })) })
  return () => {
    stopState()
    stopPanel()
  }
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
 * Compose the connection-status payload: cheap, no network.
 * @param getConfig - live config accessor.
 * @returns the state payload.
 */
function stateHandler(getConfig: () => Config): Record<string, unknown> {
  const config = getConfig()
  return {
    ok: true,
    configured: config.apiKey.length > 0,
    baseUrl: config.baseUrl,
    workspace: config.workspaceSlug,
    defaultProjectId: config.defaultProjectId,
  }
}

/**
 * Compose the panel payload: projects plus one page of the selected project's
 * work items, both through the live-config client.
 * @param query - panel query: projectId, cursor.
 * @param getConfig - live config accessor.
 * @param readCache - projects cache read.
 * @param writeCache - projects cache write.
 * @returns the panel payload.
 */
async function panelHandler(
  query: URLSearchParams,
  getConfig: () => Config,
  readCache: () => ProjectCache | undefined,
  writeCache: (next: ProjectCache) => void,
): Promise<Record<string, unknown>> {
  const config = getConfig()
  const client = new PlaneClient(() => config)
  if (config.apiKey.length === 0) {
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
  if (projectId.length > 0) {
    try {
      const payload = await client.requestItems('GET', { workspace: config.workspaceSlug, project: projectId }, {
        query: { per_page: ISSUE_LIMIT, order_by: '-created_at', ...(cursor === undefined ? {} : { cursor }) },
      })
      const page = client.pageOf(payload)
      issues = page.results.map(issueRow)
      totalCount = page.totalCount
      nextCursor = page.nextCursor
    } catch (error) {
      issueError = describeError(error)
    }
  }
  return {
    ok: true,
    baseUrl: config.baseUrl,
    workspace: config.workspaceSlug,
    projects: projects.projects,
    projectId,
    issues,
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