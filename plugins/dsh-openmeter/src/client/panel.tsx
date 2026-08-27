/**
 * The billing settings section (a top-level Settings page): the tenant 概览
 * (credit balance, runway, model cost distribution, detail CTA — no operator
 * data), plus the operator surfaces — 收银台 (customers, balances, recharge,
 * block/unblock, preset bindings) and 设置 (the config card, when provided).
 * Owns its chrome; plain fetch on mount and on manual refresh.
 *
 * @module dsh-openmeter/client/panel
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { api } from './api.ts'
import type { BindingsPayload, CustomersPayload, StatusPayload, SummaryPayload, UsagePayload } from './api.ts'
import { buildOverviewModel } from './overview.ts'
import type { ModelRow } from './overview.ts'
import { dictionary, format } from './locales.ts'

/** Copy reader. */
type T = (key: string, params?: Record<string, string | number>) => string

/** Panel state. */
interface PanelState {
  status: StatusPayload | undefined
  customers: CustomersPayload | undefined
  bindings: BindingsPayload | undefined
  error: string | undefined
  busy: boolean
}

/** Overview view state: the two payloads plus the summary fetch error. */
interface OverviewState {
  summary: SummaryPayload | undefined
  usage: UsagePayload | undefined
  error: string | undefined
}

/** Default detail callback until the host wires navigation. */
const noop = (): void => {}

/**
 * Render the billing settings section.
 * @param props - { t?, config?, onOpenUsageDetail? } the locale seat, the optional config card, and the tenant detail CTA target.
 * @returns the section.
 */
export function BillingPanel(props: { t?: T, config?: ReactNode, onOpenUsageDetail?: () => void } = {}): ReactNode {
  // The seated translator may arrive as a fresh prop identity every render,
  // and `t` feeds the reload effect's useCallback — keep both stable so the
  // mount effect doesn't loop fetch → setState → render forever.
  const seatedRef = useRef(props.t)
  seatedRef.current = props.t
  const t = useCallback((key: string, params?: Record<string, string | number>): string => {
    const dict = dictionary() as Record<string, string>
    const seated = seatedRef.current
    const raw = seated !== undefined ? seated(key, params) : dict[key] ?? key
    return params === undefined ? raw : format(raw, params)
  }, [])
  const [view, setView] = useState<'overview' | 'cashier' | 'config'>('overview')
  const [state, setState] = useState<PanelState>({ status: undefined, customers: undefined, bindings: undefined, error: undefined, busy: false })
  // Bumped by the manual refresh button so the overview re-fetches too.
  const [reloadSeq, setReloadSeq] = useState(0)

  const reload = useCallback(async (): Promise<void> => {
    setState(previous => ({ ...previous, busy: true }))
    const status = await api.status().catch(() => undefined)
    const next: PanelState = { status, customers: undefined, bindings: undefined, error: undefined, busy: false }
    if (status === undefined) next.error = t('panel.statusError')
    if (view === 'cashier') {
      const [customers, bindings] = await Promise.all([api.customers().catch(() => undefined), api.bindings().catch(() => undefined)])
      next.customers = customers
      next.bindings = bindings
      if (customers === undefined && next.error === undefined) next.error = t('panel.loadError')
    }
    setState(previous => ({ ...previous, ...next }))
  }, [t, view])

  useEffect(() => {
    void reload()
  }, [reload])

  const pending = state.status?.wal.pending
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12, padding: '4px 2px' }}>
      <h2 style={pageStyle}>{t('card.title')}</h2>
      <p style={introStyle}>{t('card.description')}</p>
      <div style={tabsStyle}>
        <button type="button" style={view === 'overview' ? tabActiveStyle : tabStyle} onClick={() => { setView('overview') }}>{t('panel.overview')}</button>
        <button type="button" style={view === 'cashier' ? tabActiveStyle : tabStyle} onClick={() => { setView('cashier') }}>{t('panel.cashier')}</button>
        {props.config !== undefined && (
          <button type="button" style={view === 'config' ? tabActiveStyle : tabStyle} onClick={() => { setView('config') }}>{t('panel.settings')}</button>
        )}
        <span style={{ flex: 1 }} />
        {state.status !== undefined && (
          <span style={pending !== undefined && pending > 0 ? warnStyle : mutedStyle}>
            {t('panel.wal')}: {pending ?? 0}
          </span>
        )}
        <button type="button" style={buttonStyle} disabled={state.busy} onClick={() => { setReloadSeq(count => count + 1); void reload() }}>{t('panel.refresh')}</button>
      </div>
      {state.error !== undefined && <p style={warnStyle}>{state.error}</p>}
      {view === 'config' ? props.config : view === 'overview'
        ? <OverviewView t={t} reloadSeq={reloadSeq} onOpenDetail={props.onOpenUsageDetail ?? noop} />
        : <CashierView state={state} t={t} reload={reload} />}
    </div>
  )
}

/**
 * Aggregate one tenant's usage rows into per-model rows: exact-subject match
 * only (other subjects never appear), tokens = billed input (input + cache
 * read + cache write) + output, CNY amounts summed over CNY-currency rows only.
 * @param usage - the usage payload; undefined when the route failed (yields no rows).
 * @param subject - the caller's own billing subject.
 * @returns one row per model, first-seen order.
 */
function buildModelRows(usage: UsagePayload | undefined, subject: string): ModelRow[] {
  const rows = new Map<string, { model: string, calls: number, tokens: number, amountCny: number }>()
  for (const row of usage?.rows ?? []) {
    if (row.subject !== subject) continue
    const current = rows.get(row.model) ?? { model: row.model, calls: 0, tokens: 0, amountCny: 0 }
    current.calls += 1
    current.tokens += row.usage.inputTokens + (row.usage.cacheReadTokens ?? 0) + (row.usage.cacheWriteTokens ?? 0) + row.usage.outputTokens
    if (row.currency === 'CNY') current.amountCny += row.estimatedAmount
    rows.set(row.model, current)
  }
  return [...rows.values()]
}

/**
 * The tenant overview: Token balance, runway, the 7-day aggregates, the
 * per-model cost distribution, and the detail CTA. Fetches its own summary +
 * usage on mount and on every `reloadSeq` bump; a failed usage fetch only
 * degrades the model table, while a failed summary fetch shows an error with
 * retry. Never renders operator data (customers, subjects, WAL counters).
 * @param props - locale, the panel's refresh signal, the detail CTA target.
 */
function OverviewView(props: { t: T, reloadSeq: number, onOpenDetail: () => void }): ReactNode {
  const { t, reloadSeq, onOpenDetail } = props
  const [state, setState] = useState<OverviewState>({ summary: undefined, usage: undefined, error: undefined })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setState({ summary: undefined, usage: undefined, error: undefined })
    api.summary().then(
      summary => { if (alive) setState(previous => ({ ...previous, summary })) },
      () => { if (alive) setState(previous => ({ ...previous, summary: undefined, error: t('overview.error') })) },
    )
    api.usage().then(
      usage => { if (alive) setState(previous => ({ ...previous, usage })) },
      () => { if (alive) setState(previous => ({ ...previous, usage: undefined })) },
    )
    return () => {
      alive = false
    }
  }, [reloadSeq, attempt, t])

  if (state.error !== undefined) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <p style={warnStyle}>{state.error}</p>
        <div style={actionsStyle}>
          <button type="button" style={buttonStyle} onClick={() => { setAttempt(count => count + 1) }}>{t('overview.retry')}</button>
        </div>
      </div>
    )
  }
  if (state.summary === undefined) return <p style={mutedStyle}>…</p>

  const overview = buildOverviewModel(state.summary, buildModelRows(state.usage, state.summary.subject))
  const empty = overview.usageTokens7d === 0 && overview.models.length === 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {overview.unavailable && <p style={warnStyle}>{t('overview.unavailable')}</p>}
      {!overview.unavailable && (
        <>
          <div style={headlineStyle}>
            <span style={balanceStyle}>
              {t('overview.balance')}：{overview.availableTokens === undefined
                ? <span style={mutedStyle}>{t('overview.noBalance')}</span>
                : `${overview.availableTokens.toLocaleString()} Token`}
            </span>
            <span style={mutedStyle}>{t('overview.asOf', { time: new Date(overview.asOf).toLocaleString() })}</span>
          </div>
          <p style={{ margin: 0 }}>
            {overview.runwayDays === null ? t('overview.runwayUnknown') : t('overview.runway', { days: overview.runwayDays })}
          </p>
          {overview.lowCredit && <p style={{ ...warnStyle, margin: 0 }}>{t('overview.lowCredit')}</p>}
        </>
      )}
      <div style={actionsStyle}>
        <button type="button" style={buttonStyle} onClick={onOpenDetail}>{t('overview.detail')}</button>
      </div>
      {empty
        ? <p style={{ ...mutedStyle, margin: 0 }}>{t('overview.empty')}</p>
        : (
          <>
            <p style={{ margin: 0 }}>
              {t('overview.usage7d')}：{overview.usageTokens7d.toLocaleString()} Token · {t('overview.estCny7d')}：¥{overview.estimatedCny7d.toFixed(2)}
            </p>
            <section>
              <h4 style={hStyle}>{t('overview.models')}</h4>
              {state.usage === undefined
                ? <p style={{ ...mutedStyle, margin: 0 }}>{t('overview.modelsUnavailable')}</p>
                : overview.models.length === 0
                  ? <p style={{ ...mutedStyle, margin: 0 }}>—</p>
                  : <table style={tableStyle}>
                      <thead>
                        <tr>
                          <th style={thStyle}>{t('overview.model')}</th>
                          <th style={thStyle}>{t('overview.calls')}</th>
                          <th style={thStyle}>{t('overview.tokens')}</th>
                          <th style={thStyle}>{t('overview.estAmount')}</th>
                          <th style={thStyle}>{t('overview.share')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {overview.models.map(row => (
                          <tr key={row.model}>
                            <td style={tdStyle}>{row.model}</td>
                            <td style={tdStyle}>{row.calls}</td>
                            <td style={tdStyle}>{row.tokens.toLocaleString()}</td>
                            <td style={tdStyle}>¥{row.amountCny.toFixed(2)}</td>
                            <td style={tdStyle}>{row.percent}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>}
            </section>
          </>
          )}
    </div>
  )
}

/**
 * The cashier view: customers + bindings.
 * @param props - state + locale + reload.
 */
function CashierView(props: { state: PanelState, t: T, reload: () => Promise<void> }): ReactNode {
  const { state, t, reload } = props
  const customers = state.customers?.customers ?? []
  const bindingsFallback: BindingsPayload = { ok: true, bindings: {}, observedPresets: [], houseSubject: '' }
  const bindings = state.bindings ?? bindingsFallback
  const [newKey, setNewKey] = useState('')
  const [newName, setNewName] = useState('')
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const run = (action: () => Promise<unknown>): void => {
    setBusy(true)
    void action().then(() => reload()).then(() => setBusy(false), () => setBusy(false))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <section>
        <h4 style={hStyle}>{t('panel.customers')}</h4>
        {customers.length === 0
          ? <p style={mutedStyle}>—</p>
          : <table style={tableStyle}>
              <tbody>
                {customers.map(customer => (
                  <tr key={customer.key}>
                    <td style={tdStyle}>
                      <strong>{customer.name}</strong>
                      <span style={mutedStyle}> @{customer.key}</span>
                      {customer.key === state.customers?.houseSubject && <span style={mutedStyle}> {t('panel.house')}</span>}
                    </td>
                    <td style={tdStyle}>
                      {customer.balance === undefined
                        ? <span style={mutedStyle}>{t('panel.noEntitlement')}</span>
                        : `${t('panel.balance')}: ${customer.balance.toLocaleString()}`}
                      {customer.manuallyBlocked && <span style={warnStyle}> · {t('panel.blocked')}</span>}
                    </td>
                    <td style={tdStyle}>
                      <input
                        style={inputStyle}
                        placeholder={t('panel.amountPrompt')}
                        value={amounts[customer.key] ?? ''}
                        onChange={event => { setAmounts({ ...amounts, [customer.key]: event.target.value }) }}
                      />
                      <button type="button" style={buttonStyle} disabled={busy} onClick={() => {
                        const amount = Number(amounts[customer.key])
                        if (Number.isFinite(amount) && amount > 0) run(() => api.grant(customer.key, amount))
                      }}>{t('panel.recharge')}</button>
                      <button type="button" style={buttonStyle} disabled={busy} onClick={() => { run(() => api.block(customer.key, !customer.manuallyBlocked)) }}>
                        {customer.manuallyBlocked ? t('panel.unblock') : t('panel.block')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>}
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <input style={inputStyle} placeholder={t('panel.customerKey')} value={newKey} onChange={event => { setNewKey(event.target.value) }} />
          <input style={inputStyle} placeholder={t('panel.customerName')} value={newName} onChange={event => { setNewName(event.target.value) }} />
          <button type="button" style={buttonStyle} disabled={busy || newKey.trim().length === 0} onClick={() => {
            run(() => api.createCustomer(newKey.trim(), newName.trim()).then(() => { setNewKey(''); setNewName('') }))
          }}>{t('panel.create')}</button>
        </div>
      </section>
      <section>
        <h4 style={hStyle}>{t('panel.bindings')}</h4>
        <table style={tableStyle}>
          <tbody>
            {bindings.observedPresets.map(preset => (
              <tr key={preset}>
                <td style={tdStyle}>{preset}</td>
                <td style={tdStyle}>
                  <select
                    style={inputStyle}
                    value={bindings.bindings[preset] ?? ''}
                    onChange={event => { run(() => api.bind(preset, event.target.value)) }}
                  >
                    <option value="">— {t('panel.house')} —</option>
                    {customers.map(customer => (
                      <option key={customer.key} value={customer.key}>{customer.name} (@{customer.key})</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
            {bindings.observedPresets.length === 0 && (
              <tr><td style={tdStyle} colSpan={2}><span style={mutedStyle}>—</span></td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  )
}

const pageStyle: CSSProperties = { margin: 0, fontSize: 16 }
const introStyle: CSSProperties = { margin: 0, opacity: 0.7 }
const tabsStyle: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }
const tabStyle: CSSProperties = { padding: '3px 10px', border: '1px solid rgba(127,127,127,.35)', borderRadius: 6, background: 'transparent', cursor: 'pointer' }
const tabActiveStyle: CSSProperties = { ...tabStyle, fontWeight: 600, borderColor: 'rgba(127,127,127,.8)' }
const buttonStyle: CSSProperties = { padding: '2px 8px', border: '1px solid rgba(127,127,127,.35)', borderRadius: 6, background: 'transparent', cursor: 'pointer', fontSize: 12 }
const inputStyle: CSSProperties = { padding: '2px 6px', border: '1px solid rgba(127,127,127,.35)', borderRadius: 6, background: 'transparent', fontSize: 12, minWidth: 70 }
const tableStyle: CSSProperties = { width: '100%', borderCollapse: 'collapse' }
const thStyle: CSSProperties = { textAlign: 'left', padding: '2px 6px', fontWeight: 600 }
const tdStyle: CSSProperties = { padding: '3px 6px', verticalAlign: 'middle' }
const hStyle: CSSProperties = { margin: '4px 0', fontSize: 12 }
const mutedStyle: CSSProperties = { opacity: 0.6 }
const warnStyle: CSSProperties = { color: '#d2482d' }
const headlineStyle: CSSProperties = { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }
const actionsStyle: CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap' }
const balanceStyle: CSSProperties = { fontSize: 14, fontWeight: 600 }
