import { describe, expect, it } from 'vitest'
import { PriceEstimator } from '../src/estimator.ts'
import type { OpenMeterClient, PriceRow } from '../src/openmeter.ts'

function row(overrides: Partial<PriceRow>): PriceRow {
  return {
    id: 'price-1',
    providerId: 'deepseek',
    modelId: 'glm-5.3',
    currency: 'CNY',
    inputPerToken: 0.001,
    outputPerToken: 0.004,
    ...overrides,
  } as PriceRow
}

function clientWith(rows: PriceRow[]): OpenMeterClient {
  return { listPrices: async () => rows } as unknown as OpenMeterClient
}

describe('PriceEstimator', () => {
  it('prices every bucket against the matching row', async () => {
    const estimator = new PriceEstimator(
      () => clientWith([row({ cacheReadPerToken: 0.0001, cacheWritePerToken: 0.002, reasoningPerToken: 0.001 })]),
      () => 'CNY',
    )
    await estimator.refresh(true)
    const estimate = estimator.estimate({
      tokens: 220,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 40,
      cacheWriteTokens: 30,
      reasoningTokens: 10,
      billedInputTokens: 170,
      provider: 'deepseek',
      model: 'glm-5.3',
    })
    // 100*0.001 + 50*0.004 + 40*0.0001 + 30*0.002 + 10*0.001 = 0.374
    expect(estimate.amount).toBeCloseTo(0.374, 9)
    expect(estimate.currency).toBe('CNY')
    expect(estimate.unpriced).toBe(false)
  })

  it('prefers the quote-currency row among duplicates', async () => {
    const estimator = new PriceEstimator(
      () => clientWith([row({ currency: 'USD', inputPerToken: 0.0001 }), row({ id: 'p2', currency: 'CNY', inputPerToken: 0.002 })]),
      () => 'CNY',
    )
    await estimator.refresh(true)
    const estimate = estimator.estimate({ tokens: 10, inputTokens: 10, outputTokens: 0, billedInputTokens: 10, provider: 'deepseek', model: 'glm-5.3' })
    expect(estimate.amount).toBeCloseTo(0.02, 9)
  })

  it('reports unpriced when no row matches', async () => {
    const estimator = new PriceEstimator(() => clientWith([]), () => 'CNY')
    await estimator.refresh(true)
    const estimate = estimator.estimate({ tokens: 5, inputTokens: 5, outputTokens: 0, billedInputTokens: 5, provider: 'x', model: 'unknown' })
    expect(estimate.unpriced).toBe(true)
    expect(estimate.amount).toBe(0)
  })

  it('keeps stale rows when the refresh fails (offline estimates)', async () => {
    let rows: PriceRow[] = [row({})]
    let fail = false
    const client = { listPrices: async (): Promise<PriceRow[]> => { if (fail) throw new Error('down'); return rows } } as unknown as OpenMeterClient
    const estimator = new PriceEstimator(() => client, () => 'CNY')
    await estimator.refresh(true)
    fail = true
    await estimator.refresh(true)
    const estimate = estimator.estimate({ tokens: 100, inputTokens: 100, outputTokens: 0, billedInputTokens: 100, provider: 'deepseek', model: 'glm-5.3' })
    expect(estimate.amount).toBeCloseTo(0.1, 9)
    rows = []
  })
})
