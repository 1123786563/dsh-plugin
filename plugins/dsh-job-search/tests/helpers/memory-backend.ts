/**
 * Minimal in-memory {@link StorageBackend} test double: one pooled medium per
 * unit name, version stamping, and the full KvUnit primitive set the
 * storage-domain facility drives. Local equivalent of the harness repo's
 * shared test helper — this package ships standalone.
 * @module dsh-job-search/tests/helpers/memory-backend
 */

import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'

/** One unit's medium: tables of records plus the global slot (`null` = never written). */
interface MemoryMedium {
  tables: Map<string, Map<string, unknown>>
  global: unknown
}

/** Shared media pool: hand one to several backends to simulate a restart. */
export class MemoryMediaPool {
  /** Unit name → its records; a missing entry is a never-materialized unit. */
  readonly media = new Map<string, MemoryMedium>()
  /** Unit name → stamped version. */
  readonly versions = new Map<string, number>()
}

/** In-memory KV unit over one pooled medium. */
class MemoryKvUnit implements KvUnit {
  private closed = false

  constructor(
    private readonly pool: MemoryMediaPool,
    private readonly name: string,
    private readonly descriptor: KvUnitDescriptor,
    private readonly medium: MemoryMedium,
  ) {}

  async loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    if (this.closed) throw new Error('unit is closed')
    const tables: Record<string, Record<string, unknown>> = {}
    for (const table of this.descriptor.tables) {
      tables[table] = Object.fromEntries(this.medium.tables.get(table) ?? new Map())
    }
    return { tables, global: this.medium.global }
  }

  async putRecord(table: string, key: string, value: unknown): Promise<void> {
    if (this.closed) throw new Error('unit is closed')
    let records = this.medium.tables.get(table)
    if (records === undefined) {
      records = new Map()
      this.medium.tables.set(table, records)
    }
    records.set(key, structuredClone(value))
  }

  async deleteRecord(table: string, key: string): Promise<void> {
    if (this.closed) throw new Error('unit is closed')
    this.medium.tables.get(table)?.delete(key)
  }

  async setGlobal(value: unknown): Promise<void> {
    if (this.closed) throw new Error('unit is closed')
    this.medium.global = structuredClone(value)
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

/** In-memory backend registered under one name on the storage hub. */
export class MemoryStorageBackend implements StorageBackend {
  readonly kv: KvFacet = {
    open: async (descriptor: KvUnitDescriptor): Promise<KvUnit> => {
      let medium = this.pool.media.get(descriptor.name)
      if (medium === undefined) {
        medium = { tables: new Map(), global: null }
        this.pool.media.set(descriptor.name, medium)
        this.pool.versions.set(descriptor.name, descriptor.version)
      } else {
        const stamped = this.pool.versions.get(descriptor.name)
        if (stamped !== descriptor.version) {
          throw new Error(`version-mismatch: unit '${descriptor.name}' wants ${descriptor.version}, medium holds ${String(stamped)}`)
        }
      }
      return new MemoryKvUnit(this.pool, descriptor.name, descriptor, medium)
    },
  }

  /**
   * @param pool - shared media pool (one instance simulates restarts across backends).
   */
  constructor(private readonly pool: MemoryMediaPool) {}

  async close(): Promise<void> {}
}
