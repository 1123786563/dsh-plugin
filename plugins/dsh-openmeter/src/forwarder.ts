/**
 * The WAL drain loop (ADR-0002): batches pending records, POSTs them to
 * OpenMeter ingest, confirms on 2xx, backs off exponentially on failure.
 * At-least-once semantics ride on OpenMeter's (namespace, id, source) dedupe.
 *
 * @module dsh-openmeter/forwarder
 */

import type { WalRecord } from './cloudevent.ts'
import type { Config } from './config.ts'
import type { OpenMeterClient } from './openmeter.ts'
import type { MeteringWal } from './wal.ts'

/** Forwarder health for the status route. */
export interface ForwarderStats {
  running: boolean
  draining: boolean
  lastDrainAt: number
  lastError?: string
  batchesSent: number
  eventsConfirmed: number
}

/**
 * The drain pump. Started by the pipeline; owns one interval timer.
 */
export class Forwarder {
  private readonly wal: MeteringWal
  private readonly client: () => OpenMeterClient
  private readonly getConfig: () => Config
  private timer: ReturnType<typeof setInterval> | undefined
  private draining = false
  private lastDrainAt = 0
  private lastError: string | undefined
  private batchesSent = 0
  private eventsConfirmed = 0

  /**
   * @param wal - the write-ahead log.
   * @param client - factory returning the live client.
   * @param getConfig - live config accessor.
   */
  constructor(wal: MeteringWal, client: () => OpenMeterClient, getConfig: () => Config) {
    this.wal = wal
    this.client = client
    this.getConfig = getConfig
  }

  /**
   * Start the interval pump.
   */
  start(): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      void this.drain()
    }, 5_000)
    // First drain attempt soon after boot (replay of the unconfirmed tail).
    setTimeout(() => {
      void this.drain()
    }, 1_000)
  }

  /**
   * Stop the pump (effect disposer).
   */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * Drain once: all pending batches, sequentially, best effort.
   */
  async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      const config = this.getConfig()
      for (;;) {
        const pending = this.wal.pending()
        if (pending.length === 0) break
        const batch: WalRecord[] = pending.slice(0, config.batchSize)
        try {
          await this.client().ingest(batch.map(record => record.event))
          await this.wal.confirm(batch.map(record => record.id), Date.now())
          this.batchesSent += 1
          this.eventsConfirmed += batch.length
          this.lastError = undefined
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error)
          this.wal.noteFailure(batch.map(record => record.id))
          break // back off; the next tick retries
        }
      }
      this.lastDrainAt = Date.now()
    } finally {
      this.draining = false
    }
  }

  /**
   * Health snapshot.
   */
  stats(): ForwarderStats {
    return {
      running: this.timer !== undefined,
      draining: this.draining,
      lastDrainAt: this.lastDrainAt,
      batchesSent: this.batchesSent,
      eventsConfirmed: this.eventsConfirmed,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    }
  }
}
