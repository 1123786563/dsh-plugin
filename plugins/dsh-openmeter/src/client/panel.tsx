/**
 * The billing sidebar panel: two views over the host routes — 用量 (month
 * aggregates + recent per-call rows, each row = one committed assistant
 * message with its estimate) and 收银台 (customers, balances, recharge,
 * block/unblock, preset bindings). Owns its chrome; plain fetch on mount and
 * on manual refresh.
 *
 * @module dsh-openmeter/client/panel
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { api } from './api.ts'
import type { BindingsPayload, CustomersPayload, StatusPayload, UsagePayload } from './api.ts'
import { dictionary, format } from './locales.ts'

/** Copy reader. */
type T = (key: string, params?: Record<string, string | number>) => string

/** Panel state. */
interface PanelState {
  status: StatusPayload | undefined
  usage: UsagePayload | undefined
  customers: CustomersPayload | undefined
  bindings: BindingsPayload | undefined
  error: string | undefined
  busy: boolean
}

/**
 * Render the billing panel.
 * @param props - { t? } the locale seat.
 * @returns the panel.
 */
export function BillingPanel(props: { t?: T } = {}): ReactNode {
  const t = (key: string, params?: Record<string, string | number>): string => {
    const dict = dictionary() as Record<string, string>
    const seated = props.t
    const raw = seated !== undefined ? seated(key, params) : dict[key] ?? key
    return params === undefined ? raw : format(raw, params)
  }
  const [view, setView] = useState<'usage' | 'cashier'>('usage')
  const [state, setState] = useState<PanelState>({ status: undefined, usage: undefined, customers: undefined, bindings: undefined, error: undefined, busy: false })

  const reload = useCallback(async (): Promise<void> => {
    setState(previous => ({ ...previous, busy: true }))
    const [status, usage] = await Promise.all([api.status().catch(() => undefined), api.usage().catch(() => undefined)])
    const next: PanelState = { status, usage, customers: undefined, bindings: undefined, error: undefined, busy: false }
    if (status === undefined) next.error = t('panel.statusError')
    if (usage === undefined && next.error === undefined) next.error = t('panel.loadError')
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
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button type="button" style={view === 'usage' ? tabActiveStyle : tabStyle} onClick={() => { setView('usage') }}>{t('panel.usage')}</button>
        <button type="button" style={view === 'cashier' ? tabActiveStyle : tabStyle} onClick={() => { setView('cashier') }}>{t('panel.cashier')}</button>
        <span style={{ flex: 1 }} />
        {state.status !== undefined && (
          <span style={pending !== undefined && pending > 0 ? warnStyle : mutedStyle}>
            {t('panel.wal')}: {pending ?? 0}
          </span>
        )}
        <button type="button" style={buttonStyle} disabled={state.busy} onClick={() => { void reload() }}>{t('panel.refresh')}</button>
      </div>
      {state.error !== undefined && <p style={warnStyle}>{state.error}</p>}
      {view === 'usage' ? <UsageView state={state} t={t} /> : <CashierView state={state} t={t} reload={reload} />}
    </div>
  )
}

/**
 * The usage view: month aggregates + recent rows.
 * @param props - state + locale.
 */
function UsageView(props: { state: PanelState, t: T }): ReactNode {
  const { state, t } = props
  const aggregates = state.usage?.aggregates ?? []
  const rows = state.usage?.rows ?? []
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <section>
        <h4 style={hStyle}>{t('panel.today')}</h4>
        {aggregates.length === 0
          ? <p style={mutedStyle}>—</p>
          : <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t('panel.subject')}</th>
                  <th style={thStyle}>{t('panel.tokens')}</th>
                  <th style={thStyle}>{t('panel.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {aggregates.map(row => (
                  <tr key={row.subject}>
                    <td style={tdStyle}>{row.subject}</td>
                    <td style={tdStyle}>{row.tokens.toLocaleString()} · {row.calls}次</td>
                    <td style={tdStyle}>{row.amount.toFixed(4)} {row.currency}</td>
                  </tr>
                ))}
              </tbody>
            </table>}
      </section>
      <section>
        <h4 style={hStyle}>{t('panel.recent')}</h4>
        {rows.length === 0
          ? <p style={mutedStyle}>—</p>
          : <table style={tableStyle}>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={row.sessionId !== undefined ? `${row.sessionId}-${row.at}-${index}` : `${row.at}-${index}`}>
                    <td style={tdStyle}>{new Date(row.at).toLocaleTimeString()}</td>
                    <td style={tdStyle}>{row.subject}</td>
                    <td style={tdStyle}>{row.model}</td>
                    <td style={tdStyle}>{(row.usage.inputTokens + row.usage.outputTokens).toLocaleString()} tok</td>
                    <td style={tdStyle}>{row.unpriced ? <span style={mutedStyle}>{t('panel.unpriced')}</span> : `${row.estimatedAmount.toFixed(6)} ${row.currency}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>}
      </section>
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
