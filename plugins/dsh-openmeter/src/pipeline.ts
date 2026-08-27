/**
 * The metering pipeline. Two listeners, two responsibilities (single-source
 * metering, no double counting):
 *
 * - llm/stream waterfall: GATE ONLY (ADR-0003). The stream wraps retries and
 *   replays too, so metering here would double-count; we only check balance
 *   before the first chunk and hard-block when exhausted.
 * - session/event assistant/message: THE metering source. One committed
 *   assistant message = one metering event, replay-safe (the in-tree token
 *   meter uses the same source), carrying usage + provider/model from
 *   message.source. Dedupe by (sessionId, seq) because the emit feed is
 *   at-least-once.
 *
 * Each metered event goes to the WAL first (the authoritative at-least-once
 * seam), then to the durable usage ledger (the local estimate/display
 * mirror, best effort — its failure never breaks metering), then to the
 * in-memory estimate ring.
 *
 * @module dsh-openmeter/pipeline
 */

import { billedInputTokens, buildWalRecord, meteredTokens } from './cloudevent.ts'
import type { CallUsage, MeteredCall, WalRecord } from './cloudevent.ts'
import type { Config } from './config.ts'
import type { BalanceGate } from './gate.ts'
import type { Estimate, PriceEstimator } from './estimator.ts'
import type { UsageLedger } from './ledger.ts'
import type { SessionsLike, StreamOptionsLike, StreamChunkLike, SessionEventLike } from './types.ts'
import type { MeteringWal } from './wal.ts'

/** Recent call row served to the usage panel. */
export interface UsageRow {
  sessionId?: string
  subject: string
  provider: string
  model: string
  usage: CallUsage
  estimatedAmount: number
  currency: string
  unpriced: boolean
  at: number
}

/** Aggregate row for the panel. */
export interface SubjectAggregate {
  subject: string
  tokens: number
  calls: number
  amount: number
  currency: string
}

/** Error thrown to abort a gated call (hard block). */
export class BlockError extends Error {
  readonly subject: string
  readonly reason: string
  constructor(subject: string, reason: string) {
    super(`billing: calls for ${subject} are blocked: ${reason}`)
    this.subject = subject
    this.reason = reason
  }
}

/** Live estimate rows kept in memory (ring buffer). */
const RECENT_LIMIT = 500

/**
 * The pipeline: gate + durable metering + estimate ring.
 */
export class MeteringPipeline {
  private readonly wal: MeteringWal
  private readonly gate: BalanceGate
  private readonly estimator: PriceEstimator
  private readonly usageLedger: Pick<UsageLedger, 'append'> | undefined
  private readonly getConfig: () => Config
  private readonly sessions: () => SessionsLike | undefined
  private readonly presetSubject: (presetId: string | undefined) => string
  private readonly observePreset: (presetId: string | undefined) => void
  private recent: UsageRow[] = []
  private readonly seenEventKeys = new Set<string>()
  private readonly stepStarts = new Map<string, number>()
  private ledgerDrops = 0
  private lastLedgerError: string | undefined

  /**
   * @param deps - the wired collaborators (all live accessors).
   */
  constructor(deps: {
    wal: MeteringWal
    gate: BalanceGate
    estimator: PriceEstimator
    /** Durable usage ledger mirror; omitted by consumers that only forward. */
    usageLedger?: Pick<UsageLedger, 'append'>
    getConfig: () => Config
    sessions: () => SessionsLike | undefined
    presetSubject: (presetId: string | undefined) => string
    observePreset: (presetId: string | undefined) => void
  }) {
    this.wal = deps.wal
    this.gate = deps.gate
    this.estimator = deps.estimator
    this.usageLedger = deps.usageLedger
    this.getConfig = deps.getConfig
    this.sessions = deps.sessions
    this.presetSubject = deps.presetSubject
    this.observePreset = deps.observePreset
  }

  /**
   * The llm/stream waterfall listener: balance gate only, never metering.
   * @param options - the model call request (frozen; read-only).
   * @param next - the downstream stream factory.
   * @returns the wrapped stream.
   */
  onStream(options: StreamOptionsLike, next: () => AsyncIterable<StreamChunkLike>): AsyncIterable<StreamChunkLike> {
    const session = options.sessionId === undefined ? undefined : this.sessions()?.get(options.sessionId)
    const presetId = session?.header?.agentPreset
    this.observePreset(presetId)
    const subject = this.presetSubject(presetId)
    const gate = this.gate
    return (async function* (): AsyncIterable<StreamChunkLike> {
      const allowed = await gate.allow(subject)
      if (!allowed) {
        const peek = gate.peek(subject)
        throw new BlockError(subject, peek?.reasonCode ?? 'no_credit_available')
      }
      yield* next()
    })()
  }

  /**
   * The session/event listener: route assistant/message (meter), step/start
   * (latency pairing). Everything else is ignored cheaply.
   * @param sessionId - the session id.
   * @param event - the session event.
   */
  onSessionEvent(sessionId: string, event: SessionEventLike): void {
    if (event.type === 'step/start' && event.data?.turn !== undefined && event.data?.step !== undefined) {
      this.stepStarts.set(`${sessionId}:${event.data.turn}:${event.data.step}`, event.time)
      if (this.stepStarts.size > 1_000) {
        for (const key of [...this.stepStarts.keys()].slice(0, 300)) this.stepStarts.delete(key)
      }
      return
    }
    if (event.type !== 'assistant/message') return
    const data = event.data ?? {}
    const usage = data.usage as CallUsage | undefined
    if (usage === undefined || typeof usage.inputTokens !== 'number' || typeof usage.outputTokens !== 'number') return
    const message = (data.message ?? {}) as { source?: { provider?: string, model?: string } }
    const provider = typeof message.source?.provider === 'string' ? message.source.provider : ''
    const model = typeof message.source?.model === 'string' ? message.source.model : ''
    if (provider.length === 0 || model.length === 0) return
    const session = this.sessions()?.get(sessionId)
    const header = session?.header
    const presetId = header?.agentPreset
    this.observePreset(presetId)
    const subject = this.presetSubject(presetId)
    const stepKey = `${sessionId}:${data.turn}:${data.step}`
    const startedAt = this.stepStarts.get(stepKey)
    this.stepStarts.delete(stepKey)
    void this.meter({
      sessionId,
      seq: event.seq,
      subject,
      provider,
      model,
      usage,
      presetId,
      isSubagent: header?.origin === 'subagent',
      parentSession: header?.parentSession,
      time: event.time,
      latencyMs: startedAt === undefined ? undefined : Math.max(0, event.time - startedAt),
    })
  }

  /**
   * Meter one committed assistant message (dedupe + WAL + ledger mirror +
   * estimate ring).
   * @param input - everything known about the committed call.
   */
  private async meter(input: {
    sessionId: string
    seq: number
    subject: string
    provider: string
    model: string
    usage: CallUsage
    presetId: string | undefined
    isSubagent: boolean
    parentSession: string | undefined
    time: number
    latencyMs: number | undefined
  }): Promise<void> {
    const dedupeKey = `${input.sessionId}:${input.seq}`
    if (this.seenEventKeys.has(dedupeKey)) return
    this.seenEventKeys.add(dedupeKey)
    if (this.seenEventKeys.size > 4_000) {
      for (const key of [...this.seenEventKeys.keys()].slice(0, 1_000)) this.seenEventKeys.delete(key)
    }
    const config = this.getConfig()
    const call: MeteredCall = {
      subject: input.subject,
      provider: input.provider,
      model: input.model,
      sessionId: input.sessionId,
      ...(input.isSubagent === true && input.parentSession !== undefined ? { rootSessionId: input.parentSession } : {}),
      ...(input.presetId === undefined || input.presetId.length === 0 ? {} : { presetId: input.presetId }),
      usage: input.usage,
      ...(input.latencyMs === undefined ? {} : { latencyMs: input.latencyMs }),
      capturedAt: input.time,
    }
    const record = buildWalRecord(call, config.eventType, config.eventSource)
    const estimate = this.estimator.estimate(record.event.data)
    await this.wal.append(record)
    this.appendLedger(config, call, record, estimate)
    this.pushRecent(call, estimate)
  }

  /**
   * Mirror one metered event into the durable usage ledger (the local
   * estimate/display source). A duplicate append is an acknowledged event.
   * Best effort: the WAL already holds the authoritative record, so a ledger
   * failure is counted ({@link MeteringPipeline.usageLedgerHealth}) and
   * never breaks metering.
   * @param config - config snapshot at meter time (source of the row's source).
   * @param call - the metered call (subject attribution and capture time).
   * @param record - the WAL record built for it (event id join key).
   * @param estimate - the estimate shared with the recent ring.
   */
  private appendLedger(config: Config, call: MeteredCall, record: WalRecord, estimate: Estimate): void {
    if (this.usageLedger === undefined) return
    try {
      this.usageLedger.append({
        source: config.eventSource,
        eventId: record.event.id,
        subject: call.subject,
        capturedAt: call.capturedAt,
        provider: call.provider,
        model: call.model,
        tokens: meteredTokens(call.usage),
        estimatedAmount: estimate.amount,
        currency: estimate.currency,
        unpriced: estimate.unpriced,
      })
    } catch (error) {
      // Swallow: LedgerRowError (a row the pipeline itself malformed) and
      // node:sqlite runtime failures — the ledger is the estimate/display
      // mirror and the WAL already carries the authoritative event, so
      // metering must not fail because the mirror could not be written
      // (OperatorStore.save takes the same stance). The drop is counted so
      // status surfacing can report it.
      this.ledgerDrops += 1
      this.lastLedgerError = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * Ledger-mirror health for status surfacing.
   * @returns drops counted so far, plus the last drop's error message when
   *   one occurred.
   */
  usageLedgerHealth(): { drops: number, lastError?: string } {
    return {
      drops: this.ledgerDrops,
      ...(this.lastLedgerError === undefined ? {} : { lastError: this.lastLedgerError }),
    }
  }

  /**
   * Push one estimate row into the ring.
   * @param call - the metered call.
   * @param estimate - the estimate computed once per metered call.
   */
  private pushRecent(call: MeteredCall, estimate: Estimate): void {
    this.recent.unshift({
      ...(call.sessionId === undefined ? {} : { sessionId: call.sessionId }),
      subject: call.subject,
      provider: call.provider,
      model: call.model,
      usage: call.usage,
      estimatedAmount: estimate.amount,
      currency: estimate.currency,
      unpriced: estimate.unpriced,
      at: call.capturedAt,
    })
    if (this.recent.length > RECENT_LIMIT) this.recent.length = RECENT_LIMIT
  }

  /**
   * Recent usage rows for the panel.
   * @param limit - max rows.
   */
  usageRows(limit = 100): UsageRow[] {
    return this.recent.slice(0, limit)
  }

  /**
   * Month-to-date aggregates per subject.
   */
  aggregates(): SubjectAggregate[] {
    const bySubject = new Map<string, SubjectAggregate>()
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    for (const row of this.recent) {
      if (row.at < monthStart) continue
      const current = bySubject.get(row.subject) ?? { subject: row.subject, tokens: 0, calls: 0, amount: 0, currency: row.currency }
      current.tokens += billedInputTokens(row.usage) + row.usage.outputTokens
      current.calls += 1
      current.amount += row.estimatedAmount
      bySubject.set(row.subject, current)
    }
    return [...bySubject.values()]
  }
}
