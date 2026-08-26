/**
 * Staged-form model behind the openmeter settings card (same pattern as
 * dsh-plane): stage what the user types, write only on save. Pure state,
 * testable in Node.
 *
 * @module dsh-openmeter/client/form
 */

/** Minimal settings-scope contract this form needs. */
export interface OpenMeterSettingsScope {
  getSnapshot(): OpenMeterScopeSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** Minimal scope-snapshot contract. */
export interface OpenMeterScopeSnapshot {
  status: string
  value?: Readonly<Record<string, unknown>>
  user?: Readonly<Record<string, unknown>>
  writable: boolean
}

/** The openmeter namespace text fields the card edits. */
export type TextField = 'endpoint' | 'token' | 'houseSubject' | 'featureKey' | 'eventType' | 'meterSlug' | 'quoteCurrency'
const TEXT_FIELDS: readonly TextField[] = ['endpoint', 'token', 'houseSubject', 'featureKey', 'eventType', 'meterSlug', 'quoteCurrency']

/** Numeric fields. */
export type NumberField = 'accessCacheTtlMs' | 'priceRefreshMs' | 'batchSize'
const NUMBER_FIELDS: readonly NumberField[] = ['accessCacheTtlMs', 'priceRefreshMs', 'batchSize']

/** Boolean fields. */
export type BooleanField = 'blockEnabled'

/** Any editable field. */
export type AnyField = TextField | NumberField | BooleanField

/** One field as the card renders it. */
export interface FieldState {
  text: string
  overridden: boolean
  invalid: boolean
}

/** Card state the component renders. */
export interface CardState {
  available: boolean
  exposed: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
  failedReason?: string
  textFields: Record<TextField, FieldState>
  numberFields: Record<NumberField, FieldState>
  blockEnabled: { overridden: boolean, value: boolean }
}

/** The face the card's slot entry injects. */
export interface CardFace {
  hooks: { openmeterSettingsCard: CardStore }
  edit: (field: AnyField, value: string | boolean) => void
  resetField: (field: AnyField) => void
  save: () => void
  discard: () => void
}

/** Draft staging held privately by the store. */
interface Staging {
  text: Partial<Record<TextField | NumberField, string>>
  blockEnabled: boolean
  blockEnabledTouched: boolean
}

/** Empty staging. */
function freshStaging(): Staging {
  return { text: {}, blockEnabled: true, blockEnabledTouched: false }
}

/** Observable card store (subscribe + snapshot for useSyncExternalStore). */
export class CardStore {
  private staging: Staging = freshStaging()
  private state: CardState
  private readonly listeners = new Set<() => void>()

  /**
   * @param scope - the bound settings scope.
   */
  constructor(private readonly scope: OpenMeterSettingsScope) {
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
  edit = (field: AnyField, value: string | boolean): void => {
    if (field === 'blockEnabled') {
      this.staging.blockEnabled = value === true
      this.staging.blockEnabledTouched = true
    } else {
      this.staging.text[field as TextField | NumberField] = String(value)
    }
    this.reattach()
  }

  /** Reset one field back to the composition layer. */
  resetField = (field: AnyField): void => {
    if (field === 'blockEnabled') this.staging.blockEnabledTouched = false
    else delete this.staging.text[field as TextField | NumberField]
    this.reattach()
  }

  /** Write staged drafts into the user layer. */
  save = (): Promise<void> => {
    const snapshot = this.scope.getSnapshot()
    const writes: Array<Promise<void>> = []
    for (const field of TEXT_FIELDS) {
      const draft = this.staging.text[field]
      if (draft === undefined) continue
      const base = typeof snapshot.value?.[field] === 'string' ? snapshot.value[field] as string : ''
      if (draft === base) {
        if (snapshot.user?.[field] !== undefined) writes.push(this.scope.unset(field))
        continue
      }
      writes.push(this.scope.set(field, draft))
    }
    for (const field of NUMBER_FIELDS) {
      const draft = this.staging.text[field]
      if (draft === undefined) continue
      const parsed = Number(draft)
      if (Number.isFinite(parsed)) writes.push(this.scope.set(field, parsed))
    }
    if (this.staging.blockEnabledTouched) writes.push(this.scope.set('blockEnabled', this.staging.blockEnabled === true))
    this.state = { ...this.state, saving: true, failed: false }
    this.emit()
    return Promise.all(writes).then(
      () => {
        this.staging = freshStaging()
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
    this.staging = freshStaging()
    this.reattach()
  }

  /** Re-derive after any change. */
  private reattach(): void {
    this.state = derive(this.scope.getSnapshot(), this.staging)
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

/** Derive card state from a scope snapshot plus staging. */
function derive(snapshot: OpenMeterScopeSnapshot, staging: Staging): CardState {
  const ready = snapshot.status === 'ready'
  const value = snapshot.value ?? {}
  const user = snapshot.user ?? {}
  const textFields = {} as Record<TextField, FieldState>
  for (const field of TEXT_FIELDS) {
    const staged = staging.text[field]
    const base = typeof value[field] === 'string' ? value[field] as string : ''
    textFields[field] = {
      text: staged ?? base,
      overridden: user[field] !== undefined,
      invalid: false,
    }
  }
  const numberFields = {} as Record<NumberField, FieldState>
  for (const field of NUMBER_FIELDS) {
    const staged = staging.text[field]
    const base = value[field] === undefined ? '' : String(value[field])
    numberFields[field] = {
      text: staged ?? base,
      overridden: user[field] !== undefined,
      invalid: staged !== undefined && !Number.isFinite(Number(staged)),
    }
  }
  const blockValue = staging.blockEnabledTouched ? staging.blockEnabled : value.blockEnabled === true
  const dirty = TEXT_FIELDS.some(field => staging.text[field] !== undefined)
    || NUMBER_FIELDS.some(field => staging.text[field] !== undefined)
    || staging.blockEnabledTouched
  const invalid = NUMBER_FIELDS.some(field => numberFields[field].invalid)
  return {
    available: ready,
    exposed: ready,
    writable: snapshot.writable,
    dirty,
    invalid,
    saving: false,
    failed: false,
    textFields,
    numberFields,
    blockEnabled: { overridden: user.blockEnabled !== undefined, value: blockValue },
  }
}

/**
 * Bind the card face the slot entry injects.
 * @param scope - the bound settings scope.
 * @returns the face (hooks + actions).
 */
export function cardFace(scope: OpenMeterSettingsScope): CardFace {
  const store = new CardStore(scope)
  return {
    hooks: { openmeterSettingsCard: store },
    edit: store.edit,
    resetField: store.resetField,
    save: () => { void store.save() },
    discard: store.discard,
  }
}
