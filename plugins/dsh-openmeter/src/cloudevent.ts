/**
 * The metering event: one immutable usage record for one LLM model call,
 * wrapped into a CloudEvents 1.0 envelope for OpenMeter ingest.
 *
 * Field semantics follow the DSH TokenUsage contract: inputTokens counts
 * UNcached input only; billed input = inputTokens + cacheReadTokens +
 * cacheWriteTokens (the "Billed Input" glossary term).
 *
 * @module dsh-openmeter/cloudevent
 */

import { randomUUID } from 'node:crypto'

/** Token buckets captured from one model call (disjoint; undefined = not reported). */
export interface CallUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** Everything known about one metered call at capture time. */
export interface MeteredCall {
  /** Customer subject key the call is attributed to (preset binding or house). */
  subject: string
  provider: string
  model: string
  /** conversation | compaction | session-title | undefined. */
  purpose?: string
  sessionId?: string
  /** Parent session id when the call came from a subagent. */
  rootSessionId?: string
  /** Agent preset id of the session (the attribution key). */
  presetId?: string
  usage: CallUsage
  /** Wall-clock duration of the call in milliseconds, when measured. */
  latencyMs?: number
  /** Epoch millis of capture; the envelope time derives from it. */
  capturedAt: number
}

/** The JSON `data` payload stored in the WAL and shipped to OpenMeter. */
export interface MeteringEventData {
  tokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  billedInputTokens: number
  provider: string
  model: string
  purpose?: string
  sessionId?: string
  rootSessionId?: string
  presetId?: string
  latencyMs?: number
}

/** The CloudEvents 1.0 envelope POSTed to /api/v1/events. */
export interface CloudEvent {
  id: string
  source: string
  specversion: '1.0'
  type: string
  subject: string
  time: string
  datacontenttype: 'application/json'
  data: MeteringEventData
}

/** One WAL record: the envelope plus bookkeeping fields (never sent as-is). */
export interface WalRecord {
  /** CloudEvents id: stable across retries, generated once at capture. */
  id: string
  /** Epoch ms when the record was appended to the WAL. */
  appendedAt: number
  /** Epoch ms when OpenMeter acknowledged the event; 0 = pending. */
  confirmedAt: number
  /** Retry backoff state: failures so far since the last success. */
  failures: number
  /** The CloudEvents envelope minus dedupe-irrelevant siblings. */
  event: CloudEvent
}

/**
 * Billed input tokens per the glossary: uncached input + cache reads + cache writes.
 * @param usage - captured token buckets.
 * @returns the billed input token count.
 */
export function billedInputTokens(usage: CallUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/**
 * Total tokens the meter aggregates: billed input + output. Reasoning tokens
 * are a breakdown of output on most providers, so they are NOT added here.
 * @param usage - captured token buckets.
 * @returns the aggregate token count for the meter's valueProperty ($.tokens).
 */
export function meteredTokens(usage: CallUsage): number {
  return billedInputTokens(usage) + usage.outputTokens
}

/**
 * Build the WAL record for one metered call: one durable event, id generated
 * once and reused verbatim on every retry (idempotency key for OpenMeter's
 * 32-day (namespace, id, source) dedupe window).
 * @param call - the captured call.
 * @param eventType - CloudEvents type (config).
 * @param eventSource - CloudEvents source (config).
 * @returns the WAL record, not yet persisted.
 */
export function buildWalRecord(call: MeteredCall, eventType: string, eventSource: string): WalRecord {
  const billed = billedInputTokens(call.usage)
  const data: MeteringEventData = {
    tokens: meteredTokens(call.usage),
    inputTokens: call.usage.inputTokens,
    outputTokens: call.usage.outputTokens,
    ...(call.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: call.usage.cacheReadTokens }),
    ...(call.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: call.usage.cacheWriteTokens }),
    ...(call.usage.reasoningTokens === undefined ? {} : { reasoningTokens: call.usage.reasoningTokens }),
    billedInputTokens: billed,
    provider: call.provider,
    model: call.model,
    ...(call.purpose === undefined || call.purpose.length === 0 ? {} : { purpose: call.purpose }),
    ...(call.sessionId === undefined || call.sessionId.length === 0 ? {} : { sessionId: call.sessionId }),
    ...(call.rootSessionId === undefined || call.rootSessionId.length === 0 ? {} : { rootSessionId: call.rootSessionId }),
    ...(call.presetId === undefined || call.presetId.length === 0 ? {} : { presetId: call.presetId }),
    ...(call.latencyMs === undefined ? {} : { latencyMs: call.latencyMs }),
  }
  const event: CloudEvent = {
    id: randomUUID(),
    source: eventSource,
    specversion: '1.0',
    type: eventType,
    subject: call.subject,
    time: new Date(call.capturedAt).toISOString(),
    datacontenttype: 'application/json',
    data,
  }
  return { id: event.id, appendedAt: call.capturedAt, confirmedAt: 0, failures: 0, event }
}

/**
 * Split one WAL record's usage into priced line items against per-token rates.
 * Exposed for the estimator; rates come from the llm-cost catalog.
 * @param data - the event payload.
 * @returns line items keyed by price field.
 */
export function pricedBuckets(data: MeteringEventData): Array<{ kind: 'input' | 'output' | 'cache_read' | 'cache_write' | 'reasoning', tokens: number }> {
  const items: Array<{ kind: 'input' | 'output' | 'cache_read' | 'cache_write' | 'reasoning', tokens: number }> = [
    { kind: 'input', tokens: data.inputTokens },
    { kind: 'output', tokens: data.outputTokens },
  ]
  if (data.cacheReadTokens !== undefined && data.cacheReadTokens > 0) items.push({ kind: 'cache_read', tokens: data.cacheReadTokens })
  if (data.cacheWriteTokens !== undefined && data.cacheWriteTokens > 0) items.push({ kind: 'cache_write', tokens: data.cacheWriteTokens })
  if (data.reasoningTokens !== undefined && data.reasoningTokens > 0) items.push({ kind: 'reasoning', tokens: data.reasoningTokens })
  return items
}
