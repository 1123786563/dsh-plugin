/**
 * Tool registration and execution: schema validation, argument resolution
 * (workspace/project/perPage fallbacks), body composition, projections, and
 * canonical output shapes, all against a stubbed fetch.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'

/** A minimal execution context: an abort signal is all the tools consume. */
function exec(): ToolRunContext {
  return { signal: new AbortController().signal } as unknown as ToolRunContext
}

/**
 * Collect registered tools behind a stub tools service.
 * @returns the context to pass to apply and the registered tool map.
 */
function harness(): { ctx: Context; registered: Map<string, ToolDefinition> } {
  const registered = new Map<string, ToolDefinition>()
  const ctx = {
    tools: {
      register(tool: ToolDefinition): () => void {
        registered.set(tool.name, tool)
        return () => registered.delete(tool.name)
      },
    },
    // installSettingsSection rides a scoped fiber; without a settings service
    // mounted, cordis never calls the callback. The webServer inject likewise
    // stays dormant, so a no-op inject keeps the stub faithful.
    inject: (): void => {},
    effect: (fn: () => (() => void) | void): (() => void) => fn() ?? (() => {}),
  } as unknown as Context
  return { ctx, registered }
}

/**
 * Install a fetch stub serving one response per call in order.
 * @param responses - ordered response bodies (and optional statuses).
 * @returns every recorded request.
 */
function stubFetch(responses: { status?: number, body?: string }[]): { url: string, method: string, body: string | undefined }[] {
  const calls: { url: string, method: string, body: string | undefined }[] = []
  let index = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : String(init.body),
    })
    const route = responses[index]
    index += 1
    const status = route?.status ?? 200
    return new Response(route?.body ?? '', { status, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('registration', () => {
  it('registers the plane tool family unconfigured', () => {
    const { ctx, registered } = harness()
    apply(ctx, undefined)
    expect([...registered.keys()].sort()).toEqual([
      'plane_create_issue',
      'plane_create_issue_comment',
      'plane_create_project',
      'plane_delete_issue',
      'plane_get_issue',
      'plane_list_issue_comments',
      'plane_list_issues',
      'plane_list_metadata',
      'plane_list_projects',
      'plane_request',
      'plane_search_issues',
      'plane_update_issue',
      'plane_update_project',
    ])
  })
})

describe('plane_list_projects', () => {
  it('uses the configured workspace and perPage, projects rows, and carries pagination', async () => {
    const calls = stubFetch([{
      body: JSON.stringify({
        results: [
          { id: 'p1', name: 'Core', identifier: 'CORE', internal_fields: 'noise' },
          { id: 'p2', name: 'Web', identifier: 'WEB' },
        ],
        total_count: 2,
        next_cursor: null,
        next_page_results: false,
      }),
    }])
    const { ctx, registered } = harness()
    apply(ctx, { backend: 'remote', apiKey: 'k', workspaceSlug: 'team', perPage: 7 })
    const value = await registered.get('plane_list_projects')?.execute({}, exec())
    expect(value).toEqual({
      projects: [
        { id: 'p1', name: 'Core', identifier: 'CORE' },
        { id: 'p2', name: 'Web', identifier: 'WEB' },
      ],
      totalCount: 2,
      hasNextPage: false,
    })
    expect(calls[0]?.url).toBe('https://api.plane.so/api/v1/workspaces/team/projects/?per_page=7')
  })

  it('fails with a workspace hint when neither call nor config supplies one', async () => {
    stubFetch([])
    const { ctx, registered } = harness()
    apply(ctx, { backend: 'remote', apiKey: 'k' })
    await expect(registered.get('plane_list_projects')?.execute({}, exec())).rejects.toThrow(/workspaceSlug/)
  })
})

describe('plane_list_issues', () => {
  it('resolves project from config, negotiates the item segment, and projects rows', async () => {
    const calls = stubFetch([
      { status: 404, body: '{"detail": "missing"}' },
      {
        body: JSON.stringify({
          results: [{
            id: 'i1', name: 'Fix login', sequence_id: 12, identifier: 'CORE-12', priority: 'high',
            state: { id: 's1', name: 'In Progress', group: 'started' },
            assignees: [{ id: 'u1', display_name: 'Ada' }],
            sub_issues_count: 3, heavy_field: 'dropped',
          }],
          total_count: 1,
          next_cursor: '20:1:0',
          next_page_results: true,
        }),
      },
    ])
    const { ctx, registered } = harness()
    apply(ctx, { backend: 'remote', apiKey: 'k', workspaceSlug: 'team', defaultProjectId: 'p1' })
    const value = await registered.get('plane_list_issues')?.execute({}, exec())
    expect(calls[0]?.url).toContain('/work-items/')
    expect(calls[1]?.url).toContain('/issues/')
    expect(calls[1]?.url).toContain('per_page=50')
    expect(value).toEqual({
      issues: [{
        id: 'i1',
        name: 'Fix login',
        sequence_id: 12,
        identifier: 'CORE-12',
        priority: 'high',
        state: { id: 's1', name: 'In Progress', group: 'started' },
        assignees: [{ id: 'u1', display_name: 'Ada' }],
      }],
      totalCount: 1,
      nextCursor: '20:1:0',
      hasNextPage: true,
    })
  })

  it('rejects perPage outside 1..100', async () => {
    stubFetch([])
    const { ctx, registered } = harness()
    apply(ctx, { backend: 'remote', apiKey: 'k', workspaceSlug: 'team', defaultProjectId: 'p1' })
    await expect(registered.get('plane_list_issues')?.execute({ perPage: 101 }, exec())).rejects.toThrow(/perPage/)
    await expect(registered.get('plane_list_issues')?.execute({ perPage: 0 }, exec())).rejects.toThrow(/perPage/)
  })
})

describe('plane_search_issues', () => {
  it('searches the workspace when no project resolves', async () => {
    const calls = stubFetch([{ body: JSON.stringify({ results: [{ id: 'i9', name: 'SAML', identifier: 'OPS-2' }] }) }])
    const { ctx, registered } = harness()
    apply(ctx, { backend: 'remote', apiKey: 'k', workspaceSlug: 'team' })
    const value = await registered.get('plane_search_issues')?.execute({ query: 'SAML', limit: 5 }, exec())
    expect(calls[0]?.url).toContain('/work-items/search/')
    expect(calls[0]?.url).toContain('search=SAML')
    expect(calls[0]?.url).toContain('workspace_search=true')
    expect(calls[0]?.url).toContain('limit=5')
    expect(value).toEqual({ results: [{ id: 'i9', name: 'SAML', identifier: 'OPS-2' }] })
  })

  it('scopes the search to the resolved project', async () => {
    const calls = stubFetch([{ body: '[]' }])
    const { ctx, registered } = harness()
    apply(ctx, { backend: 'remote', apiKey: 'k', workspaceSlug: 'team', defaultProjectId: 'p1' })
    await registered.get('plane_search_issues')?.execute({ query: 'x' }, exec())
    expect(calls[0]?.url).toContain('project_id=p1')
    expect(calls[0]?.url).not.toContain('workspace_search')
  })
})

describe('plane_create_issue', () => {
  it('maps camelCase arguments onto the Plane body', async () => {
    const calls = stubFetch([{ body: JSON.stringify({ id: 'i2', name: 'New' }) }])
    const { ctx, registered } = harness()
    apply(ctx, { backend: 'remote', apiKey: 'k', workspaceSlug: 'team', defaultProjectId: 'p1' })
    const value = await registered.get('plane_create_issue')?.execute({
      name: 'New',
      descriptionHtml: '<p>body</p>',
      priority: 'urgent',
      labels: ['l1', 'l2'],
      targetDate: '2030-01-02',
    }, exec())
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toContain('/work-items/')
    expect(calls[0]?.body).toBe(JSON.stringify({
      name: 'New',
      description_html: '<p>body</p>',
      priority: 'urgent',
      labels: ['l1', 'l2'],
      target_date: '2030-01-02',
    }))
    expect(value).toEqual({ issue: { id: 'i2', name: 'New' } })
  })

  it('rejects a blank name before any request', async () => {
    const calls = stubFetch([])
    const { ctx, registered } = harness()
    apply(ctx, { backend: 'remote', apiKey: 'k', workspaceSlug: 'team', defaultProjectId: 'p1' })
    await expect(registered.get('plane_create_issue')?.execute({ name: '  ' }, exec())).rejects.toThrow(/name/)
    expect(calls).toHaveLength(0)
  })

  it('rejects an out-of-enum priority at the schema boundary', async () => {
    const { ctx, registered } = harness()
    apply(ctx, { backend: 'remote', apiKey: 'k', workspaceSlug: 'team', defaultProjectId: 'p1' })
    await expect(registered.get('plane_create_issue')?.execute({ name: 'x', priority: 'catastrophic' }, exec()))
      .rejects.toThrow()
  })
})

describe('plane_update_issue', () => {
  it('PATCHes only the provided fields onto the item path', async () => {
    const calls = stubFetch([{ body: JSON.stringify({ id: 'i1', state: 's2' }) }])
    const { ctx, registered } = harness()
    apply(ctx, { backend: 'remote', apiKey: 'k', workspaceSlug: 'team', defaultProjectId: 'p1' })
    await registered.get('plane_update_issue')?.execute({ issueId: 'i1', state: 's2', priority: 'low' }, exec())
    expect(calls[0]?.method).toBe('PATCH')
    expect(calls[0]?.url).toContain('/work-items/i1/')
    expect(calls[0]?.body).toBe(JSON.stringify({ priority: 'low', state: 's2' }))
  })

  it('requires at least one mutable field', async () => {
    const calls = stubFetch([])
    const { ctx, registered } = harness()
    apply(ctx, { backend: 'remote', apiKey: 'k', workspaceSlug: 'team', defaultProjectId: 'p1' })
    await expect(registered.get('plane_update_issue')?.execute({ issueId: 'i1' }, exec())).rejects.toThrow(/at least one field/)
    expect(calls).toHaveLength(0)
  })
})

describe('plane comments', () => {
  it('lists and creates comments on the negotiated segment', async () => {
    const calls = stubFetch([
      { body: JSON.stringify({ results: [{ id: 'c1', comment_html: '<p>hi</p>', comment_stripped: 'hi', huge: 'x' }] }) },
      { body: JSON.stringify({ id: 'c2', comment_html: '<p>done</p>' }) },
    ])
    const { ctx, registered } = harness()
    apply(ctx, { backend: 'remote', apiKey: 'k', workspaceSlug: 'team', defaultProjectId: 'p1' })
    const listed = await registered.get('plane_list_issue_comments')?.execute({ issueId: 'i1' }, exec())
    expect(listed).toEqual({
      comments: [{ id: 'c1', comment_html: '<p>hi</p>', comment_stripped: 'hi' }],
      hasNextPage: false,
    })
    const created = await registered.get('plane_create_issue_comment')?.execute({ issueId: 'i1', commentHtml: '<p>done</p>' }, exec())
    expect(calls[1]?.method).toBe('POST')
    expect(calls[1]?.url).toContain('/comments/')
    expect(calls[1]?.body).toBe(JSON.stringify({ comment_html: '<p>done</p>' }))
    expect(created).toEqual({ comment: { id: 'c2', comment_html: '<p>done</p>' } })
  })
})

describe('plane_list_metadata', () => {
  it('lists states through the plain project path and echoes the resource', async () => {
    const calls = stubFetch([{
      body: JSON.stringify({ results: [{ id: 's1', name: 'Todo', group: 'unstarted', color: '#000' }] }),
    }])
    const { ctx, registered } = harness()
    apply(ctx, { backend: 'remote', apiKey: 'k', workspaceSlug: 'team', defaultProjectId: 'p1' })
    const value = await registered.get('plane_list_metadata')?.execute({ resource: 'states' }, exec())
    expect(calls[0]?.url).toContain('/projects/p1/states/')
    expect(value).toEqual({
      resource: 'states',
      items: [{ id: 's1', name: 'Todo', group: 'unstarted', color: '#000' }],
      hasNextPage: false,
    })
  })
})

describe('plane_request', () => {
  it('forwards method, path, scalar query, and body', async () => {
    const calls = stubFetch([{ body: JSON.stringify([{ id: 'm1' }]) }])
    const { ctx, registered } = harness()
    apply(ctx, { backend: 'remote', apiKey: 'k', workspaceSlug: 'team' })
    const value = await registered.get('plane_request')?.execute({
      method: 'POST',
      path: 'workspaces/team/projects/p1/modules/',
      query: { cursor: '1:0:0', deep: false },
      body: { name: 'M1' },
    }, exec())
    expect(calls[0]?.url).toBe('https://api.plane.so/api/v1/workspaces/team/projects/p1/modules/?cursor=1%3A0%3A0&deep=false')
    expect(calls[0]?.body).toBe(JSON.stringify({ name: 'M1' }))
    expect(value).toEqual({ body: [{ id: 'm1' }] })
  })

  it('rejects unknown methods at the schema boundary', async () => {
    const { ctx, registered } = harness()
    apply(ctx, { backend: 'remote', apiKey: 'k' })
    await expect(registered.get('plane_request')?.execute({ method: 'PUT', path: '/x/' }, exec())).rejects.toThrow()
  })
})

describe('local backend', () => {
  it('serves the in-process engine end to end without any network call', async () => {
    const calls = stubFetch([])
    vi.stubEnv('DSH_PLANE_DATA_DIR', await mkdtemp(join(tmpdir(), 'dsh-plane-tools-')))
    const { ctx, registered } = harness()
    apply(ctx, undefined)
    const project = await registered.get('plane_create_project')?.execute({ name: 'Local work', identifier: 'LOC' }, exec())
    const projectId = String((project as { project: Record<string, unknown> }).project.id)
    const created = await registered.get('plane_create_issue')?.execute({
      name: 'first local item',
      projectId,
      descriptionHtml: '<p>engine powered</p>',
      priority: 'high',
    }, exec())
    const issue = (created as { issue: Record<string, unknown> }).issue
    expect(issue.identifier).toBe('LOC-1')
    expect(issue.sequence_id).toBe(1)
    const listed = await registered.get('plane_list_issues')?.execute({ projectId }, exec())
    expect((listed as { issues: unknown[] }).issues).toHaveLength(1)
    const searched = await registered.get('plane_search_issues')?.execute({ query: 'local item' }, exec())
    expect((searched as { results: unknown[] }).results).toHaveLength(1)
    const updated = await registered.get('plane_update_issue')?.execute({ issueId: String(issue.id), projectId, name: 'renamed' }, exec())
    expect((updated as { issue: Record<string, unknown> }).issue.name).toBe('renamed')
    expect(calls).toHaveLength(0)
  })
})

describe('rendering', () => {
  it('renders one compact line per projected work item', () => {
    const { ctx, registered } = harness()
    apply(ctx, { backend: 'remote', apiKey: 'k', workspaceSlug: 'team', defaultProjectId: 'p1' })
    const tool = registered.get('plane_list_issues')
    expect(tool).toBeDefined()
    const blocks = tool?.output.render({}, {
      issues: [{
        id: 'i1', name: 'Fix login', identifier: 'CORE-12', priority: 'high',
        state: { id: 's1', name: 'In Progress' },
        assignees: [{ id: 'u1', display_name: 'Ada' }],
      }],
      hasNextPage: false,
    } as never) as { type: string, text: string }[]
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.text).toContain('CORE-12 Fix login | [In Progress/high] | @Ada')
  })
})
