/**
 * Row serializers: internal engine rows projected onto the public /api/v1
 * response shapes (field names, null vs absent, and derived values such as
 * work-item identifiers and cycle currency). Contract reference is the
 * official API reference; fields the engine does not model are omitted rather
 * than invented.
 *
 * @module dsh-plane/engine/serializers
 */

import type { Cycle, Comment, IssueLink, Label, Module, Project, State, WorkItem } from './models.ts'

/** Read-model rows the serializers close over. */
export interface EngineSnapshot {
  projects: readonly Project[]
  states: readonly State[]
  labels: readonly Label[]
  cycles: readonly Cycle[]
  modules: readonly Module[]
  workItems: readonly WorkItem[]
  comments: readonly Comment[]
  links: readonly IssueLink[]
}

/**
 * Strip HTML down to readable plain text: drop tags, collapse whitespace, and
 * decode the handful of entities descriptions actually use.
 * @param html - the HTML fragment.
 * @returns the plain text.
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/**
 * Serialize one project row.
 * @param project - the stored row.
 * @param snapshot - derived-count context.
 * @returns the API row.
 */
export function serializeProject(project: Project, snapshot: EngineSnapshot): Record<string, unknown> {
  return {
    id: project.id,
    name: project.name,
    identifier: project.identifier,
    description: project.description,
    network: project.network,
    total_members: 1,
    total_cycles: snapshot.cycles.filter(row => row.projectId === project.id).length,
    total_modules: snapshot.modules.filter(row => row.projectId === project.id).length,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
    archived_at: project.archivedAt ?? null,
  }
}

/**
 * Serialize one workflow state row.
 * @param state - the stored row.
 * @returns the API row.
 */
export function serializeState(state: State): Record<string, unknown> {
  return {
    id: state.id,
    name: state.name,
    group: state.group,
    color: state.color,
    sequence: state.sequence,
    default: state.isDefault,
    description: state.description,
    project_id: state.projectId,
    created_at: state.createdAt,
    updated_at: state.updatedAt,
  }
}

/**
 * Serialize one label row.
 * @param label - the stored row.
 * @returns the API row.
 */
export function serializeLabel(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    name: label.name,
    color: label.color,
    description: label.description,
    parent: label.parentId ?? null,
    sort_order: label.sortOrder,
    project_id: label.projectId,
    created_at: label.createdAt,
    updated_at: label.updatedAt,
  }
}

/**
 * Derive a cycle's status from its dates, Plane-style.
 * @param cycle - the stored row.
 * @returns current, upcoming, completed, or draft (undated).
 */
export function cycleStatus(cycle: Cycle): 'current' | 'upcoming' | 'completed' | 'draft' {
  if (cycle.startDate === undefined || cycle.endDate === undefined) return 'draft'
  const today = todayIso()
  if (today > cycle.endDate) return 'completed'
  if (today < cycle.startDate) return 'upcoming'
  return 'current'
}

/**
 * Serialize one cycle row with derived currency and progress.
 * @param cycle - the stored row.
 * @param snapshot - derived-count context.
 * @returns the API row.
 */
export function serializeCycle(cycle: Cycle, snapshot: EngineSnapshot): Record<string, unknown> {
  const items = snapshot.workItems.filter(row => row.cycleId === cycle.id)
  const completed = items.filter(row => {
    const state = snapshot.states.find(candidate => candidate.id === row.stateId)
    return state?.group === 'completed'
  }).length
  const status = cycleStatus(cycle)
  return {
    id: cycle.id,
    name: cycle.name,
    description: cycle.description,
    start_date: cycle.startDate ?? null,
    end_date: cycle.endDate ?? null,
    is_current: status === 'current',
    is_favorite: false,
    status,
    progress_snapshot: { completed, total: items.length },
    created_at: cycle.createdAt,
    updated_at: cycle.updatedAt,
  }
}

/**
 * Serialize one module row.
 * @param module - the stored row.
 * @returns the API row.
 */
export function serializeModule(module: Module): Record<string, unknown> {
  return {
    id: module.id,
    name: module.name,
    description: module.description,
    status: module.status,
    start_date: module.startDate ?? null,
    target_date: module.targetDate ?? null,
    created_at: module.createdAt,
    updated_at: module.updatedAt,
  }
}

/**
 * Serialize one work item row, joining derived fields (identifier, sub-issue
 * count) and mapping relation ids onto the public names.
 * @param item - the stored row.
 * @param snapshot - lookup context.
 * @returns the API row.
 */
export function serializeWorkItem(item: WorkItem, snapshot: EngineSnapshot): Record<string, unknown> {
  const project = snapshot.projects.find(row => row.id === item.projectId)
  return {
    id: item.id,
    name: item.name,
    description_html: item.descriptionHtml,
    description_stripped: stripHtml(item.descriptionHtml),
    priority: item.priority,
    state: item.stateId,
    sequence_id: item.sequenceId,
    identifier: project === undefined ? undefined : project.identifier + '-' + item.sequenceId,
    sort_order: item.sortOrder,
    is_draft: item.isDraft,
    parent: item.parentId ?? null,
    labels: [...item.labelIds],
    assignees: [...item.assigneeIds],
    start_date: item.startDate ?? null,
    target_date: item.targetDate ?? null,
    cycle: item.cycleId ?? null,
    module_ids: [...item.moduleIds],
    type: null,
    sub_issues_count: snapshot.workItems.filter(row => row.parentId === item.id).length,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    completed_at: item.completedAt ?? null,
    archived_at: item.archivedAt ?? null,
  }
}

/**
 * Serialize one comment row.
 * @param comment - the stored row.
 * @param actorId - the local member the engine acts as.
 * @returns the API row.
 */
export function serializeComment(comment: Comment, actorId: string): Record<string, unknown> {
  return {
    id: comment.id,
    comment_html: comment.commentHtml,
    comment_stripped: stripHtml(comment.commentHtml),
    access: comment.access,
    actor: actorId,
    issue: comment.workItemId,
    created_by: actorId,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  }
}

/**
 * Serialize one external link row.
 * @param link - the stored row.
 * @returns the API row.
 */
export function serializeLink(link: IssueLink): Record<string, unknown> {
  return {
    id: link.id,
    title: link.title,
    url: link.url,
    created_at: link.createdAt,
    updated_at: link.updatedAt,
  }
}

/**
 * Today's date in the ISO yyyy-mm-dd form date comparisons use.
 * @returns the local date string.
 */
function todayIso(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return now.getFullYear() + '-' + month + '-' + day
}
