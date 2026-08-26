/**
 * Local cost estimation against the OpenMeter llm-cost catalog (ADR-0001):
 * prices are pulled (never hand-maintained), cached in memory, and used for
 * instant display only — the ledger stays authoritative.
 *
 * @module dsh-openmeter/estimator
 */

import type { MeteringEventData } from './cloudevent.ts'
import type { OpenMeterClient, PriceRow } from './openmeter.ts'

/** One priced row keyed by provider/model. */
export interface PriceKey {
  provider: string
  model: string
}

/** Result of one estimate. */
export interface Estimate {
  /** Estimated amount in the row's currency. */
  amount: number
  /** Currency of the price row used (CNY when overrides are configured). */
  currency: string
  /** True when no price row matched the model at all (amount stays 0). */
  unpriced: boolean
}

/**
 * The price cache + estimator. Refreshed on an interval; never blocks calls.
 */
export class PriceEstimator {
  private readonly client: () => OpenMeterClient
  private readonly getCurrency: () => string
  private rows: PriceRow[] = []
  private byKey = new Map<string, PriceRow>()
  private lastRefreshAt = 0
  private lastError: string | undefined
  private refreshing = false

  /**
   * @param client - factory returning the live client.
   * @param getCurrency - preferred quote currency (config).
   */
  constructor(client: () => OpenMeterClient, getCurrency: () => string) {
    this.client = client
    this.getCurrency = getCurrency
  }

  /**
   * Pull prices when stale; safe to call from a timer loop.
   * @param force - refresh even when fresh.
   */
  async refresh(force = false): Promise<void> {
    if (this.refreshing) return
    if (!force && this.rows.length > 0 && Date.now() - this.lastRefreshAt < 60_000) return
    this.refreshing = true
    try {
      const rows = await this.client().listPrices()
      this.rows = rows
      this.byKey = new Map(rows.map(row => [row.providerId + '/' + row.modelId, row]))
      this.lastRefreshAt = Date.now()
      this.lastError = undefined
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
    } finally {
      this.refreshing = false
    }
  }

  /**
   * Estimate one metered call's amount against cached prices. Prefers a row
   * in the quote currency, falls back to any row for the model.
   * @param data - the event payload.
   * @returns the estimate.
   */
  estimate(data: MeteringEventData): Estimate {
    const direct = this.byKey.get(data.provider + '/' + data.model)
    const fallback = direct === undefined ? this.findByModelOnly(data.model) : undefined
    const row = direct ?? fallback
    if (row === undefined) return { amount: 0, currency: this.getCurrency(), unpriced: true }
    return {
      amount: priceRow(row, data),
      currency: row.currency,
      unpriced: false,
    }
  }

  /**
   * Pick the best row for a provider/model: quote-currency row first.
   * @param provider - provider id.
   * @param model - model id.
   */
  rowFor(provider: string, model: string): PriceRow | undefined {
    const key = provider + '/' + model
    const rows = this.rows.filter(row => row.providerId + '/' + row.modelId === key)
    return pickCurrency(rows, this.getCurrency())
  }

  /**
   * Cache health for the status route.
   */
  stats(): { rows: number, lastRefreshAt: number, lastError?: string } {
    return {
      rows: this.rows.length,
      lastRefreshAt: this.lastRefreshAt,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    }
  }

  /**
   * Fuzzy model match without provider (model ids are near-unique).
   * @param model - model id.
   */
  private findByModelOnly(model: string): PriceRow | undefined {
    const rows = this.rows.filter(row => row.modelId === model)
    return pickCurrency(rows, this.getCurrency())
  }
}

/**
 * Sum the priced buckets of one call against one price row.
 * @param row - the price row.
 * @param data - the event payload.
 * @returns the amount.
 */
function priceRow(row: PriceRow, data: MeteringEventData): number {
  const input = (row.inputPerToken ?? 0) * data.inputTokens
  const output = (row.outputPerToken ?? 0) * data.outputTokens
  const cacheRead = (row.cacheReadPerToken ?? 0) * (data.cacheReadTokens ?? 0)
  const cacheWrite = (row.cacheWritePerToken ?? 0) * (data.cacheWriteTokens ?? 0)
  const reasoning = (row.reasoningPerToken ?? 0) * (data.reasoningTokens ?? 0)
  return input + output + cacheRead + cacheWrite + reasoning
}

/**
 * Prefer a row in the quote currency among candidates.
 * @param rows - candidate rows.
 * @param currency - preferred currency.
 */
function pickCurrency(rows: PriceRow[], currency: string): PriceRow | undefined {
  return rows.find(row => row.currency === currency) ?? rows[0]
}
