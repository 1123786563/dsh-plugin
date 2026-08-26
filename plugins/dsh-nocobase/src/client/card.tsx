/**
 * The NocoBase settings card: instance origin field plus a live health badge
 * fed by the Host's status route. Styling stays with inline tokens — the card
 * must render under any shell theme.
 *
 * @module dsh-nocobase/client/card
 */

import { useEffect, useState } from 'react'
import type { NocobaseCardState, NocobaseCardStore } from './form.ts'
import { dictionary } from './locales.ts'

/** One health answer from /plugins/dsh-nocobase/status. */
interface HealthAnswer {
  ok: boolean
  health?: { healthy: boolean, baseUrl: string, error?: string, checkedAt: number }
  error?: string
}

/** Minimal styling tokens (inline so no stylesheet dependency). */
const styles = {
  card: { display: 'flex', flexDirection: 'column', gap: 10, padding: 12 } as const,
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as const,
  label: { minWidth: 96, fontSize: 13, opacity: 0.85 } as const,
  input: {
    flex: 1, minWidth: 220, padding: '4px 8px', fontSize: 13,
    borderRadius: 4, border: '1px solid rgba(127,127,127,0.45)', background: 'transparent', color: 'inherit',
  } as const,
  badge: (ok: boolean) => ({
    fontSize: 12, padding: '2px 10px', borderRadius: 999,
    border: `1px solid ${ok ? 'rgba(82,196,26,0.6)' : 'rgba(245,108,108,0.6)'}`,
    color: ok ? '#73d13d' : '#ff7875',
  }),
  hint: { fontSize: 12, opacity: 0.65 } as const,
  button: {
    fontSize: 13, padding: '4px 12px', borderRadius: 4, cursor: 'pointer',
    border: '1px solid rgba(127,127,127,0.45)', background: 'transparent', color: 'inherit',
  } as const,
  primary: {
    fontSize: 13, padding: '4px 12px', borderRadius: 4, cursor: 'pointer',
    border: '1px solid rgba(64,128,255,0.6)', background: 'rgba(64,128,255,0.15)', color: 'inherit',
  } as const,
}

/**
 * The settings card component.
 * @param props - the card selector hook and form actions (bound by the slot).
 * @returns the card element tree.
 */
export function NocobaseSettingsCard(props: {
  useNocobaseSettingsCard: <T>(select: (state: NocobaseCardState) => T) => T
  edit: (field: 'baseUrl', text: string) => void
  resetField: (field: 'baseUrl') => void
  save: () => void
  discard: () => void
}) {
  const state = props.useNocobaseSettingsCard(selected => selected)
  const dict = dictionary()
  const [health, setHealth] = useState<HealthAnswer | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      fetch('/plugins/dsh-nocobase/status')
        .then(response => response.json() as Promise<HealthAnswer>)
        .then(answer => { if (!cancelled) setHealth(answer) })
        .catch(() => { if (!cancelled) setHealth({ ok: false, error: 'fetch-failed' }) })
    }
    load()
    return () => { cancelled = true }
  }, [state.fields.baseUrl.text])

  if (!state.exposed) return <div style={styles.hint}>{dict.notExposed}</div>
  if (!state.available) return null

  const healthy = health?.health?.healthy === true
  const baseUrl = state.fields.baseUrl.text

  return (
    <div style={styles.card}>
      <div>
        <strong>{dict.title}</strong>
        <div style={styles.hint}>{dict.description}</div>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>{dict.baseUrl}</span>
        <input
          style={styles.input}
          value={baseUrl}
          aria-invalid={state.fields.baseUrl.invalid}
          onChange={event => props.edit('baseUrl', event.target.value)}
        />
        {state.fields.baseUrl.overridden && !state.dirty
          ? <button style={styles.button} onClick={() => props.resetField('baseUrl')}>{dict.reset}</button>
          : null}
      </div>
      <div style={styles.hint}>{dict.baseUrlHint}</div>
      {state.fields.baseUrl.invalid
        ? <div style={{ ...styles.hint, color: '#ff7875' }}>URL must be an http(s) origin, e.g. http://127.0.0.1:13000</div>
        : null}
      <div style={styles.row}>
        <span style={styles.label}>{dict.healthOk}</span>
        <span style={styles.badge(healthy)}>
          {health === undefined ? dict.healthChecking : healthy ? dict.healthOk : dict.healthDown}
        </span>
        <button style={styles.button} onClick={() => {
          fetch('/plugins/dsh-nocobase/status')
            .then(response => response.json() as Promise<HealthAnswer>)
            .then(setHealth)
            .catch(() => setHealth({ ok: false, error: 'fetch-failed' }))
        }}>{dict.healthRefresh}</button>
        <a style={styles.primary} href={baseUrl || health?.health?.baseUrl || '#'} target="_blank" rel="noreferrer">{dict.open}</a>
      </div>
      {state.dirty || state.failed ? (
        <div style={styles.row}>
          <button style={styles.primary} disabled={state.invalid || state.saving} onClick={props.save}>
            {state.saving ? dict.saving : dict.save}
          </button>
          <button style={styles.button} disabled={state.saving} onClick={props.discard}>{dict.discard}</button>
          {state.failed ? <span style={{ ...styles.hint, color: '#ff7875' }}>{dict.saveFailed}{state.failedReason ? `: ${state.failedReason}` : ''}</span> : null}
          {!state.writable ? <span style={styles.hint}>{dict.readOnly}</span> : null}
        </div>
      ) : null}
    </div>
  )
}
