/**
 * The balance gate (ADR-0003): hard-block model calls when the customer's
 * prepaid balance is exhausted, with a short-lived governance cache and a
 * fail-open policy when OpenMeter itself is unreachable. Manual operator
 * blocks override everything; the house subject is never blocked.
 *
 * @module dsh-openmeter/gate
 */

import type { Config } from './config.ts'
import type { GovernanceResult, OpenMeterClient } from './openmeter.ts'
import type { OperatorStore } from './store.ts'

/** One cached access answer for a subject. */
interface AccessEntry {
  at: number
  allowed: boolean
  reasonCode?: string
  reasonMessage?: string
}

/** Gate health for the status route. */
export interface GateStats {
  cacheSize: number
  lastQueryAt: number
  lastError?: string
  failOpenCount: number
  blockedCount: number
}

/**
 * The balance gate. One shared in-flight query per refresh; callers await the
 * cached answer inside TTL or trigger a refresh.
 */
export class BalanceGate {
  private readonly client: () => OpenMeterClient
  private readonly store: OperatorStore
  private readonly getConfig: () => Config
  private cache = new Map<string, AccessEntry>()
  private inflight: Promise<void> | undefined
  private lastQueryAt = 0
  private lastError: string | undefined
  private failOpenCount = 0
  private blockedCount = 0

  /**
   * @param client - factory returning the live client.
   * @param store - the operator state store (manual blocks).
   * @param getConfig - live config accessor.
   */
  constructor(client: () => OpenMeterClient, store: OperatorStore, getConfig: () => Config) {
    this.client = client
    this.store = store
    this.getConfig = getConfig
  }

  /**
   * Decide whether a call attributed to `subject` may proceed.
   * @param subject - the customer subject key (house included).
   * @returns true to allow, false to hard-block.
   */
  async allow(subject: string): Promise<boolean> {
    const config = this.getConfig()
    if (!config.blockEnabled) return true
    if (subject === config.houseSubject) return true
    if (this.store.isManuallyBlocked(subject)) {
      this.blockedCount += 1
      return false
    }
    const cached = this.cache.get(subject)
    if (cached !== undefined && Date.now() - cached.at < config.accessCacheTtlMs) {
      if (!cached.allowed) this.blockedCount += 1
      return cached.allowed
    }
    // Unknown subject: query it directly (the background sweep only covers
    // bound subjects), then fall back to any stale answer on failure.
    await this.refreshNow([subject])
    let answer = this.cache.get(subject)
    if (answer === undefined) {
      await this.refresh()
      answer = this.cache.get(subject)
    }
    if (answer === undefined) {
      // Never queried successfully: fail open (ADR-0003).
      this.failOpenCount += 1
      return true
    }
    if (!answer.allowed) this.blockedCount += 1
    return answer.allowed
  }

  /**
   * Force a governance refresh for a set of subjects (used by the cashier
   * after recharge/unblock so the gate reacts immediately).
   * @param subjects - subject keys to refresh.
   */
  async refreshNow(subjects: readonly string[]): Promise<void> {
    if (subjects.length === 0) return
    const config = this.getConfig()
    const featureKeys = [config.featureKey]
    try {
      const rows: GovernanceResult[] = await this.client().governance(subjects, featureKeys, true)
      const byKey = new Map<string, GovernanceResult>()
      for (const row of rows) {
        for (const matched of row.matched) byKey.set(matched, row)
        if (row.customerKey.length > 0) byKey.set(row.customerKey, row)
      }
      const next = new Map<string, AccessEntry>()
      for (const subject of subjects) {
        const row = byKey.get(subject)
        if (row === undefined) continue
        const access = row.features[config.featureKey]
        next.set(subject, {
          at: Date.now(),
          allowed: access?.hasAccess !== false,
          ...(access?.reasonCode === undefined ? {} : { reasonCode: access.reasonCode }),
          ...(access?.reasonMessage === undefined ? {} : { reasonMessage: access.reasonMessage }),
        })
      }
      this.cache = next.size > 0 ? next : this.cache
      this.lastQueryAt = Date.now()
      this.lastError = undefined
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * Background refresh: known bound subjects + cached subjects, one flight.
   */
  async refresh(): Promise<void> {
    if (this.inflight !== undefined) return this.inflight
    this.inflight = this.refreshBackground().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  /**
   * One cached subject's current view (for the status route).
   * @param subject - customer subject key.
   */
  peek(subject: string): AccessEntry | undefined {
    return this.cache.get(subject)
  }

  /**
   * Gate health snapshot.
   */
  stats(): GateStats {
    return {
      cacheSize: this.cache.size,
      lastQueryAt: this.lastQueryAt,
      failOpenCount: this.failOpenCount,
      blockedCount: this.blockedCount,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    }
  }

  /**
   * The background sweep: query every subject the operator bound plus cached.
   */
  private async refreshBackground(): Promise<void> {
    const config = this.getConfig()
    const state = this.store.snapshot()
    const subjects = new Set<string>(Object.values(state.bindings))
    for (const key of this.cache.keys()) subjects.add(key)
    subjects.delete(config.houseSubject)
    if (subjects.size === 0) return
    await this.refreshNow([...subjects])
  }
}
