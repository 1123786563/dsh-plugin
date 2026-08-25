/**
 * Panel routes: registration shape, JSON error containment, and the panel
 * payload's config-failure paths, against stubbed fetch.
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { mountPlaneRoutes, PANEL_PATH, STATE_PATH } from '../src/routes.ts'
import type { PlaneIncomingMessage, PlaneServerResponse } from '../src/routes.ts'
import { resolveConfig } from '../src/config.ts'

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

/** Drive one registered handler with a query string; the recorder is live. */
function fire(registrations: Registration[], path: string, query = ''): PlaneServerResponse & { status: number, body: string } {
  const registration = registrations.find(entry => entry.path === path)
  if (registration === undefined) throw new Error('route not registered: ' + path)
  const recorder = res()
  registration.handler({ method: 'GET', url: '/x' + path + query }, recorder)
  return recorder
}

describe('mountPlaneRoutes', () => {
  it('registers exactly the state and panel routes and unregisters on dispose', () => {
    const registrations: Registration[] = []
    const dispose = mountPlaneRoutes({
      register: route => {
        registrations.push(route as Registration)
        return () => {
          const at = registrations.indexOf(route as Registration)
          if (at >= 0) registrations.splice(at, 1)
        }
      },
    }, () => resolveConfig({ apiKey: 'k', workspaceSlug: 'team' }))
    expect(registrations.map(entry => entry.path).sort()).toEqual([PANEL_PATH, STATE_PATH])
    dispose()
    expect(registrations).toHaveLength(0)
  })

  it('serves connection state without touching the network', async () => {
    const registrations: Registration[] = []
    mountPlaneRoutes({
      register: route => {
        registrations.push(route as Registration)
        return () => {}
      },
    }, () => resolveConfig({ apiKey: 'plane_api_x', workspaceSlug: 'team' }))
    const calls = stubFetch([])
    const outcome = fire(registrations, STATE_PATH)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(outcome.status).toBe(200)
    expect(JSON.parse(outcome.body)).toEqual({
      ok: true,
      configured: true,
      baseUrl: 'https://api.plane.so',
      workspace: 'team',
      defaultProjectId: '',
    })
    expect(calls).toHaveLength(0)
  })

  it('answers not-configured without a network call', async () => {
    const registrations: Registration[] = []
    mountPlaneRoutes({ register: route => { registrations.push(route as Registration); return () => {} } }, () => resolveConfig({}))
    stubFetch([])
    const outcome = fire(registrations, PANEL_PATH)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    const payload = JSON.parse(outcome.body) as { ok: boolean, error: string }
    expect(payload.ok).toBe(false)
    expect(payload.error).toBe('not-configured')
  })

  it('answers no-workspace when only the key is set', async () => {
    const registrations: Registration[] = []
    mountPlaneRoutes({ register: route => { registrations.push(route as Registration); return () => {} } }, () => resolveConfig({ apiKey: 'k' }))
    stubFetch([])
    const outcome = fire(registrations, PANEL_PATH)
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(JSON.parse(outcome.body)).toEqual({ ok: false, error: 'no-workspace' })
  })

  it('serves projects plus the first project page, caching the project list', async () => {
    const registrations: Registration[] = []
    mountPlaneRoutes({ register: route => { registrations.push(route as Registration); return () => {} } },
      () => resolveConfig({ apiKey: 'k', workspaceSlug: 'team' }))
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
    expect(payload.issues).toEqual([{ id: 'i1', identifier: 'CORE-1', name: 'Fix', priority: 'high', state: 'In Progress', assignees: [], targetDate: undefined }])
    expect(payload.nextCursor).toBe('20:1:0')
    // Second panel load within the cache window refetches only the issue page.
    stubFetch([{ body: JSON.stringify({ results: [] }) }])
    fire(registrations, PANEL_PATH, '?projectId=p1')
    await new Promise(resolve => { setTimeout(resolve, 20) })
    expect(String(calls[0]?.input)).toContain('per_page')
  })

  it('contains a Plane failure as a 500 JSON error', async () => {
    const registrations: Registration[] = []
    mountPlaneRoutes({ register: route => { registrations.push(route as Registration); return () => {} } },
      () => resolveConfig({ apiKey: 'k', workspaceSlug: 'team' }))
    stubFetch([{ status: 401, body: '{"detail": "bad key"}' }])
    const outcome = fire(registrations, PANEL_PATH)
    await new Promise(resolve => { setTimeout(resolve, 20) })
    expect(outcome.status).toBe(500)
    const payload = JSON.parse(outcome.body) as { ok: boolean, error: string }
    expect(payload.ok).toBe(false)
    expect(payload.error).toContain('401')
  })
})
