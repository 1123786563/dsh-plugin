// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BillingPanel } from '../src/client/panel.tsx'
import type { StatusPayload, SummaryPayload, UsagePayload, UsageRowPayload } from '../src/client/api.ts'
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

/** One scripted fetch outcome: a JSON response or a transport rejection. */
type Responder = { ok: boolean, payload: unknown } | { rejects: Error }

const ok = (payload: unknown): Responder => ({ ok: true, payload })

/** Route fetch by URL prefix; each route plays its scripted responses in order, repeating the last. */
function stubFetch(script: { status?: Responder[], summary?: Responder[], usage?: Responder[] }): {
  counts: { status: number, summary: number, usage: number }
} {
  const counts = { status: 0, summary: 0, usage: 0 }
  const fetchMock = vi.fn(async (input: unknown): Promise<{ ok: boolean, json: () => Promise<unknown> }> => {
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
    } else if (url.startsWith('/api/openmeter/usage')) {
      responder = pick(script.usage, counts.usage)
      counts.usage += 1
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
  return { counts }
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
  })

  it('re-fetches the overview on the manual refresh path', async () => {
    const { counts } = stubFetch({
      status: [ok(makeStatus())],
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
