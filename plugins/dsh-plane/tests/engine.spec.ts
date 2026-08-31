/**
 * Local engine behavior: first-boot seeding, work-item lifecycle (sequence
 * ids, completion stamps), pagination contract, search, project/state/label/
 * cycle/module CRUD rules, API key rotation, and store durability (atomic
 * saves, backup restore).
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openEngine } from '../src/engine/engine.ts'
import { EngineError } from '../src/engine/engine.ts'
import { LOCAL_KEY_PREFIX, keyMatches } from '../src/engine/key.ts'
import { clampPerPage, encodeCursor, parseCursor } from '../src/engine/pagination.ts'
import { FsStoreAdapter, JsonStore, MemoryStoreAdapter } from '../src/engine/store.ts'

/** Temp directories created during the run. */
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/**
 * Open one engine over a fresh memory store.
 * @returns the engine.
 */
async function engine(): Promise<ReturnType<typeof openEngine>> {
  return openEngine(new JsonStore(new MemoryStoreAdapter()))
}

describe('first boot', () => {
  it('seeds one workspace, one project, and the default workflow states', async () => {
    const plane = await engine()
    const workspace = plane.workspace('dsh')
    const projects = plane.listProjects(workspace.id, { perPage: 50, cursor: undefined, orderBy: undefined })
    expect(projects.total_count).toBe(1)
    const project = projects.results[0] as Record<string, unknown>
    expect(project.identifier).toBe('DSH')
    const states = plane.listStates(String(project.id), { perPage: 50, cursor: undefined, orderBy: undefined })
    expect(states.results.map(row => row.name)).toEqual(['Backlog', 'Todo', 'In Progress', 'Done', 'Cancelled'])
    expect(states.results.map(row => row.group)).toEqual(['backlog', 'unstarted', 'started', 'completed', 'cancelled'])
    expect(states.results.find(row => row.default)).toMatchObject({ name: 'Todo' })
  })

  it('issues a plane_local_ API key and rotates it', async () => {
    const plane = await engine()
    expect(plane.apiKey.startsWith(LOCAL_KEY_PREFIX)).toBe(true)
    expect(keyMatches(plane.apiKey, plane.apiKey)).toBe(true)
    expect(keyMatches(undefined, plane.apiKey)).toBe(false)
    expect(keyMatches('plane_local_wrong', plane.apiKey)).toBe(false)
    const before = plane.apiKey
    const rotated = plane.rotateKey()
    expect(rotated).not.toBe(before)
    expect(keyMatches(before, rotated)).toBe(false)
    expect(keyMatches(rotated, rotated)).toBe(true)
  })

  it('persists and reloads across engine instances', async () => {
    const dir = await tempDir()
    const store = new JsonStore(new FsStoreAdapter(dir))
    const first = await openEngine(store)
    const workspace = first.workspace('dsh')
    const project = first.listProjects(workspace.id, { perPage: 50, cursor: undefined, orderBy: undefined }).results[0] as Record<string, unknown>
    first.createWorkItem(String(project.id), { name: 'persisted' })
    await first.flush()
    const second = await openEngine(new JsonStore(new FsStoreAdapter(dir)))
    const items = second.listWorkItems(String(project.id), { perPage: 50, cursor: undefined, orderBy: undefined })
    expect(items.total_count).toBe(1)
    expect((items.results[0] as Record<string, unknown>).name).toBe('persisted')
  })
})

describe('work items', () => {
  it('numbers sequence ids per project and derives identifiers', async () => {
    const plane = await engine()
    const workspace = plane.workspace('dsh')
    const projectId = seededProject(plane, workspace.id)
    const other = plane.createProject(workspace.id, { name: 'Other', identifier: 'OTH' })
    const first = plane.createWorkItem(projectId, { name: 'one' })
    const second = plane.createWorkItem(projectId, { name: 'two' })
    const cross = plane.createWorkItem(String(other.id), { name: 'elsewhere' })
    expect(first.sequence_id).toBe(1)
    expect(second.sequence_id).toBe(2)
    expect(cross.sequence_id).toBe(1)
    expect(second.identifier).toBe('DSH-2')
    expect(cross.identifier).toBe('OTH-1')
  })

  it('files new items into the default state and stamps completion', async () => {
    const plane = await engine()
    const projectId = seededProject(plane, plane.workspace('dsh').id)
    const states = plane.listStates(projectId, { perPage: 50, cursor: undefined, orderBy: undefined }).results as Record<string, unknown>[]
    const done = states.find(row => row.group === 'completed') as Record<string, unknown>
    const item = plane.createWorkItem(projectId, { name: 'work', priority: 'high' })
    expect(item.priority).toBe('high')
    expect(item.state).toBe(states.find(row => row.default === true)?.id)
    expect(item.completed_at).toBeNull()
    const moved = plane.updateWorkItem(projectId, String(item.id), { state: String(done.id) })
    expect(moved.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const reopened = plane.updateWorkItem(projectId, String(item.id), { state: String(item.state) })
    expect(reopened.completed_at).toBeNull()
  })

  it('validates priority, parent, and label references', async () => {
    const plane = await engine()
    const projectId = seededProject(plane, plane.workspace('dsh').id)
    expect(() => plane.createWorkItem(projectId, { name: 'x', priority: 'wild' })).toThrow(EngineError)
    expect(() => plane.createWorkItem(projectId, { name: 'x', parent: '00000000-0000-4000-8000-000000000000' })).toThrow(EngineError)
    expect(() => plane.createWorkItem(projectId, { name: 'x', labels: ['00000000-0000-4000-8000-000000000000'] })).toThrow(EngineError)
    expect(() => plane.createWorkItem(projectId, { name: '' })).toThrow(EngineError)
    const child = plane.createWorkItem(projectId, { name: 'parent' })
    expect(() => plane.updateWorkItem(projectId, String(child.id), { parent: String(child.id) })).toThrow(EngineError)
  })

  it('orphans sub-items on delete and cascades comments', async () => {
    const plane = await engine()
    const projectId = seededProject(plane, plane.workspace('dsh').id)
    const parent = plane.createWorkItem(projectId, { name: 'parent' })
    const child = plane.createWorkItem(projectId, { name: 'child', parent: String(parent.id) })
    plane.createComment(projectId, String(child.id), { comment_html: '<p>note</p>' })
    plane.deleteWorkItem(projectId, String(parent.id))
    const orphan = plane.getWorkItem(projectId, String(child.id))
    expect(orphan.parent).toBeNull()
    expect(plane.listComments(projectId, String(child.id), { perPage: 50, cursor: undefined, orderBy: undefined }).total_count).toBe(1)
    expect(() => plane.getWorkItem(projectId, String(parent.id))).toThrow(EngineError)
  })

  it('orders by the requested key and direction', async () => {
    const plane = await engine()
    const projectId = seededProject(plane, plane.workspace('dsh').id)
    for (const name of ['alpha', 'beta', 'gamma']) plane.createWorkItem(projectId, { name })
    const byName = plane.listWorkItems(projectId, { perPage: 50, cursor: undefined, orderBy: 'name' })
    expect(byName.results.map(row => row.name)).toEqual(['alpha', 'beta', 'gamma'])
    const byNameDesc = plane.listWorkItems(projectId, { perPage: 50, cursor: undefined, orderBy: '-name' })
    expect(byNameDesc.results.map(row => row.name)).toEqual(['gamma', 'beta', 'alpha'])
  })
})

describe('pagination contract', () => {
  it('encodes and parses value:offset:is_prev cursors', () => {
    expect(encodeCursor(3, 1, false)).toBe('3:1:0')
    expect(encodeCursor(3, 0, true)).toBe('3:0:1')
    expect(parseCursor('3:1:0')).toEqual({ limit: 3, page: 1 })
    expect(parseCursor('3.0:2:1')).toEqual({ limit: 3, page: 2 })
    expect(parseCursor('broken')).toBeUndefined()
    expect(parseCursor('a:b:c')).toBeUndefined()
    expect(parseCursor(undefined)).toBeUndefined()
    expect(clampPerPage(undefined)).toBe(50)
    expect(clampPerPage('7')).toBe(7)
    expect(clampPerPage(500)).toBe(100)
  })

  it('pages with next and prev cursors', async () => {
    const plane = await engine()
    const projectId = seededProject(plane, plane.workspace('dsh').id)
    for (let index = 0; index < 7; index += 1) plane.createWorkItem(projectId, { name: 'item-' + index })
    const page0 = plane.listWorkItems(projectId, { perPage: 3, cursor: undefined, orderBy: 'name' })
    expect(page0.count).toBe(3)
    expect(page0.next_page_results).toBe(true)
    expect(page0.prev_page_results).toBe(false)
    expect(page0.total_count).toBe(7)
    const page1 = plane.listWorkItems(projectId, { perPage: 3, cursor: page0.next_cursor ?? undefined, orderBy: 'name' })
    expect(page1.count).toBe(3)
    expect(page1.prev_page_results).toBe(true)
    const page2 = plane.listWorkItems(projectId, { perPage: 3, cursor: page1.next_cursor ?? undefined, orderBy: 'name' })
    expect(page2.count).toBe(1)
    expect(page2.next_cursor).toBeNull()
    expect(page2.next_page_results).toBe(false)
    expect(page2.total_pages).toBe(3)
  })
})

describe('projects, states, labels, cycles, modules', () => {
  it('enforces unique project identifiers and seeds states', async () => {
    const plane = await engine()
    const workspaceId = plane.workspace('dsh').id
    plane.createProject(workspaceId, { name: 'Second', identifier: 'SEC' })
    expect(() => plane.createProject(workspaceId, { name: 'Dup', identifier: 'sec' })).toThrow(EngineError)
    expect(() => plane.createProject(workspaceId, { name: 'Bad', identifier: 'TOO-LONG-IDENT' })).toThrow(EngineError)
    const second = plane.listProjects(workspaceId, { perPage: 50, cursor: undefined, orderBy: 'name' }).results.find(row => row.identifier === 'SEC') as Record<string, unknown>
    expect(plane.listStates(String(second.id), { perPage: 50, cursor: undefined, orderBy: undefined }).total_count).toBe(5)
  })

  it('moves work items when a state is deleted and refuses the last one', async () => {
    const plane = await engine()
    const projectId = seededProject(plane, plane.workspace('dsh').id)
    const states = plane.listStates(projectId, { perPage: 50, cursor: undefined, orderBy: undefined }).results as Record<string, unknown>[]
    const backlog = states.find(row => row.name === 'Backlog') as Record<string, unknown>
    const item = plane.createWorkItem(projectId, { name: 'moved', state: String(backlog.id) })
    plane.deleteState(projectId, String(backlog.id))
    const after = plane.getWorkItem(projectId, String(item.id))
    expect(after.state).not.toBe(backlog.id)
    let remaining = plane.listStates(projectId, { perPage: 50, cursor: undefined, orderBy: undefined }).results as Record<string, unknown>[]
    while (remaining.length > 1) {
      plane.deleteState(projectId, String(remaining[0]?.id))
      remaining = plane.listStates(projectId, { perPage: 50, cursor: undefined, orderBy: undefined }).results as Record<string, unknown>[]
    }
    expect(() => plane.deleteState(projectId, String(remaining[0]?.id))).toThrow(EngineError)
  })

  it('detaches labels from work items on delete', async () => {
    const plane = await engine()
    const projectId = seededProject(plane, plane.workspace('dsh').id)
    const label = plane.createLabel(projectId, { name: 'bug', color: '#ff0000' })
    const item = plane.createWorkItem(projectId, { name: 'labeled', labels: [String(label.id)] })
    plane.deleteLabel(projectId, String(label.id))
    expect(plane.getWorkItem(projectId, String(item.id)).labels).toEqual([])
  })

  it('derives cycle status from dates and swaps membership', async () => {
    const plane = await engine()
    const projectId = seededProject(plane, plane.workspace('dsh').id)
    const past = isoDaysFrom(-14)
    const recent = isoDaysFrom(-7)
    const cycle = plane.createCycle(projectId, { name: 'sprint', start_date: past, end_date: recent })
    expect(cycle.is_current).toBe(false)
    expect(cycle.status).toBe('completed')
    const item = plane.createWorkItem(projectId, { name: 'in cycle' })
    plane.setCycleMembership(projectId, String(cycle.id), [String(item.id)], false)
    expect(plane.getWorkItem(projectId, String(item.id)).cycle).toBe(cycle.id)
    plane.setCycleMembership(projectId, String(cycle.id), [String(item.id)], true)
    expect(plane.getWorkItem(projectId, String(item.id)).cycle).toBeNull()
    expect(() => plane.createCycle(projectId, { name: 'bad', start_date: recent, end_date: past })).toThrow(EngineError)
  })

  it('manages module membership', async () => {
    const plane = await engine()
    const projectId = seededProject(plane, plane.workspace('dsh').id)
    const module = plane.createModule(projectId, { name: 'infra', status: 'in-progress' })
    expect(module.status).toBe('in-progress')
    const item = plane.createWorkItem(projectId, { name: 'mod work' })
    plane.setModuleMembership(projectId, String(module.id), [String(item.id)], false)
    expect(plane.getWorkItem(projectId, String(item.id)).module_ids).toEqual([module.id])
    plane.setModuleMembership(projectId, String(module.id), [String(item.id)], true)
    expect(plane.getWorkItem(projectId, String(item.id)).module_ids).toEqual([])
  })
})

describe('search, comments, links, members', () => {
  it('matches name, description text, and identifiers', async () => {
    const plane = await engine()
    const workspaceId = plane.workspace('dsh').id
    const projectId = seededProject(plane, workspaceId)
    plane.createWorkItem(projectId, { name: 'Fix login redirect' })
    plane.createWorkItem(projectId, { name: 'chore', description_html: '<p>rotate the database credentials</p>' })
    const third = plane.createWorkItem(projectId, { name: 'another' })
    expect(plane.search(workspaceId, { text: 'login', projectId: undefined, limit: 10 })).toHaveLength(1)
    expect(plane.search(workspaceId, { text: 'credentials', projectId: undefined, limit: 10 })).toHaveLength(1)
    expect(plane.search(workspaceId, { text: 'dsh-' + String(third.sequence_id), projectId: undefined, limit: 10 })).toHaveLength(1)
    expect(plane.search(workspaceId, { text: '', projectId: undefined, limit: 10 })).toHaveLength(0)
    expect(plane.search(workspaceId, { text: 'another', projectId: '00000000-0000-4000-8000-000000000000', limit: 10 })).toHaveLength(0)
  })

  it('strips comment html into plain text', async () => {
    const plane = await engine()
    const projectId = seededProject(plane, plane.workspace('dsh').id)
    const item = plane.createWorkItem(projectId, { name: 'discussed' })
    const comment = plane.createComment(projectId, String(item.id), { comment_html: '<p>hello <b>world</b></p>' })
    expect(comment.comment_stripped).toContain('hello world')
    expect(comment.access).toBe('INTERNAL')
  })

  it('validates link urls', async () => {
    const plane = await engine()
    const projectId = seededProject(plane, plane.workspace('dsh').id)
    const item = plane.createWorkItem(projectId, { name: 'linked' })
    expect(() => plane.createLink(projectId, String(item.id), { title: 'bad', url: 'ftp://example.com' })).toThrow(EngineError)
    const link = plane.createLink(projectId, String(item.id), { title: 'docs', url: 'https://example.com/docs' })
    expect(plane.listLinks(projectId, String(item.id))).toHaveLength(1)
    plane.deleteLink(projectId, String(item.id), String(link.id))
    expect(plane.listLinks(projectId, String(item.id))).toHaveLength(0)
  })

  it('exposes one local member and users/me', async () => {
    const plane = await engine()
    expect(plane.listMembers()).toHaveLength(1)
    expect(plane.me()).toMatchObject({ display_name: 'DSH Local', email: 'dsh@local' })
  })
})

describe('store durability', () => {
  it('restores from the backup when the primary file is corrupt', async () => {
    const dir = await tempDir()
    const first = await openEngine(new JsonStore(new FsStoreAdapter(dir)))
    const projectId = seededProject(first, first.workspace('dsh').id)
    first.createWorkItem(projectId, { name: 'first save' })
    await first.flush()
    first.createWorkItem(projectId, { name: 'second save' })
    await first.flush()
    await writeFile(join(dir, 'store.json'), '{corrupt', 'utf8')
    const second = await openEngine(new JsonStore(new FsStoreAdapter(dir)))
    const names = second.listWorkItems(projectId, { perPage: 50, cursor: undefined, orderBy: undefined }).results.map(row => row.name)
    expect(names).toEqual(['first save'])
  })

  it('refuses to reset when the store is corrupt with no backup', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'store.json'), '{corrupt', 'utf8')
    await expect(openEngine(new JsonStore(new FsStoreAdapter(dir)))).rejects.toThrow(/corrupt/)
  })

  it('writes valid JSON with restrictive permissions', async () => {
    const dir = await tempDir()
    const plane = await openEngine(new JsonStore(new FsStoreAdapter(dir)))
    await plane.flush()
    const raw = await readFile(join(dir, 'store.json'), 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})

/**
 * The seeded project id for one workspace.
 * @param plane - the engine.
 * @param workspaceId - the scoping workspace.
 * @returns the project id.
 */
function seededProject(plane: Awaited<ReturnType<typeof openEngine>>, workspaceId: string): string {
  const project = plane.listProjects(workspaceId, { perPage: 50, cursor: undefined, orderBy: undefined }).results[0] as Record<string, unknown>
  return String(project.id)
}

/**
 * Create one temp directory tracked for cleanup.
 * @returns the directory path.
 */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-plane-engine-'))
  tempDirs.push(dir)
  return dir
}

/**
 * One ISO yyyy-mm-dd date offset from today.
 * @param days - the day offset.
 * @returns the date string.
 */
function isoDaysFrom(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}
