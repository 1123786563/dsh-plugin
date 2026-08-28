// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BillingPanel } from '../src/client/panel.tsx'
import type { BudgetPayload, PageStats, StatusPayload, SummaryPayload, UsageDetailPayload, UsageDetailRow, UsagePayload, UsageRowPayload } from '../src/client/api.ts'
import { format, zh } from '../src/client/locales.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

/** Read copy from the zh product dictionary the way the seated translator does. */
function t(key: string, params?: Record<string, string | number>): string {
  return format(zh[key] ?? key, params ?? {})
}

/** Format a number the way panel.tsx renders it: the runtime-default locale. */
const num = (n: number): string => n.toLocaleString()

const NOW = Date.parse('2026-08-30T12:00:00.000Z')

function makeSummary(overrides: {
  availability?: 'ready' | 'unavailable'
  availableTokens?: number
  hasAccess?: boolean
  usageTokens7d?: number
  estimatedCny7d?: number
} = {}): SummaryPayload {
  return {
    ok: true,
    availability: overrides.availability ?? 'ready',
    tenantId: 'tenant-a',
    subject: 'cust-a',
    ...(overrides.availableTokens === undefined ? {} : { availableTokens: overrides.availableTokens }),
    ...(overrides.hasAccess === undefined ? {} : { hasAccess: overrides.hasAccess }),
    usageTokens7d: overrides.usageTokens7d ?? 1400,
    estimatedCny7d: overrides.estimatedCny7d ?? 12.5,
    asOf: NOW,
  }
}

function makeRow(overrides: Partial<Omit<UsageRowPayload, 'sessionId'>> = {}): UsageRowPayload {
  return {
    subject: overrides.subject ?? 'cust-a',
    provider: overrides.provider ?? 'deepseek',
    model: overrides.model ?? 'deepseek-chat',
    usage: overrides.usage ?? { inputTokens: 100, outputTokens: 50 },
    estimatedAmount: overrides.estimatedAmount ?? 1,
    currency: overrides.currency ?? 'CNY',
    unpriced: overrides.unpriced ?? false,
    at: overrides.at ?? NOW,
  }
}

function makeUsage(rows: UsageRowPayload[]): UsagePayload {
  return { ok: true, rows, aggregates: [] }
}

function makeStatus(): StatusPayload {
  return {
    ok: true,
    endpoint: 'https://openmeter.example',
    houseSubject: 'house',
    featureKey: 'gate',
    meterSlug: 'tokens',
    quoteCurrency: 'CNY',
    blockEnabled: true,
    wal: { pending: 0, confirmedRecent: 0, total: 0 },
    forwarder: { running: true, eventsConfirmed: 0 },
    gate: { failOpenCount: 0, blockedCount: 0 },
    prices: { rows: 1 },
  }
}

function makeDetailRow(overrides: Partial<UsageDetailRow> = {}): UsageDetailRow {
  return {
    at: overrides.at ?? NOW,
    provider: overrides.provider ?? 'deepseek',
    model: overrides.model ?? 'deepseek-chat',
    tokens: overrides.tokens ?? 1000,
    inputTokens: overrides.inputTokens ?? 700,
    outputTokens: overrides.outputTokens ?? 300,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    cacheWriteTokens: overrides.cacheWriteTokens ?? 0,
    reasoningTokens: overrides.reasoningTokens ?? 0,
    estimatedAmount: overrides.estimatedAmount ?? 1,
    currency: overrides.currency ?? 'CNY',
    unpriced: overrides.unpriced ?? false,
  }
}

/** PageStats over the given rows, mirroring the route's CNY-pricing rules. */
function statsOf(rows: UsageDetailRow[]): PageStats {
  const sum = (pick: (row: UsageDetailRow) => number): number => rows.reduce((total, row) => total + pick(row), 0)
  return {
    calls: rows.length,
    tokens: sum(row => row.tokens),
    inputTokens: sum(row => row.inputTokens),
    outputTokens: sum(row => row.outputTokens),
    cacheReadTokens: sum(row => row.cacheReadTokens),
    cacheWriteTokens: sum(row => row.cacheWriteTokens),
    reasoningTokens: sum(row => row.reasoningTokens),
    estimatedAmountCny: rows.reduce((total, row) => (row.currency === 'CNY' && !row.unpriced ? total + row.estimatedAmount : total), 0),
    unpricedCalls: rows.reduce((count, row) => (row.unpriced ? count + 1 : count), 0),
  }
}

/** One detail payload; page/totals mirror the scripted rows the way the route aggregates them. */
function makeDetailPayload(overrides: { rows?: UsageDetailRow[], cursor?: string } = {}): UsageDetailPayload {
  const rows = overrides.rows ?? [makeDetailRow()]
  return {
    ok: true,
    rows,
    page: statsOf(rows),
    totals: statsOf(rows),
    ...(overrides.cursor === undefined ? {} : { cursor: overrides.cursor }),
  }
}

/**
 * One budget payload mirroring the server union's per-availability field
 * presence: `unconfigured` carries no budget or overage, and
 * `insufficient-history` carries the budget without a projection.
 */
function makeBudget(overrides: {
  availability?: BudgetPayload['availability']
  canManageBudget?: boolean
  monthlyBudgetCny?: number
  monthToDateCny?: number
  projectedMonthEndCny?: number
  projectedOverageCny?: number
} = {}): BudgetPayload {
  const availability = overrides.availability ?? 'ready'
  const budget = availability === 'unconfigured' ? undefined : overrides.monthlyBudgetCny ?? 100
  const projected = availability === 'insufficient-history' ? undefined : overrides.projectedMonthEndCny ?? 80
  const overage = availability === 'ready' ? overrides.projectedOverageCny ?? 0 : undefined
  return {
    ok: true,
    availability,
    ...(budget === undefined ? {} : { monthlyBudgetCny: budget }),
    monthToDateCny: overrides.monthToDateCny ?? 50,
    ...(projected === undefined ? {} : { projectedMonthEndCny: projected }),
    ...(overage === undefined ? {} : { projectedOverageCny: overage }),
    canManageBudget: overrides.canManageBudget ?? true,
    basis: { method: 'linear-daily-average', monthStartMs: NOW, monthEndMs: NOW, daysInMonth: 31, daysElapsed: 15, dataAsOfMs: NOW, currency: 'CNY', spendSource: 'local-ledger-estimates' },
  }
}

/** Local calendar label of an epoch, mirroring the client's day key. */
const localDay = (at: number): string => {
  const date = new Date(at)
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Local zero-padded HH:mm:ss of an epoch, mirroring formatClock. */
const localClock = (at: number): string => {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Compose the calls/tokens/CNY stats string the way the detail view renders it. */
const statsText = (calls: number, tokens: number, cny: number, unpriced: number): string => {
  const base = t('detail.stats', { calls, tokens: tokens.toLocaleString('en-US'), cny: `¥${cny.toFixed(2)}` })
  return unpriced > 0 ? `${base} · ${t('detail.unpricedCount', { count: unpriced })}` : base
}

/** One scripted fetch outcome: a JSON response or a transport rejection. */
type Responder = { ok: boolean, payload: unknown } | { rejects: Error }

const ok = (payload: unknown): Responder => ({ ok: true, payload })

/** Route fetch by URL prefix; each route plays its scripted responses in order, repeating the last. */
function stubFetch(script: { status?: Responder[], summary?: Responder[], usage?: Responder[], meUsage?: Responder[], budget?: Responder[] }): {
  counts: { status: number, summary: number, usage: number, meUsage: number, budget: number, customers: number, bindings: number }
  meUsageUrls: string[]
  budgetRequests: Array<{ method: string, body: string }>
} {
  const counts = { status: 0, summary: 0, usage: 0, meUsage: 0, budget: 0, customers: 0, bindings: 0 }
  const meUsageUrls: string[] = []
  const budgetRequests: Array<{ method: string, body: string }> = []
  const fetchMock = vi.fn(async (input: unknown, init?: { method?: string, body?: string }): Promise<{ ok: boolean, json: () => Promise<unknown> }> => {
    const url = String(input)
    const pick = (route: Responder[] | undefined, count: number): Responder => {
      const responder = route?.[count] ?? route?.at(-1)
      if (responder === undefined) throw new Error(`unscripted fetch: ${url}`)
      return responder
    }
    let responder: Responder
    if (url.startsWith('/api/openmeter/me/summary')) {
      responder = pick(script.summary, counts.summary)
      counts.summary += 1
    } else if (url.startsWith('/api/openmeter/me/budget')) {
      responder = pick(script.budget, counts.budget)
      budgetRequests.push({ method: init?.method ?? 'GET', body: init?.body ?? '' })
      counts.budget += 1
    } else if (url.startsWith('/api/openmeter/me/usage')) {
      responder = pick(script.meUsage, counts.meUsage)
      meUsageUrls.push(url)
      counts.meUsage += 1
    } else if (url.startsWith('/api/openmeter/usage')) {
      responder = pick(script.usage, counts.usage)
      counts.usage += 1
    } else if (url.startsWith('/api/openmeter/operator/customers')) {
      responder = pick(script.customers, counts.customers)
      counts.customers += 1
    } else if (url.startsWith('/api/openmeter/operator/bindings')) {
      responder = pick(script.bindings, counts.bindings)
      counts.bindings += 1
    } else if (url.startsWith('/api/openmeter/status')) {
      responder = pick(script.status, counts.status)
      counts.status += 1
    } else {
      throw new Error(`unscripted fetch: ${url}`)
    }
    if ('rejects' in responder) throw responder.rejects
    return { ok: responder.ok, json: async () => responder.payload }
  })
  vi.stubGlobal('fetch', fetchMock)
  return { counts, meUsageUrls, budgetRequests }
}

function renderPanel(onOpenUsageDetail?: () => void): ReturnType<typeof render> {
  return onOpenUsageDetail === undefined
    ? render(<BillingPanel t={t} />)
    : render(<BillingPanel t={t} onOpenUsageDetail={onOpenUsageDetail} />)
}

// No vitest `globals: true`: RTL cannot self-register cleanup, so unmount here.
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('BillingPanel overview (tenant surface)', () => {
  it('renders balance, runway, and the per-model cost table from the caller subject only', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000, hasAccess: true }))],
      usage: [ok(makeUsage([
        makeRow({ model: 'deepseek-chat', usage: { inputTokens: 300, outputTokens: 100, cacheReadTokens: 50 }, estimatedAmount: 1 }),
        makeRow({ model: 'deepseek-chat', usage: { inputTokens: 200, outputTokens: 100 }, estimatedAmount: 2 }),
        makeRow({ model: 'deepseek-reasoner', usage: { inputTokens: 500, outputTokens: 250, cacheWriteTokens: 50 }, estimatedAmount: 1 }),
        makeRow({ subject: 'cust-b', model: 'deepseek-vlm', estimatedAmount: 9 }),
      ]))],
    })
    renderPanel()
    expect(await screen.findByText(new RegExp(`${num(8000)} Token`))).toBeTruthy()
    expect(screen.getByText(t('overview.runway', { days: 40 }))).toBeTruthy()
    expect(screen.getByText(/更新于/)).toBeTruthy()
    expect(screen.queryByText(/deepseek-vlm/)).toBeNull()
    const chat = Array.from(screen.getByText('deepseek-chat').closest('tr')?.querySelectorAll('td') ?? []).map(td => td.textContent)
    expect(chat).toEqual(['deepseek-chat', '2', '750', '¥3.00', '75%'])
    const reasoner = Array.from(screen.getByText('deepseek-reasoner').closest('tr')?.querySelectorAll('td') ?? []).map(td => td.textContent)
    expect(reasoner).toEqual(['deepseek-reasoner', '1', '800', '¥1.00', '25%'])
  })

  it('counts non-CNY row tokens but excludes their amounts from the CNY totals', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([
        makeRow({ model: 'deepseek-chat', usage: { inputTokens: 300, outputTokens: 100 }, estimatedAmount: 1.5 }),
        makeRow({ model: 'deepseek-reasoner', usage: { inputTokens: 200, outputTokens: 100 }, estimatedAmount: 0.5 }),
        makeRow({ model: 'x-usd', usage: { inputTokens: 500, outputTokens: 100 }, estimatedAmount: 9, currency: 'USD' }),
      ]))],
    })
    renderPanel()
    expect(await screen.findByText('x-usd')).toBeTruthy()
    const chat = Array.from(screen.getByText('deepseek-chat').closest('tr')?.querySelectorAll('td') ?? []).map(td => td.textContent)
    expect(chat).toEqual(['deepseek-chat', '1', '400', '¥1.50', '75%'])
    const reasoner = Array.from(screen.getByText('deepseek-reasoner').closest('tr')?.querySelectorAll('td') ?? []).map(td => td.textContent)
    expect(reasoner).toEqual(['deepseek-reasoner', '1', '300', '¥0.50', '25%'])
    const usd = Array.from(screen.getByText('x-usd').closest('tr')?.querySelectorAll('td') ?? []).map(td => td.textContent)
    expect(usd).toEqual(['x-usd', '1', '600', '¥0.00', '0%'])
  })

  it('routes the detail CTA to onOpenUsageDetail exactly once per click', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
    })
    const onOpenUsageDetail = vi.fn()
    renderPanel(onOpenUsageDetail)
    fireEvent.click(await screen.findByText(t('overview.detail')))
    expect(onOpenUsageDetail).toHaveBeenCalledTimes(1)
  })

  it('shows the empty state when the seven-day usage is zero', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000, usageTokens7d: 0, estimatedCny7d: 0 }))],
      usage: [ok(makeUsage([]))],
    })
    renderPanel()
    expect(await screen.findByText(t('overview.empty'))).toBeTruthy()
    expect(screen.queryByText(t('overview.models'))).toBeNull()
  })

  it('shows the unavailable banner with local aggregates but no balance or runway', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availability: 'unavailable', usageTokens7d: 1200, estimatedCny7d: 3.5 }))],
      usage: [ok(makeUsage([makeRow({ model: 'deepseek-chat', estimatedAmount: 3.5 })]))],
    })
    renderPanel()
    expect(await screen.findByText(t('overview.unavailable'))).toBeTruthy()
    const aggregates = screen.getByText(new RegExp(`${num(1200)} Token`))
    expect(aggregates.textContent).toContain('¥3.50')
    expect(screen.getByText('deepseek-chat')).toBeTruthy()
    expect(screen.queryByText(new RegExp(t('overview.balance')))).toBeNull()
    expect(screen.queryByText(/预计可用/)).toBeNull()
    expect(screen.queryByText(t('overview.runwayUnknown'))).toBeNull()
  })

  it('warns on low credit when the runway drops below seven days', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 690, usageTokens7d: 700 }))],
      usage: [ok(makeUsage([makeRow({ model: 'deepseek-chat', estimatedAmount: 1 })]))],
    })
    renderPanel()
    expect(await screen.findByText(t('overview.lowCredit'))).toBeTruthy()
    expect(screen.getByText(t('overview.runway', { days: 6.9 }))).toBeTruthy()
  })

  it('surfaces a summary fetch error and refetches on retry', async () => {
    const { counts } = stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [{ rejects: new Error('network down') }, ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
    })
    renderPanel()
    expect(await screen.findByText(t('overview.error'))).toBeTruthy()
    expect(counts.summary).toBe(1)
    fireEvent.click(screen.getByText(t('overview.retry')))
    expect(await screen.findByText(new RegExp(`${num(8000)} Token`))).toBeTruthy()
    expect(counts.summary).toBe(2)
  })

  it('degrades only the model table when the usage fetch rejects', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [{ rejects: new Error('usage down') }],
    })
    renderPanel()
    expect(await screen.findByText(t('overview.modelsUnavailable'))).toBeTruthy()
    expect(screen.getByText(t('overview.models'))).toBeTruthy()
    expect(screen.queryByText(t('overview.model'))).toBeNull()
    expect(screen.getByText(new RegExp(`${num(8000)} Token`))).toBeTruthy()
    const aggregates = screen.getByText(new RegExp(`${num(1400)} Token`))
    expect(aggregates.textContent).toContain('¥12.50')
  })

  it('pins the narrow-screen layout: wrapping rows and full-width tables', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([makeRow({ model: 'deepseek-chat', estimatedAmount: 2 })]))],
    })
    const { container } = renderPanel()
    await screen.findByText(new RegExp(`${num(8000)} Token`))
    expect(screen.getByText(new RegExp(`${num(8000)} Token`)).closest('div')?.style.flexWrap).toBe('wrap')
    expect(screen.getByText(t('overview.detail')).closest('div')?.style.flexWrap).toBe('wrap')
    const tables = Array.from(container.querySelectorAll('table'))
    expect(tables.length).toBeGreaterThan(0)
    for (const table of tables) expect(table.style.width).toBe('100%')
  })

  it('defaults to the overview tab and keeps the operator tabs', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([makeRow({ model: 'deepseek-chat', estimatedAmount: 2 })]))],
    })
    render(<BillingPanel t={t} config={<div>CONFIG_CARD</div>} />)
    expect(await screen.findByText(new RegExp(`${num(8000)} Token`))).toBeTruthy()
    expect(screen.getByText(t('panel.overview'))).toBeTruthy()
    expect(screen.getByText(t('panel.cashier'))).toBeTruthy()
    expect(screen.getByText(t('panel.settings'))).toBeTruthy()
    expect(screen.queryByText(/本月累计/)).toBeNull()
    expect(screen.queryByText(/最近调用/)).toBeNull()
    expect(screen.queryByText(t('panel.customers'))).toBeNull()
  })

  it('fetches the summary exactly once per mount (no effect loop)', async () => {
    const { counts } = stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([makeRow({ model: 'deepseek-chat', estimatedAmount: 2 })]))],
    })
    renderPanel()
    await screen.findByText(new RegExp(`${num(8000)} Token`))
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30))
    })
    expect(counts.summary).toBe(1)
    expect(counts.usage).toBe(1)
    expect(counts.budget).toBe(1)
  })

  it('re-fetches the overview on the manual refresh path', async () => {
    const { counts } = stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([makeRow({ model: 'deepseek-chat', estimatedAmount: 2 })]))],
    })
    renderPanel()
    await screen.findByText(new RegExp(`${num(8000)} Token`))
    fireEvent.click(screen.getByText(t('panel.refresh')))
    await waitFor(() => {
      expect(counts.summary).toBe(2)
    })
  })
})

describe('BillingPanel usage detail view (tenant drill-down)', () => {
  /** UTC noons two days apart: distinct local calendar days under any timezone offset below 24h. */
  const DAY_NEW = Date.UTC(2026, 7, 30, 12, 0, 0)
  const DAY_OLD = Date.UTC(2026, 7, 29, 12, 0, 0)

  it('opens the detail view from the CTA and fetches the journal with a bare default query', async () => {
    const { counts, meUsageUrls } = stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
      meUsage: [ok(makeDetailPayload())],
    })
    renderPanel()
    fireEvent.click(await screen.findByText(t('overview.detail')))
    // The tab and the detail header share the 用量明细 copy; the filter
    // controls only exist inside the detail view.
    expect(await screen.findByText(t('detail.apply'))).toBeTruthy()
    expect(counts.meUsage).toBe(1)
    // The bare URL pins the whole default query: no subject, no limit, no params at all.
    expect(meUsageUrls[0]).toBe('/api/openmeter/me/usage')
    expect(screen.queryByText(new RegExp(`${num(8000)} Token`))).toBeNull()
  })

  it('returns to the overview on back and preserves filters and rows across revisits without refetching', async () => {
    const { counts } = stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
      meUsage: [ok(makeDetailPayload({ rows: [makeDetailRow({ model: 'deepseek-chat' })] }))],
    })
    renderPanel()
    fireEvent.click(await screen.findByText(t('overview.detail')))
    expect(await screen.findByText('deepseek-chat')).toBeTruthy()
    fireEvent.change(screen.getByLabelText(t('overview.model')), { target: { value: 'deepseek-chat' } })
    fireEvent.click(screen.getByText(t('detail.apply')))
    await waitFor(() => {
      expect(counts.meUsage).toBe(2)
    })
    fireEvent.click(screen.getByText(t('detail.back')))
    expect(await screen.findByText(new RegExp(`${num(8000)} Token`))).toBeTruthy()
    fireEvent.click(screen.getByText(t('overview.detail')))
    expect((screen.getByLabelText(t('overview.model')) as HTMLInputElement).value).toBe('deepseek-chat')
    expect(screen.getByText('deepseek-chat')).toBeTruthy()
    expect(counts.meUsage).toBe(2)
  })

  it('commits date and model filters on apply with local-day epoch bounds; uncommitted edits never fetch', async () => {
    const { counts, meUsageUrls } = stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
      meUsage: [ok(makeDetailPayload()), ok(makeDetailPayload())],
    })
    renderPanel()
    fireEvent.click(await screen.findByText(t('overview.detail')))
    await screen.findByText(t('detail.apply'))
    fireEvent.change(screen.getByLabelText(t('detail.from')), { target: { value: '2026-08-20' } })
    fireEvent.change(screen.getByLabelText(t('detail.to')), { target: { value: '2026-08-22' } })
    fireEvent.change(screen.getByLabelText(t('overview.model')), { target: { value: '  deepseek-chat  ' } })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(counts.meUsage).toBe(1)
    fireEvent.click(screen.getByText(t('detail.apply')))
    await waitFor(() => {
      expect(counts.meUsage).toBe(2)
    })
    const url = meUsageUrls[1] ?? ''
    expect(url).toContain(`from=${new Date(2026, 7, 20).getTime()}`)
    expect(url).toContain(`to=${new Date(2026, 7, 22, 23, 59, 59, 999).getTime()}`)
    expect(url).toContain('model=deepseek-chat')
  })

  it('groups rows into newest-first day sections with subtotals and per-row detail', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
      meUsage: [ok(makeDetailPayload({ rows: [
        makeDetailRow({ at: DAY_NEW, estimatedAmount: 1.5 }),
        makeDetailRow({ at: DAY_OLD, model: 'deepseek-reasoner', tokens: 500, inputTokens: 400, outputTokens: 100, estimatedAmount: 2 }),
        makeDetailRow({ at: DAY_OLD, model: 'x-usd', tokens: 600, inputTokens: 500, outputTokens: 100, estimatedAmount: 9, currency: 'USD' }),
        makeDetailRow({ at: DAY_OLD, model: 'x-unpriced', tokens: 100, inputTokens: 50, outputTokens: 50, estimatedAmount: 0, unpriced: true }),
      ] }))],
    })
    const { container } = renderPanel()
    fireEvent.click(await screen.findByText(t('overview.detail')))
    expect(await screen.findByText(localDay(DAY_NEW))).toBeTruthy()
    expect(screen.getByText(localDay(DAY_OLD))).toBeTruthy()
    const text = container.textContent ?? ''
    expect(text.indexOf(localDay(DAY_NEW))).toBeLessThan(text.indexOf(localDay(DAY_OLD)))
    expect(screen.getByText(statsText(1, 1000, 1.5, 0))).toBeTruthy()
    expect(screen.getByText(statsText(3, 1200, 2, 1))).toBeTruthy()
    // The two days are UTC noons exactly 24h apart (so their local day keys are always distinct), which also makes their clock strings identical in every timezone — locate the row by its unique model instead.
    const newRow = screen.getByText('deepseek-chat').closest('tr')
    expect(Array.from(newRow?.querySelectorAll('td') ?? []).map(td => td.textContent)).toEqual([
      localClock(DAY_NEW),
      'deepseek',
      'deepseek-chat',
      `1,000${t('detail.dimensions', { input: 700, output: 300, cacheRead: 0, cacheWrite: 0, reasoning: 0 })}`,
      '¥1.50',
    ])
    expect(screen.getByText(t('detail.unpriced')).closest('td')?.textContent).toBe(t('detail.unpriced'))
    const usdRow = screen.getByText('9 USD').closest('tr')
    expect(usdRow?.textContent).toContain('x-usd')
    expect(usdRow?.textContent).not.toContain('¥')
    expect(screen.getByText(t('detail.totals', { stats: statsText(4, 2200, 3.5, 1) }))).toBeTruthy()
  })

  it('shows the empty state with the since-activation note on a successful empty load', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
      meUsage: [ok(makeDetailPayload({ rows: [] }))],
    })
    renderPanel()
    fireEvent.click(await screen.findByText(t('overview.detail')))
    expect(await screen.findByText(t('detail.empty'))).toBeTruthy()
    expect(screen.getByText(t('detail.emptyNote'))).toBeTruthy()
    expect(screen.queryByText(t('detail.end'))).toBeNull()
  })

  it('surfaces a localized error banner on rejection and recovers on retry with the same query', async () => {
    const { counts, meUsageUrls } = stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
      meUsage: [
        { rejects: new Error('openmeter route /api/openmeter/me/usage -> 500: {"secret":"route-internals"}') },
        ok(makeDetailPayload()),
      ],
    })
    renderPanel()
    fireEvent.click(await screen.findByText(t('overview.detail')))
    expect(await screen.findByText(t('detail.error'))).toBeTruthy()
    expect(screen.queryByText(/route-internals/)).toBeNull()
    expect(counts.meUsage).toBe(1)
    fireEvent.click(screen.getByText(t('detail.retry')))
    expect(await screen.findByText('¥1.00')).toBeTruthy()
    expect(counts.meUsage).toBe(2)
    expect(meUsageUrls[1]).toBe(meUsageUrls[0])
  })

  it('appends the next keyset page and marks the end when the cursor stops', async () => {
    const { counts, meUsageUrls } = stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
      meUsage: [
        ok(makeDetailPayload({ rows: [makeDetailRow({ model: 'page-one-row' })], cursor: 'opaque-1' })),
        ok(makeDetailPayload({ rows: [makeDetailRow({ model: 'page-two-row', at: DAY_OLD })] })),
      ],
    })
    renderPanel()
    fireEvent.click(await screen.findByText(t('overview.detail')))
    expect(await screen.findByText('page-one-row')).toBeTruthy()
    expect(screen.getByText(t('detail.nextPage'))).toBeTruthy()
    expect(screen.queryByText(t('detail.end'))).toBeNull()
    fireEvent.click(screen.getByText(t('detail.nextPage')))
    expect(await screen.findByText('page-two-row')).toBeTruthy()
    expect(screen.getByText('page-one-row')).toBeTruthy()
    expect(meUsageUrls[1]).toContain('cursor=opaque-1')
    expect(counts.meUsage).toBe(2)
    expect(screen.getByText(t('detail.end'))).toBeTruthy()
    expect(screen.queryByText(t('detail.nextPage'))).toBeNull()
  })

  it('hides the next-page button after a failed page fetch and resumes from the failed cursor on retry', async () => {
    const { counts, meUsageUrls } = stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
      meUsage: [
        ok(makeDetailPayload({ rows: [makeDetailRow({ model: 'page-one-row' })], cursor: 'opaque-1' })),
        { rejects: new Error('page two down') },
        ok(makeDetailPayload({ rows: [makeDetailRow({ model: 'page-two-row', at: DAY_OLD })], cursor: 'opaque-2' })),
      ],
    })
    renderPanel()
    fireEvent.click(await screen.findByText(t('overview.detail')))
    expect(await screen.findByText('page-one-row')).toBeTruthy()
    fireEvent.click(screen.getByText(t('detail.nextPage')))
    expect(await screen.findByText(t('detail.error'))).toBeTruthy()
    expect(screen.getByText('page-one-row')).toBeTruthy()
    expect(screen.queryByText(t('detail.nextPage'))).toBeNull()
    fireEvent.click(screen.getByText(t('detail.retry')))
    expect(await screen.findByText('page-two-row')).toBeTruthy()
    expect(screen.getByText('page-one-row')).toBeTruthy()
    expect(screen.getByText(t('detail.nextPage'))).toBeTruthy()
    expect(meUsageUrls[2]).toContain('cursor=opaque-1')
    expect(counts.meUsage).toBe(3)
  })

  it('pins the narrow-screen detail layout: wrapping controls and full-width tables', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
      meUsage: [ok(makeDetailPayload())],
    })
    const { container } = renderPanel()
    fireEvent.click(await screen.findByText(t('overview.detail')))
    expect(await screen.findByText('¥1.00')).toBeTruthy()
    expect(screen.getByText(t('detail.apply')).closest('div')?.style.flexWrap).toBe('wrap')
    const tables = Array.from(container.querySelectorAll('table'))
    expect(tables.length).toBeGreaterThan(0)
    for (const table of tables) expect(table.style.width).toBe('100%')
  })
})

describe('BillingPanel budget card and editor (tenant surface)', () => {
  it('renders a read-only card for a member: tone copy, no edit entry, no input on the page', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget({ canManageBudget: false }))],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
    })
    const { container } = renderPanel()
    // The default payload projects ¥80.00 against the ¥100.00 budget: the near boundary (>= 0.8).
    expect(await screen.findByText(t('budget.near', { projected: '¥80.00', budget: '¥100.00' }))).toBeTruthy()
    expect(screen.queryByText(t('budget.edit'))).toBeNull()
    expect(screen.queryByText(t('budget.configure'))).toBeNull()
    expect(container.querySelectorAll('input')).toHaveLength(0)
  })

  it('edits the budget as manager: prefilled input, one PUT with the exact body, card refreshed from the response', async () => {
    let resolvePut: (payload: BudgetPayload) => void = () => {}
    const hangingPut = new Promise<BudgetPayload>(resolve => { resolvePut = resolve })
    const { counts, budgetRequests } = stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget()), ok(hangingPut)],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
    })
    renderPanel()
    fireEvent.click(await screen.findByText(t('budget.edit')))
    const input = screen.getByLabelText(t('budget.field')) as HTMLInputElement
    expect(input.value).toBe('100.00')
    fireEvent.change(input, { target: { value: '120.5' } })
    fireEvent.click(screen.getByText(t('budget.save')))
    // While the PUT is in flight the save button relabels and every button disables.
    expect(await screen.findByText(t('budget.saving'))).toBeTruthy()
    expect((screen.getByText(t('budget.saving')).closest('button') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByText(t('budget.cancel')).closest('button') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      resolvePut(makeBudget({ monthlyBudgetCny: 120.5 }))
    })
    await waitFor(() => {
      expect(screen.queryByLabelText(t('budget.field'))).toBeNull()
    })
    expect(counts.budget).toBe(2)
    // The serialized PUT body is pinned exactly: one field, the parsed amount.
    expect(budgetRequests).toEqual([
      { method: 'GET', body: '' },
      { method: 'PUT', body: '{"monthlyBudgetCny":120.5}' },
    ])
    // The card re-renders from the PUT response (the fresh forecast), and the
    // 120.5 budget against the ¥80.00 projection reads as under.
    expect(screen.getByText(t('budget.progress', { budget: '¥120.50', spent: '¥50.00' }))).toBeTruthy()
    expect(screen.getByText(t('budget.under', { projected: '¥80.00', budget: '¥120.50' }))).toBeTruthy()
  })

  it('rejects invalid amounts client-side with no fetch and the form staying open', async () => {
    const { counts } = stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
    })
    renderPanel()
    fireEvent.click(await screen.findByText(t('budget.edit')))
    for (const value of ['0', '-5', '0.004', '100000001', 'abc', '']) {
      fireEvent.change(screen.getByLabelText(t('budget.field')), { target: { value } })
      fireEvent.click(screen.getByText(t('budget.save')))
      expect(await screen.findByText(t('budget.invalidAmount'))).toBeTruthy()
      expect((screen.getByLabelText(t('budget.field')) as HTMLInputElement).value).toBe(value)
    }
    expect(counts.budget).toBe(1)
  })

  it('keeps the form open with the edited input on save failure, and a later good save still works', async () => {
    const { counts } = stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget()), { ok: false, payload: { ok: false } }, ok(makeBudget({ monthlyBudgetCny: 140 }))],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
    })
    renderPanel()
    fireEvent.click(await screen.findByText(t('budget.edit')))
    fireEvent.change(screen.getByLabelText(t('budget.field')), { target: { value: '130' } })
    fireEvent.click(screen.getByText(t('budget.save')))
    expect(await screen.findByText(t('budget.saveFailed'))).toBeTruthy()
    expect((screen.getByLabelText(t('budget.field')) as HTMLInputElement).value).toBe('130')
    fireEvent.change(screen.getByLabelText(t('budget.field')), { target: { value: '140' } })
    fireEvent.click(screen.getByText(t('budget.save')))
    await waitFor(() => {
      expect(screen.queryByLabelText(t('budget.field'))).toBeNull()
    })
    expect(screen.queryByText(t('budget.saveFailed'))).toBeNull()
    expect(screen.getByText(t('budget.progress', { budget: '¥140.00', spent: '¥50.00' }))).toBeTruthy()
    expect(counts.budget).toBe(3)
  })

  it('cancel discards the edit and reopening prefills the original budget', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
    })
    renderPanel()
    fireEvent.click(await screen.findByText(t('budget.edit')))
    fireEvent.change(screen.getByLabelText(t('budget.field')), { target: { value: '999' } })
    fireEvent.click(screen.getByText(t('budget.cancel')))
    expect(screen.queryByLabelText(t('budget.field'))).toBeNull()
    expect(screen.getByText(t('budget.progress', { budget: '¥100.00', spent: '¥50.00' }))).toBeTruthy()
    fireEvent.click(screen.getByText(t('budget.edit')))
    expect((screen.getByLabelText(t('budget.field')) as HTMLInputElement).value).toBe('100.00')
  })

  it('warns over budget with the projected total, the budget, and the overage all in the copy', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget({ projectedMonthEndCny: 150, projectedOverageCny: 50 }))],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
    })
    renderPanel()
    expect(await screen.findByText(t('budget.over', { projected: '¥150.00', budget: '¥100.00', overage: '¥50.00' }))).toBeTruthy()
  })

  it('offers 设置预算 when unconfigured and renders the configured card from the save response', async () => {
    const { budgetRequests } = stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget({ availability: 'unconfigured' })), ok(makeBudget({ monthlyBudgetCny: 80 }))],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
    })
    renderPanel()
    expect(await screen.findByText(t('budget.unconfigured'))).toBeTruthy()
    expect(screen.getByText(t('budget.unconfiguredSpend', { spent: '¥50.00' }))).toBeTruthy()
    expect(screen.getByText(t('budget.unconfiguredProjected', { projected: '¥80.00' }))).toBeTruthy()
    expect(screen.queryByText(t('budget.edit'))).toBeNull()
    fireEvent.click(screen.getByText(t('budget.configure')))
    expect((screen.getByLabelText(t('budget.field')) as HTMLInputElement).value).toBe('')
    fireEvent.change(screen.getByLabelText(t('budget.field')), { target: { value: '80' } })
    fireEvent.click(screen.getByText(t('budget.save')))
    await waitFor(() => {
      expect(screen.queryByLabelText(t('budget.field'))).toBeNull()
    })
    expect(budgetRequests[1]).toEqual({ method: 'PUT', body: '{"monthlyBudgetCny":80}' })
    expect(screen.getByText(t('budget.progress', { budget: '¥80.00', spent: '¥50.00' }))).toBeTruthy()
  })

  it('renders the distinct no-history copy without a projection or edit entry for a member', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget({ availability: 'insufficient-history', canManageBudget: false }))],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
    })
    const { container } = renderPanel()
    expect(await screen.findByText(t('budget.noHistory'))).toBeTruthy()
    expect(screen.queryByText(t('budget.unavailable'))).toBeNull()
    expect(screen.queryByText(t('budget.edit'))).toBeNull()
    expect(container.querySelectorAll('input')).toHaveLength(0)
  })

  it('degrades only the budget card when its fetch rejects: overview stays and no error banner', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [{ rejects: new Error('budget down') }],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([makeRow({ model: 'deepseek-chat', estimatedAmount: 2 })]))],
    })
    renderPanel()
    expect(await screen.findByText(t('budget.unavailable'))).toBeTruthy()
    expect(screen.queryByText(t('budget.edit'))).toBeNull()
    expect(screen.getByText(new RegExp(`${num(8000)} Token`))).toBeTruthy()
    expect(screen.getByText(t('overview.runway', { days: 40 }))).toBeTruthy()
    expect(screen.getByText(t('overview.models'))).toBeTruthy()
    expect(screen.queryByText(t('overview.error'))).toBeNull()
  })

  it('re-fetches the budget on manual refresh and renders the refreshed value', async () => {
    const { counts } = stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget()), ok(makeBudget({ monthlyBudgetCny: 120.5 })), ok(makeBudget({ monthlyBudgetCny: 200 }))],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
    })
    renderPanel()
    fireEvent.click(await screen.findByText(t('budget.edit')))
    fireEvent.change(screen.getByLabelText(t('budget.field')), { target: { value: '120.5' } })
    fireEvent.click(screen.getByText(t('budget.save')))
    await waitFor(() => {
      expect(screen.queryByLabelText(t('budget.field'))).toBeNull()
    })
    expect(counts.budget).toBe(2)
    fireEvent.click(screen.getByText(t('panel.refresh')))
    await waitFor(() => {
      expect(counts.budget).toBe(3)
    })
    expect(await screen.findByText(t('budget.progress', { budget: '¥200.00', spent: '¥50.00' }))).toBeTruthy()
  })

  it('pins the budget card rows to wrapping layout on narrow screens', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
    })
    renderPanel()
    expect(await screen.findByText(t('budget.progress', { budget: '¥100.00', spent: '¥50.00' }))).toBeTruthy()
    // The 月度预算 copy now also labels the navigation tab; the card's own
    // title is the heading element.
    const cardTitle = screen.getAllByText(t('budget.title')).find(el => el.tagName === 'H4')
    expect(cardTitle?.closest('div')?.style.flexWrap).toBe('wrap')
    expect(screen.getByText(t('budget.progress', { budget: '¥100.00', spent: '¥50.00' })).closest('div')?.style.flexWrap).toBe('wrap')
    expect(screen.getByText(t('budget.near', { projected: '¥80.00', budget: '¥100.00' })).closest('div')?.style.flexWrap).toBe('wrap')
  })
})

// ---------------------------------------------------------------------------
// Issue #10 (租户导航清理): navigation derives from the authenticated
// capability set; operator surfaces stay out of the tenant surface, and the
// hidden entries remain server-guarded (the client only ever degrades).
// ---------------------------------------------------------------------------

describe('BillingPanel navigation cleanup (issue #10)', () => {
  /** A 403-shaped responder: the server's operator gate refusing a tenant. */
  const forbidden = { ok: false, payload: { ok: false, error: 'forbidden' } }

  it('hides the operator tabs, links, and config card from a plain tenant, with no error banner', async () => {
    stubFetch({
      status: [forbidden],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
    })
    render(<BillingPanel t={t} config={<div>CONFIG_CARD</div>} />)
    expect(await screen.findByText(new RegExp(`${num(8000)} Token`))).toBeTruthy()
    expect(screen.queryByText(t('panel.cashier'))).toBeNull()
    expect(screen.queryByText(t('panel.settings'))).toBeNull()
    expect(screen.queryByText('CONFIG_CARD')).toBeNull()
    expect(screen.queryByText(t('panel.customers'))).toBeNull()
    expect(screen.queryByText(t('panel.statusError'))).toBeNull()
  })

  it('keeps the three tenant entries for a plain tenant: overview, detail, budget', async () => {
    stubFetch({
      status: [forbidden],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
    })
    renderPanel()
    expect(await screen.findByText(new RegExp(`${num(8000)} Token`))).toBeTruthy()
    // The navigation entries are buttons (the detail/budget copy also labels
    // in-view headings, so select the tab by role).
    expect(screen.getByRole('button', { name: t('panel.overview') })).toBeTruthy()
    expect(screen.getByRole('button', { name: t('detail.title') })).toBeTruthy()
    expect(screen.getByRole('button', { name: t('budget.title') })).toBeTruthy()
  })

  it('opens the budget entry as its own view with its own fetch', async () => {
    const { counts } = stubFetch({
      status: [forbidden],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
    })
    renderPanel()
    await screen.findByText(new RegExp(`${num(8000)} Token`))
    const overviewBudgetFetches = counts.budget
    fireEvent.click(screen.getByRole('button', { name: t('budget.title') }))
    expect(await screen.findByText(t('budget.progress', { budget: '¥100.00', spent: '¥50.00' }))).toBeTruthy()
    expect(counts.budget).toBe(overviewBudgetFetches + 1)
  })

  it('shows the operator tabs alongside the tenant entries for an operator, and mounts the config card on demand', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
    })
    render(<BillingPanel t={t} config={<div>CONFIG_CARD</div>} />)
    expect(await screen.findByText(new RegExp(`${num(8000)} Token`))).toBeTruthy()
    expect(screen.getByRole('button', { name: t('panel.overview') })).toBeTruthy()
    expect(screen.getByRole('button', { name: t('detail.title') })).toBeTruthy()
    expect(screen.getByRole('button', { name: t('budget.title') })).toBeTruthy()
    expect(screen.getByRole('button', { name: t('panel.cashier') })).toBeTruthy()
    expect(screen.getByRole('button', { name: t('panel.settings') })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('panel.settings') }))
    expect(await screen.findByText('CONFIG_CARD')).toBeTruthy()
  })

  it('degrades the cashier surface to a localized error when the operator routes reject (hidden entry stays server-guarded)', async () => {
    stubFetch({
      status: [ok(makeStatus())],
      budget: [ok(makeBudget())],
      summary: [ok(makeSummary({ availableTokens: 8000 }))],
      usage: [ok(makeUsage([]))],
      customers: [forbidden],
      bindings: [forbidden],
    })
    renderPanel()
    await screen.findByText(new RegExp(`${num(8000)} Token`))
    fireEvent.click(screen.getByRole('button', { name: t('panel.cashier') }))
    // The view mounts for the authenticated operator but the rejected routes
    // degrade to the localized error with zero customer data rendered — the
    // server guard stays authoritative even on this side of the wire.
    expect(await screen.findByText(t('panel.loadError'))).toBeTruthy()
    expect(screen.queryByText(t('panel.recharge'))).toBeNull()
    expect(screen.queryByText(t('panel.block'))).toBeNull()
  })
})
