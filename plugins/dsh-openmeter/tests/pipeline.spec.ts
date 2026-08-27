import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MeteringPipeline } from '../src/pipeline.ts'
import { BalanceGate } from '../src/gate.ts'
import { PriceEstimator } from '../src/estimator.ts'
import { OperatorStore } from '../src/store.ts'
import { resolveConfig } from '../src/config.ts'
import { UsageLedger } from '../src/ledger.ts'
import { MeteringWal } from '../src/wal.ts'
import type { OpenMeterClient } from '../src/openmeter.ts'
import type { SessionsLike } from '../src/types.ts'

let dir: string | undefined
const ledgers: UsageLedger[] = []

afterEach(async () => {
  for (const ledger of ledgers) ledger.close()
  ledgers.length = 0
  if (dir !== undefined) {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch (error) {
      // Known macOS ENOTEMPTY tmpdir flake (repo-wide); one forced retry clears it.
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
      await rm(dir, { recursive: true, force: true })
    }
  }
  dir = undefined
})

function sessionsWith(header?: { agentPreset?: string, origin?: string, parentSession?: string }): SessionsLike {
  return {
    get: id => (header === undefined ? undefined : { id, header: { id, ...header } }),
  }
}

async function build(options: {
  header?: { agentPreset?: string, origin?: string, parentSession?: string }
  manualBlock?: string
  bind?: { preset: string, customer: string }
  /** Reuse an existing data directory (restart-recovery scenarios). */
  dir?: string
  /** Omit the usageLedger dep (pipeline must work exactly as before). */
  withoutLedger?: boolean
}) {
  dir = options.dir ?? await mkdtemp(join(tmpdir(), 'ompipe-'))
  const config = resolveConfig({ accessCacheTtlMs: 5_000 })
  const store = new OperatorStore(dir)
  if (options.manualBlock !== undefined) await store.setManualBlock(options.manualBlock, true)
  const client = { governance: async () => [] } as unknown as OpenMeterClient
  const gate = new BalanceGate(() => client, store, () => config)
  const estimator = new PriceEstimator(() => client, () => config.quoteCurrency)
  const wal = new MeteringWal(dir)
  await wal.load()
  const usageLedger = options.withoutLedger === true ? undefined : UsageLedger.open(dir)
  if (usageLedger !== undefined) ledgers.push(usageLedger)
  const sessions = sessionsWith(options.header)
  const pipeline = new MeteringPipeline({
    wal,
    gate,
    estimator,
    getConfig: () => config,
    sessions: () => sessions,
    presetSubject: presetId => store.subjectFor(presetId, config.houseSubject),
    observePreset: presetId => store.observePreset(presetId),
    ...(usageLedger === undefined ? {} : { usageLedger }),
  })
  return { pipeline, wal, store, config, ledger: usageLedger, dir }
}

const usage = { inputTokens: 100, outputTokens: 50 }

describe('MeteringPipeline metering (session/event source)', () => {
  it('meters one committed assistant message as one WAL record', async () => {
    const { pipeline, wal } = await build({})
    pipeline.onSessionEvent('s1', {
      type: 'assistant/message',
      seq: 3,
      time: 1_700_000_000_000,
      data: { turn: 1, step: 0, usage, message: { source: { provider: 'deepseek', model: 'glm-5.3' } } },
    })
    await Promise.resolve()
    const pending = wal.pending()
    expect(pending.length).toBe(1)
    expect(pending[0]?.event.subject).toBe('house')
    expect(pending[0]?.event.data.model).toBe('glm-5.3')
    expect(pending[0]?.event.data.tokens).toBe(150)
  })

  it('never meters the same (session, seq) twice', async () => {
    const { pipeline, wal } = await build({})
    const event = {
      type: 'assistant/message',
      seq: 3,
      time: 1_700_000_000_000,
      data: { turn: 1, step: 0, usage, message: { source: { provider: 'deepseek', model: 'glm-5.3' } } },
    } as const
    pipeline.onSessionEvent('s1', event)
    pipeline.onSessionEvent('s1', event)
    await Promise.resolve()
    expect(wal.pending().length).toBe(1)
  })

  it('attributes via preset binding; house fallback otherwise', async () => {
    const { pipeline, wal, store } = await build({ header: { agentPreset: 'preset-a' } })
    await store.setBinding('preset-a', 'cust-1')
    pipeline.onSessionEvent('s1', {
      type: 'assistant/message',
      seq: 1,
      time: 1,
      data: { turn: 0, step: 0, usage, message: { source: { provider: 'x', model: 'm' } } },
    })
    await Promise.resolve()
    expect(wal.pending()[0]?.event.subject).toBe('cust-1')
  })

  it('subagent calls carry rootSessionId', async () => {
    const { pipeline, wal } = await build({ header: { origin: 'subagent', parentSession: 'root-9' } })
    pipeline.onSessionEvent('sub-1', {
      type: 'assistant/message',
      seq: 1,
      time: 1,
      data: { turn: 0, step: 0, usage, message: { source: { provider: 'x', model: 'm' } } },
    })
    await Promise.resolve()
    expect(wal.pending()[0]?.event.data.rootSessionId).toBe('root-9')
    expect(wal.pending()[0]?.event.data.sessionId).toBe('sub-1')
  })

  it('computes latency from the paired step/start', async () => {
    const { pipeline, wal } = await build({})
    pipeline.onSessionEvent('s1', { type: 'step/start', seq: 2, time: 1_000, data: { turn: 1, step: 0 } })
    pipeline.onSessionEvent('s1', {
      type: 'assistant/message',
      seq: 3,
      time: 2_500,
      data: { turn: 1, step: 0, usage, message: { source: { provider: 'x', model: 'm' } } },
    })
    await Promise.resolve()
    expect(wal.pending()[0]?.event.data.latencyMs).toBe(1_500)
  })

  it('skips assistant messages without usage or source', async () => {
    const { pipeline, wal } = await build({})
    pipeline.onSessionEvent('s1', { type: 'assistant/message', seq: 1, time: 1, data: { turn: 0, step: 0, message: { source: { provider: 'x', model: 'm' } } } })
    pipeline.onSessionEvent('s1', { type: 'assistant/message', seq: 2, time: 1, data: { turn: 0, step: 1, usage, message: {} } })
    await Promise.resolve()
    expect(wal.pending().length).toBe(0)
  })
})

describe('MeteringPipeline gate (llm/stream source)', () => {
  async function* stream(): AsyncIterable<{ type: string }> {
    yield { type: 'usage' }
    yield { type: 'finish' }
  }

  it('passes the stream through untouched when allowed', async () => {
    const { pipeline } = await build({})
    const wrapped = pipeline.onStream({ provider: 'x', model: 'm', sessionId: 's1' }, stream)
    const chunks: string[] = []
    for await (const chunk of wrapped) chunks.push(chunk.type)
    expect(chunks).toEqual(['usage', 'finish'])
  })

  it('throws BlockError before the first chunk when balance is exhausted', async () => {
    const { pipeline, store } = await build({ header: { agentPreset: 'preset-a' }, manualBlock: 'cust-1' })
    await store.setBinding('preset-a', 'cust-1')
    const wrapped = pipeline.onStream({ provider: 'x', model: 'm', sessionId: 's1' }, stream)
    await expect((async () => {
      for await (const _chunk of wrapped) void _chunk
    })()).rejects.toThrow(/blocked/)
  })
})

describe('durable usage ledger integration', () => {
  it('appends exactly one ledger row per committed assistant message', async () => {
    const { pipeline, ledger: maybeLedger, wal, config } = await build({})
    const ledger = maybeLedger!
    pipeline.onSessionEvent('s1', {
      type: 'assistant/message',
      seq: 3,
      time: 1_700_000_000_000,
      data: { turn: 1, step: 0, usage, message: { source: { provider: 'deepseek', model: 'glm-5.3' } } },
    })
    await vi.waitFor(() => {
      expect(ledger.list({ subject: 'house' })).toHaveLength(1)
    })
    const row = ledger.list({ subject: 'house' })[0]!
    expect(row.subject).toBe('house')
    expect(row.tokens).toBe(150)
    expect(row.capturedAt).toBe(1_700_000_000_000)
    expect(row.source).toBe(config.eventSource)
    expect(row.provider).toBe('deepseek')
    expect(row.model).toBe('glm-5.3')
    // The test client serves no price rows: the estimate is the unpriced zero.
    expect(row.estimatedAmount).toBe(0)
    expect(row.currency).toBe(config.quoteCurrency)
    expect(row.unpriced).toBe(true)
    expect(row.eventId).toBe(wal.pending()[0]?.event.id)
    // The ring row carries the same estimate object the ledger row stored.
    const ring = pipeline.usageRows()
    expect(ring).toHaveLength(1)
    expect(ring[0]).toMatchObject({
      subject: row.subject,
      provider: row.provider,
      model: row.model,
      estimatedAmount: row.estimatedAmount,
      currency: row.currency,
      unpriced: row.unpriced,
      at: row.capturedAt,
    })
  })

  it('keeps a single ledger row when the same (session, seq) is delivered twice', async () => {
    const { pipeline, ledger: maybeLedger, wal } = await build({})
    const ledger = maybeLedger!
    const event = {
      type: 'assistant/message',
      seq: 3,
      time: 1_700_000_000_000,
      data: { turn: 1, step: 0, usage, message: { source: { provider: 'deepseek', model: 'glm-5.3' } } },
    } as const
    pipeline.onSessionEvent('s1', event)
    pipeline.onSessionEvent('s1', event)
    await vi.waitFor(() => {
      expect(ledger.list({ subject: 'house' })).toHaveLength(1)
    })
    expect(wal.pending()).toHaveLength(1)
    expect(ledger.stats().total).toBe(1)
  })

  it('acknowledges a ledger-level duplicate without touching the original row', async () => {
    const { pipeline, ledger: maybeLedger, config } = await build({})
    const ledger = maybeLedger!
    pipeline.onSessionEvent('s1', {
      type: 'assistant/message',
      seq: 3,
      time: 1_700_000_000_000,
      data: { turn: 1, step: 0, usage, message: { source: { provider: 'deepseek', model: 'glm-5.3' } } },
    })
    await vi.waitFor(() => {
      expect(ledger.list({ subject: 'house' })).toHaveLength(1)
    })
    const original = ledger.list({ subject: 'house' })[0]!
    // Same (source, eventId) with a conflicting payload: the write-once
    // seam the pipeline relies on when it treats 'duplicate' as acknowledged.
    const outcome = ledger.append({
      source: config.eventSource,
      eventId: original.eventId,
      subject: 'other-tenant',
      capturedAt: 1,
      provider: 'p',
      model: 'm',
      tokens: 1,
      estimatedAmount: 1,
      currency: 'USD',
      unpriced: false,
    })
    expect(outcome).toBe('duplicate')
    expect(ledger.list({ subject: 'house' })).toEqual([original])
    expect(ledger.list({ subject: 'other-tenant' })).toHaveLength(0)
    expect(ledger.stats().total).toBe(1)
  })

  it('recovers persisted rows across a new pipeline instance on the same directory', async () => {
    // A current timestamp: the replayed WAL drops pending records older than
    // the 33-day dedupe window, so a restart test must meter "now".
    const time = Date.now()
    const first = await build({})
    const firstLedger = first.ledger!
    first.pipeline.onSessionEvent('s1', {
      type: 'assistant/message',
      seq: 3,
      time,
      data: { turn: 1, step: 0, usage, message: { source: { provider: 'deepseek', model: 'glm-5.3' } } },
    })
    await vi.waitFor(() => {
      expect(firstLedger.list({ subject: 'house' })).toHaveLength(1)
    })
    const original = firstLedger.list({ subject: 'house' })[0]!

    // Restart: a fresh pipeline + fresh ledger connection on the same
    // directory list the persisted row without re-appending anything.
    const second = await build({ dir: first.dir })
    const secondLedger = second.ledger!
    expect(secondLedger.list({ subject: 'house' })).toEqual([original])
    expect(second.wal.pending()).toHaveLength(1)

    // A re-fed (sessionId, seq) through the fresh pipeline is a NEW
    // capture: buildWalRecord mints a new CloudEvent id, the WAL appends a
    // second record, and the ledger mirrors it — the (sessionId, seq)
    // dedupe set is per instance and the ledger key is (source, eventId),
    // so the ledger stays 1:1 with the authoritative WAL across restarts.
    second.pipeline.onSessionEvent('s1', {
      type: 'assistant/message',
      seq: 3,
      time,
      data: { turn: 1, step: 0, usage, message: { source: { provider: 'deepseek', model: 'glm-5.3' } } },
    })
    await vi.waitFor(() => {
      expect(secondLedger.stats().total).toBe(2)
    })
    expect(second.wal.pending()).toHaveLength(2)
    const rows = secondLedger.list({ subject: 'house' })
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.eventId)).toContain(original.eventId)
    expect(new Set(rows.map(row => row.eventId)).size).toBe(2)
    expect(rows.every(row => row.tokens === 150 && row.capturedAt === time)).toBe(true)
  })

  it('meters exactly as before when no usageLedger dep is wired', async () => {
    const { pipeline, wal, dir } = await build({ withoutLedger: true })
    pipeline.onSessionEvent('s1', {
      type: 'assistant/message',
      seq: 3,
      time: 1_700_000_000_000,
      data: { turn: 1, step: 0, usage, message: { source: { provider: 'deepseek', model: 'glm-5.3' } } },
    })
    await vi.waitFor(() => {
      expect(wal.pending()).toHaveLength(1)
    })
    await vi.waitFor(() => {
      expect(pipeline.usageRows()).toHaveLength(1)
    })
    const observer = UsageLedger.open(dir)
    try {
      expect(observer.stats().total).toBe(0)
    } finally {
      observer.close()
    }
  })
})
