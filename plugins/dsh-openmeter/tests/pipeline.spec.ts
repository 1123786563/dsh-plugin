import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MeteringPipeline } from '../src/pipeline.ts'
import { BalanceGate } from '../src/gate.ts'
import { PriceEstimator } from '../src/estimator.ts'
import { OperatorStore } from '../src/store.ts'
import { resolveConfig } from '../src/config.ts'
import { MeteringWal } from '../src/wal.ts'
import type { OpenMeterClient } from '../src/openmeter.ts'
import type { SessionsLike } from '../src/types.ts'

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
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
}) {
  dir = await mkdtemp(join(tmpdir(), 'ompipe-'))
  const config = resolveConfig({ accessCacheTtlMs: 5_000 })
  const store = new OperatorStore(dir)
  if (options.manualBlock !== undefined) await store.setManualBlock(options.manualBlock, true)
  const client = { governance: async () => [] } as unknown as OpenMeterClient
  const gate = new BalanceGate(() => client, store, () => config)
  const estimator = new PriceEstimator(() => client, () => config.quoteCurrency)
  const wal = new MeteringWal(dir)
  await wal.load()
  const sessions = sessionsWith(options.header)
  const pipeline = new MeteringPipeline({
    wal,
    gate,
    estimator,
    getConfig: () => config,
    sessions: () => sessions,
    presetSubject: presetId => store.subjectFor(presetId, config.houseSubject),
    observePreset: presetId => store.observePreset(presetId),
  })
  return { pipeline, wal, store, config }
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
