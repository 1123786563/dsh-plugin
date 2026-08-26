/**
 * Staged-form model behind the nocobase settings card. A card stages what the
 * user types and writes it only on save: a settings write is a durable,
 * revision-fenced document mutation, so staging keeps what is on screen
 * exactly what a save would store. Pure state: no React, no DOM, testable in
 * Node alongside the host half.
 *
 * @module dsh-nocobase/client/form
 */

/** Minimal settings-scope contract this form needs (see dsh-client-runtime SettingsScope). */
export interface NocobaseSettingsScope {
  /** Current sync snapshot (stable reference until the next change). */
  getSnapshot(): NocobaseScopeSnapshot
  /** Observe snapshot replacements; returns the disposer. */
  subscribe(listener: () => void): () => void
  /** Queue one field write into the user layer. */
  set(field: string, value: unknown): Promise<void>
  /** Clear one field back to the composition layer. */
  unset(field: string): Promise<void>
}

/** Minimal scope-snapshot contract (status/value/user/writable suffice here). */
export interface NocobaseScopeSnapshot {
  /** 'loading' | 'unavailable' | ready, as the scope reports it. */
  status: string
  /** Resolved section when loaded. */
  value?: Readonly<Record<string, unknown>>
  /** Raw user layer when one exists; a key's presence marks an override. */
  user?: Readonly<Record<string, unknown>>
  /** Whether the Host document accepts writes. */
  writable: boolean
}

/** The nocobase namespace fields the card edits. */
export type NocobaseField = 'baseUrl'

/** One field as the card renders it. */
export interface NocobaseFieldState {
  /** Draft text the control renders. */
  text: string
  /** Whether a user-layer entry exists for this field (an override to reset). */
  overridden: boolean
  /** Whether the draft is not a value this field accepts, which blocks saving. */
  invalid: boolean
}

/** Card state the component renders. */
export interface NocobaseCardState {
  /** False while the namespace is still loading; the card renders nothing. */
  available: boolean
  /** False when the namespace is not served to this client at all. */
  exposed: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether the form holds edits a save would write. */
  dirty: boolean
  /** Whether any staged draft is invalid, which blocks the save. */
  invalid: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged. */
  failed: boolean
  /** The rejection reason the Host returned for the last failed save. */
  failedReason?: string
  /** One NocobaseFieldState per edited field. */
  fields: Record<NocobaseField, NocobaseFieldState>
}

/** The face the card's slot entry injects (hooks + write actions). */
export interface NocobaseCardFace {
  hooks: {
    /** Card snapshot, bound by the renderer as useNocobaseSettingsCard. */
    nocobaseSettingsCard: NocobaseCardStore
  }
  /** Stage draft text for one field. */
  edit: (field: NocobaseField, text: string) => void
  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  resetField: (field: NocobaseField) => void
  /** Write every staged edit, then re-seed from what the Host accepted. */
  save: () => void
  /** Drop every staged edit. */
  discard: () => void
}

/** Minimal snapshot-store contract React's useSyncExternalStore binds. */
export interface NocobaseCardStore {
  getSnapshot(): NocobaseCardState
  subscribe(listener: () => void): () => void
}

/** One staged edit. */
interface Staged {
  /** Draft text the control renders. */
  text: string
  /** True when this edit clears the field whatever text it shows. */
  clear: boolean
}

/** A draft is valid when it is an http(s) URL; trailing slashes are stripped on save. */
const URL_PATTERN = /^https?:\/\/\S+$/

/** The face the card's slot registration injects (hooks + form actions). */
export class NocobaseSettingsCardController {
  private readonly scope: NocobaseSettingsScope
  private readonly staged = new Map<NocobaseField, Staged>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false
  private failedReason: string | undefined
  private state: NocobaseCardState
  private readonly unsubscribe: () => void

  /**
   * Bind the namespace scope and derive the first card state.
   * @param scope - the bound settings scope for the nocobase namespace.
   */
  constructor(scope: NocobaseSettingsScope) {
    this.scope = scope
    this.state = this.derive()
    this.unsubscribe = scope.subscribe(() => { this.reseed() })
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): NocobaseCardFace {
    return {
      hooks: { nocobaseSettingsCard: this.store() },
      edit: (field, text) => { this.edit(field, text) },
      resetField: field => { this.resetField(field) },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  /** Release the scope subscription; the slot disposer calls this on teardown. */
  dispose(): void {
    this.unsubscribe()
    this.listeners.clear()
  }

  /**
   * Stage draft text for one field.
   * @param field - the namespace field.
   * @param text - the draft text.
   */
  edit(field: NocobaseField, text: string): void {
    this.staged.set(field, { text, clear: false })
    this.failed = false
    this.failedReason = undefined
    this.publish()
  }

  /**
   * Stage a clear for one field.
   * @param field - the namespace field.
   */
  resetField(field: NocobaseField): void {
    this.staged.set(field, { text: this.stored(field), clear: true })
    this.failed = false
    this.failedReason = undefined
    this.publish()
  }

  /** Drop every staged edit. */
  discard(): void {
    this.staged.clear()
    this.failed = false
    this.failedReason = undefined
    this.publish()
  }

  /** Write every staged edit, then re-seed from what the Host accepted. */
  async save(): Promise<void> {
    if (this.saving || this.derive().invalid) return
    this.saving = true
    this.failed = false
    this.failedReason = undefined
    this.publish()
    try {
      for (const [field, staged] of [...this.staged]) {
        if (staged.clear) {
          await this.scope.unset(field)
          continue
        }
        await this.scope.set(field, staged.text.replace(/\/+$/, ''))
      }
      this.staged.clear()
    } catch (error) {
      this.failed = true
      this.failedReason = error instanceof Error ? error.message : String(error)
    } finally {
      this.saving = false
      this.publish()
    }
  }

  /** Re-seed drafts from the scope snapshot when nothing is staged mid-flight. */
  private reseed(): void {
    if (this.saving || this.staged.size > 0) return
    this.publish()
  }

  /**
   * Read the stored text one field would re-seed from.
   * @param field - the namespace field.
   * @returns the stored value as text, or the empty string.
   */
  private stored(field: NocobaseField): string {
    const value = this.scope.getSnapshot().value?.[field]
    return value === undefined || value === null ? '' : String(value)
  }

  /**
   * Compose the card state from the scope snapshot and staged edits.
   * @returns the current card state.
   */
  private derive(): NocobaseCardState {
    const snapshot = this.scope.getSnapshot()
    const available = snapshot.status !== 'loading' && snapshot.value !== undefined
    const exposed = snapshot.status !== 'unavailable'
    const fields = {} as Record<NocobaseField, NocobaseFieldState>
    let invalid = false
    for (const field of ['baseUrl'] as const) {
      const staged = this.staged.get(field)
      const text = staged?.text ?? this.stored(field)
      const fieldInvalid = text.length > 0 ? !URL_PATTERN.test(text) : false
      invalid = invalid || fieldInvalid
      fields[field] = {
        text,
        overridden: Object.hasOwn(snapshot.user ?? {}, field),
        invalid: fieldInvalid,
      }
    }
    return {
      available,
      exposed,
      writable: snapshot.writable,
      dirty: this.staged.size > 0,
      invalid,
      saving: this.saving,
      failed: this.failed,
      ...(this.failedReason === undefined ? {} : { failedReason: this.failedReason }),
      fields,
    }
  }

  /**
   * Publish a fresh derived state to the store.
   */
  private publish(): void {
    this.state = this.derive()
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * Build the bound snapshot store the renderer hooks into.
   * @returns the store matching React's useSyncExternalStore contract.
   */
  private store(): NocobaseCardStore {
    return {
      getSnapshot: () => this.state,
      subscribe: listener => {
        this.listeners.add(listener)
        return () => { this.listeners.delete(listener) }
      },
    }
  }
}
