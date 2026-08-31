/**
 * The /api/v1-compatible router over the local engine: one path-matching
 * surface consumed three ways — in-process by the tools, over HTTP by the
 * webServer mount (X-API-Key guarded), and by contract tests. Path shapes
 * follow the public API: /workspaces/{slug}/projects/... with the work-item
 * resource reachable through both the work-items and legacy issues segments.
 *
 * @module dsh-plane/api/router
 */

import type { PlaneEngine } from '../engine/engine.ts'
import { EngineError } from '../engine/engine.ts'

/** One routed API call. */
export interface RouterRequest {
  /** HTTP verb. */
  method: string
  /** Path below /api/v1, e.g. /workspaces/dsh/projects/ (leading slash optional). */
  path: string
  /** Scalar query parameters (multi-values are not part of the v1 surface). */
  query: Record<string, string | undefined>
  /** Decoded JSON body for POST/PATCH. */
  body: unknown
}

/** One routed API answer. */
export interface RouterResult {
  /** HTTP status to answer with. */
  status: number
  /** Decoded JSON body; null renders an empty response body. */
  body: unknown
}

/** Resource segments naming the work-item resource across API generations. */
const ITEM_SEGMENTS = new Set(['work-items', 'issues'])

/**
 * Create the v1 router bound to one engine.
 * @param engine - the local engine serving the calls.
 * @returns the router's handle function.
 */
export function createV1Router(engine: PlaneEngine): (request: RouterRequest) => RouterResult {
  return request => {
    try {
      return route(engine, request)
    } catch (error) {
      if (error instanceof EngineError) return { status: error.status, body: { error: error.message } }
      return { status: 500, body: { error: error instanceof Error ? error.message : String(error) } }
    }
  }
}

/**
 * Match one request against the v1 surface.
 * @param engine - the local engine.
 * @param request - the routed call.
 * @returns the answer.
 */
function route(engine: PlaneEngine, request: RouterRequest): RouterResult {
  const segments = request.path.split('/').filter(segment => segment.length > 0)
  const method = request.method.toUpperCase()
  const body = asBody(request.body)

  if (segments[0] === 'users' && segments[1] === 'me' && segments.length === 2) {
    return answer(method, { GET: () => engine.me() })
  }
  if (segments[0] !== 'workspaces' || segments.length < 3) return unknownPath(request.path)
  const workspace = engine.workspace(segments[1] ?? '')
  const rest = segments.slice(2)

  if (rest[0] === 'projects-lite' && rest.length === 1) {
    return answer(method, { GET: () => engine.listProjectsLite(workspace.id) })
  }
  if (rest[0] === 'projects') return routeProjects(engine, workspace.id, rest.slice(1), method, request, body)
  if (rest[0] === 'members' && rest.length <= 2) {
    return answer(method, { GET: () => engine.listMembers() })
  }
  if (ITEM_SEGMENTS.has(String(rest[0])) && rest[1] === 'search' && rest.length === 2) {
    return routeSearch(engine, workspace.id, method, request)
  }
  return unknownPath(request.path)
}

/**
 * Route /workspaces/{slug}/projects/... paths.
 * @param engine - the local engine.
 * @param workspaceId - the resolved workspace id.
 * @param rest - segments below projects/.
 * @param method - HTTP verb.
 * @param request - the routed call (query access).
 * @param body - the decoded request body.
 * @returns the answer.
 */
function routeProjects(
  engine: PlaneEngine,
  workspaceId: string,
  rest: string[],
  method: string,
  request: RouterRequest,
  body: Record<string, unknown>,
): RouterResult {
  if (rest.length === 0) {
    return answer(method, {
      GET: () => engine.listProjects(workspaceId, pageQuery(request)),
      POST: () => ({ status: 201, body: engine.createProject(workspaceId, body) }),
    })
  }
  const projectId = rest[0] ?? ''
  if (rest.length === 1) {
    return answer(method, {
      GET: () => engine.getProject(workspaceId, projectId),
      PATCH: () => engine.updateProject(workspaceId, projectId, body),
      DELETE: () => {
        engine.deleteProject(workspaceId, projectId)
        return { status: 204, body: null }
      },
    })
  }
  const child = rest[1] ?? ''
  const childRest = rest.slice(2)

  if (child === 'states') return routeCollection(method, request, body, {
    list: q => engine.listStates(projectId, q),
    create: b => engine.createState(projectId, b),
    itemId: childRest[0],
    get: id => engine.getState(projectId, id),
    update: (id, b) => engine.updateState(projectId, id, b),
    remove: id => engine.deleteState(projectId, id),
  })
  if (child === 'labels') return routeCollection(method, request, body, {
    list: q => engine.listLabels(projectId, q),
    create: b => engine.createLabel(projectId, b),
    itemId: childRest[0],
    get: id => engine.getLabel(projectId, id),
    update: (id, b) => engine.updateLabel(projectId, id, b),
    remove: id => engine.deleteLabel(projectId, id),
  })
  if (child === 'cycles') return routeCycles(engine, method, request, body, projectId, childRest)
  if (child === 'modules') return routeModules(engine, method, request, body, projectId, childRest)
  if (ITEM_SEGMENTS.has(child)) return routeWorkItems(engine, method, request, body, projectId, childRest)
  return unknownPath(request.path)
}

/** One CRUD sub-resource surface handed to the generic collection router. */
interface CollectionRoutes {
  list: (query: ReturnType<typeof pageQuery>) => unknown
  create: (body: Record<string, unknown>) => unknown
  itemId: string | undefined
  get: (id: string) => unknown
  update: (id: string, body: Record<string, unknown>) => unknown
  remove: (id: string) => void
}

/**
 * Route one collection + item detail pair (states, labels).
 * @param method - HTTP verb.
 * @param request - the routed call.
 * @param body - the decoded request body.
 * @param routes - the collection surface.
 * @returns the answer.
 */
function routeCollection(
  method: string,
  request: RouterRequest,
  body: Record<string, unknown>,
  routes: CollectionRoutes,
): RouterResult {
  if (routes.itemId === undefined) {
    return answer(method, {
      GET: () => routes.list(pageQuery(request)),
      POST: () => ({ status: 201, body: routes.create(body) }),
    })
  }
  return answer(method, {
    GET: () => routes.get(routes.itemId ?? ''),
    PATCH: () => routes.update(routes.itemId ?? '', body),
    DELETE: () => {
      routes.remove(routes.itemId ?? '')
      return { status: 204, body: null }
    },
  })
}

/**
 * Route cycles, including cycle-issues membership endpoints.
 * @param engine - the local engine.
 * @param method - HTTP verb.
 * @param request - the routed call.
 * @param body - the decoded request body.
 * @param projectId - the resolved project id.
 * @param rest - segments below cycles/.
 * @returns the answer.
 */
function routeCycles(
  engine: PlaneEngine,
  method: string,
  request: RouterRequest,
  body: Record<string, unknown>,
  projectId: string,
  rest: string[],
): RouterResult {
  if (rest[0] === 'cycles-lite' && rest.length === 1) {
    return answer(method, { GET: () => engine.listCycles(projectId, { perPage: '100', cursor: undefined, orderBy: undefined }) })
  }
  const cycleId = rest[0] ?? ''
  if (rest.length === 1) {
    return answer(method, {
      GET: () => engine.getCycle(projectId, cycleId),
      PATCH: () => engine.updateCycle(projectId, cycleId, body),
      DELETE: () => {
        engine.deleteCycle(projectId, cycleId)
        return { status: 204, body: null }
      },
    })
  }
  if (rest[1] === 'cycle-issues') {
    if (rest.length === 2) {
      return answer(method, {
        POST: () => {
          engine.setCycleMembership(projectId, cycleId, idList(body.issues), false)
          return { status: 201, body: null }
        },
      })
    }
    if (rest.length === 3) {
      return answer(method, {
        DELETE: () => {
          engine.setCycleMembership(projectId, cycleId, [String(rest[2])], true)
          return { status: 204, body: null }
        },
      })
    }
  }
  return answer(method, {
    GET: () => engine.listCycles(projectId, pageQuery(request)),
    POST: () => ({ status: 201, body: engine.createCycle(projectId, body) }),
  })
}

/**
 * Route modules, including module-issues membership endpoints.
 * @param engine - the local engine.
 * @param method - HTTP verb.
 * @param request - the routed call.
 * @param body - the decoded request body.
 * @param projectId - the resolved project id.
 * @param rest - segments below modules/.
 * @returns the answer.
 */
function routeModules(
  engine: PlaneEngine,
  method: string,
  request: RouterRequest,
  body: Record<string, unknown>,
  projectId: string,
  rest: string[],
): RouterResult {
  if (rest.length === 0) {
    return answer(method, {
      GET: () => engine.listModules(projectId, pageQuery(request)),
      POST: () => ({ status: 201, body: engine.createModule(projectId, body) }),
    })
  }
  const moduleId = rest[0] ?? ''
  if (rest[1] === 'module-issues') {
    if (rest.length === 2) {
      return answer(method, {
        POST: () => {
          engine.setModuleMembership(projectId, moduleId, idList(body.issues), false)
          return { status: 201, body: null }
        },
      })
    }
    if (rest.length === 3) {
      return answer(method, {
        DELETE: () => {
          engine.setModuleMembership(projectId, moduleId, [String(rest[2])], true)
          return { status: 204, body: null }
        },
      })
    }
  }
  return answer(method, {
    GET: () => engine.getModule(projectId, moduleId),
    PATCH: () => engine.updateModule(projectId, moduleId, body),
    DELETE: () => {
      engine.deleteModule(projectId, moduleId)
      return { status: 204, body: null }
    },
  })
}

/**
 * Route work items: list, create, detail, comments, links, and search.
 * @param engine - the local engine.
 * @param method - HTTP verb.
 * @param request - the routed call.
 * @param body - the decoded request body.
 * @param projectId - the resolved project id.
 * @param rest - segments below the item segment.
 * @returns the answer.
 */
function routeWorkItems(
  engine: PlaneEngine,
  method: string,
  request: RouterRequest,
  body: Record<string, unknown>,
  projectId: string,
  rest: string[],
): RouterResult {
  if (rest.length === 0) {
    return answer(method, {
      GET: () => engine.listWorkItems(projectId, pageQuery(request)),
      POST: () => ({ status: 201, body: engine.createWorkItem(projectId, body) }),
    })
  }
  if (rest[0] === 'search' && rest.length === 1) {
    const workspaceId = engine.projectById(projectId).workspaceId
    return routeSearch(engine, workspaceId, method, request, projectId)
  }
  const itemId = rest[0] ?? ''
  if (rest.length === 1) {
    return answer(method, {
      GET: () => engine.getWorkItem(projectId, itemId),
      PATCH: () => engine.updateWorkItem(projectId, itemId, body),
      DELETE: () => {
        engine.deleteWorkItem(projectId, itemId)
        return { status: 204, body: null }
      },
    })
  }
  if (rest[1] === 'comments') {
    if (rest.length === 2) {
      return answer(method, {
        GET: () => engine.listComments(projectId, itemId, pageQuery(request)),
        POST: () => ({ status: 201, body: engine.createComment(projectId, itemId, body) }),
      })
    }
  }
  if (rest[1] === 'links') {
    if (rest.length === 2) {
      return answer(method, {
        GET: () => engine.listLinks(projectId, itemId),
        POST: () => ({ status: 201, body: engine.createLink(projectId, itemId, body) }),
      })
    }
    if (rest.length === 3) {
      return answer(method, {
        DELETE: () => {
          engine.deleteLink(projectId, itemId, String(rest[2]))
          return { status: 204, body: null }
        },
      })
    }
  }
  return unknownPath(request.path)
}

/**
 * Route the workspace-level work-item search endpoint.
 * @param engine - the local engine.
 * @param workspaceId - the resolved workspace id.
 * @param method - HTTP verb.
 * @param request - the routed call.
 * @param projectId - the project to scope the search to, if any.
 * @returns the answer.
 */
function routeSearch(engine: PlaneEngine, workspaceId: string, method: string, request: RouterRequest, projectId?: string): RouterResult {
  const scoped = projectId ?? request.query.project_id
  const results = engine.search(workspaceId, {
    text: request.query.search ?? '',
    projectId: scoped === undefined || scoped.length === 0 ? undefined : scoped,
    limit: Math.max(1, Math.min(100, numberOr(request.query.limit, 25))),
  })
  return answer(method, {
    GET: () => ({
      total_count: results.length,
      next_cursor: null,
      prev_cursor: null,
      next_page_results: false,
      prev_page_results: false,
      count: results.length,
      total_pages: 1,
      total_results: results.length,
      results,
    }),
  })
}

/** Per-method handlers for one matched route. */
type MethodHandlers = Partial<Record<'GET' | 'POST' | 'PATCH' | 'DELETE', () => unknown | RouterResult>>

/**
 * Dispatch one matched route by method, defaulting missing verbs to 405 and
 * honoring handlers that return a full RouterResult (status overrides).
 * @param method - the HTTP verb.
 * @param handlers - the matched route's per-method handlers.
 * @returns the answer.
 */
function answer(method: string, handlers: MethodHandlers): RouterResult {
  const handler = handlers[method as keyof MethodHandlers]
  if (handler === undefined) return { status: 405, body: { error: 'method not allowed: ' + method } }
  const value = handler()
  if (isResult(value)) return value
  return { status: 200, body: value }
}

/**
 * Narrow one value to a full RouterResult.
 * @param value - a handler return.
 * @returns true when the value is a RouterResult.
 */
function isResult(value: unknown): value is RouterResult {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value
}

/**
 * Extract the shared pagination keys from one request's query.
 * @param request - the routed call.
 * @returns the page query.
 */
function pageQuery(request: RouterRequest): { perPage: string | undefined, cursor: string | undefined, orderBy: string | undefined } {
  return { perPage: request.query.per_page, cursor: request.query.cursor, orderBy: request.query.order_by }
}

/**
 * Read one numeric query value with a default.
 * @param raw - the raw query string.
 * @param fallback - the default when missing or malformed.
 * @returns the number.
 */
function numberOr(raw: string | undefined, fallback: number): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
  return Number.isInteger(parsed) ? parsed : fallback
}

/**
 * Narrow one request body to an object, rejecting scalars with 400.
 * @param body - the decoded body.
 * @returns the object body.
 */
function asBody(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {}
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new EngineError('request body must be a JSON object', 400)
  }
  return body as Record<string, unknown>
}

/**
 * Narrow one body field to a string array.
 * @param value - the raw body value.
 * @returns the string list.
 */
function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

/**
 * The 404 answer for unmatched paths.
 * @param path - the requested path.
 * @returns the answer.
 */
function unknownPath(path: string): RouterResult {
  return {
    status: 404,
    body: { error: 'no such endpoint in the dsh-plane local engine: ' + path + ' (the v1 surface covers work items, projects, states, labels, cycles, modules, members, and users/me)' },
  }
}
