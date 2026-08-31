/**
 * Panel routes: registration shape, JSON error containment, and the panel
 * payload's config-failure paths, against stubbed fetch.
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { mountPlaneRoutes, PANEL_PATH, STATE_PATH } from '../src/routes.ts'
import type { PlaneIncomingMessage, PlaneServerResponse } from '../src/routes.ts'
import { PlaneClient } from '../src/client.ts'
import { LocalBackend } from '../src/backend.ts'
import { createV1Router } from '../src/api/router.ts'
import { openEngine } from '../src/engine/engine.ts'
import { JsonStore, MemoryStoreAdapter } from '../src/engine/store.ts'
import { resolveConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'

/** One captured route registration. */
interface Registration {
  kind: string
  path: string
  handler: (req: PlaneIncomingMessage, res: PlaneServerResponse) => void
}

/** Build a response recorder carrying its own live status and body. */
function res(): PlaneServerResponse & { status: number, body: string } {
  const recorder = { status: 0, body: '' } as PlaneServerResponse & { status: number, body: string }
  recorder.writeHead = (status: number): void => { recorder.status = status }
  recorder.end = (body: string): void => { recorder.body = body }
  return recorder
}

/** Install a fetch stub serving one response per ordered call. */
function stubFetch(responses: { status?: number, body?: string }[]): unknown[] {
  const calls: unknown[] = []
  let index = 0
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: unknown) => {
    calls.push({ input, init })
    const route = responses[index]
    index += 1
    return new Response(route?.body ?? '', { status: route?.status ?? 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Mount the routes over one remote-client config, recording registrations.
 * @param registrations - the collector for registered routes.
 * @param raw - the partial config to resolve per read.
 * @returns the disposer unregistering every route.
 */
function mountRemote(registrations: Registration[], raw: Partial<Config>): () => void {
  const getConfig = (): Config => resolveConfig({ backend: 'remote', ...raw })
  return mountPlaneRoutes(
    {
      register: route => {
        registrations.push(route as Registration)
        return () => {
          const at = registrations.indexOf(route as Registration)
          if (at >= 0) registrations.splice(at, 1)
        }
      },
    },
    getConfig,
    () => new PlaneClient(getConfig),
  )
}

/** Drive one registered handler with a query string; the recorder is live. */
function fire(registrations: Registration[], path: string, query = ''): PlaneServerResponse & { status: number, body: string } {
  return fireRaw(registrations, path, query)
}

/**
 * Drive one prefix-matched handler with method, headers, and a JSON body.
 * @param registrations - registered routes.
 * @param path - the request path (prefix-matched from the tail).
 * @param method - HTTP verb.
 * @param headers - request headers.
 * @param body - JSON body to stream.
 * @returns the live response recorder.
 */
function fireRaw(
  registrations: Registration[],
  path: string,
  query = '',
  method = 'GET',
  headers: Record<string, string> = {},
  body?: string,
): PlaneServerResponse & { status: number, body: string } {
  const registration = registrations.find(entry => path.startsWith(entry.path))
  if (registration === undefined) throw new Error('route not registered: ' + path)
  const recorder = res()
  const stream: NodeJS.ReadableStream = {
    [Symbol.asyncIterator]: async function* () {
      if (body !== undefined) yield body
    },
  }
  registration.handler({ ...stream, method, url: '/x' + path + query, headers }, recorder)
  return recorder
}

describe('mountPlaneRoutes', () => {
  it('registers exactly the state and panel routes and unregisters on dispose', () => {
    const registrations: Registration[] = []
    const dispose = mountRemote(registrations, { apiKey: 'k', workspaceSlug: 'team' })
    expect(registrations.map(entry => entry.path).sort()).toEqual([PANEL_PATH, STATE_PATH])
    dispose()
    expect(registrations).toHaveLength(0)
  })

  it('serves connection state without touching the network', async () => {
    const registrations: Registration[] = []
    mountRemote(registrations, { apiKey: 'k', workspaceSlug: 'team' })
    const calls = stubFetch([])
    const outcome = fire(registrations, STATE_PATH)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(outcome.status).toBe(200)
    expect(JSON.parse(outcome.body)).toEqual({
      ok: true,
      backend: 'remote',
      configured: true,
      baseUrl: 'https://api.plane.so',
      workspace: 'team',
      defaultProjectId: '',
    })
    expect(calls).toHaveLength(0)
  })

  it('answers not-configured without a network call', async () => {
    const registrations: Registration[] = []
    mountRemote(registrations, {})
    stubFetch([])
    const outcome = fire(registrations, PANEL_PATH)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const payload = JSON.parse(outcome.body) as { ok: boolean, error: string }
    expect(payload.ok).toBe(false)
    expect(payload.error).toBe('not-configured')
  })

  it('answers no-workspace when only the key is set', async () => {
    const registrations: Registration[] = []
    mountRemote(registrations, { apiKey: 'k' })
    stubFetch([])
    const outcome = fire(registrations, PANEL_PATH)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(JSON.parse(outcome.body)).toEqual({ ok: false, error: 'no-workspace' })
  })

  it('serves projects plus the first project page, caching the project list', async () => {
    const registrations: Registration[] = []
    mountRemote(registrations, { apiKey: 'k', workspaceSlug: 'team' })
    const calls = stubFetch([
      { body: JSON.stringify({ results: [{ id: 'p1', name: 'Core', identifier: 'CORE' }] }) },
      { body: JSON.stringify({ results: [{ id: 'i1', identifier: 'CORE-1', name: 'Fix', priority: 'high', state: { id: 's', name: 'In Progress' }, assignees: [] }], next_cursor: '20:1:0' }) },
    ])
    const outcome = fire(registrations, PANEL_PATH)
    await new Promise(resolve => { setTimeout(resolve, 20) })
    const payload = JSON.parse(outcome.body) as Record<string, unknown>
    expect(payload.ok).toBe(true)
    expect(payload.projectId).toBe('p1')
    expect(payload.projects).toEqual([{ id: 'p1', name: 'Core', identifier: 'CORE' }])
    expect(payload.issues).toEqual([{ id: 'i1', identifier: 'CORE-1', name: 'Fix', priority: 'high', state: 'In Progress', stateId: '', assignees: [], targetDate: undefined }])
    expect(payload.nextCursor).toBe('20:1:0')
    // Second panel load within the cache window refetches only the issue page.
    stubFetch([{ body: JSON.stringify({ results: [] }) }])
    fire(registrations, PANEL_PATH, '?projectId=p1')
    await new Promise(resolve => { setTimeout(resolve, 20) })
    expect(String(calls[0]?.input)).toContain('per_page')
  })

  it('contains a Plane failure as a 500 JSON error', async () => {
    const registrations: Registration[] = []
    mountRemote(registrations, { apiKey: 'k', workspaceSlug: 'team' })
    stubFetch([{ status: 401, body: '{"detail": "bad key"}' }])
    const outcome = fire(registrations, PANEL_PATH)
    await new Promise(resolve => { setTimeout(resolve, 20) })
    expect(outcome.status).toBe(500)
    const payload = JSON.parse(outcome.body) as { ok: boolean, error: string }
    expect(payload.ok).toBe(false)
    expect(payload.error).toContain('401')
  })
})

describe('engine HTTP surfaces', () => {
  /**
   * Mount every route over one fresh in-memory engine.
   * @param registrations - the registration collector.
   * @param raw - partial config.
   */
  function mountLocal(registrations: Registration[], raw: Partial<Config> = {}): Promise<ReturnType<typeof openEngine>> {
    const engineReady = openEngine(new JsonStore(new MemoryStoreAdapter()))
    const getConfig = (): Config => resolveConfig(raw)
    mountPlaneRoutes(
      {
        register: route => {
          registrations.push(route as Registration)
          return () => {}
        },
      },
      getConfig,
      async () => new LocalBackend(createV1Router(await engineReady)),
      () => engineReady,
    )
    return engineReady
  }

  it('guards the v1 surface with the engine key', async () => {
    const registrations: Registration[] = []
    const engine = await mountLocal(registrations)
    const denied = fireRaw(registrations, '/plugins/dsh-plane/api/v1/workspaces/dsh/projects/')
    await new Promise(resolve => { setTimeout(resolve, 5) })
    expect(denied.status).toBe(401)
    const allowed = fireRaw(registrations, '/plugins/dsh-plane/api/v1/workspaces/dsh/projects/', '', 'GET', { 'x-api-key': engine.apiKey })
    await new Promise(resolve => { setTimeout(resolve, 5) })
    expect(allowed.status).toBe(200)
    const body = JSON.parse(allowed.body) as Record<string, unknown>
    expect(body.total_count).toBe(1)
  })

  it('serves the ui surface without a key and accepts writes', async () => {
    const registrations: Registration[] = []
    await mountLocal(registrations)
    const projects = fireRaw(registrations, '/plugins/dsh-plane/ui/v1/workspaces/dsh/projects/')
    await new Promise(resolve => { setTimeout(resolve, 5) })
    expect(projects.status).toBe(200)
    const projectId = String(((JSON.parse(projects.body) as Record<string, unknown>).results as Record<string, unknown>[])[0]?.id)
    const created = fireRaw(
      registrations,
      '/plugins/dsh-plane/ui/v1/workspaces/dsh/projects/' + projectId + '/work-items/',
      '', 'POST', { 'content-type': 'application/json' },
      JSON.stringify({ name: 'from the browser half' }),
    )
    await new Promise(resolve => { setTimeout(resolve, 5) })
    expect(created.status).toBe(201)
    expect(JSON.parse(created.body)).toMatchObject({ name: 'from the browser half', identifier: 'DSH-1' })
  })

  it('rejects malformed JSON bodies with a 500 error', async () => {
    const registrations: Registration[] = []
    await mountLocal(registrations)
    const outcome = fireRaw(
      registrations,
      '/plugins/dsh-plane/ui/v1/workspaces/dsh/projects/',
      '', 'POST', { 'content-type': 'application/json' }, 'not json',
    )
    await new Promise(resolve => { setTimeout(resolve, 5) })
    expect(outcome.status).toBe(500)
    expect(JSON.parse(outcome.body).error).toMatch(/JSON/)
  })
})
