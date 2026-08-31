/**
 * Model-facing Plane tools: projects, work items, comments, cycles, states,
 * labels, and a raw-request escape hatch that reaches every other endpoint.
 *
 * Every tool takes an optional workspace (falling back to the configured
 * workspaceSlug) and project-scoped tools take an optional projectId (falling
 * back to defaultProjectId), so a deployment can pin one Plane workspace and
 * project while callers can still address others.
 *
 * @module dsh-plane/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PlaneBackend } from './backend.ts'
import type { Page } from './client.ts'
import type { Config } from './config.ts'
import { commentKeys, issueKeys, issueLine, metadataKeys, projectKeys, projectRows } from './view.ts'
import type { MetadataResource } from './view.ts'

/** Plane work-item priorities, in Plane's own vocabulary. */
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const

/** Argument-to-body-key mapping shared by create and update. */
const ISSUE_BODY_FIELDS = {
  name: 'name',
  descriptionHtml: 'description_html',
  priority: 'priority',
  state: 'state',
  assignees: 'assignees',
  labels: 'labels',
  parent: 'parent',
  startDate: 'start_date',
  targetDate: 'target_date',
  isDraft: 'is_draft',
} as const

/**
 * Supplies the live backend per call: the local engine or the remote client,
 * picked from the current settings so backend flips apply without a restart.
 */
export type BackendFactory = () => PlaneBackend | Promise<PlaneBackend>

/**
 * Register the plane_* tools on the host tools service.
 * @param ctx - host context carrying the tools service.
 * @param getBackend - the activation's backend factory.
 * @param config - the activation's resolved config.
 */
export function registerPlaneTools(ctx: Context, getBackend: BackendFactory, getConfig: () => Config): void {
  ctx.tools.register(planeListProjects(getBackend, getConfig))
  ctx.tools.register(planeCreateProject(getBackend, getConfig))
  ctx.tools.register(planeUpdateProject(getBackend, getConfig))
  ctx.tools.register(planeListIssues(getBackend, getConfig))
  ctx.tools.register(planeSearchIssues(getBackend, getConfig))
  ctx.tools.register(planeGetIssue(getBackend, getConfig))
  ctx.tools.register(planeCreateIssue(getBackend, getConfig))
  ctx.tools.register(planeUpdateIssue(getBackend, getConfig))
  ctx.tools.register(planeDeleteIssue(getBackend, getConfig))
  ctx.tools.register(planeListIssueComments(getBackend, getConfig))
  ctx.tools.register(planeCreateIssueComment(getBackend, getConfig))
  ctx.tools.register(planeListMetadata(getBackend, getConfig))
  ctx.tools.register(planeRequest(getBackend))
}

/**
 * Resolve the workspace slug for one call.
 * @param config - activation config.
 * @param workspace - caller-supplied slug override.
 * @returns the workspace slug.
 */
function workspaceOf(config: Config, workspace: string | undefined): string {
  const slug = (workspace ?? config.workspaceSlug).trim()
  if (slug.length === 0) {
    throw new Error('no Plane workspace: pass workspace on the call or set workspaceSlug in the dsh-plane config')
  }
  return slug
}

/**
 * Resolve the project id for one project-scoped call.
 * @param config - activation config.
 * @param projectId - caller-supplied id override.
 * @returns the project id.
 */
function projectOf(config: Config, projectId: string | undefined): string {
  const id = (projectId ?? config.defaultProjectId).trim()
  if (id.length === 0) {
    throw new Error('no Plane project: pass projectId on the call or set defaultProjectId in the dsh-plane config')
  }
  return id
}

/**
 * Resolve the per-call page size.
 * @param config - activation config.
 * @param perPage - caller-supplied size.
 * @returns the clamped page size between 1 and 100.
 */
function perPageOf(config: Config, perPage: number | undefined): number {
  if (perPage === undefined) return config.perPage
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
    throw new Error('perPage must be an integer between 1 and 100')
  }
  return perPage
}

/**
 * Build a JSON body from present arguments only.
 * @param args - caller arguments in camelCase.
 * @param fields - argument-to-body-key mapping to copy.
 * @returns the body object with only the provided fields.
 */
function issueBody(args: Record<string, unknown>, fields: Record<string, string>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const [arg, key] of Object.entries(fields)) {
    if (args[arg] !== undefined) body[key] = args[arg]
  }
  return body
}

/**
 * Compose one list-tool envelope from a normalized page.
 * @param key - output key naming the rows (projects, issues, comments, items).
 * @param results - projected rows.
 * @param page - the normalized page.
 * @returns the canonical output value.
 */
function pageEnvelope<K extends string>(
  key: K,
  results: Record<string, JsonValue>[],
  page: Pick<Page<Record<string, unknown>>, 'totalCount' | 'nextCursor' | 'hasNextPage'>,
): { [P in K]: Record<string, JsonValue>[] } & { totalCount?: number, nextCursor?: string, hasNextPage: boolean } {
  const out = { [key]: results, hasNextPage: page.hasNextPage } as unknown as {
    [P in K]: Record<string, JsonValue>[]
  } & { totalCount?: number, nextCursor?: string, hasNextPage: boolean }
  if (page.totalCount !== undefined) out.totalCount = page.totalCount
  if (page.nextCursor !== undefined) out.nextCursor = page.nextCursor
  return out
}

/**
 * Render projected rows as compact text lines.
 * @param title - header line.
 * @param rows - projected rows.
 * @param line - per-row renderer.
 * @returns one text content block.
 */
function renderLines(
  title: string,
  rows: readonly Record<string, unknown>[],
  line: (row: Record<string, unknown>) => string,
): { type: 'text', text: string }[] {
  if (rows.length === 0) return [{ type: 'text', text: title + ': no results.' }]
  const body = rows.map(row => '- ' + line(row)).join('\n')
  return [{ type: 'text', text: title + ' (' + String(rows.length) + '):\n' + body }]
}

/** Page-tail parameters shared by list tools. */
const PAGE_PARAMS = {
  workspace: { type: 'string', description: 'Workspace slug; defaults to the configured workspaceSlug.' },
  cursor: { type: 'string', description: 'Pagination cursor from a previous page (nextCursor).' },
  perPage: { type: 'integer', description: 'Page size, 1-100; defaults to the configured perPage.' },
  orderBy: { type: 'string', description: 'Field to order by, prefix with - for descending (e.g. -created_at).' },
} as const

/** Project parameter shared by project-scoped tools. */
const PROJECT_PARAM = {
  projectId: { type: 'string', description: 'Plane project id (uuid); defaults to the configured defaultProjectId.' },
} as const

/** Workspace parameter alone, for tools without paging. */
const WORKSPACE_PARAM = {
  workspace: { type: 'string', description: 'Workspace slug; defaults to the configured workspaceSlug.' },
} as const

/**
 * Tool: list Plane projects page by page.
 * @param getBackend - activation backend factory.
 * @param config - activation config.
 * @returns the tool definition.
 */
function planeListProjects(getBackend: BackendFactory, getConfig: () => Config): ToolDefinition {
  return defineTool({
    name: 'plane_list_projects',
    description: 'List projects in a Plane workspace, one cursor page at a time. Triggers: discover the project id '
      + 'needed by every other plane tool, survey active projects, find a project by name.',
    parameters: { ...PAGE_PARAMS },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          projects: { type: 'array', required: true, items: { type: 'json' } },
          totalCount: { type: 'integer' },
          nextCursor: { type: 'string' },
          hasNextPage: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => renderLines('Plane projects', value.projects as Record<string, unknown>[], row => {
        const label = typeof row.identifier === 'string' && row.identifier.length > 0 ? row.identifier : ''
        return (label + ' ' + String(row.name ?? '')).trim() + ' (' + String(row.id) + ')'
      }),
    },
    async execute(args, exec) {
      const config = getConfig()
      const client = await getBackend()
      const payload = await client.request(
        'GET',
        '/workspaces/' + encodeURIComponent(workspaceOf(config, args.workspace)) + '/projects/',
        {
          query: {
            cursor: args.cursor,
            per_page: perPageOf(config, args.perPage),
            order_by: args.orderBy,
          },
          signal: exec.signal,
        },
      )
      const page = client.pageOf(payload)
      return pageEnvelope('projects', projectRows(page.results, projectKeys), page)
    },
  })
}

/**
 * Tool: create a project.
 * @param getBackend - activation backend factory.
 * @param config - activation config.
 * @returns the tool definition.
 */
function planeCreateProject(getBackend: BackendFactory, getConfig: () => Config): ToolDefinition {
  return defineTool({
    name: 'plane_create_project',
    description: 'Create a Plane project. Triggers: start tracking work for a new effort, split work into a separate '
      + 'board. New projects get Plane\'s default workflow states.',
    parameters: {
      name: { type: 'string', required: true, description: 'Project name.' },
      identifier: { type: 'string', required: true, description: 'Short project key prepended to work-item ids (e.g. ENG in ENG-12); 1-12 letters or digits.' },
      description: { type: 'string', description: 'Project description.' },
      network: { type: 'string', enum: ['secret', 'public'], description: 'Visibility: secret (default) or public.' },
      ...WORKSPACE_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { project: { type: 'json', required: true } },
      },
      render: (_args, value) => renderLines('Created Plane project', [value.project as Record<string, unknown>], row => {
        return String(row.identifier ?? '') + ' ' + String(row.name ?? '') + ' (' + String(row.id) + ')'
      }),
    },
    async execute(args, exec) {
      const config = getConfig()
      if (args.name.trim().length === 0) throw new Error('name must be a non-empty string')
      const client = await getBackend()
      const body: Record<string, unknown> = { name: args.name, identifier: args.identifier }
      if (args.description !== undefined) body.description = args.description
      if (args.network !== undefined) body.network = args.network
      const project = await client.request(
        'POST',
        '/workspaces/' + encodeURIComponent(workspaceOf(config, args.workspace)) + '/projects/',
        { body, signal: exec.signal },
      )
      return { project: project as JsonValue }
    },
  })
}

/**
 * Tool: partially update a project.
 * @param getBackend - activation backend factory.
 * @param config - activation config.
 * @returns the tool definition.
 */
function planeUpdateProject(getBackend: BackendFactory, getConfig: () => Config): ToolDefinition {
  return defineTool({
    name: 'plane_update_project',
    description: 'Partially update one Plane project: rename, change its identifier, description, or visibility. '
      + 'Triggers: correct a typo in a project name, retarget the project key.',
    parameters: {
      projectId: { type: 'string', required: true, description: 'Plane project id (uuid).' },
      name: { type: 'string', description: 'New project name.' },
      identifier: { type: 'string', description: 'New short project key, 1-12 letters or digits.' },
      description: { type: 'string', description: 'New description.' },
      network: { type: 'string', enum: ['secret', 'public'], description: 'New visibility.' },
      ...WORKSPACE_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { project: { type: 'json', required: true } },
      },
      render: (_args, value) => renderLines('Updated Plane project', [value.project as Record<string, unknown>], row => {
        return String(row.identifier ?? '') + ' ' + String(row.name ?? '') + ' (' + String(row.id) + ')'
      }),
    },
    async execute(args, exec) {
      const config = getConfig()
      const body: Record<string, unknown> = {}
      if (args.name !== undefined) body.name = args.name
      if (args.identifier !== undefined) body.identifier = args.identifier
      if (args.description !== undefined) body.description = args.description
      if (args.network !== undefined) body.network = args.network
      if (Object.keys(body).length === 0) {
        throw new Error('provide at least one field to update (name, identifier, description, network)')
      }
      const client = await getBackend()
      const project = await client.request(
        'PATCH',
        '/workspaces/' + encodeURIComponent(workspaceOf(config, args.workspace)) + '/projects/' + encodeURIComponent(args.projectId) + '/',
        { body, signal: exec.signal },
      )
      return { project: project as JsonValue }
    },
  })
}

/**
 * Tool: list work items in one project.
 * @param getBackend - activation backend factory.
 * @param config - activation config.
 * @returns the tool definition.
 */
function planeListIssues(getBackend: BackendFactory, getConfig: () => Config): ToolDefinition {
  return defineTool({
    name: 'plane_list_issues',
    description: 'List work items (issues) in one Plane project, one cursor page at a time; order by -created_at for '
      + 'newest first. Filter by state/priority/assignee by reading pages and selecting rows; use '
      + 'plane_search_issues for text lookup. Triggers: enumerate a project backlog or board.',
    parameters: { ...PAGE_PARAMS, ...PROJECT_PARAM },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          issues: { type: 'array', required: true, items: { type: 'json' } },
          totalCount: { type: 'integer' },
          nextCursor: { type: 'string' },
          hasNextPage: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => renderLines('Plane work items', value.issues as Record<string, unknown>[], issueLine),
    },
    async execute(args, exec) {
      const config = getConfig()
      const client = await getBackend()
      const payload = await client.requestItems('GET', {
        workspace: workspaceOf(config, args.workspace),
        project: projectOf(config, args.projectId),
      }, {
        query: { cursor: args.cursor, per_page: perPageOf(config, args.perPage), order_by: args.orderBy },
        signal: exec.signal,
      })
      const page = client.pageOf(payload)
      return pageEnvelope('issues', projectRows(page.results, issueKeys), page)
    },
  })
}

/**
 * Tool: search work items by text.
 * @param getBackend - activation backend factory.
 * @param config - activation config.
 * @returns the tool definition.
 */
function planeSearchIssues(getBackend: BackendFactory, getConfig: () => Config): ToolDefinition {
  return defineTool({
    name: 'plane_search_issues',
    description: 'Search Plane work items by name, description, or identifier (e.g. ENG-123) across the workspace or '
      + 'within one project. Triggers: find an issue by title or key, locate the id before an update or comment.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search text: a name fragment, description words, or an identifier like ENG-123.' },
      ...PROJECT_PARAM,
      ...WORKSPACE_PARAM,
      limit: { type: 'integer', description: 'Maximum results to return; defaults to 25.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          results: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render: (_args, value) => renderLines('Plane search', value.results as Record<string, unknown>[], issueLine),
    },
    async execute(args, exec) {
      const config = getConfig()
      const client = await getBackend()
      const projectId = (args.projectId ?? config.defaultProjectId).trim()
      const payload = await client.requestItems('GET', { workspace: workspaceOf(config, args.workspace), tail: 'search' }, {
        query: {
          search: args.query,
          project_id: projectId.length > 0 ? projectId : undefined,
          workspace_search: projectId.length > 0 ? undefined : 'true',
          limit: args.limit === undefined ? undefined : Math.max(1, Math.min(100, Math.trunc(args.limit))),
        },
        signal: exec.signal,
      })
      const page = client.pageOf(payload)
      return { results: projectRows(page.results, issueKeys) }
    },
  })
}

/**
 * Tool: fetch one work item with full detail.
 * @param getBackend - activation backend factory.
 * @param config - activation config.
 * @returns the tool definition.
 */
function planeGetIssue(getBackend: BackendFactory, getConfig: () => Config): ToolDefinition {
  return defineTool({
    name: 'plane_get_issue',
    description: 'Fetch one Plane work item by id with its full payload: description, state, assignees, labels, dates. '
      + 'Triggers: read an issue before editing it, inspect its full description.',
    parameters: {
      issueId: { type: 'string', required: true, description: 'Work item id (uuid).' },
      ...PROJECT_PARAM,
      ...WORKSPACE_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { issue: { type: 'json', required: true } },
      },
      render: (_args, value) => renderLines('Plane work item', [value.issue as Record<string, unknown>], issueLine),
    },
    async execute(args, exec) {
      const config = getConfig()
      const client = await getBackend()
      const issue = await client.requestItems('GET', {
        workspace: workspaceOf(config, args.workspace),
        project: projectOf(config, args.projectId),
        tail: encodeURIComponent(args.issueId),
      }, { signal: exec.signal })
      return { issue: issue as JsonValue }
    },
  })
}

/**
 * Tool: create a work item.
 * @param getBackend - activation backend factory.
 * @param config - activation config.
 * @returns the tool definition.
 */
function planeCreateIssue(getBackend: BackendFactory, getConfig: () => Config): ToolDefinition {
  return defineTool({
    name: 'plane_create_issue',
    description: 'Create a Plane work item. Triggers: file work found during coding or research into the tracker, '
      + 'plan multi-step work as trackable items, record a decision or follow-up.',
    parameters: {
      name: { type: 'string', required: true, description: 'Work item title.' },
      descriptionHtml: { type: 'string', description: 'Description as HTML (e.g. p-tagged paragraphs); plain text is accepted as one paragraph.' },
      priority: { type: 'string', enum: [...PRIORITIES], description: 'Priority: urgent, high, medium, low, or none.' },
      state: { type: 'string', description: 'Target state id from plane_list_metadata resource=states; the project default applies when omitted.' },
      assignees: { type: 'array', items: { type: 'string' }, description: 'Assignee member ids.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Label ids from plane_list_metadata resource=labels.' },
      parent: { type: 'string', description: 'Parent work item id, making this a sub-item.' },
      startDate: { type: 'string', description: 'Start date, YYYY-MM-DD.' },
      targetDate: { type: 'string', description: 'Target date, YYYY-MM-DD.' },
      isDraft: { type: 'boolean', description: 'Create as a draft.' },
      ...PROJECT_PARAM,
      ...WORKSPACE_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { issue: { type: 'json', required: true } },
      },
      render: (_args, value) => renderLines('Created Plane work item', [value.issue as Record<string, unknown>], issueLine),
    },
    async execute(args, exec) {
      const config = getConfig()
      if (args.name.trim().length === 0) throw new Error('name must be a non-empty string')
      const client = await getBackend()
      const issue = await client.requestItems('POST', {
        workspace: workspaceOf(config, args.workspace),
        project: projectOf(config, args.projectId),
      }, { body: issueBody(args as unknown as Record<string, unknown>, ISSUE_BODY_FIELDS), signal: exec.signal })
      return { issue: issue as JsonValue }
    },
  })
}

/**
 * Tool: update a work item partially.
 * @param getBackend - activation backend factory.
 * @param config - activation config.
 * @returns the tool definition.
 */
function planeUpdateIssue(getBackend: BackendFactory, getConfig: () => Config): ToolDefinition {
  return defineTool({
    name: 'plane_update_issue',
    description: 'Partially update one Plane work item: rename, reprioritize, move across states, reassign, set dates. '
      + 'Triggers: change status after finishing work, adjust priority or assignment, edit a description.',
    parameters: {
      issueId: { type: 'string', required: true, description: 'Work item id (uuid).' },
      name: { type: 'string', description: 'New title.' },
      descriptionHtml: { type: 'string', description: 'New description as HTML; replaces the whole description.' },
      priority: { type: 'string', enum: [...PRIORITIES], description: 'New priority.' },
      state: { type: 'string', description: 'New state id from plane_list_metadata resource=states.' },
      assignees: { type: 'array', items: { type: 'string' }, description: 'Replacement assignee member ids (whole-list replacement).' },
      labels: { type: 'array', items: { type: 'string' }, description: 'Replacement label ids (whole-list replacement).' },
      parent: { type: 'string', description: 'New parent work item id.' },
      startDate: { type: 'string', description: 'New start date, YYYY-MM-DD.' },
      targetDate: { type: 'string', description: 'New target date, YYYY-MM-DD.' },
      isDraft: { type: 'boolean', description: 'Draft flag.' },
      ...PROJECT_PARAM,
      ...WORKSPACE_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { issue: { type: 'json', required: true } },
      },
      render: (_args, value) => renderLines('Updated Plane work item', [value.issue as Record<string, unknown>], issueLine),
    },
    async execute(args, exec) {
      const config = getConfig()
      const client = await getBackend()
      const body = issueBody(args as unknown as Record<string, unknown>, ISSUE_BODY_FIELDS)
      if (Object.keys(body).length === 0) {
        throw new Error(
          'provide at least one field to update (name, descriptionHtml, priority, state, assignees, labels, parent, startDate, targetDate, isDraft)',
        )
      }
      const issue = await client.requestItems('PATCH', {
        workspace: workspaceOf(config, args.workspace),
        project: projectOf(config, args.projectId),
        tail: encodeURIComponent(args.issueId),
      }, { body, signal: exec.signal })
      return { issue: issue as JsonValue }
    },
  })
}

/**
 * Tool: delete a work item.
 * @param getBackend - activation backend factory.
 * @param config - activation config.
 * @returns the tool definition.
 */
function planeDeleteIssue(getBackend: BackendFactory, getConfig: () => Config): ToolDefinition {
  return defineTool({
    name: 'plane_delete_issue',
    description: 'Delete one Plane work item permanently. Triggers: remove a duplicate or wrongly-filed item; '
      + 'prefer closing via a plane_update_issue state change.',
    parameters: {
      issueId: { type: 'string', required: true, description: 'Work item id (uuid).' },
      ...PROJECT_PARAM,
      ...WORKSPACE_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          deleted: { type: 'boolean', required: true },
          issueId: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: 'Deleted Plane work item ' + String(value.issueId) + '.' }],
    },
    async execute(args, exec) {
      const config = getConfig()
      const client = await getBackend()
      await client.requestItems('DELETE', {
        workspace: workspaceOf(config, args.workspace),
        project: projectOf(config, args.projectId),
        tail: encodeURIComponent(args.issueId),
      }, { signal: exec.signal })
      return { deleted: true, issueId: args.issueId }
    },
  })
}

/**
 * Tool: list comments on one work item.
 * @param getBackend - activation backend factory.
 * @param config - activation config.
 * @returns the tool definition.
 */
function planeListIssueComments(getBackend: BackendFactory, getConfig: () => Config): ToolDefinition {
  return defineTool({
    name: 'plane_list_issue_comments',
    description: 'List comments on one Plane work item, one cursor page at a time. Triggers: read the discussion '
      + 'before replying or changing an issue.',
    parameters: {
      issueId: { type: 'string', required: true, description: 'Work item id (uuid).' },
      ...PAGE_PARAMS,
      ...PROJECT_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          comments: { type: 'array', required: true, items: { type: 'json' } },
          totalCount: { type: 'integer' },
          nextCursor: { type: 'string' },
          hasNextPage: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => renderLines('Plane comments', value.comments as Record<string, unknown>[], row => {
        const who = String(row.created_by ?? 'unknown')
        const when = String(row.created_at ?? '')
        const text = String(row.comment_stripped ?? row.comment_html ?? '')
        return who + ' ' + when + ': ' + text.slice(0, 200)
      }),
    },
    async execute(args, exec) {
      const config = getConfig()
      const client = await getBackend()
      const payload = await client.requestItems('GET', {
        workspace: workspaceOf(config, args.workspace),
        project: projectOf(config, args.projectId),
        tail: encodeURIComponent(args.issueId) + '/comments',
      }, {
        query: { cursor: args.cursor, per_page: perPageOf(config, args.perPage), order_by: args.orderBy },
        signal: exec.signal,
      })
      const page = client.pageOf(payload)
      return pageEnvelope('comments', projectRows(page.results, commentKeys), page)
    },
  })
}

/**
 * Tool: comment on one work item.
 * @param getBackend - activation backend factory.
 * @param config - activation config.
 * @returns the tool definition.
 */
function planeCreateIssueComment(getBackend: BackendFactory, getConfig: () => Config): ToolDefinition {
  return defineTool({
    name: 'plane_create_issue_comment',
    description: 'Add a comment to one Plane work item as the API-key owner. Triggers: report progress or findings on '
      + 'a tracked issue, answer a question in the discussion, leave a decision record.',
    parameters: {
      issueId: { type: 'string', required: true, description: 'Work item id (uuid).' },
      commentHtml: { type: 'string', required: true, description: 'Comment content as HTML (e.g. p-tagged paragraphs); plain text becomes one paragraph.' },
      ...PROJECT_PARAM,
      ...WORKSPACE_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { comment: { type: 'json', required: true } },
      },
      render: () => [{ type: 'text', text: 'Posted the Plane comment.' }],
    },
    async execute(args, exec) {
      const config = getConfig()
      if (args.commentHtml.trim().length === 0) throw new Error('commentHtml must be a non-empty string')
      const client = await getBackend()
      const comment = await client.requestItems('POST', {
        workspace: workspaceOf(config, args.workspace),
        project: projectOf(config, args.projectId),
        tail: encodeURIComponent(args.issueId) + '/comments',
      }, { body: { comment_html: args.commentHtml }, signal: exec.signal })
      return { comment: comment as JsonValue }
    },
  })
}

/**
 * Tool: list project metadata (states, labels, cycles).
 * @param getBackend - activation backend factory.
 * @param config - activation config.
 * @returns the tool definition.
 */
function planeListMetadata(getBackend: BackendFactory, getConfig: () => Config): ToolDefinition {
  return defineTool({
    name: 'plane_list_metadata',
    description: 'List one project metadata kind: states (workflow columns with their group), labels, or cycles '
      + '(iterations with dates). Triggers: resolve the state id for plane_update_issue or plane_create_issue, '
      + 'pick label ids, choose the current cycle.',
    parameters: {
      resource: { type: 'string', required: true, enum: ['states', 'labels', 'cycles'], description: 'Which metadata kind to list.' },
      ...PAGE_PARAMS,
      ...PROJECT_PARAM,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          resource: { type: 'string', required: true },
          items: { type: 'array', required: true, items: { type: 'json' } },
          totalCount: { type: 'integer' },
          nextCursor: { type: 'string' },
          hasNextPage: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => renderLines('Plane ' + String(value.resource), value.items as Record<string, unknown>[], row => {
        const name = String(row.name ?? row.id)
        const group = row.group === undefined ? '' : ' [' + String(row.group) + ']'
        const dates = row.start_date === undefined ? '' : ' ' + String(row.start_date) + '..' + String(row.end_date ?? '')
        return (name + group + dates).trim() + ' (' + String(row.id) + ')'
      }),
    },
    async execute(args, exec) {
      const config = getConfig()
      const client = await getBackend()
      const resource = args.resource as MetadataResource
      const payload = await client.request(
        'GET',
        '/workspaces/' + encodeURIComponent(workspaceOf(config, args.workspace))
          + '/projects/' + encodeURIComponent(projectOf(config, args.projectId)) + '/' + resource + '/',
        { query: { cursor: args.cursor, per_page: perPageOf(config, args.perPage) }, signal: exec.signal },
      )
      const page = client.pageOf(payload)
      return {
        resource: args.resource,
        items: projectRows(page.results, metadataKeys(resource)),
        ...(page.totalCount === undefined ? {} : { totalCount: page.totalCount }),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        hasNextPage: page.hasNextPage,
      }
    },
  })
}

/**
 * Tool: raw request against any Plane endpoint.
 * @param getBackend - activation backend factory.
 * @returns the tool definition.
 */
function planeRequest(getBackend: BackendFactory): ToolDefinition {
  return defineTool({
    name: 'plane_request',
    description: 'Raw request to the Plane REST API for everything the named tools do not cover: modules, intake, '
      + 'milestones, members, teamspaces, project CRUD, cycle work-item transfer, and more. Paths are rooted at '
      + '/api/v1 (e.g. workspaces/my-team/projects/ or workspaces/my-team/projects/<id>/modules/). '
      + 'Triggers: a Plane endpoint outside the plane_* tool set.',
    parameters: {
      method: { type: 'string', required: true, enum: ['GET', 'POST', 'PATCH', 'DELETE'], description: 'HTTP verb.' },
      path: { type: 'string', required: true, description: 'API path with or without the /api/v1 prefix; parameters go in query and body, not the path.' },
      query: { type: 'object', additionalProperties: true, description: 'Query parameters as string, number, or boolean values.' },
      body: { type: 'json', description: 'JSON request body for POST and PATCH.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { body: { type: 'json', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: 'Plane response: ' + JSON.stringify(value.body).slice(0, 2000) }],
    },
    async execute(args, exec) {
      const client = await getBackend()
      const body = await client.request(args.method, args.path, {
        query: normalizeQuery(args.query),
        body: args.body,
        signal: exec.signal,
      })
      return { body: body as JsonValue }
    },
  })
}

/**
 * Narrow a free-form query object to scalar query values.
 * @param query - caller-supplied query object.
 * @returns query values safe for URL composition.
 */
function normalizeQuery(query: Record<string, unknown> | undefined): Record<string, string | number | boolean | undefined> {
  if (query === undefined) return {}
  const out: Record<string, string | number | boolean | undefined> = {}
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    } else {
      out[key] = JSON.stringify(value)
    }
  }
  return out
}
