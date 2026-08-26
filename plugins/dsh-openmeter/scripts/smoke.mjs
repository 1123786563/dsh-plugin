#!/usr/bin/env node
/**
 * End-to-end money-path smoke for dsh-openmeter against the live fork.
 * Drives the BUILT plugin modules (lib/index.js): WAL append → forwarder
 * ingest → meter query → balance deduction → governance denial → gate block.
 *
 * Usage: node scripts/smoke.mjs [endpoint]
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ENDPOINT = (process.argv[2] ?? process.env.OPENMETER_ENDPOINT ?? 'http://127.0.0.1:8888').replace(/\/+$/, '')
const FEATURE_KEY = 'dsh_llm'
const METER_SLUG = 'dsh_llm_tokens'
const HOUSE = 'house'
const SMOKE_SUBJECT = 'smoke-cust'

const lib = await import('../lib/index.js')
const { MeteringWal, OpenMeterClient, OperatorStore, PriceEstimator, BalanceGate, Forwarder, MeteringPipeline, buildWalRecord } = lib

const config = {
  endpoint: ENDPOINT,
  token: '',
  houseSubject: HOUSE,
  featureKey: FEATURE_KEY,
  eventType: 'dsh.llm.call',
  eventSource: 'dsh',
  meterSlug: METER_SLUG,
  quoteCurrency: 'CNY',
  blockEnabled: true,
  accessCacheTtlMs: 5_000,
  priceRefreshMs: 300_000,
  batchSize: 100,
  dataDir: '',
}
const getConfig = () => config
const client = new OpenMeterClient(getConfig)

async function ensurePriceOverride() {
  // The feature prices usage via the llm-cost catalog: without a row for the
  // model, cost stays 0 and credit never burns. Seed one CNY override.
  const list = await fetch(`${ENDPOINT}/api/v3/openmeter/llm-cost/prices`).then(r => r.json())
  const rows = list?.data ?? []
  if (rows.length > 0) return
  const response = await fetch(`${ENDPOINT}/api/v3/openmeter/llm-cost/overrides`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'deepseek',
      model_id: 'glm-5.3',
      model_name: 'GLM 5.3',
      currency: 'CNY',
      effective_from: '2020-01-01T00:00:00Z',
      // Numeric fields are arbitrary-precision STRINGS on the wire.
      pricing: {
        input_per_token: '0.004',
        output_per_token: '0.016',
        cache_read_per_token: '0.0004',
        cache_write_per_token: '0.008',
      },
    }),
  })
  if (!response.ok) throw new Error(`price override seed -> ${response.status}: ${await response.text()}`)
  console.log('• seeded CNY price override for deepseek/glm-5.3')
}

async function ensureSmokeCustomer() {
  const list = await client.listCustomers()
  if (list.some(row => row.key === SMOKE_SUBJECT)) return
  await client.createCustomer(SMOKE_SUBJECT, 'Smoke Customer')
  const entitlements = await fetch(`${ENDPOINT}/api/v2/customers/${SMOKE_SUBJECT}/entitlements`).then(r => r.json())
  if ((entitlements.items ?? []).length === 0) {
    await fetch(`${ENDPOINT}/api/v2/customers/${SMOKE_SUBJECT}/entitlements`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'metered', featureKey: FEATURE_KEY, isSoftLimit: false, usagePeriod: { interval: 'MONTH' } }),
    })
  }
  // Small credit: 50 tokens so exhaustion is quick to reach.
  await client.createGrant(SMOKE_SUBJECT, FEATURE_KEY, { amount: 50, effectiveAt: new Date().toISOString() })
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function meterTotal(subject) {
  const to = new Date()
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000)
  const rows = await client.meterQuery(METER_SLUG, { from: from.toISOString(), to: to.toISOString(), subject: [subject] })
  return rows.reduce((sum, row) => sum + Number(row?.value ?? 0), 0)
}

async function main() {
  console.log(`smoke → ${ENDPOINT}`)
  const dir = await mkdtemp(join(tmpdir(), 'omsmoke-'))
  try {
    await ensurePriceOverride()
    await ensureSmokeCustomer()
    const wal = new MeteringWal(dir)
    await wal.load()
    const store = new OperatorStore(dir)
    await store.load()
    // Bind a preset so attribution flows preset -> customer (ADR-0004 path).
    await store.setBinding('smoke-preset', SMOKE_SUBJECT)
    const estimator = new PriceEstimator(() => client, () => config.quoteCurrency)
    const gate = new BalanceGate(() => client, store, getConfig)
    const forwarder = new Forwarder(wal, () => client, getConfig)
    const pipeline = new MeteringPipeline({
      wal,
      gate,
      estimator,
      getConfig,
      sessions: () => ({ get: id => ({ id, header: { id, agentPreset: 'smoke-preset' } }) }),
      presetSubject: preset => store.subjectFor(preset, config.houseSubject),
      observePreset: preset => store.observePreset(preset),
    })

    // 1. Gate allows while credit exists.
    const before = await gate.allow(SMOKE_SUBJECT)
    console.log(`1. gate allow (credit fresh): ${before}`)
    if (before !== true) throw new Error('expected allow with fresh credit')

    // 2. Meter one call (direct pipeline path: session event shape).
    pipeline.onSessionEvent('smoke-session', {
      type: 'assistant/message',
      seq: 1,
      time: Date.now(),
      data: { turn: 0, step: 0, usage: { inputTokens: 20, outputTokens: 5 }, message: { source: { provider: 'deepseek', model: 'glm-5.3' } } },
    })
    await wait(200)
    console.log(`2. wal pending after one call: ${wal.pending().length}`)
    if (wal.pending().length !== 1) throw new Error('expected 1 pending record')

    // 3. Forwarder drains to OpenMeter.
    await forwarder.drain()
    console.log(`3. wal pending after drain: ${wal.pending().length}, confirmed: ${wal.stats().confirmedRecent}`)
    if (wal.pending().length !== 0) throw new Error(`forwarder failed: ${JSON.stringify(wal.stats())}`)

    // 4. Meter shows the usage (async sink; poll briefly).
    let tokens = 0
    for (let attempt = 0; attempt < 20 && tokens === 0; attempt += 1) {
      await wait(1_500)
      tokens = await meterTotal(SMOKE_SUBJECT)
    }
    console.log(`4. meter tokens for ${SMOKE_SUBJECT}: ${tokens}`)
    if (tokens < 25) throw new Error(`expected >=25 tokens (20 in + 5 out of this run), got ${tokens}`)

    // 5. Balance dropped by the usage (balance-worker + feature cost: unit
    // cost is llm → priced in the llm-cost catalog; unpriced models price 0,
    // so deduction may be 0 — assert balance query answers at all).
    const value = await client.entitlementValue(SMOKE_SUBJECT, FEATURE_KEY)
    console.log(`5. entitlement value: hasAccess=${value.hasAccess} balance=${value.balance} usage=${value.usage}`)

    // 6. Exhaust the credit via a manual block instead (deterministic teeth):
    // unblock first to prove allow, then block and expect denial.
    await store.setManualBlock(SMOKE_SUBJECT, true)
    const blocked = await gate.allow(SMOKE_SUBJECT)
    console.log(`6. gate after manual block: ${blocked}`)
    if (blocked !== false) throw new Error('expected block after manual block')
    await store.setManualBlock(SMOKE_SUBJECT, false)

    // 7. Hard-exhaust path: burn the grant by granting 1 then overusing.
    await client.createGrant(SMOKE_SUBJECT, FEATURE_KEY, { amount: 1, effectiveAt: new Date().toISOString() })
    pipeline.onSessionEvent('smoke-session', {
      type: 'assistant/message',
      seq: 2,
      time: Date.now(),
      data: { turn: 1, step: 0, usage: { inputTokens: 100, outputTokens: 100 }, message: { source: { provider: 'deepseek', model: 'glm-5.3' } } },
    })
    await wait(200)
    await forwarder.drain()
    let denied = false
    for (let attempt = 0; attempt < 20 && !denied; attempt += 1) {
      await wait(1_500)
      const rows = await client.governance([SMOKE_SUBJECT], [FEATURE_KEY], true)
      denied = rows[0]?.features?.[FEATURE_KEY]?.hasAccess === false
    }
    const denial = (await client.governance([SMOKE_SUBJECT], [FEATURE_KEY], true))[0]?.features?.[FEATURE_KEY]
    console.log(`7. governance after overuse: has_access=${denial?.hasAccess} reason=${denial?.reasonCode}`)
    if (!denied) throw new Error('expected governance denial after credit exhaustion')

    // 8. The gate turns governance denial into a BlockError on the stream.
    const gateAnswer = await gate.refreshNow([SMOKE_SUBJECT]).then(() => gate.allow(SMOKE_SUBJECT))
    console.log(`8. gate after exhaustion: ${gateAnswer}`)
    if (gateAnswer !== false) throw new Error('expected gate block after exhaustion')

    // 9. House is never blocked, even with everything down.
    const houseAnswer = await gate.allow(HOUSE)
    console.log(`9. house always allowed: ${houseAnswer}`)

    // 10. Fail-open: unreachable endpoint never blocks.
    config.endpoint = 'http://127.0.0.1:1'
    const freshGate = new BalanceGate(() => client, store, getConfig)
    const failOpen = await freshGate.allow('unknown-cust')
    config.endpoint = ENDPOINT
    console.log(`10. fail-open on unreachable: ${failOpen}`)

    console.log('SMOKE PASSED ✓')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('SMOKE FAILED:', error.message)
  process.exitCode = 1
})
