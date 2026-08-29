/**
 * Cross-tenant billing acceptance integration fixture (issue #11, Task 1).
 *
 * Drives the BUILT plugin bundle — `../lib/index.js`, the same import form
 * as scripts/smoke.mjs — through the metering pipeline chain (WAL →
 * forwarder → meter → balance gate) and the local HTTP surfaces mounted via
 * `mountRoutes`: the operator cashier under /operator/*, the tenant
 * self-service surfaces under /me/*, and the retired global cashier paths.
 *
 * Identity fidelity: the auth seam resolves a bearer token to a verified
 * identity (the Casdoor position) and the operator-maintained
 * tenantId → subject map is the only attribution source — client input
 * never names a tenant or subject.
 *
 * Determinism: every fixture owns a mkdtemp directory removed in afterAll;
 * subject/preset keys carry a unique per-run prefix; seeding is idempotent
 * (re-seeding the same event never doubles). Groups 1–5 run fully offline
 * against an unreachable endpoint (127.0.0.1:1). The OpenMeter real-chain
 * subset (group 6) runs only when 127.0.0.1:8888 answers and skips
 * (`describe.skipIf`) otherwise — an honest degradation, never a faked pass.
 *
 * Runtime values come exclusively from the built bundle; `../src` imports
 * below are type-only (erased at runtime) and document the structural
 * contracts the bundle is asserted against.
 *
 * @module dsh-openmeter/tests/tenant-billing.integration
 */

import { afterAll, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BudgetStore } from '../src/budget.ts'
import type { Config } from '../src/config.ts'
import type { LedgerRow } from '../src/ledger.ts'
import type { RouteAuth, RouteIdentity, WebServerLike } from '../src/routes.ts'

/** The built bundle's runtime export surface this fixture consumes. */
interface LibBundle {
  MeteringWal: typeof import('../src/wal.ts').MeteringWal
  OpenMeterClient: typeof import('../src/openmeter.ts').OpenMeterClient
  OperatorStore: typeof import('../src/store.ts').OperatorStore
  PriceEstimator: typeof import('../src/estimator.ts').PriceEstimator
  BalanceGate: typeof import('../src/gate.ts').BalanceGate
  Forwarder: typeof import('../src/forwarder.ts').Forwarder
  MeteringPipeline: typeof import('../src/pipeline.ts').MeteringPipeline
  UsageLedger: typeof import('../src/ledger.ts').UsageLedger
  mountRoutes: typeof import('../src/routes.ts').mountRoutes
  resolveConfig: typeof import('../src/config.ts').resolveConfig
}

const lib = await import('../lib/index.js') as unknown as LibBundle

/** Unreachable-by-construction endpoint for the offline degraded groups. */
const DEAD_ENDPOINT = 'http://127.0.0.1:1'

/** The self-hosted OpenMeter fork origin for the real-chain subset. */
const LIVE_ENDPOINT = (process.env.OPENMETER_ENDPOINT ?? 'http://127.0.0.1:8888').replace(/\/+$/, '')

/** Feature key and meter slug the gate and meter chain use (config defaults). */
const FEATURE_KEY = 'dsh_llm'

const METER_SLUG = 'dsh_llm_tokens'

/**
 * Probe the fork's llm-cost prices path once at collection time; the
 * real-chain group skips honestly when this does not answer.
 */
async function endpointReachable(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/api/v3/openmeter/llm-cost/prices`, { signal: AbortSignal.timeout(1_500) })
    return response.ok
  } catch {
    return false
  }
}

const LIVE_REACHABLE = await endpointReachable(LIVE_ENDPOINT)

/**
 * Collection-time meter-sink probe for the full-chain case: an endpoint can
 * answer prices/customers/ingest 2xx yet serve no meters, in which case the
 * meter leg of the real chain can never materialize rows there.
 */
async function meterSinkLive(endpoint: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/api/v1/meters`, { signal: AbortSignal.timeout(1_500) })
    if (!response.ok) return false
    const list = await response.json() as { data?: unknown[] }
    return (list.data?.length ?? 0) > 0
  } catch {
    return false
  }
}

const METER_SINK_LIVE = LIVE_REACHABLE && await meterSinkLive(LIVE_ENDPOINT)

/** Unique-per-run prefix so subjects never collide across runs or fixtures. */
const RUN_NONCE = randomUUID().slice(0, 8)

/** Fixture directories awaiting afterAll cleanup. */
const createdDirs: string[] = []

/**
 * Wait until `condition` holds, failing the test on timeout instead of
 * hanging the runner (the pipeline meters fire-and-forget).
 * @param condition - exit predicate, polled every 15 ms.
 * @param deadlineMs - poll budget in milliseconds.
 */
async function waitFor(condition: () => boolean, deadlineMs: number): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > deadlineMs) throw new Error(`fixture wait timed out after ${deadlineMs}ms`)
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}

/**
 * In-memory seam for `RouteDeps.budget` (`Pick<BudgetStore, 'get'|'set'>`).
 * The built bundle does not export BudgetStore — it is src/test-plane only —
 * so the fixture provides the exact structural contract the routes consume;
 * durable budget persistence is budget.spec.ts's unit territory.
 */
class MemoryBudgetStore {
  private readonly rows = new Map<string, { amountCny: number }>()

  get(tenantId: string): { amountCny: number } | null {
    return this.rows.get(tenantId) ?? null
  }

  set(tenantId: string, amountCny: number): void {
    this.rows.set(tenantId, { amountCny })
  }
}

/** One verified identity plus the bearer token the auth seam accepts for it. */
export type TokenedIdentity = RouteIdentity & { readonly token: string }

/** One tenant identity bundle: member and manager identities over one mapped subject. */
export interface TenantFixture {
  readonly tenantId: string
  readonly subject: string
  readonly presetId: string
  readonly member: TokenedIdentity
  readonly manager: TokenedIdentity
}

/** The wired acceptance stack: routes, pipeline chain, and per-tenant actors. */
export interface AcceptanceFixture {
  readonly dir: string
  readonly tenantA: TenantFixture
  readonly tenantB: TenantFixture
  readonly operator: { identity: RouteIdentity, token: string }
  readonly wal: InstanceType<LibBundle['MeteringWal']>
  readonly ledger: InstanceType<LibBundle['UsageLedger']>
  readonly store: InstanceType<LibBundle['OperatorStore']>
  readonly client: InstanceType<LibBundle['OpenMeterClient']>
  readonly estimator: InstanceType<LibBundle['PriceEstimator']>
  readonly gate: InstanceType<LibBundle['BalanceGate']>
  readonly forwarder: InstanceType<LibBundle['Forwarder']>
  readonly pipeline: InstanceType<LibBundle['MeteringPipeline']>
  /** Dispatch one request through the mounted routes as one fixture actor. */
  request(options: {
    method: string
    path: string
    body?: unknown
    token?: string
    remoteAddress?: string
  }): Promise<{ status: number, body: Record<string, unknown> }>
  /** Meter one assistant message for a tenant through the real pipeline. */
  seedUsage(tenant: TenantFixture, call: { seq: number, inputTokens: number, outputTokens: number, model?: string }): Promise<void>
  /** Append one deterministic CNY-priced ledger row for a subject. */
  appendPricedRow(subject: string, amountCny: number): void
  /** Close seams; the directory itself is removed in afterAll. */
  dispose(): void
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void

/**
 * Build the acceptance fixture: fresh mkdtemp dir, WAL/store/ledger/client/
 * gate/estimator/forwarder/pipeline from the BUILT bundle, two tenant actors
 * (A/B) plus one platform operator, preset bindings routed to each mapped
 * subject, and every /api/openmeter route mounted on an in-memory webServer.
 * @param options - `endpoint` overrides the config endpoint (live subset),
 *   `subjectPrefix` overrides tenant A's subject prefix.
 */
export async function makeAcceptanceFixture(options: { endpoint?: string, subjectPrefix?: string } = {}): Promise<AcceptanceFixture> {
  const nonce = randomUUID().slice(0, 8)
  const dir = await mkdtemp(join(tmpdir(), `omaccept-${nonce}-`))
  createdDirs.push(dir)

  const prefix = (options.subjectPrefix ?? 't1').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)
  const makeTenant = (label: 'a' | 'b'): TenantFixture => {
    const tenantId = `${prefix}-tenant-${label}-${nonce}`
    const token = `tok-${label}-member-${nonce}`
    const managerToken = `tok-${label}-manager-${nonce}`
    return {
      tenantId,
      subject: `${prefix}-subject-${label}-${nonce}`,
      presetId: `${prefix}-preset-${label}-${nonce}`,
      member: { tenantId, userId: `${label}-member`, displayName: `Tenant ${label} member`, roles: [], token },
      manager: { tenantId, userId: `${label}-manager`, displayName: `Tenant ${label} manager`, roles: ['owner'], token: managerToken },
    }
  }
  const tenantA = makeTenant('a')
  const tenantB = makeTenant('b')
  const operator = {
    identity: { tenantId: `${prefix}-tenant-ops-${nonce}`, userId: 'operator', displayName: 'Platform Operator', roles: ['dsh-admin'] } as RouteIdentity,
    token: `tok-operator-${nonce}`,
  }

  // The auth seam: bearer token -> verified identity, plus the
  // operator-maintained tenantId -> subject map (the only attribution
  // source). The operator tenant is mapped too — policy resolution
  // fails closed for unmapped tenants, operators included.
  const tenantSubjects: Record<string, string> = {
    [tenantA.tenantId]: tenantA.subject,
    [tenantB.tenantId]: tenantB.subject,
    [operator.identity.tenantId]: `${prefix}-subject-ops-${nonce}`,
  }
  const identities = new Map<string, RouteIdentity>([
    [tenantA.member.token, tenantA.member],
    [tenantA.manager.token, tenantA.manager],
    [tenantB.member.token, tenantB.member],
    [tenantB.manager.token, tenantB.manager],
    [operator.token, operator.identity],
  ])
  const auth: RouteAuth = {
    available: () => true,
    identityFromRequest: req => {
      const header = req.headers.authorization
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined
      return identities.get(header.slice('Bearer '.length).trim())
    },
    tenantSubjects: () => tenantSubjects,
  }

  // The stack, wired exactly as lib consumers (index.ts apply /
  // scripts/smoke.mjs) wire it, over a fresh temp directory.
  const config = lib.resolveConfig({ endpoint: options.endpoint ?? DEAD_ENDPOINT, dataDir: dir })
  const getConfig = (): Config => config
  const wal = new lib.MeteringWal(dir)
  await wal.load()
  const store = new lib.OperatorStore(dir)
  await store.load()
  await store.setBinding(tenantA.presetId, tenantA.subject)
  await store.setBinding(tenantB.presetId, tenantB.subject)
  const ledger = lib.UsageLedger.open(dir)
  const budget = new MemoryBudgetStore()
  const client = new lib.OpenMeterClient(getConfig)
  const estimator = new lib.PriceEstimator(() => client, () => config.quoteCurrency)
  const gate = new lib.BalanceGate(() => client, store, getConfig)
  const forwarder = new lib.Forwarder(wal, () => client, getConfig)
  const presetsBySession = new Map<string, string>()
  const pipeline = new lib.MeteringPipeline({
    wal,
    gate,
    estimator,
    usageLedger: ledger,
    getConfig,
    sessions: () => ({
      get: (id: string) => {
        const presetId = presetsBySession.get(id)
        return presetId === undefined ? undefined : { id, header: { id, agentPreset: presetId } }
      },
    }),
    presetSubject: presetId => store.subjectFor(presetId, config.houseSubject),
    observePreset: presetId => store.observePreset(presetId),
  })

  // In-memory webServer + request dispatch (routes.spec.ts precedent).
  const handlers = new Map<string, Handler>()
  const webServer: WebServerLike = {
    register: route => {
      handlers.set(route.path, route.handler)
      return () => { handlers.delete(route.path) }
    },
  }
  const disposeRoutes = lib.mountRoutes(webServer, {
    getConfig,
    client: () => client,
    gate,
    forwarder,
    pipeline,
    store,
    estimator,
    wal,
    auth,
    usageLedger: ledger,
    budget,
  })

  // Seeding bookkeeping: expected per-subject row counts (unique seed keys
  // only — a replayed (session, seq) never increments, mirroring the
  // pipeline's dedupe) drive the waitFor below.
  const expectedCalls = new Map<string, number>()
  const seededKeys = new Set<string>()
  const countCalls = (subject: string): number => expectedCalls.get(subject) ?? 0

  let pricedSeq = 0

  const fixture: AcceptanceFixture = {
    dir,
    tenantA,
    tenantB,
    operator,
    wal,
    ledger,
    store,
    client,
    estimator,
    gate,
    forwarder,
    pipeline,
    async request({ method, path, body, token, remoteAddress }) {
      const handler = handlers.get(path.split('?')[0] ?? path)
      if (handler === undefined) throw new Error(`no route mounted for ${path}`)
      const chunks: Buffer[] = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
      const req = {
        method,
        url: path,
        headers: {
          host: '127.0.0.1:38080',
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        socket: { remoteAddress: remoteAddress ?? '127.0.0.1' },
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) yield chunk
        },
      } as unknown as IncomingMessage
      let settle!: (value: { status: number, body: Record<string, unknown> }) => void
      const recorded = new Promise<{ status: number, body: Record<string, unknown> }>(resolve => { settle = resolve })
      let status = 0
      const res = {
        writeHead: (code: number) => { status = code },
        end: (payload: string) => { settle({ status, body: JSON.parse(payload) as Record<string, unknown> }) },
      } as unknown as ServerResponse
      handler(req, res)
      return await recorded
    },
    async seedUsage(tenant, call) {
      const sessionId = `${tenant.tenantId}#session`
      presetsBySession.set(sessionId, tenant.presetId)
      pipeline.onSessionEvent(sessionId, {
        type: 'assistant/message',
        seq: call.seq,
        time: Date.now(),
        data: {
          turn: 0,
          step: 0,
          usage: { inputTokens: call.inputTokens, outputTokens: call.outputTokens },
          message: { source: { provider: 'deepseek', model: call.model ?? 'glm-5.3' } },
        },
      })
      const key = `${sessionId}:${call.seq}`
      if (!seededKeys.has(key)) {
        seededKeys.add(key)
        expectedCalls.set(tenant.subject, countCalls(tenant.subject) + 1)
      }
      await waitFor(() => ledger.usagePage({ subject: tenant.subject }).totals.calls >= countCalls(tenant.subject), 2_000)
    },
    appendPricedRow(subject, amountCny) {
      pricedSeq += 1
      ledger.append({
        source: 'acceptance-fixture',
        eventId: `priced-${subject}-${pricedSeq}`,
        subject,
        capturedAt: Date.now(),
        provider: 'fixture',
        model: 'fixture-priced',
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        estimatedAmount: amountCny,
        currency: 'CNY',
        unpriced: false,
      })
      expectedCalls.set(subject, countCalls(subject) + 1)
    },
    dispose() {
      disposeRoutes()
      forwarder.stop()
      ledger.close()
    },
  }
  return fixture
}

/**
 * Single-tenant fixture factory (issue #11 Task 1 exported surface for the
 * Task 2 documentation-contract tests to reference).
 * @param subjectPrefix - prefix for tenant A's mapped subject.
 */
export async function makeTenantFixture(subjectPrefix: string): Promise<AcceptanceFixture> {
  return await makeAcceptanceFixture({ subjectPrefix })
}

/**
 * Operator fixture factory (issue #11 Task 1 exported surface): a full stack
 * with the operator actor ready.
 */
export async function makeOperatorFixture(): Promise<AcceptanceFixture> {
  return await makeAcceptanceFixture()
}

afterAll(async () => {
  for (const dir of createdDirs.splice(0)) {
    await chmod(dir, 0o700).catch(() => {})
    try {
      await rm(dir, { recursive: true, force: true })
    } catch (error) {
      // Known macOS ENOTEMPTY tmpdir flake (repo-wide); one forced retry clears it.
      if ((error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
      await rm(dir, { recursive: true, force: true })
    }
  }
})

describe('A/B tenant mutual invisibility (offline ledger + local aggregates)', () => {
  it('A meters usage and sees only own rows in /me/usage; B sees zero rows, counts, or subjects of A', async () => {
    const fx = await makeAcceptanceFixture()
    try {
      await fx.seedUsage(fx.tenantA, { seq: 1, inputTokens: 20, outputTokens: 5 })
      const aUsage = await fx.request({ method: 'GET', path: '/api/openmeter/me/usage', token: fx.tenantA.member.token })
      expect(aUsage.status).toBe(200)
      expect(aUsage.body.rows).toHaveLength(1)
      expect(aUsage.body.totals).toMatchObject({ calls: 1, tokens: 25 })
      expect(JSON.stringify(aUsage.body)).not.toContain(fx.tenantB.subject)

      const bUsage = await fx.request({ method: 'GET', path: '/api/openmeter/me/usage', token: fx.tenantB.member.token })
      expect(bUsage.status).toBe(200)
      expect(bUsage.body.rows).toEqual([])
      expect(bUsage.body.totals).toMatchObject({ calls: 0, tokens: 0, estimatedAmountCny: 0 })
      expect(JSON.stringify(bUsage.body)).not.toContain(fx.tenantA.subject)
    } finally {
      fx.dispose()
    }
  })

  it('symmetric: B meters usage with distinct amounts; A sees none of B amounts or counts', async () => {
    const fx = await makeAcceptanceFixture()
    try {
      await fx.seedUsage(fx.tenantA, { seq: 1, inputTokens: 20, outputTokens: 5 })
      await fx.seedUsage(fx.tenantB, { seq: 1, inputTokens: 7, outputTokens: 3 })
      fx.appendPricedRow(fx.tenantA.subject, 12.5)
      fx.appendPricedRow(fx.tenantB.subject, 7.25)

      const aUsage = await fx.request({ method: 'GET', path: '/api/openmeter/me/usage', token: fx.tenantA.member.token })
      expect(aUsage.body.totals).toMatchObject({ calls: 2, estimatedAmountCny: 12.5 })
      expect(JSON.stringify(aUsage.body)).not.toContain(fx.tenantB.subject)
      expect(JSON.stringify(aUsage.body)).not.toContain('7.25')

      const bUsage = await fx.request({ method: 'GET', path: '/api/openmeter/me/usage', token: fx.tenantB.member.token })
      expect(bUsage.body.totals).toMatchObject({ calls: 2, estimatedAmountCny: 7.25 })
      expect(JSON.stringify(bUsage.body)).not.toContain(fx.tenantA.subject)
      expect(JSON.stringify(bUsage.body)).not.toContain('12.5')
    } finally {
      fx.dispose()
    }
  })

  it('/me/summary local aggregates are subject-scoped even while OpenMeter is down', async () => {
    const fx = await makeAcceptanceFixture()
    try {
      await fx.seedUsage(fx.tenantA, { seq: 1, inputTokens: 20, outputTokens: 5 })
      const aSummary = await fx.request({ method: 'GET', path: '/api/openmeter/me/summary', token: fx.tenantA.member.token })
      expect(aSummary.status).toBe(200)
      expect(aSummary.body.availability).toBe('unavailable')
      expect(aSummary.body.subject).toBe(fx.tenantA.subject)
      expect(aSummary.body.usageTokens7d).toBe(25)
      expect(JSON.stringify(aSummary.body)).not.toContain(fx.tenantB.subject)

      const bSummary = await fx.request({ method: 'GET', path: '/api/openmeter/me/summary', token: fx.tenantB.member.token })
      expect(bSummary.body.usageTokens7d).toBe(0)
      expect(JSON.stringify(bSummary.body)).not.toContain(fx.tenantA.subject)
    } finally {
      fx.dispose()
    }
  })

  it('seeding is idempotent: replaying the same session event never doubles rows or totals', async () => {
    const fx = await makeAcceptanceFixture()
    try {
      await fx.seedUsage(fx.tenantA, { seq: 1, inputTokens: 20, outputTokens: 5 })
      const first = await fx.request({ method: 'GET', path: '/api/openmeter/me/usage', token: fx.tenantA.member.token })
      expect(first.body.totals).toMatchObject({ calls: 1, tokens: 25 })

      await fx.seedUsage(fx.tenantA, { seq: 1, inputTokens: 20, outputTokens: 5 })
      await new Promise(resolve => setTimeout(resolve, 100))
      const second = await fx.request({ method: 'GET', path: '/api/openmeter/me/usage', token: fx.tenantA.member.token })
      expect(second.body.totals).toMatchObject({ calls: 1, tokens: 25 })
      expect(second.body.rows).toHaveLength(1)
    } finally {
      fx.dispose()
    }
  })
})

describe('tenant budget: visibility, edit rights, over-line warning', () => {
  it('manager sets and sees the budget; a plain member is read-only (403 on PUT)', async () => {
    const fx = await makeAcceptanceFixture()
    try {
      const put = await fx.request({ method: 'PUT', path: '/api/openmeter/me/budget', token: fx.tenantA.manager.token, body: { monthlyBudgetCny: 10 } })
      expect(put.status).toBe(200)
      expect(put.body.canManageBudget).toBe(true)
      expect(put.body.monthlyBudgetCny).toBe(10)

      const memberGet = await fx.request({ method: 'GET', path: '/api/openmeter/me/budget', token: fx.tenantA.member.token })
      expect(memberGet.status).toBe(200)
      expect(memberGet.body.canManageBudget).toBe(false)
      expect(memberGet.body.monthlyBudgetCny).toBe(10)

      const memberPut = await fx.request({ method: 'PUT', path: '/api/openmeter/me/budget', token: fx.tenantA.member.token, body: { monthlyBudgetCny: 99 } })
      expect(memberPut.status).toBe(403)
      expect(memberPut.body).toEqual({ ok: false, error: 'forbidden' })
      const after = await fx.request({ method: 'GET', path: '/api/openmeter/me/budget', token: fx.tenantA.manager.token })
      expect(after.body.monthlyBudgetCny).toBe(10)
    } finally {
      fx.dispose()
    }
  })

  it('B has zero visibility of A budget: B side stays unconfigured with no A figures', async () => {
    const fx = await makeAcceptanceFixture()
    try {
      await fx.request({ method: 'PUT', path: '/api/openmeter/me/budget', token: fx.tenantA.manager.token, body: { monthlyBudgetCny: 10 } })
      const bBudget = await fx.request({ method: 'GET', path: '/api/openmeter/me/budget', token: fx.tenantB.manager.token })
      expect(bBudget.status).toBe(200)
      expect(bBudget.body.availability).toBe('unconfigured')
      expect('monthlyBudgetCny' in bBudget.body).toBe(false)
      expect(JSON.stringify(bBudget.body)).not.toContain(fx.tenantA.tenantId)
      expect(JSON.stringify(bBudget.body)).not.toContain(fx.tenantA.subject)
    } finally {
      fx.dispose()
    }
  })

  it('A spend over the line drives a ready forecast with projectedOverageCny > 0', async () => {
    const fx = await makeAcceptanceFixture()
    try {
      fx.appendPricedRow(fx.tenantA.subject, 500)
      const put = await fx.request({ method: 'PUT', path: '/api/openmeter/me/budget', token: fx.tenantA.manager.token, body: { monthlyBudgetCny: 10 } })
      expect(put.status).toBe(200)
      expect(put.body.availability).toBe('ready')
      expect(put.body.monthlyBudgetCny).toBe(10)
      expect(put.body.monthToDateCny).toBe(500)
      expect(put.body.projectedOverageCny).toBeGreaterThan(0)
    } finally {
      fx.dispose()
    }
  })

  it('PUT validation: non-positive amount → invalid-amount; extra keys (subject attempt) → invalid-body', async () => {
    const fx = await makeAcceptanceFixture()
    try {
      const zero = await fx.request({ method: 'PUT', path: '/api/openmeter/me/budget', token: fx.tenantA.manager.token, body: { monthlyBudgetCny: 0 } })
      expect(zero.status).toBe(400)
      expect(zero.body).toEqual({ ok: false, error: 'invalid-amount' })

      const spoof = await fx.request({ method: 'PUT', path: '/api/openmeter/me/budget', token: fx.tenantA.manager.token, body: { monthlyBudgetCny: 5, subject: fx.tenantB.subject } })
      expect(spoof.status).toBe(400)
      expect(spoof.body).toEqual({ ok: false, error: 'invalid-body' })
    } finally {
      fx.dispose()
    }
  })
})

describe('operator surface boundary', () => {
  it('operator reads bindings and writes a manual block carrying an audit actor', async () => {
    const fx = await makeAcceptanceFixture()
    try {
      const bindings = await fx.request({ method: 'GET', path: '/api/openmeter/operator/bindings', token: fx.operator.token })
      expect(bindings.status).toBe(200)
      expect(bindings.body.bindings).toMatchObject({ [fx.tenantA.presetId]: fx.tenantA.subject, [fx.tenantB.presetId]: fx.tenantB.subject })

      const block = await fx.request({ method: 'POST', path: '/api/openmeter/operator/block', token: fx.operator.token, body: { customerKey: fx.tenantA.subject, blocked: true } })
      expect(block.status).toBe(200)
      expect(block.body.audit).toMatchObject({ action: 'block.set', target: fx.tenantA.subject })
      expect(block.body.audit.actor).toMatchObject({ tenantId: fx.operator.identity.tenantId, userId: fx.operator.identity.userId })
      expect(fx.store.isManuallyBlocked(fx.tenantA.subject)).toBe(true)

      await fx.request({ method: 'POST', path: '/api/openmeter/operator/block', token: fx.operator.token, body: { customerKey: fx.tenantA.subject, blocked: false } })
      expect(fx.store.isManuallyBlocked(fx.tenantA.subject)).toBe(false)
    } finally {
      fx.dispose()
    }
  })

  it('tenant members are refused on every operator route before any store mutation', async () => {
    const fx = await makeAcceptanceFixture()
    try {
      for (const path of ['/api/openmeter/operator/customers', '/api/openmeter/operator/grants', '/api/openmeter/operator/block', '/api/openmeter/operator/bindings']) {
        const read = await fx.request({ method: 'GET', path, token: fx.tenantA.manager.token })
        expect(read.status).toBe(403)
        expect(read.body).toEqual({ ok: false, error: 'forbidden' })
      }
      const write = await fx.request({ method: 'POST', path: '/api/openmeter/operator/block', token: fx.tenantA.manager.token, body: { customerKey: fx.tenantB.subject, blocked: true } })
      expect(write.status).toBe(403)
      expect(fx.store.isManuallyBlocked(fx.tenantB.subject)).toBe(false)
    } finally {
      fx.dispose()
    }
  })

  it('callers without a verified identity get 401 on operator and tenant surfaces alike', async () => {
    const fx = await makeAcceptanceFixture()
    try {
      const operatorRead = await fx.request({ method: 'GET', path: '/api/openmeter/operator/customers' })
      expect(operatorRead.status).toBe(401)
      expect(operatorRead.body).toEqual({ ok: false, error: 'unauthenticated' })
      const me = await fx.request({ method: 'GET', path: '/api/openmeter/me/summary' })
      expect(me.status).toBe(401)
      expect(me.body).toEqual({ ok: false, error: 'unauthenticated' })
    } finally {
      fx.dispose()
    }
  })

  it('retired global cashier paths answer 410 route-migrated for every method and caller', async () => {
    const fx = await makeAcceptanceFixture()
    try {
      for (const segment of ['customers', 'grants', 'block', 'bindings']) {
        for (const method of ['GET', 'POST']) {
          for (const token of [undefined, fx.tenantA.member.token, fx.operator.token]) {
            const result = await fx.request({ method, path: `/api/openmeter/${segment}`, token, body: method === 'POST' ? { customerKey: fx.tenantA.subject } : undefined })
            expect(result.status).toBe(410)
            expect(result.body).toEqual({ ok: false, error: 'route-migrated', to: `/api/openmeter/operator/${segment}` })
          }
        }
      }
    } finally {
      fx.dispose()
    }
  })

  it('operator mutations past the authz gate degrade honestly (502) against a dead upstream', async () => {
    const fx = await makeAcceptanceFixture()
    try {
      const grant = await fx.request({ method: 'POST', path: '/api/openmeter/operator/grants', token: fx.operator.token, body: { customerKey: fx.tenantA.subject, amount: 5 } })
      expect(grant.status).toBe(502)
      expect(grant.body.ok).toBe(false)
    } finally {
      fx.dispose()
    }
  })
})

describe('cross-tenant subject attempts are rejected', () => {
  it('A querying with B subject via /me/usage gets 400 subject-not-allowed, not B data', async () => {
    const fx = await makeAcceptanceFixture()
    try {
      await fx.seedUsage(fx.tenantB, { seq: 1, inputTokens: 7, outputTokens: 3 })
      const attempt = await fx.request({ method: 'GET', path: `/api/openmeter/me/usage?subject=${encodeURIComponent(fx.tenantB.subject)}`, token: fx.tenantA.member.token })
      expect(attempt.status).toBe(400)
      expect(attempt.body).toEqual({ ok: false, error: 'subject-not-allowed' })
    } finally {
      fx.dispose()
    }
  })

  it('a tenantId query parameter is rejected the same way', async () => {
    const fx = await makeAcceptanceFixture()
    try {
      const attempt = await fx.request({ method: 'GET', path: `/api/openmeter/me/usage?tenantId=${encodeURIComponent(fx.tenantB.tenantId)}`, token: fx.tenantA.member.token })
      expect(attempt.status).toBe(400)
      expect(attempt.body).toEqual({ ok: false, error: 'subject-not-allowed' })
    } finally {
      fx.dispose()
    }
  })

  it('non-loopback requests are refused 403 before any identity resolution', async () => {
    const fx = await makeAcceptanceFixture()
    try {
      const remote = await fx.request({ method: 'GET', path: '/api/openmeter/me/summary', token: fx.tenantA.member.token, remoteAddress: '203.0.113.9' })
      expect(remote.status).toBe(403)
      expect(remote.body).toEqual({ ok: false, error: 'forbidden' })
    } finally {
      fx.dispose()
    }
  })
})

describe('unreachable OpenMeter degrades honestly (invalid-port fixture)', () => {
  it('/me/summary answers unavailable with local aggregates and no fabricated balance', async () => {
    const fx = await makeAcceptanceFixture({ endpoint: DEAD_ENDPOINT })
    try {
      await fx.seedUsage(fx.tenantA, { seq: 1, inputTokens: 20, outputTokens: 5 })
      const summary = await fx.request({ method: 'GET', path: '/api/openmeter/me/summary', token: fx.tenantA.member.token })
      expect(summary.status).toBe(200)
      expect(summary.body.ok).toBe(true)
      expect(summary.body.availability).toBe('unavailable')
      expect('availableTokens' in summary.body).toBe(false)
      expect('hasAccess' in summary.body).toBe(false)
      expect(summary.body.usageTokens7d).toBe(25)
    } finally {
      fx.dispose()
    }
  })

  it('the tenant summary never leaks the endpoint or internal error text', async () => {
    const fx = await makeAcceptanceFixture({ endpoint: DEAD_ENDPOINT })
    try {
      const summary = await fx.request({ method: 'GET', path: '/api/openmeter/me/summary', token: fx.tenantA.member.token })
      const raw = JSON.stringify(summary.body)
      expect(raw).not.toContain(DEAD_ENDPOINT)
      expect(raw).not.toContain('127.0.0.1:1')
      expect(raw).not.toContain('ECONNREFUSED')
    } finally {
      fx.dispose()
    }
  })

  it('operator customer listing degrades to 502 without serving tenant data', async () => {
    const fx = await makeAcceptanceFixture({ endpoint: DEAD_ENDPOINT })
    try {
      const customers = await fx.request({ method: 'GET', path: '/api/openmeter/operator/customers', token: fx.operator.token })
      expect(customers.status).toBe(502)
      expect(customers.body.ok).toBe(false)
      expect('customers' in customers.body).toBe(false)
    } finally {
      fx.dispose()
    }
  })

  it('the gate fails open: an outage never blocks model calls', async () => {
    const fx = await makeAcceptanceFixture({ endpoint: DEAD_ENDPOINT })
    try {
      await expect(fx.gate.allow(fx.tenantA.subject)).resolves.toBe(true)
    } finally {
      fx.dispose()
    }
  })
})

describe.skipIf(!LIVE_REACHABLE)('OpenMeter real chain at 127.0.0.1:8888 (forwards → meter → balance → block)', () => {
  /**
   * Seed one CNY price override so llm-feature usage can burn credit
   * (idempotent: skipped when any row exists). Mirrors scripts/smoke.mjs.
   */
  async function ensurePriceOverride(): Promise<void> {
    const list = await fetch(`${LIVE_ENDPOINT}/api/v3/openmeter/llm-cost/prices`).then(r => r.json())
    if ((list?.data ?? []).length > 0) return
    const response = await fetch(`${LIVE_ENDPOINT}/api/v3/openmeter/llm-cost/overrides`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'deepseek',
        model_id: 'glm-5.3',
        model_name: 'GLM 5.3',
        currency: 'CNY',
        effective_from: '2020-01-01T00:00:00Z',
        pricing: { input_per_token: '0.004', output_per_token: '0.016', cache_read_per_token: '0.0004', cache_write_per_token: '0.008' },
      }),
    })
    if (!response.ok) throw new Error(`price override seed -> ${response.status}: ${await response.text()}`)
  }

  /** Create the customer, its metered entitlement, and one grant. */
  async function ensureCustomer(fx: AcceptanceFixture, subject: string, grantAmount: number): Promise<void> {
    const existing = await fx.client.listCustomers()
    if (!existing.some(row => row.key === subject)) await fx.client.createCustomer(subject, `T1 ${subject}`)
    const entitlements = await fetch(`${LIVE_ENDPOINT}/api/v2/customers/${subject}/entitlements`).then(r => r.json())
    if ((entitlements.items ?? []).length === 0) {
      await fetch(`${LIVE_ENDPOINT}/api/v2/customers/${subject}/entitlements`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'metered', featureKey: FEATURE_KEY, isSoftLimit: false, usagePeriod: { interval: 'MONTH' } }),
      })
    }
    await fx.client.createGrant(subject, FEATURE_KEY, { amount: grantAmount, effectiveAt: new Date().toISOString() })
  }

  /** Subject-scoped meter total over the last 24h. */
  async function meterTotal(fx: AcceptanceFixture, subject: string): Promise<number> {
    const to = new Date()
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1000)
    const rows = await fx.client.meterQuery(METER_SLUG, { from: from.toISOString(), to: to.toISOString(), subject: [subject] })
    return rows.reduce((sum, row) => sum + Number(row?.value ?? 0), 0)
  }

  // TODO: skipped automatically while the endpoint's meter sink is absent —
  // `METER_SINK_LIVE` above probes GET /api/v1/meters at collection time.
  // The endpoint currently answering on 127.0.0.1:8888 is a partial local
  // shim, not the OpenMeter fork: ingest and customers answer 2xx (customer
  // ids read "…-LOCAL-SHIM-CUSTOMER"), but the meters list is empty and the
  // dsh_llm_tokens meter query always answers `{}`, so the meter leg of this
  // chain can never materialize rows there. Verified 2026-08-30 by direct
  // probe (see t1-report.md). Once the real fork (compose stack) serves a
  // non-empty meters list, this case un-skips itself. Until then the legs
  // that DO work against the shim are covered by the case below:
  // customers, entitlements, grants, gate/block, and the WAL → forwarder →
  // ingest drain (asserting the WAL empties; meter-row materialization and
  // ready-state summaries remain fork-only).
  it.skipIf(!METER_SINK_LIVE)('A and B meter through the real chain and stay isolated end to end', async () => {
    const fx = await makeAcceptanceFixture({ endpoint: LIVE_ENDPOINT })
    try {
      await ensurePriceOverride()
      await ensureCustomer(fx, fx.tenantA.subject, 50)
      await ensureCustomer(fx, fx.tenantB.subject, 50)

      await fx.seedUsage(fx.tenantA, { seq: 1, inputTokens: 20, outputTokens: 5 })
      await fx.seedUsage(fx.tenantB, { seq: 1, inputTokens: 7, outputTokens: 3 })
      await fx.forwarder.drain()
      expect(fx.wal.pending()).toHaveLength(0)

      await new Promise(resolve => setTimeout(resolve, 1_000))
      let aTokens = 0
      let bTokens = 0
      for (let attempt = 0; attempt < 20 && (aTokens === 0 || bTokens === 0); attempt += 1) {
        aTokens = await meterTotal(fx, fx.tenantA.subject)
        bTokens = await meterTotal(fx, fx.tenantB.subject)
        if (aTokens === 0 || bTokens === 0) await new Promise(resolve => setTimeout(resolve, 1_500))
      }
      expect(aTokens).toBeGreaterThanOrEqual(25)
      expect(bTokens).toBeGreaterThanOrEqual(10)

      const aSummary = await fx.request({ method: 'GET', path: '/api/openmeter/me/summary', token: fx.tenantA.member.token })
      expect(aSummary.body.availability).toBe('ready')
      expect(aSummary.body.subject).toBe(fx.tenantA.subject)
      expect(aSummary.body.usageTokens7d).toBeGreaterThanOrEqual(25)
      expect(JSON.stringify(aSummary.body)).not.toContain(fx.tenantB.subject)
      const bSummary = await fx.request({ method: 'GET', path: '/api/openmeter/me/summary', token: fx.tenantB.member.token })
      expect(bSummary.body.availability).toBe('ready')
      expect(JSON.stringify(bSummary.body)).not.toContain(fx.tenantA.subject)

      const aEntitlement = await fx.client.entitlementValue(fx.tenantA.subject, FEATURE_KEY)
      expect(aEntitlement.hasAccess).toBe(true)
    } finally {
      fx.dispose()
    }
  }, 120_000)

  it('a manual block stops one tenant at the gate while the other proceeds', async () => {
    const fx = await makeAcceptanceFixture({ endpoint: LIVE_ENDPOINT })
    try {
      await ensurePriceOverride()
      await ensureCustomer(fx, fx.tenantA.subject, 50)
      await ensureCustomer(fx, fx.tenantB.subject, 50)

      // Ingest leg (works against the shim: /api/v1/ingest answers 2xx) —
      // the seeded event flows WAL → forwarder → ingest and the WAL empties.
      // Meter-row materialization stays unasserted: the shim's meter query
      // always answers `{}`.
      await fx.seedUsage(fx.tenantA, { seq: 1, inputTokens: 20, outputTokens: 5 })
      await fx.forwarder.drain()
      expect(fx.wal.pending()).toHaveLength(0)

      expect(await fx.gate.allow(fx.tenantA.subject)).toBe(true)
      expect(await fx.gate.allow(fx.tenantB.subject)).toBe(true)

      await fx.store.setManualBlock(fx.tenantA.subject, true)
      expect(await fx.gate.allow(fx.tenantA.subject)).toBe(false)
      expect(await fx.gate.allow(fx.tenantB.subject)).toBe(true)

      await fx.store.setManualBlock(fx.tenantA.subject, false)
      await fx.gate.refreshNow([fx.tenantA.subject])
      expect(await fx.gate.allow(fx.tenantA.subject)).toBe(true)
    } finally {
      fx.dispose()
    }
  }, 120_000)
})
