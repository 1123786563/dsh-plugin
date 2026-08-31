/**
 * JSON file persistence for the engine: load-on-boot, atomic save (tmp file +
 * rename), a .bak copy of the last good save, and restore-from-backup when the
 * primary file is unreadable. The load/save cycle is deliberately synchronous
 * (engine calls are synchronous domain operations on the hot path) with an
 * injectable adapter so tests can run against memory or a temp directory.
 *
 * @module dsh-plane/engine/store
 */

import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { StoreData } from './models.ts'

/** Storage adapter the engine persists through; the fs one is the default. */
export interface StoreAdapter {
  /** Read the raw primary file, or undefined when it does not exist. */
  read(): Promise<string | undefined>
  /** Write the primary file atomically (tmp + rename). */
  write(text: string): Promise<void>
  /** Copy the primary file to the backup slot before the next overwrite. */
  backup(): Promise<void>
}

/** Whole-file fs adapter over one directory holding store.json. */
export class FsStoreAdapter implements StoreAdapter {
  private readonly file: string
  private readonly backupFile: string
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
    this.file = join(dir, 'store.json')
    this.backupFile = join(dir, 'store.json.bak')
  }

  async read(): Promise<string | undefined> {
    try {
      return await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async write(text: string): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = this.file + '.tmp'
    await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, this.file)
  }

  async backup(): Promise<void> {
    try {
      await copyFile(this.file, this.backupFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async readBackup(): Promise<string | undefined> {
    try {
      return await readFile(this.backupFile, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
}

/** In-memory adapter for tests and embedders that never touch disk. */
export class MemoryStoreAdapter implements StoreAdapter {
  text: string | undefined

  async read(): Promise<string | undefined> {
    return this.text
  }

  async write(text: string): Promise<void> {
    this.text = text
  }

  async backup(): Promise<void> {}
}

/**
 * Persist and restore the engine store: parse the primary file, fall back to
 * the .bak copy when the primary is unreadable, and refuse to silently reset
 * (a corrupt payload with no backup surfaces as an error).
 */
export class JsonStore {
  private readonly adapter: StoreAdapter
  data: StoreData | undefined

  constructor(adapter: StoreAdapter) {
    this.adapter = adapter
  }

  /**
   * Load the store from the adapter, restoring from the backup when the
   * primary file is damaged.
   * @returns the loaded store, or undefined when nothing is persisted yet.
   */
  async load(): Promise<StoreData | undefined> {
    const primary = await this.adapter.read()
    if (primary !== undefined) {
      const parsed = parseStore(primary)
      if (parsed !== undefined) {
        this.data = parsed
        return parsed
      }
    }
    const restored = await this.restoreFromBackup()
    if (restored !== undefined) {
      this.data = restored
      return restored
    }
    if (primary !== undefined) {
      throw new Error('dsh-plane local store is corrupt and no usable backup exists: ' + storePath(this.adapter))
    }
    return undefined
  }

  /**
   * Try the backup copy of the fs adapter; memory adapters have none.
   * @returns the restored store, or undefined.
   */
  private async restoreFromBackup(): Promise<StoreData | undefined> {
    if (!(this.adapter instanceof FsStoreAdapter)) return undefined
    const text = await this.adapter.readBackup()
    return text === undefined ? undefined : parseStore(text)
  }

  /**
   * Persist the current store atomically, keeping the previous file as .bak.
   * @param data - the store snapshot to persist.
   */
  async save(data: StoreData): Promise<void> {
    await this.adapter.backup()
    await this.adapter.write(JSON.stringify(data, null, 2))
    this.data = data
  }
}

/**
 * Parse one persisted payload into a store, validating the shape loosely.
 * @param text - the raw file content.
 * @returns the store, or undefined when the payload is not a valid store.
 */
function parseStore(text: string): StoreData | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  if (row.version !== 1 || typeof row.apiKey !== 'string' || !Array.isArray(row.projects)) return undefined
  return row as unknown as StoreData
}

/**
 * Describe the adapter's location for error messages.
 * @param adapter - the store adapter.
 * @returns a short location description.
 */
function storePath(adapter: StoreAdapter): string {
  return adapter instanceof FsStoreAdapter ? 'store.json' : 'memory store'
}
