/**
 * dsh-openmeter: OpenMeter billing for DeepSeek Harness.
 *
 * Host half: the metering pipeline (llm/stream gate + session/event durable
 * metering), the WAL-backed at-least-once forwarder, the balance gate with
 * governance cache, the llm-cost price cache, the cashier/panel HTTP routes,
 * and the openmeter settings namespace. Unreachable OpenMeter never blocks
 * model calls (fail-open, ADR-0003); usage queues on the WAL (ADR-0002).
 *
 * @module dsh-openmeter
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { join } from 'node:path'
import { Config, resolveConfig } from './config.ts'
import type { Config as ConfigShape } from './config.ts'
import { resolveDshHome } from './dsh-home.ts'
import { PriceEstimator } from './estimator.ts'
import { Forwarder } from './forwarder.ts'
import { BalanceGate } from './gate.ts'
import { mountRoutes } from './routes.ts'
import type { WebServerLike } from './routes.ts'
import { MeteringPipeline } from './pipeline.ts'
import { OpenMeterClient } from './openmeter.ts'
import { OperatorStore } from './store.ts'
import type { SessionsLike, SessionEventLike, StreamOptionsLike, StreamChunkLike } from './types.ts'
import { MeteringWal } from './wal.ts'

/** Cordis plugin name; keep this stable after publishing. */
export const name = 'openmeter'

/** Services that must exist before the plugin is applied. */
export const inject: string[] = []

/** The settings namespace this plugin owns (the card's slot key matches it). */
export const OPENMETER_NS = settingsNamespace('openmeter')

export { Config }
export type { ConfigShape }
export {
  BalanceGate,
  Forwarder,
  MeteringPipeline,
  MeteringWal,
  OpenMeterClient,
  OperatorStore,
  PriceEstimator,
  mountRoutes,
  resolveConfig,
  resolveDshHome,
}
export { BlockError } from './pipeline.ts'
export { billedInputTokens, buildWalRecord, meteredTokens } from './cloudevent.ts'

/**
 * Activate the plugin: resolve configuration, wire the pipeline stack, start
 * the background loops (all plain timers cleared by the effect disposer), and
 * mount the routes when a webServer service exists.
 * @param ctx - host context.
 * @param config - loader-supplied entry config.
 */
export function apply(ctx: Context, config: Partial<ConfigShape> | undefined): void {
  const entry = resolveConfig(config)
  let authoritative: () => ConfigShape = () => entry
  let current = entry
  const getConfig = (): Config => current

  const dir = current.dataDir.length > 0 ? current.dataDir : join(resolveDshHome(process.env), 'openmeter')

  const wal = new MeteringWal(dir)
  const store = new OperatorStore(dir)
  const client = new OpenMeterClient(getConfig)
  const estimator = new PriceEstimator(() => client, () => current.quoteCurrency)
  const gate = new BalanceGate(() => client, store, getConfig)
  const forwarder = new Forwarder(wal, () => client, getConfig)
  // Reading `ctx.sessions` directly throws "cannot get property ... without
  // inject" in this fiber; the scoped inject below is the sanctioned access
  // and keeps the service optional (metering falls back to the house subject).
  let sessions: SessionsLike | undefined
  ctx.effect(() => ctx.inject(['sessions'], scoped => {
    sessions = (scoped as unknown as { sessions: SessionsLike }).sessions
    return () => { sessions = undefined }
  }))
  const pipeline = new MeteringPipeline({
    wal,
    gate,
    estimator,
    getConfig,
    sessions: () => sessions,
    presetSubject: presetId => store.subjectFor(presetId, current.houseSubject),
    observePreset: presetId => store.observePreset(presetId),
  })

  installSettingsSection(ctx, OPENMETER_NS, Config, entry, {
    setSource: read => {
      authoritative = read as () => ConfigShape
    },
    onChange: () => {
      current = resolveConfig(authoritative())
    },
  })

  ctx.effect(() => {
    const timers: Array<ReturnType<typeof setInterval>> = []
    void wal.load()
    void store.load()
    forwarder.start()
    timers.push(setInterval(() => {
      void forwarder.drain()
    }, 5_000))
    timers.push(setInterval(() => {
      void gate.refresh()
    }, Math.max(5_000, current.accessCacheTtlMs / 2)))
    timers.push(setInterval(() => {
      void estimator.refresh()
    }, Math.max(30_000, current.priceRefreshMs)))
    void estimator.refresh(true)

    // Loose event binding: the harness owns the exact event types; the
    // pipeline consumes duck-typed shapes (see types.ts).
    const on = (ctx as unknown as {
      on(name: string, listener: (...args: never[]) => unknown, options?: Record<string, unknown>): () => void
    }).on.bind(ctx)

    // The gate: wrap every streaming model call (block before first byte).
    const disposeStream = on('llm/stream', ((options: unknown, next: () => AsyncIterable<unknown>) =>
      pipeline.onStream(options as StreamOptionsLike, next as () => AsyncIterable<StreamChunkLike>)) as (...args: never[]) => unknown, { global: true })

    // The meter: one WAL record per committed assistant message.
    const disposeEvents = on('session/event', ((session: unknown, event: unknown) => {
      const sessionId = typeof (session as { id?: unknown })?.id === 'string' ? (session as { id: string }).id : ''
      if (sessionId.length === 0) return
      pipeline.onSessionEvent(sessionId, event as SessionEventLike)
    }) as (...args: never[]) => unknown)

    return () => {
      for (const timer of timers) clearInterval(timer)
      forwarder.stop()
      disposeStream()
      disposeEvents()
    }
  }, 'openmeter: pipeline')

  ctx.inject(['webServer'], scoped => {
    scoped.effect(() => mountRoutes(scoped.webServer as unknown as WebServerLike, {
      getConfig,
      client: () => client,
      gate,
      forwarder,
      pipeline,
      store,
      estimator,
      wal,
    }), 'openmeter: routes')
  })
}
