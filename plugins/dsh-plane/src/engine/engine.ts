/**
 * The in-process Plane engine: domain operations over the JSON store. One
 * instance per activation, synchronous reads and mutations over an in-memory
 * snapshot, with every mutation queued onto a serial save chain so concurrent
 * tool calls cannot interleave partial file writes. On first boot the engine
 * seeds one workspace, one project, and Plane's default workflow states.
 *
 * @module dsh-plane/engine/engine
 */

import { randomUUID } from 'node:crypto'
import { generateLocalKey } from './key.ts'
import {
  DEFAULT_PROJECT,
  DEFAULT_STATES,
  DEFAULT_WORKSPACE_SLUG,
  MODULE_STATUSES,
  PRIORITIES,
  STATE_GROUPS,
} from './models.ts'
import type {
  Comment,
  Cycle,
  IssueLink,
  Label,
  LocalMember,
  Module,
  Priority,
  Project,
  State,
  StateGroup,
  StoreData,
  WorkItem,
  Workspace,
} from './models.ts'
import { normalizeOrder, paginate } from './pagination.ts'
import type { Paginated } from './pagination.ts'
import {
  serializeCycle,
  serializeComment,
  serializeLabel,
  serializeLink,
  serializeModule,
  serializeProject,
  serializeState,
  serializeWorkItem,
  stripHtml,
} from './serializers.ts'
import type { EngineSnapshot } from './serializers.ts'
import { JsonStore } from './store.ts'

/** A domain failure carrying the HTTP status the router should answer with. */
export class EngineError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'EngineError'
    this.status = status
  }
}

/** The `order_by` keys lists accept, mapped onto row fields. */
const ITEM_ORDER_KEYS: Record<string, (row: WorkItem) => string | number | undefined> = {
  created_at: row => row.createdAt,
  updated_at: row => row.updatedAt,
  name: row => row.name.toLowerCase(),
  sequence_id: row => row.sequenceId,
  sort_order: row => row.sortOrder,
  start_date: row => row.startDate,
  target_date: row => row.targetDate,
}

/**
 * Open the engine over one store: load the persisted snapshot or seed a fresh
 * one on first boot.
 * @param store - the JSON store to persist through.
 * @returns the ready engine.
 */
export async function openEngine(store: JsonStore): Promise<PlaneEngine> {
  const loaded = await store.load()
  if (loaded !== undefined) return new PlaneEngine(store, loaded)
  const seeded = seedStore()
  const engine = new PlaneEngine(store, seeded)
  await store.save(seeded)
  return engine
}

/**
 * Build a first-boot store: one workspace, one project, default states, and a
 * freshly generated local API key.
 * @returns the seeded store data.
 */
function seedStore(): StoreData {
  const now = new Date().toISOString()
  const workspace: Workspace = {
    id: randomUUID(),
    slug: DEFAULT_WORKSPACE_SLUG,
    name: 'DSH',
    createdAt: now,
    updatedAt: now,
  }
  const project: Project = {
    id: randomUUID(),
    workspaceId: workspace.id,
    name: DEFAULT_PROJECT.name,
    identifier: DEFAULT_PROJECT.identifier,
    description: 'Work items created in the dsh harness land here by default.',
    network: 'secret',
    sequenceCount: 0,
    createdAt: now,
    updatedAt: now,
    archivedAt: undefined,
  }
  const states: State[] = DEFAULT_STATES.map((entry, index) => ({
    id: randomUUID(),
    projectId: project.id,
    name: entry.name,
    group: entry.group,
    color: entry.color,
    sequence: entry.sequence,
    isDefault: entry.group === 'unstarted',
    description: '',
    createdAt: now,
    updatedAt: now,
  }))
  const member: LocalMember = { id: randomUUID(), displayName: 'DSH Local', email: 'dsh@local' }
  return {
    version: 1,
    apiKey: generateLocalKey(),
    member,
    workspaces: [workspace],
    projects: [project],
    states,
    labels: [],
    cycles: [],
    modules: [],
    workItems: [],
    comments: [],
    links: [],
  }
}

/**
 * The domain engine. Mutating methods return the serialized API row; all of
 * them schedule a serial save of the whole store.
 */
export class PlaneEngine {
  private data: StoreData
  private readonly store: JsonStore
  private saveChain: Promise<void> = Promise.resolve()
  private lastSaveError: unknown

  constructor(store: JsonStore, data: StoreData) {
    this.store = store
    this.data = data
  }

  /** The persisted local API key. */
  get apiKey(): string {
    return this.data.apiKey
  }

  /** Replace the local API key (settings card reset). */
  rotateKey(): string {
    this.data.apiKey = generateLocalKey()
    this.scheduleSave()
    return this.data.apiKey
  }

  /** Await every queued save; exposes the last save failure, if any. */
  async flush(): Promise<void> {
    await this.saveChain
    if (this.lastSaveError !== undefined) throw this.lastSaveError
  }

  /** Engine health summary for state routes and the settings card. */
  health(): Record<string, unknown> {
    return {
      workspaces: this.data.workspaces.length,
      projects: this.data.projects.length,
      workItems: this.data.workItems.length,
      comments: this.data.comments.length,
      lastSaveError: this.lastSaveError === undefined ? undefined : String(this.lastSaveError),
    }
  }

  /** Read-only snapshot the serializers close over. */
  snapshot(): EngineSnapshot {
    return {
      projects: this.data.projects,
      states: this.data.states,
      labels: this.data.labels,
      cycles: this.data.cycles,
      modules: this.data.modules,
      workItems: this.data.workItems,
      comments: this.data.comments,
      links: this.data.links,
    }
  }

  /** Resolve one workspace by slug or fail with 404. */
  workspace(slug: string): Workspace {
    const found = this.data.workspaces.find(row => row.slug === slug)
    if (found === undefined) throw new EngineError('workspace not found: ' + slug, 404)
    return found
  }

  /** Resolve one project by id, scoped to a workspace, or fail with 404. */
  project(workspaceId: string, projectId: string): Project {
    const found = this.data.projects.find(row => row.id === projectId && row.workspaceId === workspaceId)
    if (found === undefined) throw new EngineError('project not found: ' + projectId, 404)
    return found
  }

  /** Resolve one project by id across workspaces (engine-internal paths). */
  projectById(projectId: string): Project {
    const found = this.data.projects.find(row => row.id === projectId)
    if (found === undefined) throw new EngineError('project not found: ' + projectId, 404)
    return found
  }

  // ---------------------------------------------------------------- projects

  /** List one workspace's projects, paginated and ordered. */
  listProjects(workspaceId: string, query: PageQuery): Paginated<Record<string, unknown>> {
    const snapshot = this.snapshot()
    const order = normalizeOrder(query.orderBy)
    const keyOf = order.key === 'name' ? (row: Project) => row.name.toLowerCase() : (row: Project) => row.createdAt
    const rows = this.data.projects
      .filter(row => row.workspaceId === workspaceId)
      .sort(byOrder(order, keyOf, row => row.id))
      .map(row => serializeProject(row, snapshot))
    return paginate(rows, query.perPage, query.cursor)
  }

  /** Lite project rows: id, identifier, name only. */
  listProjectsLite(workspaceId: string): Record<string, unknown>[] {
    return this.data.projects
      .filter(row => row.workspaceId === workspaceId)
      .map(row => ({ id: row.id, identifier: row.identifier, name: row.name }))
  }

  /** Create one project (with Plane's default states seeded). */
  createProject(workspaceId: string, body: Record<string, unknown>): Record<string, unknown> {
    const name = requireString(body, 'name')
    const identifier = requireIdentifier(body)
    const clash = this.data.projects.some(row => row.workspaceId === workspaceId && row.identifier === identifier)
    if (clash) throw new EngineError('project identifier already exists in this workspace: ' + identifier, 400)
    const now = new Date().toISOString()
    const project: Project = {
      id: randomUUID(),
      workspaceId,
      name,
      identifier,
      description: optionalString(body, 'description') ?? '',
      network: body.network === 'public' ? 'public' : 'secret',
      sequenceCount: 0,
      createdAt: now,
      updatedAt: now,
      archivedAt: undefined,
    }
    this.data.projects.push(project)
    this.data.states.push(...seedStates(project.id))
    this.scheduleSave()
    return serializeProject(project, this.snapshot())
  }

  /** Fetch one project. */
  getProject(workspaceId: string, projectId: string): Record<string, unknown> {
    return serializeProject(this.project(workspaceId, projectId), this.snapshot())
  }

  /** Partially update one project. */
  updateProject(workspaceId: string, projectId: string, body: Record<string, unknown>): Record<string, unknown> {
    const project = this.project(workspaceId, projectId)
    if (body.name !== undefined) project.name = requireString(body, 'name')
    if (body.description !== undefined) project.description = optionalString(body, 'description') ?? ''
    if (body.network !== undefined) project.network = body.network === 'public' ? 'public' : 'secret'
    if (body.identifier !== undefined) {
      const identifier = requireIdentifier(body)
      const clash = this.data.projects.some(row => row.id !== projectId && row.workspaceId === workspaceId && row.identifier === identifier)
      if (clash) throw new EngineError('project identifier already exists in this workspace: ' + identifier, 400)
      project.identifier = identifier
    }
    project.updatedAt = new Date().toISOString()
    this.scheduleSave()
    return serializeProject(project, this.snapshot())
  }

  /** Delete one project and every dependent row. */
  deleteProject(workspaceId: string, projectId: string): void {
    this.project(workspaceId, projectId)
    const workItemIds = new Set(this.data.workItems.filter(row => row.projectId === projectId).map(row => row.id))
    this.data.workItems = this.data.workItems.filter(row => row.projectId !== projectId)
    this.data.states = this.data.states.filter(row => row.projectId !== projectId)
    this.data.labels = this.data.labels.filter(row => row.projectId !== projectId)
    this.data.cycles = this.data.cycles.filter(row => row.projectId !== projectId)
    this.data.modules = this.data.modules.filter(row => row.projectId !== projectId)
    this.data.comments = this.data.comments.filter(row => !workItemIds.has(row.workItemId))
    this.data.links = this.data.links.filter(row => !workItemIds.has(row.workItemId))
    this.data.projects = this.data.projects.filter(row => row.id !== projectId)
    this.scheduleSave()
  }

  // ------------------------------------------------------------------ states

  /** List one project's states, paginated and ordered by sequence. */
  listStates(projectId: string, query: PageQuery): Paginated<Record<string, unknown>> {
    const rows = this.data.states
      .filter(row => row.projectId === projectId)
      .sort((a, b) => a.sequence - b.sequence)
      .map(row => serializeState(row))
    return paginate(rows, query.perPage, query.cursor)
  }

  /** Create one state. */
  createState(projectId: string, body: Record<string, unknown>): Record<string, unknown> {
    const name = requireString(body, 'name')
    const group = requireEnum(body, 'group', STATE_GROUPS) as StateGroup
    const now = new Date().toISOString()
    const makeDefault = body.default === true
    if (makeDefault) for (const state of this.data.states) if (state.projectId === projectId) state.isDefault = false
    const state: State = {
      id: randomUUID(),
      projectId,
      name,
      group,
      color: optionalString(body, 'color') ?? '#94a3b8',
      sequence: optionalNumber(body, 'sequence') ?? nextSequence(this.data.states, projectId),
      isDefault: makeDefault,
      description: optionalString(body, 'description') ?? '',
      createdAt: now,
      updatedAt: now,
    }
    this.data.states.push(state)
    this.scheduleSave()
    return serializeState(state)
  }

  /** Fetch one state. */
  getState(projectId: string, stateId: string): Record<string, unknown> {
    return serializeState(this.state(projectId, stateId))
  }

  /** Partially update one state. */
  updateState(projectId: string, stateId: string, body: Record<string, unknown>): Record<string, unknown> {
    const state = this.state(projectId, stateId)
    if (body.name !== undefined) state.name = requireString(body, 'name')
    if (body.group !== undefined) state.group = requireEnum(body, 'group', STATE_GROUPS) as StateGroup
    if (body.color !== undefined) state.color = optionalString(body, 'color') ?? state.color
    if (body.sequence !== undefined) state.sequence = optionalNumber(body, 'sequence') ?? state.sequence
    if (body.description !== undefined) state.description = optionalString(body, 'description') ?? ''
    if (body.default === true) {
      for (const candidate of this.data.states) if (candidate.projectId === projectId) candidate.isDefault = candidate.id === stateId
    }
    state.updatedAt = new Date().toISOString()
    this.scheduleSave()
    return serializeState(state)
  }

  /** Delete one state; work items move to the project's remaining default. */
  deleteState(projectId: string, stateId: string): void {
    this.state(projectId, stateId)
    const remaining = this.data.states.filter(row => row.projectId === projectId && row.id !== stateId)
    const fallback = remaining.find(row => row.isDefault) ?? remaining[0]
    if (fallback === undefined) throw new EngineError('cannot delete the last state of a project', 400)
    for (const item of this.data.workItems) if (item.stateId === stateId) item.stateId = fallback.id
    this.data.states = this.data.states.filter(row => row.id !== stateId)
    this.scheduleSave()
  }

  /** Resolve one state scoped to a project or fail with 404. */
  state(projectId: string, stateId: string): State {
    const found = this.data.states.find(row => row.projectId === projectId && row.id === stateId)
    if (found === undefined) throw new EngineError('state not found: ' + stateId, 404)
    return found
  }

  /** The state new work items land in: the default, else the first. */
  defaultState(projectId: string): State | undefined {
    const rows = this.data.states.filter(row => row.projectId === projectId)
    return rows.find(row => row.isDefault) ?? rows[0]
  }

  // ------------------------------------------------------------------ labels

  /** List one project's labels, paginated. */
  listLabels(projectId: string, query: PageQuery): Paginated<Record<string, unknown>> {
    const rows = this.data.labels
      .filter(row => row.projectId === projectId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map(row => serializeLabel(row))
    return paginate(rows, query.perPage, query.cursor)
  }

  /** Create one label. */
  createLabel(projectId: string, body: Record<string, unknown>): Record<string, unknown> {
    const name = requireString(body, 'name')
    const now = new Date().toISOString()
    const label: Label = {
      id: randomUUID(),
      projectId,
      name,
      color: optionalString(body, 'color') ?? '#60a5fa',
      description: optionalString(body, 'description') ?? '',
      parentId: optionalString(body, 'parent'),
      sortOrder: optionalNumber(body, 'sort_order') ?? 65535,
      createdAt: now,
      updatedAt: now,
    }
    if (label.parentId !== undefined && !this.data.labels.some(row => row.id === label.parentId)) {
      throw new EngineError('parent label not found: ' + label.parentId, 400)
    }
    this.data.labels.push(label)
    this.scheduleSave()
    return serializeLabel(label)
  }

  /** Fetch one label. */
  getLabel(projectId: string, labelId: string): Record<string, unknown> {
    return serializeLabel(this.label(projectId, labelId))
  }

  /** Partially update one label. */
  updateLabel(projectId: string, labelId: string, body: Record<string, unknown>): Record<string, unknown> {
    const label = this.label(projectId, labelId)
    if (body.name !== undefined) label.name = requireString(body, 'name')
    if (body.color !== undefined) label.color = optionalString(body, 'color') ?? label.color
    if (body.description !== undefined) label.description = optionalString(body, 'description') ?? ''
    if (body.sort_order !== undefined) label.sortOrder = optionalNumber(body, 'sort_order') ?? label.sortOrder
    if (body.parent !== undefined) label.parentId = optionalString(body, 'parent')
    label.updatedAt = new Date().toISOString()
    this.scheduleSave()
    return serializeLabel(label)
  }

  /** Delete one label and detach it from work items. */
  deleteLabel(projectId: string, labelId: string): void {
    this.label(projectId, labelId)
    for (const item of this.data.workItems) item.labelIds = item.labelIds.filter(id => id !== labelId)
    this.data.labels = this.data.labels.filter(row => row.id !== labelId)
    this.scheduleSave()
  }

  /** Resolve one label scoped to a project or fail with 404. */
  label(projectId: string, labelId: string): Label {
    const found = this.data.labels.find(row => row.projectId === projectId && row.id === labelId)
    if (found === undefined) throw new EngineError('label not found: ' + labelId, 404)
    return found
  }

  // ------------------------------------------------------------------ cycles

  /** List one project's cycles, paginated. */
  listCycles(projectId: string, query: PageQuery): Paginated<Record<string, unknown>> {
    const snapshot = this.snapshot()
    const rows = this.data.cycles
      .filter(row => row.projectId === projectId)
      .sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? '') || a.name.localeCompare(b.name))
      .map(row => serializeCycle(row, snapshot))
    return paginate(rows, query.perPage, query.cursor)
  }

  /** Create one cycle. */
  createCycle(projectId: string, body: Record<string, unknown>): Record<string, unknown> {
    const name = requireString(body, 'name')
    const now = new Date().toISOString()
    const cycle: Cycle = {
      id: randomUUID(),
      projectId,
      name,
      description: optionalString(body, 'description') ?? '',
      startDate: optionalDate(body, 'start_date'),
      endDate: optionalDate(body, 'end_date'),
      createdAt: now,
      updatedAt: now,
    }
    validateCycleRange(cycle)
    this.data.cycles.push(cycle)
    this.scheduleSave()
    return serializeCycle(cycle, this.snapshot())
  }

  /** Fetch one cycle. */
  getCycle(projectId: string, cycleId: string): Record<string, unknown> {
    return serializeCycle(this.cycle(projectId, cycleId), this.snapshot())
  }

  /** Partially update one cycle. */
  updateCycle(projectId: string, cycleId: string, body: Record<string, unknown>): Record<string, unknown> {
    const cycle = this.cycle(projectId, cycleId)
    if (body.name !== undefined) cycle.name = requireString(body, 'name')
    if (body.description !== undefined) cycle.description = optionalString(body, 'description') ?? ''
    if (body.start_date !== undefined) cycle.startDate = optionalDate(body, 'start_date')
    if (body.end_date !== undefined) cycle.endDate = optionalDate(body, 'end_date')
    validateCycleRange(cycle)
    cycle.updatedAt = new Date().toISOString()
    this.scheduleSave()
    return serializeCycle(cycle, this.snapshot())
  }

  /** Delete one cycle and detach it from work items. */
  deleteCycle(projectId: string, cycleId: string): void {
    this.cycle(projectId, cycleId)
    for (const item of this.data.workItems) if (item.cycleId === cycleId) item.cycleId = undefined
    this.data.cycles = this.data.cycles.filter(row => row.id !== cycleId)
    this.scheduleSave()
  }

  /** Resolve one cycle scoped to a project or fail with 404. */
  cycle(projectId: string, cycleId: string): Cycle {
    const found = this.data.cycles.find(row => row.projectId === projectId && row.id === cycleId)
    if (found === undefined) throw new EngineError('cycle not found: ' + cycleId, 404)
    return found
  }

  // ----------------------------------------------------------------- modules

  /** List one project's modules, paginated. */
  listModules(projectId: string, query: PageQuery): Paginated<Record<string, unknown>> {
    const rows = this.data.modules
      .filter(row => row.projectId === projectId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(row => serializeModule(row))
    return paginate(rows, query.perPage, query.cursor)
  }

  /** Create one module. */
  createModule(projectId: string, body: Record<string, unknown>): Record<string, unknown> {
    const name = requireString(body, 'name')
    const now = new Date().toISOString()
    const module: Module = {
      id: randomUUID(),
      projectId,
      name,
      description: optionalString(body, 'description') ?? '',
      status: (body.status === undefined ? 'backlog' : requireEnum(body, 'status', MODULE_STATUSES)) as Module['status'],
      startDate: optionalDate(body, 'start_date'),
      targetDate: optionalDate(body, 'target_date'),
      createdAt: now,
      updatedAt: now,
    }
    this.data.modules.push(module)
    this.scheduleSave()
    return serializeModule(module)
  }

  /** Fetch one module. */
  getModule(projectId: string, moduleId: string): Record<string, unknown> {
    return serializeModule(this.module(projectId, moduleId))
  }

  /** Partially update one module. */
  updateModule(projectId: string, moduleId: string, body: Record<string, unknown>): Record<string, unknown> {
    const module = this.module(projectId, moduleId)
    if (body.name !== undefined) module.name = requireString(body, 'name')
    if (body.description !== undefined) module.description = optionalString(body, 'description') ?? ''
    if (body.status !== undefined) module.status = requireEnum(body, 'status', MODULE_STATUSES) as Module['status']
    if (body.start_date !== undefined) module.startDate = optionalDate(body, 'start_date')
    if (body.target_date !== undefined) module.targetDate = optionalDate(body, 'target_date')
    module.updatedAt = new Date().toISOString()
    this.scheduleSave()
    return serializeModule(module)
  }

  /** Delete one module and detach it from work items. */
  deleteModule(projectId: string, moduleId: string): void {
    this.module(projectId, moduleId)
    for (const item of this.data.workItems) item.moduleIds = item.moduleIds.filter(id => id !== moduleId)
    this.data.modules = this.data.modules.filter(row => row.id !== moduleId)
    this.scheduleSave()
  }

  /** Resolve one module scoped to a project or fail with 404. */
  module(projectId: string, moduleId: string): Module {
    const found = this.data.modules.find(row => row.projectId === projectId && row.id === moduleId)
    if (found === undefined) throw new EngineError('module not found: ' + moduleId, 404)
    return found
  }

  // --------------------------------------------------------------- work items

  /** List one project's work items, paginated and ordered. */
  listWorkItems(projectId: string, query: PageQuery): Paginated<Record<string, unknown>> {
    const snapshot = this.snapshot()
    const order = normalizeOrder(query.orderBy)
    const key = ITEM_ORDER_KEYS[order.key] ?? ((row: WorkItem) => row.createdAt)
    const rows = this.data.workItems
      .filter(row => row.projectId === projectId)
      .sort((a, b) => compareValues(key(a), key(b), order.descending))
      .map(row => serializeWorkItem(row, snapshot))
    return paginate(rows, query.perPage, query.cursor)
  }

  /** Create one work item in a project. */
  createWorkItem(projectId: string, body: Record<string, unknown>): Record<string, unknown> {
    const project = this.projectById(projectId)
    const name = requireString(body, 'name')
    const stateId = optionalString(body, 'state') ?? this.defaultState(projectId)?.id
    if (stateId === undefined) throw new EngineError('project has no states to file the work item into', 400)
    this.state(projectId, stateId)
    const priority = (body.priority === undefined ? 'none' : requireEnum(body, 'priority', PRIORITIES)) as Priority
    const now = new Date().toISOString()
    project.sequenceCount += 1
    const item: WorkItem = {
      id: randomUUID(),
      projectId,
      name,
      descriptionHtml: optionalString(body, 'description_html') ?? '',
      priority,
      stateId,
      sequenceId: project.sequenceCount,
      sortOrder: optionalNumber(body, 'sort_order') ?? 65535,
      isDraft: body.is_draft === true,
      parentId: optionalString(body, 'parent'),
      labelIds: idList(body.labels),
      assigneeIds: idList(body.assignees),
      startDate: optionalDate(body, 'start_date'),
      targetDate: optionalDate(body, 'target_date'),
      cycleId: optionalString(body, 'cycle'),
      moduleIds: idList(body.modules),
      createdAt: now,
      updatedAt: now,
      completedAt: undefined,
      archivedAt: undefined,
    }
    if (item.parentId !== undefined && !this.data.workItems.some(row => row.id === item.parentId && row.projectId === projectId)) {
      throw new EngineError('parent work item not found: ' + item.parentId, 400)
    }
    if (item.cycleId !== undefined) this.cycle(projectId, item.cycleId)
    for (const moduleId of item.moduleIds) this.module(projectId, moduleId)
    for (const labelId of item.labelIds) this.label(projectId, labelId)
    this.data.workItems.push(item)
    this.applyCompletion(item)
    this.scheduleSave()
    return serializeWorkItem(item, this.snapshot())
  }

  /** Fetch one work item. */
  getWorkItem(projectId: string, itemId: string): Record<string, unknown> {
    return serializeWorkItem(this.workItem(projectId, itemId), this.snapshot())
  }

  /** Partially update one work item. */
  updateWorkItem(projectId: string, itemId: string, body: Record<string, unknown>): Record<string, unknown> {
    const item = this.workItem(projectId, itemId)
    if (body.name !== undefined) item.name = requireString(body, 'name')
    if (body.description_html !== undefined) item.descriptionHtml = optionalString(body, 'description_html') ?? ''
    if (body.priority !== undefined) item.priority = requireEnum(body, 'priority', PRIORITIES) as Priority
    if (body.state !== undefined) {
      const stateId = optionalString(body, 'state')
      if (stateId === undefined || stateId.length === 0) throw new EngineError('state cannot be emptied', 400)
      item.stateId = stateId
      this.state(projectId, stateId)
    }
    if (body.sort_order !== undefined) item.sortOrder = optionalNumber(body, 'sort_order') ?? item.sortOrder
    if (body.is_draft !== undefined) item.isDraft = body.is_draft === true
    if (body.parent !== undefined) {
      const parentId = optionalString(body, 'parent')
      if (parentId === item.id) throw new EngineError('a work item cannot be its own parent', 400)
      if (parentId !== undefined) this.workItem(projectId, parentId)
      item.parentId = parentId
    }
    if (body.labels !== undefined) {
      item.labelIds = idList(body.labels)
      for (const labelId of item.labelIds) this.label(projectId, labelId)
    }
    if (body.assignees !== undefined) item.assigneeIds = idList(body.assignees)
    if (body.start_date !== undefined) item.startDate = optionalDate(body, 'start_date')
    if (body.target_date !== undefined) item.targetDate = optionalDate(body, 'target_date')
    if (body.cycle !== undefined) {
      const cycleId = optionalString(body, 'cycle')
      if (cycleId !== undefined) this.cycle(projectId, cycleId)
      item.cycleId = cycleId
    }
    if (body.modules !== undefined) {
      item.moduleIds = idList(body.modules)
      for (const moduleId of item.moduleIds) this.module(projectId, moduleId)
    }
    if (body.archived_at !== undefined) item.archivedAt = optionalString(body, 'archived_at')
    item.updatedAt = new Date().toISOString()
    this.applyCompletion(item)
    this.scheduleSave()
    return serializeWorkItem(item, this.snapshot())
  }

  /** Delete one work item, its comments and links; orphans keep flying. */
  deleteWorkItem(projectId: string, itemId: string): void {
    this.workItem(projectId, itemId)
    for (const item of this.data.workItems) if (item.parentId === itemId) item.parentId = undefined
    this.data.comments = this.data.comments.filter(row => row.workItemId !== itemId)
    this.data.links = this.data.links.filter(row => row.workItemId !== itemId)
    this.data.workItems = this.data.workItems.filter(row => row.id !== itemId)
    this.scheduleSave()
  }

  /** Resolve one work item scoped to a project or fail with 404. */
  workItem(projectId: string, itemId: string): WorkItem {
    const found = this.data.workItems.find(row => row.projectId === projectId && row.id === itemId)
    if (found === undefined) throw new EngineError('work item not found: ' + itemId, 404)
    return found
  }

  /** Attach or detach work items to a cycle (cycle-issues endpoints). */
  setCycleMembership(projectId: string, cycleId: string, issueIds: string[], remove: boolean): void {
    this.cycle(projectId, cycleId)
    for (const issueId of issueIds) {
      const item = this.workItem(projectId, issueId)
      if (remove) {
        if (item.cycleId === cycleId) item.cycleId = undefined
      } else {
        item.cycleId = cycleId
      }
      item.updatedAt = new Date().toISOString()
    }
    this.scheduleSave()
  }

  /** Attach or detach work items to a module (module-issues endpoints). */
  setModuleMembership(projectId: string, moduleId: string, issueIds: string[], remove: boolean): void {
    this.module(projectId, moduleId)
    for (const issueId of issueIds) {
      const item = this.workItem(projectId, issueId)
      if (remove) item.moduleIds = item.moduleIds.filter(id => id !== moduleId)
      else if (!item.moduleIds.includes(moduleId)) item.moduleIds.push(moduleId)
      item.updatedAt = new Date().toISOString()
    }
    this.scheduleSave()
  }

  // ---------------------------------------------------------------- comments

  /** List one work item's comments, oldest first, paginated. */
  listComments(projectId: string, itemId: string, query: PageQuery): Paginated<Record<string, unknown>> {
    this.workItem(projectId, itemId)
    const actor = this.data.member.id
    const rows = this.data.comments
      .filter(row => row.workItemId === itemId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(row => serializeComment(row, actor))
    return paginate(rows, query.perPage, query.cursor)
  }

  /** Add one comment to a work item. */
  createComment(projectId: string, itemId: string, body: Record<string, unknown>): Record<string, unknown> {
    this.workItem(projectId, itemId)
    const commentHtml = requireString(body, 'comment_html')
    const now = new Date().toISOString()
    const comment: Comment = {
      id: randomUUID(),
      workItemId: itemId,
      commentHtml,
      access: body.access === 'EXTERNAL' ? 'EXTERNAL' : 'INTERNAL',
      parentId: optionalString(body, 'parent'),
      createdAt: now,
      updatedAt: now,
    }
    this.data.comments.push(comment)
    this.scheduleSave()
    return serializeComment(comment, this.data.member.id)
  }

  // ------------------------------------------------------------------- links

  /** List one work item's links. */
  listLinks(projectId: string, itemId: string): Record<string, unknown>[] {
    this.workItem(projectId, itemId)
    return this.data.links.filter(row => row.workItemId === itemId).map(row => serializeLink(row))
  }

  /** Add one link to a work item. */
  createLink(projectId: string, itemId: string, body: Record<string, unknown>): Record<string, unknown> {
    this.workItem(projectId, itemId)
    const title = requireString(body, 'title')
    const url = requireString(body, 'url')
    if (!/^https?:\/\//i.test(url)) throw new EngineError('link url must be http(s)', 400)
    const now = new Date().toISOString()
    const link: IssueLink = { id: randomUUID(), workItemId: itemId, title, url, createdAt: now, updatedAt: now }
    this.data.links.push(link)
    this.scheduleSave()
    return serializeLink(link)
  }

  /** Delete one link. */
  deleteLink(projectId: string, itemId: string, linkId: string): void {
    this.workItem(projectId, itemId)
    this.data.links = this.data.links.filter(row => !(row.id === linkId && row.workItemId === itemId))
    this.scheduleSave()
  }

  // -------------------------------------------------------- search & members

  /** Search work items by name, description, or identifier. */
  search(workspaceId: string, options: { text: string, projectId: string | undefined, limit: number }): Record<string, unknown>[] {
    const needle = options.text.trim().toLowerCase()
    if (needle.length === 0) return []
    const snapshot = this.snapshot()
    const projectIds = options.projectId === undefined
      ? this.data.projects.filter(row => row.workspaceId === workspaceId).map(row => row.id)
      : [options.projectId]
    const rows: Record<string, unknown>[] = []
    for (const item of this.data.workItems) {
      if (!projectIds.includes(item.projectId)) continue
      const serialized = serializeWorkItem(item, snapshot)
      const identifier = typeof serialized.identifier === 'string' ? serialized.identifier.toLowerCase() : ''
      const haystack = (item.name + '\n' + stripHtml(item.descriptionHtml) + '\n' + identifier).toLowerCase()
      if (haystack.includes(needle)) rows.push(serialized)
      if (rows.length >= options.limit) break
    }
    return rows
  }

  /** The single local member as the public members endpoint sees it. */
  listMembers(): Record<string, unknown>[] {
    return [{ id: this.data.member.id, member: this.data.member.id, role: 20, display_name: this.data.member.displayName }]
  }

  /** The single local member as users/me sees it. */
  me(): Record<string, unknown> {
    return { id: this.data.member.id, display_name: this.data.member.displayName, email: this.data.member.email }
  }

  // -------------------------------------------------------------- internals

  /**
   * Keep completedAt in step with the state group: entering a completed state
   * stamps it, leaving clears it.
   * @param item - the mutated work item.
   */
  private applyCompletion(item: WorkItem): void {
    const state = this.data.states.find(row => row.id === item.stateId)
    if (state === undefined) return
    if (state.group === 'completed' && item.completedAt === undefined) item.completedAt = new Date().toISOString()
    if (state.group !== 'completed' && item.completedAt !== undefined) item.completedAt = undefined
  }

  /**
   * Queue one serial whole-store save; failures are recorded, not thrown, so
   * a transient fs error cannot take the in-memory domain down with it.
   */
  private scheduleSave(): void {
    this.saveChain = this.saveChain.then(
      () => this.store.save(this.data),
      () => this.store.save(this.data),
    ).catch(error => {
      this.lastSaveError = error
    })
  }
}

/** Pagination inputs every list operation takes. */
export interface PageQuery {
  perPage: number | string | undefined
  cursor: string | undefined
  orderBy: string | undefined
}

/**
 * Compare two orderable values with undefined sorting last.
 * @param a - left value.
 * @param b - right value.
 * @param descending - invert the comparison.
 * @returns the sort discriminator.
 */
function compareValues(a: string | number | undefined, b: string | number | undefined, descending: boolean): number {
  const factor = descending ? -1 : 1
  if (a === undefined && b === undefined) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  if (a < b) return -1 * factor
  if (a > b) return 1 * factor
  return 0
}

/**
 * Build a comparator over one orderable key extraction with a tiebreaker.
 * @param order - the normalized order (key direction).
 * @param keyOf - the orderable extraction for the requested key.
 * @param fallbackOf - the tiebreaker extraction (always ascending).
 * @returns the comparator.
 */
function byOrder<T>(
  order: { descending: boolean },
  keyOf: (row: T) => string | number | undefined,
  fallbackOf: (row: T) => string | number | undefined,
): (a: T, b: T) => number {
  return (a, b) => compareValues(keyOf(a), keyOf(b), order.descending) || compareValues(fallbackOf(a), fallbackOf(b), false)
}

/** Seed the default workflow states for one new project. */
function seedStates(projectId: string): State[] {
  const now = new Date().toISOString()
  return DEFAULT_STATES.map(entry => ({
    id: randomUUID(),
    projectId,
    name: entry.name,
    group: entry.group,
    color: entry.color,
    sequence: entry.sequence,
    isDefault: entry.group === 'unstarted',
    description: '',
    createdAt: now,
    updatedAt: now,
  }))
}

/**
 * The next sequence number for a project's states (Plane steps by 10000).
 * @param states - all states.
 * @param projectId - the scoping project.
 * @returns the next sequence value.
 */
function nextSequence(states: readonly State[], projectId: string): number {
  const max = states.filter(row => row.projectId === projectId).reduce((acc, row) => Math.max(acc, row.sequence), 0)
  return max + 10000
}

/**
 * Read one required non-empty string body field.
 * @param body - the request body.
 * @param key - the field name.
 * @returns the trimmed value.
 */
function requireString(body: Record<string, unknown>, key: string): string {
  const value = optionalString(body, key)
  if (value === undefined) throw new EngineError(key + ' is required and must be a non-empty string', 400)
  return value
}

/**
 * Read one optional string body field, treating empty strings as absent.
 * @param body - the request body.
 * @param key - the field name.
 * @returns the trimmed value or undefined.
 */
function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Read one optional numeric body field.
 * @param body - the request body.
 * @param key - the field name.
 * @returns the number or undefined.
 */
function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

/**
 * Read one required enum body field.
 * @param body - the request body.
 * @param key - the field name.
 * @param values - the allowed values.
 * @returns the member value.
 */
function requireEnum(body: Record<string, unknown>, key: string, values: readonly string[]): string {
  const value = optionalEnum(body, key, values)
  if (value === undefined) throw new EngineError(key + ' must be one of: ' + values.join(', '), 400)
  return value
}

/**
 * Read one optional enum body field.
 * @param body - the request body.
 * @param key - the field name.
 * @param values - the allowed values.
 * @returns the member value or undefined.
 */
function optionalEnum(body: Record<string, unknown>, key: string, values: readonly string[]): string | undefined {
  const value = body[key]
  if (typeof value !== 'string') return undefined
  return values.includes(value) ? value : undefined
}

/**
 * Read one optional yyyy-mm-dd date body field.
 * @param body - the request body.
 * @param key - the field name.
 * @returns the date string or undefined.
 */
function optionalDate(body: Record<string, unknown>, key: string): string | undefined {
  const value = optionalString(body, key)
  if (value === undefined) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new EngineError(key + ' must be a yyyy-mm-dd date', 400)
  }
  return value
}

/**
 * Read one required project identifier (uppercase, at most 12 characters).
 * @param body - the request body.
 * @returns the normalized identifier.
 */
function requireIdentifier(body: Record<string, unknown>): string {
  const raw = requireString(body, 'identifier')
  const identifier = raw.toUpperCase()
  if (!/^[A-Z0-9]{1,12}$/.test(identifier)) {
    throw new EngineError('identifier must be 1-12 letters or digits', 400)
  }
  return identifier
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
 * Reject cycles whose end precedes their start.
 * @param cycle - the cycle to validate.
 */
function validateCycleRange(cycle: Cycle): void {
  if (cycle.startDate !== undefined && cycle.endDate !== undefined && cycle.endDate < cycle.startDate) {
    throw new EngineError('end_date cannot precede start_date', 400)
  }
}

// Local aliases keeping the domain methods free of import churn above.

