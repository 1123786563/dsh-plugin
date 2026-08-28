/**
 * The billing settings section (a top-level Settings page): the tenant 概览
 * (credit balance, runway, the month-scoped budget warning card with its
 * manager-only editor, model cost distribution, detail CTA — no operator
 * data) with its 用量明细 drill-down (mounted on first open, then kept alive
 * behind a display toggle so filters, rows, and the cursor survive
 * back-and-forth), the 预算 entry (the budget card as its own view), plus
 * the operator surfaces — 收银台 (customers, balances, recharge,
 * block/unblock, preset bindings) and 设置 (the config card, when provided)
 * — rendered only for callers the operator status probe authenticates
 * (issue #10: hiding never replaces the server-side operator guards). Owns
 * its chrome; plain fetch on mount and on manual refresh.
 *
 * @module dsh-openmeter/client/panel
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { api } from './api.ts'
import type { BindingsPayload, BudgetPayload, CustomersPayload, PageStats, StatusPayload, SummaryPayload, UsageDetailRow, UsagePayload } from './api.ts'
import { budgetCopy } from './budget-ui.ts'
import type { BudgetCopyModel } from './budget-ui.ts'
import { buildOverviewModel } from './overview.ts'
import type { ModelRow } from './overview.ts'
import { buildBillingNavigation } from './navigation.ts'
import type { BillingView } from './navigation.ts'
import { dictionary, format } from './locales.ts'
import { formatClock, formatCny, formatTokens, groupUsageRows, toUsageQuery } from './usage-detail.ts'
import type { UsageDetailFilters } from './usage-detail.ts'

/** Copy reader. */
type T = (key: string, params?: Record<string, string | number>) => string

/** Panel state. */
interface PanelState {
  status: StatusPayload | undefined
  /** Whether the operator status probe authenticated the caller (issue #10). */
  operator: boolean
  customers: CustomersPayload | undefined
  bindings: BindingsPayload | undefined
  error: string | undefined
  busy: boolean
}

/** Budget card fetch state: pending, loaded, or failed — pending ≠ failed. */
type BudgetState = { status: 'pending' } | { status: 'ok', payload: BudgetPayload } | { status: 'failed' }

/** Overview view state: the two payloads, the budget tri-state, and the summary fetch error. */
interface OverviewState {
  summary: SummaryPayload | undefined
  usage: UsagePayload | undefined
  budget: BudgetState
  error: string | undefined
}

/**
 * Render the billing settings section.
 * @param props - { t?, config?, onOpenUsageDetail? } the locale seat, the optional config card, and the tenant detail CTA target (invoked once per CTA click, alongside the built-in detail view).
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
  const [view, setView] = useState<BillingView>('overview')
  const [state, setState] = useState<PanelState>({ status: undefined, operator: false, customers: undefined, bindings: undefined, error: undefined, busy: false })
  // Bumped by the manual refresh button so the overview re-fetches too.
  const [reloadSeq, setReloadSeq] = useState(0)
  // Once the detail view has been opened it stays mounted (hidden behind a
  // display toggle), so its filters, rows, and cursor survive back-and-forth.
  const [detailOpened, setDetailOpened] = useState(false)

  const openDetail = (): void => {
    setDetailOpened(true)
    setView('detail')
    props.onOpenUsageDetail?.()
  }

  /** Switch to one navigation entry's view (the detail entry latches keep-alive). */
  const switchView = (target: BillingView): void => {
    if (target === 'detail') {
      setDetailOpened(true)
      setView('detail')
      return
    }
    setView(target)
  }

  const reload = useCallback(async (): Promise<void> => {
    setState(previous => ({ ...previous, busy: true }))
    const status = await api.status().catch(() => undefined)
    // The operator-gated status route doubles as the capability probe
    // (issue #10): success authenticates an operator, a refusal reads as a
    // plain tenant — never an error banner on the tenant surface.
    const operator = status !== undefined
    const next: PanelState = { status, operator, customers: undefined, bindings: undefined, error: undefined, busy: false }
    if (operator && view === 'cashier') {
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
  // Issue #10: navigation entries derive from the authenticated capability
  // set — tenants get overview/detail/budget; the operator entries (and the
  // config card seat) render only when the probe authenticated an operator.
  const entries = buildBillingNavigation({ operator: state.operator }).filter(
    entry => entry.view !== 'settings' || props.config !== undefined,
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12, padding: '4px 2px' }}>
      <h2 style={pageStyle}>{t('card.title')}</h2>
      <p style={introStyle}>{t('card.description')}</p>
      <div style={tabsStyle}>
        {entries.map(entry => (
          <button
            key={entry.id}
            type="button"
            style={view === entry.view ? tabActiveStyle : tabStyle}
            onClick={() => { switchView(entry.view) }}
          >{t(entry.labelKey)}</button>
        ))}
        <span style={{ flex: 1 }} />
        {state.status !== undefined && (
          <span style={pending !== undefined && pending > 0 ? warnStyle : mutedStyle}>
            {t('panel.wal')}: {pending ?? 0}
          </span>
        )}
        <button type="button" style={buttonStyle} disabled={state.busy} onClick={() => { setReloadSeq(count => count + 1); void reload() }}>{t('panel.refresh')}</button>
      </div>
      {state.error !== undefined && <p style={warnStyle}>{state.error}</p>}
      {view !== 'detail' && (view === 'settings' ? props.config : view === 'overview'
        ? <OverviewView t={t} reloadSeq={reloadSeq} onOpenDetail={openDetail} />
        : view === 'budget'
          ? <BudgetView t={t} reloadSeq={reloadSeq} />
          : state.operator === true ? <CashierView state={state} t={t} reload={reload} /> : null)}
      {detailOpened && (
        <div style={{ display: view === 'detail' ? 'block' : 'none' }}>
          <div style={detailBarStyle}>
            <button type="button" style={buttonStyle} onClick={() => { setView('overview') }}>{t('detail.back')}</button>
            <span style={{ fontWeight: 600 }}>{t('detail.title')}</span>
          </div>
          <UsageDetailView t={t} />
        </div>
      )}
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
 * month-scoped budget warning card, the per-model cost distribution, and
 * the detail CTA. Fetches its own summary + usage + budget on mount and on
 * every `reloadSeq` bump; a failed usage fetch only degrades the model
 * table, a failed budget fetch only degrades the budget card, while a
 * failed summary fetch shows an error with retry. Never renders operator
 * data (customers, subjects, WAL counters).
 * @param props - locale, the panel's refresh signal, the detail CTA target.
 */
function OverviewView(props: { t: T, reloadSeq: number, onOpenDetail: () => void }): ReactNode {
  const { t, reloadSeq, onOpenDetail } = props
  const [state, setState] = useState<OverviewState>({ summary: undefined, usage: undefined, budget: { status: 'pending' }, error: undefined })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setState({ summary: undefined, usage: undefined, budget: { status: 'pending' }, error: undefined })
    api.summary().then(
      summary => { if (alive) setState(previous => ({ ...previous, summary })) },
      () => { if (alive) setState(previous => ({ ...previous, summary: undefined, error: t('overview.error') })) },
    )
    api.usage().then(
      usage => { if (alive) setState(previous => ({ ...previous, usage })) },
      () => { if (alive) setState(previous => ({ ...previous, usage: undefined })) },
    )
    api.budget().then(
      budget => { if (alive) setState(previous => ({ ...previous, budget: { status: 'ok', payload: budget } })) },
      () => { if (alive) setState(previous => ({ ...previous, budget: { status: 'failed' } })) },
    )
    return () => {
      alive = false
    }
  }, [reloadSeq, attempt, t])

  /** Swap the budget card's payload for the fresh forecast a save answered. */
  const onBudgetSaved = (payload: BudgetPayload): void => {
    setState(previous => ({ ...previous, budget: { status: 'ok', payload } }))
  }

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
      <BudgetCard t={t} budget={state.budget} onSaved={onBudgetSaved} />
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
 * The tone line copy: money strings interpolated from the Task-1 view
 * model. The `unavailable` tone keeps its two causes distinct — a failed
 * fetch and an `insufficient-history` month render different text in the
 * same muted styling.
 * @param t - locale reader.
 * @param copy - the Task-1 budget view model.
 * @param payload - the fetched payload; undefined when the fetch failed.
 * @returns the localized tone line.
 */
function budgetToneLine(t: T, copy: BudgetCopyModel, payload: BudgetPayload | undefined): string {
  switch (copy.tone) {
    case 'over':
      return t('budget.over', { projected: copy.projected ?? '', budget: copy.budget ?? '', overage: copy.overage ?? '' })
    case 'near':
      return t('budget.near', { projected: copy.projected ?? '', budget: copy.budget ?? '' })
    case 'under':
      return t('budget.under', { projected: copy.projected ?? '', budget: copy.budget ?? '' })
    case 'unconfigured':
      return t('budget.unconfigured')
    case 'unavailable':
      return payload?.availability === 'insufficient-history' ? t('budget.noHistory') : t('budget.unavailable')
  }
}

/**
 * The month-scoped budget warning card: budget-versus-spend progress with a
 * capped bar, the month-end projection, and a tone-colored warning line,
 * all from `budgetCopy` (Task 1). Managers (`canManageBudget`) get a
 * one-field controlled editor: client-side validation mirrors the server
 * contract (positive, ≤ 100000000, exact to 分) and never fetches when
 * invalid; a valid save calls `api.setBudget` and swaps the card's payload
 * for the fresh forecast the PUT answers. A failed fetch renders the
 * unavailable line with no editor — no capability is known without a
 * payload. Independent of the entitlement-driven overview rows.
 * @param props - locale, the budget fetch state, and the save-success callback.
 */
function BudgetCard(props: { t: T, budget: BudgetState, onSaved: (payload: BudgetPayload) => void }): ReactNode {
  const { t, budget, onSaved } = props
  const payload = budget.status === 'ok' ? budget.payload : undefined
  const copy = budgetCopy(payload)
  const [editing, setEditing] = useState(false)
  const [input, setInput] = useState('')
  const [validationError, setValidationError] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [saving, setSaving] = useState(false)

  /** Open the editor with the current budget at two decimals (empty when unconfigured); errors cleared. */
  const open = (): void => {
    setEditing(true)
    setInput(payload?.monthlyBudgetCny === undefined ? '' : payload.monthlyBudgetCny.toFixed(2))
    setValidationError(false)
    setSaveError(false)
  }

  /** Close the editor, discarding the input and clearing errors. */
  const close = (): void => {
    setEditing(false)
    setInput('')
    setValidationError(false)
    setSaveError(false)
  }

  /** Validate then save: an invalid amount never fetches; success swaps in the response and closes the form. */
  const save = (): void => {
    const amount = Number(input.trim())
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000 || Math.round(amount * 100) < 1) {
      setValidationError(true)
      return
    }
    setValidationError(false)
    setSaving(true)
    api.setBudget(amount).then(
      fresh => {
        setSaving(false)
        setEditing(false)
        setSaveError(false)
        onSaved(fresh)
      },
      () => {
        setSaving(false)
        setSaveError(true)
      },
    )
  }

  const toneStyle = copy.tone === 'over' ? warnStyle : copy.tone === 'near' ? attentionStyle : mutedStyle
  return (
    <section>
      <div style={budgetRowStyle}>
        <h4 style={{ ...hStyle, margin: 0 }}>{t('budget.title')}</h4>
        {payload?.canManageBudget === true && !editing && (
          <button type="button" style={buttonStyle} onClick={open}>
            {payload.monthlyBudgetCny === undefined ? t('budget.configure') : t('budget.edit')}
          </button>
        )}
      </div>
      {budget.status === 'pending' && <div style={budgetRowStyle}><span style={mutedStyle}>…</span></div>}
      {budget.status === 'failed' && <div style={{ ...budgetRowStyle, ...mutedStyle }}>{t('budget.unavailable')}</div>}
      {budget.status === 'ok' && (
        <>
          {copy.progress !== null && (
            <>
              <div style={budgetRowStyle}>{t('budget.progress', { budget: copy.budget ?? '', spent: copy.spent })}</div>
              <div style={budgetBarTrackStyle}>
                <div style={{ ...budgetBarFillStyle, width: `${Math.round(copy.progress * 100)}%` }} />
              </div>
            </>
          )}
          {copy.tone !== 'unconfigured' && copy.projected !== null && (
            <div style={budgetRowStyle}>{t('budget.projected', { projected: copy.projected })}</div>
          )}
          <div style={{ ...budgetRowStyle, ...toneStyle }}>{budgetToneLine(t, copy, payload)}</div>
          {copy.tone === 'unconfigured' && (
            <>
              <div style={{ ...budgetRowStyle, ...mutedStyle }}>{t('budget.unconfiguredSpend', { spent: copy.spent })}</div>
              {copy.projected !== null && (
                <div style={{ ...budgetRowStyle, ...mutedStyle }}>{t('budget.unconfiguredProjected', { projected: copy.projected })}</div>
              )}
            </>
          )}
        </>
      )}
      {editing && (
        <div style={budgetRowStyle}>
          <label style={controlLabelStyle}>
            {t('budget.field')}
            <input style={inputStyle} value={input} onChange={event => { setInput(event.target.value) }} />
          </label>
          <button type="button" style={buttonStyle} disabled={saving} onClick={save}>{saving ? t('budget.saving') : t('budget.save')}</button>
          <button type="button" style={buttonStyle} disabled={saving} onClick={close}>{t('budget.cancel')}</button>
          {validationError && <span style={warnStyle}>{t('budget.invalidAmount')}</span>}
          {saveError && <span style={warnStyle}>{t('budget.saveFailed')}</span>}
        </div>
      )}
    </section>
  )
}

/**
 * The 预算 entry's own view (issue #10): the budget warning card mounted
 * standalone, fetching its own payload on mount and on every `reloadSeq`
 * bump (the manual refresh button is the retry path). A failed fetch
 * degrades exactly like the overview's inline card (the unavailable line,
 * no editor) — never an operator surface.
 * @param props - locale and the panel's refresh signal.
 */
function BudgetView(props: { t: T, reloadSeq: number }): ReactNode {
  const { t, reloadSeq } = props
  const [budget, setBudget] = useState<BudgetState>({ status: 'pending' })

  useEffect(() => {
    let alive = true
    setBudget({ status: 'pending' })
    api.budget().then(
      payload => { if (alive) setBudget({ status: 'ok', payload }) },
      () => { if (alive) setBudget({ status: 'failed' }) },
    )
    return () => {
      alive = false
    }
  }, [reloadSeq])

  /** Swap the card's payload for the fresh forecast a save answered. */
  const onSaved = (payload: BudgetPayload): void => {
    setBudget({ status: 'ok', payload })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <BudgetCard t={t} budget={budget} onSaved={onSaved} />
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

/**
 * The tenant usage-detail journal: filter controls (from/to local days +
 * exact model match), per-day grouped rows with subtotals, the filtered-range
 * totals line, and keyset next-page pagination. Fetches on first mount, on
 * every committed filter change, on retry, and on next-page; rows accumulate
 * across pages. A failed fetch renders a localized banner — never the
 * rejection's own text, which can carry route internals — and keeps prior
 * rows. No operator data and no subject/tenantId parameter: only the
 * caller's own journal is reachable.
 * @param props - locale.
 */
function UsageDetailView(props: { t: T }): ReactNode {
  const { t } = props
  const [filters, setFilters] = useState<UsageDetailFilters>({})
  const [query, setQuery] = useState<UsageDetailFilters>({})
  const [rows, setRows] = useState<UsageDetailRow[]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [cursorPage, setCursorPage] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [totals, setTotals] = useState<PageStats | undefined>(undefined)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(false)
    api.usageDetail(toUsageQuery(query, cursorPage)).then(
      payload => {
        if (!alive) return
        setRows(previous => [...previous, ...payload.rows])
        setCursor(payload.cursor)
        setTotals(payload.totals)
        setLoading(false)
      },
      () => {
        if (!alive) return
        setError(true)
        setLoading(false)
      },
    )
    return () => {
      alive = false
    }
  }, [query, cursorPage, attempt])

  /** Compose the shared calls/tokens/CNY stats string with the optional unpriced suffix. */
  const statsText = (calls: number, tokens: number, cny: number, unpriced: number): string => {
    const base = t('detail.stats', { calls, tokens: formatTokens(tokens), cny: formatCny(cny) })
    return unpriced > 0 ? `${base} · ${t('detail.unpricedCount', { count: unpriced })}` : base
  }

  /** Commit the edited filters: reset rows, cursor, and totals, then refetch. */
  const apply = (): void => {
    setQuery({ ...filters })
    setCursor(undefined)
    setCursorPage(undefined)
    setRows([])
    setTotals(undefined)
  }

  const groups = groupUsageRows(rows)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={controlsStyle}>
        <label style={controlLabelStyle}>{t('detail.from')}<input type="date" style={inputStyle} value={filters.from ?? ''} onChange={event => { setFilters({ ...filters, from: event.target.value }) }} /></label>
        <label style={controlLabelStyle}>{t('detail.to')}<input type="date" style={inputStyle} value={filters.to ?? ''} onChange={event => { setFilters({ ...filters, to: event.target.value }) }} /></label>
        <label style={controlLabelStyle}>{t('overview.model')}<input type="text" style={inputStyle} placeholder={t('detail.modelPlaceholder')} value={filters.model ?? ''} onChange={event => { setFilters({ ...filters, model: event.target.value }) }} /></label>
        <button type="button" style={buttonStyle} onClick={apply}>{t('detail.apply')}</button>
      </div>
      {error && (
        <div style={actionsStyle}>
          <span style={warnStyle}>{t('detail.error')}</span>
          <button type="button" style={buttonStyle} onClick={() => { setAttempt(count => count + 1) }}>{t('detail.retry')}</button>
        </div>
      )}
      {loading && rows.length === 0 && <p style={{ ...mutedStyle, margin: 0 }}>…</p>}
      {!loading && !error && rows.length === 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <p style={{ ...mutedStyle, margin: 0 }}>{t('detail.empty')}</p>
          <p style={{ ...mutedStyle, margin: 0 }}>{t('detail.emptyNote')}</p>
        </div>
      )}
      {groups.map(group => (
        <section key={group.key}>
          <h4 style={hStyle}>{group.key}</h4>
          <p style={{ ...mutedStyle, margin: 0 }}>
            {statsText(group.calls, group.tokens, group.estimatedAmountCny, group.unpricedCalls)}
          </p>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>{t('detail.colTime')}</th>
                <th style={thStyle}>{t('detail.colSource')}</th>
                <th style={thStyle}>{t('overview.model')}</th>
                <th style={thStyle}>{t('overview.tokens')}</th>
                <th style={thStyle}>{t('detail.colCost')}</th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row, index) => (
                <tr key={`${row.at}-${index}`}>
                  <td style={tdStyle}>{formatClock(row.at)}</td>
                  <td style={tdStyle}>{row.provider}</td>
                  <td style={tdStyle}>{row.model}</td>
                  <td style={tdStyle}>
                    <div>{formatTokens(row.tokens)}</div>
                    <div style={mutedStyle}>
                      {t('detail.dimensions', {
                        input: row.inputTokens,
                        output: row.outputTokens,
                        cacheRead: row.cacheReadTokens,
                        cacheWrite: row.cacheWriteTokens,
                        reasoning: row.reasoningTokens,
                      })}
                    </div>
                  </td>
                  <td style={tdStyle}>
                    {row.unpriced
                      ? <span style={mutedStyle}>{t('detail.unpriced')}</span>
                      : row.currency === 'CNY' ? formatCny(row.estimatedAmount) : `${row.estimatedAmount} ${row.currency}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
      {rows.length > 0 && totals !== undefined && (
        <p style={{ margin: 0 }}>
          {t('detail.totals', { stats: statsText(totals.calls, totals.tokens, totals.estimatedAmountCny, totals.unpricedCalls) })}
        </p>
      )}
      {cursor !== undefined && !loading && !error && (
        <div style={actionsStyle}>
          <button type="button" style={buttonStyle} onClick={() => { if (cursor !== undefined) setCursorPage(cursor) }}>{t('detail.nextPage')}</button>
        </div>
      )}
      {!loading && !error && rows.length > 0 && cursor === undefined && <p style={{ ...mutedStyle, margin: 0 }}>{t('detail.end')}</p>}
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
const attentionStyle: CSSProperties = { color: '#b8860b' }
const budgetRowStyle: CSSProperties = { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }
const budgetBarTrackStyle: CSSProperties = { width: '100%', height: 4, background: 'rgba(127,127,127,.2)', borderRadius: 2, overflow: 'hidden' }
const budgetBarFillStyle: CSSProperties = { height: '100%', background: 'rgba(127,127,127,.55)' }
const headlineStyle: CSSProperties = { display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }
const actionsStyle: CSSProperties = { display: 'flex', gap: 6, flexWrap: 'wrap' }
const balanceStyle: CSSProperties = { fontSize: 14, fontWeight: 600 }
const detailBarStyle: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }
const controlsStyle: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }
const controlLabelStyle: CSSProperties = { display: 'flex', gap: 4, alignItems: 'center' }
