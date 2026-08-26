/**
 * Durable at-least-once queue for metering events (ADR-0002).
 *
 * One append-only JSONL file: every line a WalRecord. Appends hit the file
 * before the call returns (process-crash safe; machine-power loss may lose the
 * OS page cache only). Confirmed records are kept until they age out of the
 * OpenMeter (namespace, id, source) dedupe window (32 days), then dropped by
 * an atomic rewrite (compaction). Restart replays everything unconfirmed.
 *
 * @module dsh-openmeter/wal
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { WalRecord } from './cloudevent.ts'

/** Milliseconds after which a confirmed record may be dropped (32d + slack). */
const CONFIRMED_RETENTION_MS = 33 * 24 * 60 * 60 * 1000

/** Compaction triggers when stale confirmed lines exceed this count. */
const COMPACT_STALE_THRESHOLD = 500

/** WAL health snapshot for the status route. */
export interface WalStats {
  pending: number
  confirmedRecent: number
  total: number
  oldestPendingAt: number
  lastConfirmedAt: number
  lastError?: string
}

/**
 * The write-ahead log. Single-writer; the forwarder is its only consumer.
 */
export class MeteringWal {
  private readonly file: string
  private readonly tmp: string
  private records: WalRecord[] = []
  private loaded = false
  private writing = false
  private lastError: string | undefined

  /**
   * @param dir - directory holding wal.jsonl (created on demand).
   */
  constructor(dir: string) {
    this.file = join(dir, 'wal.jsonl')
    this.tmp = join(dir, 'wal.jsonl.tmp')
  }

  /**
   * Replay the file into memory; corrupt lines are skipped (never throw — a
   * torn last line must not brick billing).
   */
  async load(): Promise<void> {
    if (this.loaded) return
    await mkdir(dirname(this.file), { recursive: true })
    let text = ''
    try {
      text = await readFile(this.file, 'utf8')
    } catch {
      text = ''
    }
    const records: WalRecord[] = []
    const dedupeWindowEdge = Date.now() - CONFIRMED_RETENTION_MS
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      try {
        const parsed = JSON.parse(trimmed) as WalRecord
        if (typeof parsed?.id === 'string' && parsed?.event?.id === parsed.id) {
          // A pending record older than the OpenMeter dedupe window is
          // ambiguous (delivered-but-unconfirmed vs never-delivered):
          // redelivering could double-bill, so it is dropped.
          if (Number(parsed.confirmedAt) === 0 && (Number(parsed.appendedAt) || 0) < dedupeWindowEdge) continue
          records.push({
            id: parsed.id,
            appendedAt: Number(parsed.appendedAt) || 0,
            confirmedAt: Number(parsed.confirmedAt) || 0,
            failures: Number(parsed.failures) || 0,
            event: parsed.event,
          })
        }
      } catch {
        // Skip the torn line; a duplicate id, if any, dedupes server-side.
      }
    }
    this.records = records
    this.loaded = true
  }

  /**
   * Persist one record durably (append + flush to the OS).
   * @param record - the record to append.
   */
  async append(record: WalRecord): Promise<void> {
    await this.load()
    this.records.push(record)
    await appendFile(this.file, JSON.stringify(record) + '\n', 'utf8')
  }

  /**
   * Pending records in append order (the forwarder's work list).
   * @returns records not yet confirmed by OpenMeter.
   */
  pending(): WalRecord[] {
    return this.records.filter(record => record.confirmedAt === 0)
  }

  /**
   * Mark records confirmed and schedule compaction when stale lines pile up.
   * @param ids - confirmed CloudEvents ids.
   * @param at - confirmation timestamp (epoch ms).
   */
  async confirm(ids: readonly string[], at: number): Promise<void> {
    if (ids.length === 0) return
    const set = new Set(ids)
    for (const record of this.records) {
      if (record.confirmedAt === 0 && set.has(record.id)) {
        record.confirmedAt = at
        record.failures = 0
      }
    }
    const stale = this.records.filter(record => record.confirmedAt !== 0 && at - record.confirmedAt > CONFIRMED_RETENTION_MS)
    if (stale.length > COMPACT_STALE_THRESHOLD) await this.compact(at)
  }

  /**
   * Record one failed drain attempt on the given records (backoff bookkeeping).
   * @param ids - the ids whose batch failed.
   */
  noteFailure(ids: readonly string[]): void {
    const set = new Set(ids)
    for (const record of this.records) {
      if (record.confirmedAt === 0 && set.has(record.id)) record.failures += 1
    }
  }

  /**
   * Rewrite the file keeping pending records plus confirmed ones inside the
   * dedupe window. Atomic via rename; skipped while another write runs.
   * @param now - current epoch ms.
   */
  async compact(now: number): Promise<void> {
    if (this.writing) return
    this.writing = true
    try {
      const kept = this.records.filter(record =>
        record.confirmedAt === 0 || now - record.confirmedAt <= CONFIRMED_RETENTION_MS,
      )
      const body = kept.map(record => JSON.stringify(record)).join('\n') + (kept.length > 0 ? '\n' : '')
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(this.tmp, body, 'utf8')
      await rename(this.tmp, this.file)
      this.records = kept
      this.lastError = undefined
    } catch (error) {
      this.lastError = describe(error)
    } finally {
      this.writing = false
    }
  }

  /**
   * Health snapshot for the status route.
   * @returns current WAL statistics.
   */
  stats(): WalStats {
    const pendingRecords = this.records.filter(record => record.confirmedAt === 0)
    const confirmedRecords = this.records.filter(record => record.confirmedAt !== 0)
    let oldestPendingAt = 0
    for (const record of pendingRecords) {
      if (oldestPendingAt === 0 || record.appendedAt < oldestPendingAt) oldestPendingAt = record.appendedAt
    }
    let lastConfirmedAt = 0
    for (const record of confirmedRecords) {
      if (record.confirmedAt > lastConfirmedAt) lastConfirmedAt = record.confirmedAt
    }
    return {
      pending: pendingRecords.length,
      confirmedRecent: confirmedRecords.length,
      total: this.records.length,
      oldestPendingAt,
      lastConfirmedAt,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    }
  }

  /**
   * Records with confirmedAt set, newest first, for usage aggregation routes.
   * @returns a defensive copy of the confirmed records.
   */
  confirmedSnapshot(): WalRecord[] {
    return this.records
      .filter(record => record.confirmedAt !== 0)
      .slice()
      .sort((a, b) => b.appendedAt - a.appendedAt)
  }
}

/**
 * Describe one thrown error on one line.
 * @param error - the thrown value.
 * @returns a short message.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
