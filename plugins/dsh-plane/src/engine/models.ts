/**
 * Domain types for the in-process Plane engine. Field names and semantics
 * follow the public /api/v1 contract (the Plane model fields the official
 * serializers expose): work items carry sequence ids per project, states are
 * grouped into Plane's five workflow groups, and every row keeps the audit
 * quartet so list tools and external clients see familiar shapes.
 *
 * @module dsh-plane/engine/models
 */

/** Plane work-item priorities, in Plane's own vocabulary. */
export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const

/** Plane state groups, in workflow order. */
export const STATE_GROUPS = ['backlog', 'unstarted', 'started', 'completed', 'cancelled'] as const

/** Cycle statuses derived from dates, in Plane's vocabulary. */
export const CYCLE_STATUSES = ['current', 'upcoming', 'completed', 'draft'] as const

/** Module statuses, in Plane's vocabulary. */
export const MODULE_STATUSES = ['backlog', 'planned', 'in-progress', 'paused', 'completed', 'cancelled'] as const

/** A Plane work-item priority. */
export type Priority = (typeof PRIORITIES)[number]

/** A Plane state group. */
export type StateGroup = (typeof STATE_GROUPS)[number]

/** A cycle status derived from its dates. */
export type CycleStatus = (typeof CYCLE_STATUSES)[number]

/** A module status. */
export type ModuleStatus = (typeof MODULE_STATUSES)[number]

/** One workspace row. */
export interface Workspace {
  id: string
  slug: string
  name: string
  createdAt: string
  updatedAt: string
}

/** One project row; `sequenceCount` is the per-project work-item counter. */
export interface Project {
  id: string
  workspaceId: string
  name: string
  identifier: string
  description: string
  network: 'secret' | 'public'
  sequenceCount: number
  createdAt: string
  updatedAt: string
  archivedAt: string | undefined
}

/** One workflow state row. */
export interface State {
  id: string
  projectId: string
  name: string
  group: StateGroup
  color: string
  sequence: number
  isDefault: boolean
  description: string
  createdAt: string
  updatedAt: string
}

/** One label row. */
export interface Label {
  id: string
  projectId: string
  name: string
  color: string
  description: string
  parentId: string | undefined
  sortOrder: number
  createdAt: string
  updatedAt: string
}

/** One cycle row; `isCurrent` is derived from dates on read. */
export interface Cycle {
  id: string
  projectId: string
  name: string
  description: string
  startDate: string | undefined
  endDate: string | undefined
  createdAt: string
  updatedAt: string
}

/** One module row. */
export interface Module {
  id: string
  projectId: string
  name: string
  description: string
  status: ModuleStatus
  startDate: string | undefined
  targetDate: string | undefined
  createdAt: string
  updatedAt: string
}

/** One work item row. */
export interface WorkItem {
  id: string
  projectId: string
  name: string
  descriptionHtml: string
  priority: Priority
  stateId: string
  sequenceId: number
  sortOrder: number
  isDraft: boolean
  parentId: string | undefined
  labelIds: string[]
  assigneeIds: string[]
  startDate: string | undefined
  targetDate: string | undefined
  cycleId: string | undefined
  moduleIds: string[]
  createdAt: string
  updatedAt: string
  completedAt: string | undefined
  archivedAt: string | undefined
}

/** One comment row; `access` mirrors Plane's INTERNAL/EXTERNAL vocabulary. */
export interface Comment {
  id: string
  workItemId: string
  commentHtml: string
  access: 'INTERNAL' | 'EXTERNAL'
  parentId: string | undefined
  createdAt: string
  updatedAt: string
}

/** One external link row on a work item. */
export interface IssueLink {
  id: string
  workItemId: string
  title: string
  url: string
  createdAt: string
  updatedAt: string
}

/** The single local member the engine acts as (v1 is single-principal). */
export interface LocalMember {
  id: string
  displayName: string
  email: string
}

/** The whole persisted store payload; versioned for forward migration. */
export interface StoreData {
  version: 1
  apiKey: string
  member: LocalMember
  workspaces: Workspace[]
  projects: Project[]
  states: State[]
  labels: Label[]
  cycles: Cycle[]
  modules: Module[]
  workItems: WorkItem[]
  comments: Comment[]
  links: IssueLink[]
}

/** The seeded default workspace slug the engine creates on first boot. */
export const DEFAULT_WORKSPACE_SLUG = 'dsh'

/** The seeded default project name and identifier. */
export const DEFAULT_PROJECT = { name: 'General', identifier: 'DSH' } as const

/** Plane's default workflow states seeded into every new project. */
export const DEFAULT_STATES: readonly { name: string, group: StateGroup, color: string, sequence: number }[] = [
  { name: 'Backlog', group: 'backlog', color: '#a3a3a3', sequence: 15000 },
  { name: 'Todo', group: 'unstarted', color: '#3a3a3a', sequence: 25000 },
  { name: 'In Progress', group: 'started', color: '#f59e0b', sequence: 35000 },
  { name: 'Done', group: 'completed', color: '#16a34a', sequence: 45000 },
  { name: 'Cancelled', group: 'cancelled', color: '#dc2626', sequence: 55000 },
]
