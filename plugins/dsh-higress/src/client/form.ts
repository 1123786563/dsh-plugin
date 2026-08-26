/**
 * Staged-form model behind the llm-higress settings card (same pattern as
 * dsh-openmeter): stage what the user types, write only on save. Pure state,
 * testable in Node.
 *
 * @module dsh-higress/client/form
 */

import type { HigressCatalogModel } from '../config.ts'

/** Minimal settings-scope contract this form needs. */
export interface HigressSettingsScope {
  getSnapshot(): HigressScopeSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** Minimal scope-snapshot contract. */
export interface HigressScopeSnapshot {
  status: string
  value?: Readonly<Record<string, unknown>>
  user?: Readonly<Record<string, unknown>>
  writable: boolean
}

/** The editable fields. */
export type AnyField = 'baseURL' | 'apiKeyEnv' | 'models'

const TEXT_FIELDS: readonly AnyField[] = ['baseURL', 'apiKeyEnv']

/** One field as the card renders it. */
export interface FieldState {
  text: string
  overridden: boolean
}

/** Card state the component renders. */
export interface CardState {
  available: boolean
  writable: boolean
  dirty: boolean
  saving: boolean
  failed: boolean
  failedReason?: string
  baseURL: FieldState
  apiKeyEnv: FieldState
  models: FieldState
}

/** The face the card's slot entry injects. */
export interface CardFace {
  hooks: { higressSettingsCard: CardStore }
  edit: (field: AnyField, value: string) => void
  resetField: (field: AnyField) => void
  save: () => void
  discard: () => void
}

const DEFAULT_CONTEXT_WINDOW = 65_536

/** Parse the models textarea: one model id per line, prior metadata preserved. */
export function parseModelsText(
  text: string,
  existing: readonly HigressCatalogModel[],
  defaultContextWindow: number = DEFAULT_CONTEXT_WINDOW,
): HigressCatalogModel[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(id => existing.find(model => model.id === id) ?? { id, name: id, contextWindow: defaultContextWindow })
}

/** Format the catalog as the textarea shows it: one id per line. */
export function formatModelsText(models: readonly HigressCatalogModel[] | undefined): string {
  return (models ?? []).map(model => model.id).join('\n')
}

function catalogOf(value: unknown): readonly HigressCatalogModel[] {
  return Array.isArray(value) ? value as HigressCatalogModel[] : []
}

/** Observable card store (subscribe + snapshot for useSyncExternalStore). */
export class CardStore {
  private staging: Partial<Record<AnyField, string>> = {}
  private state: CardState
  private readonly listeners = new Set<() => void>()

  /**
   * @param scope - the bound settings scope.
   */
  constructor(private readonly scope: HigressSettingsScope) {
    this.state = derive(scope.getSnapshot(), this.staging)
    scope.subscribe(() => this.reattach())
  }

  /** Current snapshot. */
  getSnapshot = (): CardState => this.state

  /** Subscribe to replacements. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Stage a draft for one field. */
  edit = (field: AnyField, value: string): void => {
    this.staging[field] = value
    this.reattach()
  }

  /** Reset one field back to the composition layer. */
  resetField = (field: AnyField): void => {
    delete this.staging[field]
    void this.scope.unset(field)
    this.reattach()
  }

  /** Write staged drafts into the user layer. */
  save = (): Promise<void> => {
    const snapshot = this.scope.getSnapshot()
    const writes: Array<Promise<void>> = []
    for (const field of TEXT_FIELDS) {
      const draft = this.staging[field]
      if (draft === undefined) continue
      const base = typeof snapshot.value?.[field] === 'string' ? snapshot.value[field] as string : ''
      if (draft === base) {
        if (snapshot.user?.[field] !== undefined) writes.push(this.scope.unset(field))
        continue
      }
      writes.push(this.scope.set(field, draft))
    }
    const modelsDraft = this.staging.models
    if (modelsDraft !== undefined) {
      writes.push(this.scope.set('models', parseModelsText(modelsDraft, catalogOf(snapshot.value?.models))))
    }
    this.state = { ...this.state, saving: true, failed: false }
    this.emit()
    return Promise.all(writes).then(
      () => {
        this.staging = {}
        this.state = { ...derive(this.scope.getSnapshot(), this.staging), saving: false }
        this.emit()
      },
      (error: unknown) => {
        this.state = { ...this.state, saving: false, failed: true, failedReason: error instanceof Error ? error.message : String(error) }
        this.emit()
      },
    )
  }

  /** Drop staged drafts. */
  discard = (): void => {
    this.staging = {}
    this.reattach()
  }

  private reattach(): void {
    this.state = derive(this.scope.getSnapshot(), this.staging)
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

function fieldOf(snapshot: HigressScopeSnapshot, staging: Partial<Record<AnyField, string>>, field: AnyField, base: string): FieldState {
  return {
    text: staging[field] ?? base,
    overridden: snapshot.user?.[field] !== undefined,
  }
}

function derive(snapshot: HigressScopeSnapshot, staging: Partial<Record<AnyField, string>>): CardState {
  const ready = snapshot.status === 'ready'
  const value = snapshot.value ?? {}
  const baseURLBase = typeof value.baseURL === 'string' ? value.baseURL : 'http://127.0.0.1:8080/v1'
  const apiKeyEnvBase = typeof value.apiKeyEnv === 'string' ? value.apiKeyEnv : 'HIGRESS_API_KEY'
  return {
    available: ready,
    writable: snapshot.writable,
    dirty: Object.keys(staging).length > 0,
    saving: false,
    failed: false,
    baseURL: fieldOf(snapshot, staging, 'baseURL', baseURLBase),
    apiKeyEnv: fieldOf(snapshot, staging, 'apiKeyEnv', apiKeyEnvBase),
    models: fieldOf(snapshot, staging, 'models', formatModelsText(catalogOf(value.models))),
  }
}

/**
 * Bind the card face the slot entry injects.
 * @param scope - the bound settings scope.
 * @returns the face (hooks + actions).
 */
export function cardFace(scope: HigressSettingsScope): CardFace {
  const store = new CardStore(scope)
  return {
    hooks: { higressSettingsCard: store },
    edit: store.edit,
    resetField: store.resetField,
    save: () => { void store.save() },
    discard: store.discard,
  }
}
