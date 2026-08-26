/**
 * NocoBase health probe: the official readiness endpoint is /__health_check
 * (the CLI waits on it too). Failures surface as { healthy: false } payloads,
 * never as thrown errors — the card shows state, it does not gate boot.
 *
 * @module dsh-nocobase/nocobase
 */

import type { Config } from './config.ts'

/** One health answer for the status route and card. */
export interface NocobaseHealth {
  healthy: boolean
  baseUrl: string
  /** HTTP status of the probe, when one answer arrived. */
  status?: number
  /** Short failure reason, when the probe failed. */
  error?: string
  /** When the probe ran (epoch ms). */
  checkedAt: number
}

/**
 * Probe the NocoBase readiness endpoint once.
 * @param getConfig - live config accessor (settings-resolved when attached).
 * @returns the health answer (never throws).
 */
export async function probeNocobase(getConfig: () => Config): Promise<NocobaseHealth> {
  const config = getConfig()
  const answer: NocobaseHealth = { healthy: false, baseUrl: config.baseUrl, checkedAt: Date.now() }
  try {
    const response = await fetch(`${config.baseUrl}/__health_check`, {
      signal: AbortSignal.timeout(config.timeoutMs),
    })
    answer.status = response.status
    answer.healthy = response.ok
  } catch (error) {
    answer.error = error instanceof Error ? error.message : String(error)
  }
  return answer
}
