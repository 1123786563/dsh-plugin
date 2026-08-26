/**
 * The NocoBase sidebar tab: a health badge plus an "open NocoBase" link, fed
 * by the Host's status route (no NocoBase APIs are called from the dsh origin).
 *
 * @module dsh-nocobase/client/panel
 */

import { useEffect, useState } from 'react'
import { dictionary } from './locales.ts'

/** One health answer from /plugins/dsh-nocobase/status. */
interface HealthAnswer {
  ok: boolean
  health?: { healthy: boolean, baseUrl: string, error?: string, checkedAt: number }
  error?: string
}

/** Panel styling tokens. */
const styles = {
  box: { display: 'flex', flexDirection: 'column', gap: 10, padding: 12 } as const,
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } as const,
  badge: (ok: boolean) => ({
    fontSize: 12, padding: '2px 10px', borderRadius: 999,
    border: `1px solid ${ok ? 'rgba(82,196,26,0.6)' : 'rgba(245,108,108,0.6)'}`,
    color: ok ? '#73d13d' : '#ff7875',
  }),
  link: {
    fontSize: 13, padding: '6px 14px', borderRadius: 4, cursor: 'pointer', textDecoration: 'none',
    border: '1px solid rgba(64,128,255,0.6)', background: 'rgba(64,128,255,0.15)', color: 'inherit',
  } as const,
  hint: { fontSize: 12, opacity: 0.65 } as const,
}

/**
 * The sidebar tab component.
 * @returns the panel element tree.
 */
export function NocobasePanelTab() {
  const dict = dictionary()
  const [health, setHealth] = useState<HealthAnswer | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    fetch('/plugins/dsh-nocobase/status')
      .then(response => response.json() as Promise<HealthAnswer>)
      .then(answer => { if (!cancelled) setHealth(answer) })
      .catch(() => { if (!cancelled) setHealth({ ok: false, error: 'fetch-failed' }) })
    return () => { cancelled = true }
  }, [])

  const healthy = health?.health?.healthy === true
  const baseUrl = health?.health?.baseUrl

  return (
    <div style={styles.box}>
      <div style={styles.row}>
        <span style={styles.badge(healthy)}>
          {health === undefined ? dict.healthChecking : healthy ? dict.healthOk : dict.healthDown}
        </span>
        {baseUrl ? <a style={styles.link} href={baseUrl} target="_blank" rel="noreferrer">{dict.open}</a> : null}
      </div>
      <div style={styles.hint}>{dict.panelHint}</div>
    </div>
  )
}
