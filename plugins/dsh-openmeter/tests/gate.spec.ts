import { describe, expect, it } from 'vitest'
import { BalanceGate } from '../src/gate.ts'
import type { GovernanceResult, OpenMeterClient } from '../src/openmeter.ts'
import { OperatorStore } from '../src/store.ts'
import { resolveConfig } from '../src/config.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function fakeClient(rows: GovernanceResult[] = [], error?: Error): OpenMeterClient {
  return {
    governance: async () => {
      if (error !== undefined) throw error
      return rows
    },
  } as unknown as OpenMeterClient
}

function deniedRow(subject: string, reason: string): GovernanceResult {
  return {
    matched: [subject],
    customerId: 'id',
    customerKey: subject,
    features: { 'dsh_llm': { hasAccess: false, reasonCode: reason, reasonMessage: reason } },
  }
}

function allowedRow(subject: string): GovernanceResult {
  return { matched: [subject], customerId: 'id', customerKey: subject, features: { 'dsh_llm': { hasAccess: true } } }
}

describe('BalanceGate', () => {
  it('never blocks the house subject', async () => {
    const config = resolveConfig({ accessCacheTtlMs: 5_000 })
    const store = new OperatorStore(await mkdtemp(join(tmpdir(), 'omgate-')))
    const gate = new BalanceGate(() => fakeClient([deniedRow('house', 'no_credit_available')]), store, () => config)
    await expect(gate.allow('house')).resolves.toBe(true)
  })

  it('hard-blocks a denied customer (reason no_credit_available)', async () => {
    const config = resolveConfig({ accessCacheTtlMs: 5_000 })
    const store = new OperatorStore(await mkdtemp(join(tmpdir(), 'omgate-')))
    const gate = new BalanceGate(() => fakeClient([deniedRow('cust-1', 'no_credit_available')]), store, () => config)
    await expect(gate.allow('cust-1')).resolves.toBe(false)
    expect(gate.peek('cust-1')?.reasonCode).toBe('no_credit_available')
    expect(gate.stats().blockedCount).toBe(1)
  })

  it('fails open when OpenMeter is unreachable', async () => {
    const config = resolveConfig({ accessCacheTtlMs: 5_000 })
    const store = new OperatorStore(await mkdtemp(join(tmpdir(), 'omgate-')))
    const gate = new BalanceGate(() => fakeClient([], new Error('connection refused')), store, () => config)
    await expect(gate.allow('cust-1')).resolves.toBe(true)
    expect(gate.stats().failOpenCount).toBe(1)
  })

  it('falls back to the stale answer on refresh failure', async () => {
    const config = resolveConfig({ accessCacheTtlMs: 5_000 })
    const store = new OperatorStore(await mkdtemp(join(tmpdir(), 'omgate-')))
    let client = fakeClient([allowedRow('cust-1')])
    const gate = new BalanceGate(() => client, store, () => config)
    await expect(gate.allow('cust-1')).resolves.toBe(true)
    client = fakeClient([], new Error('down'))
    await expect(gate.allow('cust-1')).resolves.toBe(true)
  })

  it('manual operator block overrides governance', async () => {
    const config = resolveConfig({ accessCacheTtlMs: 5_000 })
    const store = new OperatorStore(await mkdtemp(join(tmpdir(), 'omgate-')))
    await store.setManualBlock('cust-1', true)
    const gate = new BalanceGate(() => fakeClient([allowedRow('cust-1')]), store, () => config)
    await expect(gate.allow('cust-1')).resolves.toBe(false)
  })

  it('blockEnabled=false turns the gate into a no-op', async () => {
    const config = resolveConfig({ blockEnabled: false, accessCacheTtlMs: 5_000 })
    const store = new OperatorStore(await mkdtemp(join(tmpdir(), 'omgate-')))
    await store.setManualBlock('cust-1', true)
    const gate = new BalanceGate(() => fakeClient([deniedRow('cust-1', 'x')]), store, () => config)
    await expect(gate.allow('cust-1')).resolves.toBe(true)
  })
})
