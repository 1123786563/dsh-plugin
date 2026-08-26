/**
 * Local operator state: preset→customer bindings (the attribution table,
 * ADR-0004), observed preset ids, and manual blocks. One JSON file, atomic
 * rewrite on change, tolerant of a torn write (last-good reload).
 *
 * @module dsh-openmeter/store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Persisted operator state shape. */
export interface OperatorState {
  /** presetId -> customer subject key. */
  bindings: Record<string, string>
  /** preset ids observed in live sessions (for the cashier pick list). */
  observedPresets: string[]
  /** customer keys manually blocked by the operator (override everything). */
  manualBlocks: Record<string, true>
}

/** Empty state. */
export function emptyState(): OperatorState {
  return { bindings: {}, observedPresets: [], manualBlocks: {} }
}

/**
 * The operator state store. Single-writer; routes and the pipeline share one
 * instance.
 */
export class OperatorStore {
  private readonly file: string
  private readonly tmp: string
  private state: OperatorState = emptyState()
  private loaded = false

  /**
   * @param dir - directory holding state.json.
   */
  constructor(dir: string) {
    this.file = join(dir, 'state.json')
    this.tmp = join(dir, 'state.json.tmp')
  }

  /**
   * Load (or initialize) the state file.
   */
  async load(): Promise<void> {
    if (this.loaded) return
    await mkdir(dirname(this.file), { recursive: true })
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<OperatorState>
      this.state = {
        bindings: plainRecord(parsed.bindings),
        observedPresets: Array.isArray(parsed.observedPresets) ? parsed.observedPresets.map(String) : [],
        manualBlocks: plainBooleanRecord(parsed.manualBlocks),
      }
    } catch {
      this.state = emptyState()
    }
    this.loaded = true
  }

  /**
   * Current snapshot (defensive copy).
   * @returns the operator state.
   */
  snapshot(): OperatorState {
    return {
      bindings: { ...this.state.bindings },
      observedPresets: [...this.state.observedPresets],
      manualBlocks: { ...this.state.manualBlocks },
    }
  }

  /**
   * Resolve the subject key for one preset id (ADR-0004).
   * @param presetId - agent preset id (or undefined).
   * @param houseSubject - fallback subject for unbound sessions.
   * @returns the customer subject key.
   */
  subjectFor(presetId: string | undefined, houseSubject: string): string {
    if (presetId === undefined || presetId.length === 0) return houseSubject
    return this.state.bindings[presetId] ?? houseSubject
  }

  /**
   * Remember a preset id observed in a live session.
   * @param presetId - the observed preset id.
   */
  observePreset(presetId: string | undefined): void {
    if (presetId === undefined || presetId.length === 0) return
    if (this.state.observedPresets.includes(presetId)) return
    this.state.observedPresets.push(presetId)
    if (this.state.observedPresets.length > 200) this.state.observedPresets.shift()
    void this.save()
  }

  /**
   * Set or clear one binding.
   * @param presetId - agent preset id.
   * @param customerKey - customer subject key; empty clears the binding.
   */
  async setBinding(presetId: string, customerKey: string): Promise<void> {
    await this.load()
    if (customerKey.trim().length === 0) delete this.state.bindings[presetId]
    else this.state.bindings[presetId] = customerKey.trim()
    await this.save()
  }

  /**
   * Manually block or unblock a customer (the cashier's override).
   * @param customerKey - customer subject key.
   * @param blocked - true to block, false to lift.
   */
  async setManualBlock(customerKey: string, blocked: boolean): Promise<void> {
    await this.load()
    if (blocked) this.state.manualBlocks[customerKey] = true
    else delete this.state.manualBlocks[customerKey]
    await this.save()
  }

  /**
   * Whether a customer is manually blocked.
   * @param customerKey - customer subject key.
   */
  isManuallyBlocked(customerKey: string): boolean {
    return this.state.manualBlocks[customerKey] === true
  }

  /**
   * Persist atomically. Best effort: observation-triggered saves must never
   * crash the pipeline when the data directory disappeared mid-flight.
   */
  private async save(): Promise<void> {
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.tmp, JSON.stringify(this.state), 'utf8')
      await rename(this.tmp, this.file)
    } catch {
      // Swallow: the next successful save rewrites the whole state anyway.
    }
  }
}

/**
 * Coerce unknown JSON to a plain boolean-true record.
 * @param value - decoded value.
 * @returns a safe record.
 */
function plainBooleanRecord(value: unknown): Record<string, true> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, true> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === true) out[key] = true
  }
  return out
}

/**
 * Coerce unknown JSON to a plain string record.
 * @param value - decoded value.
 * @returns a safe record.
 */
function plainRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string') out[key] = entry
  }
  return out
}
