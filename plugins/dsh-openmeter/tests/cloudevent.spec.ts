import { describe, expect, it } from 'vitest'
import { billedInputTokens, buildWalRecord, meteredTokens } from '../src/cloudevent.ts'

describe('billedInputTokens', () => {
  it('sums uncached input plus cache read and write', () => {
    expect(billedInputTokens({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 })).toBe(115)
  })

  it('treats missing cache buckets as zero', () => {
    expect(billedInputTokens({ inputTokens: 100, outputTokens: 50 })).toBe(100)
  })

  it('counts metered tokens as billed input plus output, reasoning not double-counted', () => {
    expect(meteredTokens({ inputTokens: 10, outputTokens: 20, reasoningTokens: 15 })).toBe(30)
  })
})

describe('buildWalRecord', () => {
  const call = {
    subject: 'cust-1',
    provider: 'deepseek',
    model: 'glm-5.3',
    sessionId: 's1',
    rootSessionId: 'root1',
    presetId: 'p1',
    usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 10 },
    latencyMs: 1200,
    capturedAt: 1_700_000_000_000,
  }

  it('builds a CloudEvents 1.0 envelope with the meter payload', () => {
    const record = buildWalRecord(call, 'dsh.llm.call', 'dsh')
    expect(record.event.specversion).toBe('1.0')
    expect(record.event.type).toBe('dsh.llm.call')
    expect(record.event.source).toBe('dsh')
    expect(record.event.subject).toBe('cust-1')
    expect(record.event.time).toBe(new Date(1_700_000_000_000).toISOString())
    expect(record.event.data.tokens).toBe(150)
    expect(record.event.data.billedInputTokens).toBe(110)
    expect(record.event.data.rootSessionId).toBe('root1')
    expect(record.confirmedAt).toBe(0)
  })

  it('omits absent optional dimensions instead of writing undefined', () => {
    const record = buildWalRecord({ subject: 'house', provider: 'x', model: 'm', usage: { inputTokens: 1, outputTokens: 1 }, capturedAt: 1 }, 't', 's')
    expect(record.event.data).not.toHaveProperty('rootSessionId')
    expect(record.event.data).not.toHaveProperty('purpose')
    expect(record.event.data).not.toHaveProperty('cacheReadTokens')
  })

  it('uses a fresh UUID per record (idempotency key generated once)', () => {
    const first = buildWalRecord(call, 't', 's')
    const second = buildWalRecord(call, 't', 's')
    expect(first.id).not.toBe(second.id)
    expect(first.id).toBe(first.event.id)
  })
})
