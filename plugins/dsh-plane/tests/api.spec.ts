/**
 * v1 router contract: envelope shapes (total_count/results/next_cursor/...),
 * status codes (201 creates, 204 deletes), both item segments (work-items
 * and legacy issues), membership endpoints, search, and error answers.
 */

import { describe, expect, it } from 'vitest'
import { createV1Router } from '../src/api/router.ts'
import type { RouterRequest } from '../src/api/router.ts'
import { openEngine } from '../src/engine/engine.ts'
import { JsonStore, MemoryStoreAdapter } from '../src/engine/store.ts'

/**
 * One router bound to a fresh engine over a memory store.
 * @returns the handle function.
 */
async function router(): Promise<ReturnType<typeof createV1Router>> {
  return createV1Router(await openEngine(new JsonStore(new MemoryStoreAdapter())))
}

/**
 * Issue one GET with optional query.
 * @param handle - the router.
 * @param path - the v1 path.
 * @param query - scalar query.
 * @returns the result.
 */
async function get(handle: ReturnType<typeof createV1Router>, path: string, query: RouterRequest['query'] = {}): Promise<ReturnType<ReturnType<typeof createV1Router>>> {
  return handle({ method: 'GET', path, query, body: undefined })
}

describe('projects', () => {
  it('lists with the full cursor envelope', async () => {
    const handle = await router()
    const result = await get(handle, '/workspaces/dsh/projects/')
    expect(result.status).toBe(200)
    const body = result.body as Record<string, unknown>
    expect(body.total_count).toBe(1)
    expect(body.count).toBe(1)
    expect(body.next_cursor).toBeNull()
    expect(body.prev_cursor).toBeNull()
    expect(body.next_page_results).toBe(false)
    expect(body.prev_page_results).toBe(false)
    const project = (body.results as Record<string, unknown>[])[0]
    expect(project).toMatchObject({ name: 'General', identifier: 'DSH', network: 'secret' })
    expect(project.total_members).toBe(1)
  })

  it('creates, reads, updates, and deletes projects', async () => {
    const handle = await router()
    const created = handle({
      method: 'POST', path: '/workspaces/dsh/projects/', query: {},
      body: { name: 'Engine Work', identifier: 'ENG', description: 'engine tasks' },
    })
    expect(created.status).toBe(201)
    const id = String((created.body as Record<string, unknown>).id)
    const read = await get(handle, '/workspaces/dsh/projects/' + id + '/')
    expect((read.body as Record<string, unknown>).name).toBe('Engine Work')
    const patched = handle({ method: 'PATCH', path: '/workspaces/dsh/projects/' + id + '/', query: {}, body: { name: 'Renamed' } })
    expect(((patched as { body: Record<string, unknown> }).body).name).toBe('Renamed')
    const lite = await get(handle, '/workspaces/dsh/projects-lite/')
    expect((lite.body as Record<string, unknown>[]).some(row => row.id === id)).toBe(true)
    const removed = handle({ method: 'DELETE', path: '/workspaces/dsh/projects/' + id + '/', query: {}, body: undefined })
    expect(removed.status).toBe(204)
    expect((await get(handle, '/workspaces/dsh/projects/' + id + '/')).status).toBe(404)
  })

  it('rejects duplicate identifiers with 400', async () => {
    const handle = await router()
    const dup = handle({ method: 'POST', path: '/workspaces/dsh/projects/', query: {}, body: { name: 'Dup', identifier: 'DSH' } })
    expect(dup.status).toBe(400)
    expect((dup.body as Record<string, unknown>).error).toMatch(/identifier/)
  })
})

describe('work items', () => {
  /**
   * One router with one extra work item created.
   * @returns the router and the created item row.
   */
  async function seeded(): Promise<{ handle: ReturnType<typeof createV1Router>, projectId: string, item: Record<string, unknown> }> {
    const handle = await router()
    const projects = await get(handle, '/workspaces/dsh/projects/')
    const projectId = String(((projects.body as Record<string, unknown>).results as Record<string, unknown>[])[0]?.id)
    const created = handle({
      method: 'POST', path: '/workspaces/dsh/projects/' + projectId + '/work-items/', query: {},
      body: { name: 'First item', priority: 'high', description_html: '<p>body</p>' },
    })
    return { handle, projectId, item: created.body as Record<string, unknown> }
  }

  it('creates with derived fields on both item segments', async () => {
    const { handle, projectId, item } = await seeded()
    expect(item.name).toBe('First item')
    expect(item.sequence_id).toBe(1)
    expect(item.identifier).toBe('DSH-1')
    expect(item.priority).toBe('high')
    expect(item.description_stripped).toBe('body')
    expect(item.is_draft).toBe(false)
    expect(item.labels).toEqual([])
    expect(item.completed_at).toBeNull()
    expect(typeof item.state).toBe('string')
    const legacy = await get(handle, '/workspaces/dsh/projects/' + projectId + '/issues/')
    expect(((legacy.body as Record<string, unknown>).results as Record<string, unknown>[]).map(row => row.identifier)).toEqual(['DSH-1'])
  })

  it('reads, updates, and deletes one item', async () => {
    const { handle, projectId, item } = await seeded()
    const id = String(item.id)
    const states = await get(handle, '/workspaces/dsh/projects/' + projectId + '/states/')
    const done = ((states.body as Record<string, unknown>).results as Record<string, unknown>[]).find(row => row.group === 'completed')
    const patched = handle({
      method: 'PATCH', path: '/workspaces/dsh/projects/' + projectId + '/work-items/' + id + '/', query: {},
      body: { state: String(done?.id), name: 'Renamed item' },
    })
    const patchedBody = (patched as { body: Record<string, unknown> }).body
    expect(patchedBody.name).toBe('Renamed item')
    expect(patchedBody.completed_at).toMatch(/^\d{4}/)
    const removed = handle({ method: 'DELETE', path: '/workspaces/dsh/projects/' + projectId + '/work-items/' + id + '/', query: {}, body: undefined })
    expect(removed.status).toBe(204)
    expect((await get(handle, '/workspaces/dsh/projects/' + projectId + '/work-items/' + id + '/')).status).toBe(404)
  })

  it('pages lists with cursors', async () => {
    const handle = await router()
    const projects = await get(handle, '/workspaces/dsh/projects/')
    const projectId = String(((projects.body as Record<string, unknown>).results as Record<string, unknown>[])[0]?.id)
    for (let index = 0; index < 5; index += 1) {
      handle({ method: 'POST', path: '/workspaces/dsh/projects/' + projectId + '/work-items/', query: {}, body: { name: 'item ' + index } })
    }
    const page0 = await get(handle, '/workspaces/dsh/projects/' + projectId + '/work-items/', { per_page: '2', order_by: 'name' })
    const body0 = page0.body as Record<string, unknown>
    expect(body0.count).toBe(2)
    expect(body0.next_cursor).toBe('2:1:0')
    const page1 = await get(handle, '/workspaces/dsh/projects/' + projectId + '/work-items/', { per_page: '2', order_by: 'name', cursor: String(body0.next_cursor) })
    const body1 = page1.body as Record<string, unknown>
    expect(body1.prev_cursor).toBe('2:0:1')
    expect(body1.count).toBe(2)
  })

  it('serves comments and search', async () => {
    const { handle, projectId, item } = await seeded()
    const id = String(item.id)
    const posted = handle({
      method: 'POST', path: '/workspaces/dsh/projects/' + projectId + '/work-items/' + id + '/comments/', query: {},
      body: { comment_html: '<p>first!</p>' },
    })
    expect(posted.status).toBe(201)
    const comments = await get(handle, '/workspaces/dsh/projects/' + projectId + '/work-items/' + id + '/comments/')
    const commentRow = ((comments.body as Record<string, unknown>).results as Record<string, unknown>[])[0]
    expect(commentRow.comment_stripped).toBe('first!')
    const search = await get(handle, '/workspaces/dsh/work-items/search/', { search: 'first item' })
    expect(((search.body as Record<string, unknown>).results as Record<string, unknown>[]).map(row => row.identifier)).toEqual(['DSH-1'])
    const scoped = await get(handle, '/workspaces/dsh/projects/' + projectId + '/work-items/search/', { search: 'DSH-1' })
    expect(((scoped.body as Record<string, unknown>).results as unknown[])).toHaveLength(1)
  })
})

describe('metadata resources', () => {
  it('manages states and labels', async () => {
    const handle = await router()
    const projects = await get(handle, '/workspaces/dsh/projects/')
    const projectId = String(((projects.body as Record<string, unknown>).results as Record<string, unknown>[])[0]?.id)
    const state = handle({ method: 'POST', path: '/workspaces/dsh/projects/' + projectId + '/states/', query: {}, body: { name: 'Blocked', group: 'started' } })
    expect(state.status).toBe(201)
    const stateId = String((state.body as Record<string, unknown>).id)
    const patched = handle({ method: 'PATCH', path: '/workspaces/dsh/projects/' + projectId + '/states/' + stateId + '/', query: {}, body: { color: '#ff0000' } })
    expect((patched as { body: Record<string, unknown> }).body.color).toBe('#ff0000')
    const label = handle({ method: 'POST', path: '/workspaces/dsh/projects/' + projectId + '/labels/', query: {}, body: { name: 'infra' } })
    expect(label.status).toBe(201)
    const removed = handle({ method: 'DELETE', path: '/workspaces/dsh/projects/' + projectId + '/labels/' + String((label.body as Record<string, unknown>).id) + '/', query: {}, body: undefined })
    expect(removed.status).toBe(204)
  })

  it('manages cycles and modules with membership endpoints', async () => {
    const handle = await router()
    const projects = await get(handle, '/workspaces/dsh/projects/')
    const projectId = String(((projects.body as Record<string, unknown>).results as Record<string, unknown>[])[0]?.id)
    const item = handle({ method: 'POST', path: '/workspaces/dsh/projects/' + projectId + '/work-items/', query: {}, body: { name: 'to plan' } })
    const itemId = String((item.body as Record<string, unknown>).id)
    const cycle = handle({ method: 'POST', path: '/workspaces/dsh/projects/' + projectId + '/cycles/', query: {}, body: { name: 'Sprint 1' } })
    const cycleId = String((cycle.body as Record<string, unknown>).id)
    const attached = handle({
      method: 'POST', path: '/workspaces/dsh/projects/' + projectId + '/cycles/' + cycleId + '/cycle-issues/', query: {},
      body: { issues: [itemId] },
    })
    expect(attached.status).toBe(201)
    expect((await get(handle, '/workspaces/dsh/projects/' + projectId + '/work-items/' + itemId + '/')).body).toMatchObject({ cycle: cycleId })
    const detached = handle({ method: 'DELETE', path: '/workspaces/dsh/projects/' + projectId + '/cycles/' + cycleId + '/cycle-issues/' + itemId + '/', query: {}, body: undefined })
    expect(detached.status).toBe(204)
    const module = handle({ method: 'POST', path: '/workspaces/dsh/projects/' + projectId + '/modules/', query: {}, body: { name: 'M1', status: 'planned' } })
    const moduleId = String((module.body as Record<string, unknown>).id)
    handle({ method: 'POST', path: '/workspaces/dsh/projects/' + projectId + '/modules/' + moduleId + '/module-issues/', query: {}, body: { issues: [itemId] } })
    expect((await get(handle, '/workspaces/dsh/projects/' + projectId + '/work-items/' + itemId + '/')).body).toMatchObject({ module_ids: [moduleId] })
  })
})

describe('errors and members', () => {
  it('answers 404, 405, and 400 with error bodies', async () => {
    const handle = await router()
    const missing = await get(handle, '/workspaces/dsh/not-a-resource/')
    expect(missing.status).toBe(404)
    expect((missing.body as Record<string, unknown>).error).toMatch(/no such endpoint/)
    const wrongMethod = handle({ method: 'PUT', path: '/workspaces/dsh/projects/', query: {}, body: {} })
    expect(wrongMethod.status).toBe(405)
    const badBody = handle({ method: 'POST', path: '/workspaces/dsh/projects/', query: {}, body: 'scalar' })
    expect(badBody.status).toBe(400)
    const noWorkspace = await get(handle, '/workspaces/nope/projects/')
    expect(noWorkspace.status).toBe(404)
    expect((noWorkspace.body as Record<string, unknown>).error).toMatch(/workspace/)
  })

  it('serves members and users/me', async () => {
    const handle = await router()
    const members = await get(handle, '/workspaces/dsh/members/')
    expect(((members.body as Record<string, unknown>).results ?? members.body) as unknown).toBeTruthy()
    const me = await get(handle, '/users/me/')
    expect((me.body as Record<string, unknown>).display_name).toBe('DSH Local')
  })
})
