/**
 * The Plane sidebar panel: the configured workspace's projects and the
 * selected project's work items, served by the Host's read-only panel route
 * (the API key never reaches the browser). Polls every 30 s and on demand;
 * shows configuration banners instead of rows when the Host half is unset.
 *
 * @module dsh-plane/client/panel
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { dictionary, format } from './locales.ts'

/** Panel refresh interval. */
const POLL_MS = 30_000

/** Host panel-route payload (see src/routes.ts). */
interface PanelPayload {
  ok: boolean
  error?: string
  baseUrl?: string
  workspace?: string
  projects?: { id: string, name: string, identifier: string }[]
  projectId?: string
  issues?: PanelIssue[]
  totalCount?: number
  nextCursor?: string
  issueError?: string
}

/** One work-item row the panel renders. */
interface PanelIssue {
  id: string
  identifier: string
  name: string
  priority: string
  state: string
  assignees: string[]
  targetDate?: string
}

/**
  * Render the Plane panel tab.
  * @returns the panel.
  */
export function PlanePanelTab(): ReactNode {
  const dict = dictionary() as Record<string, string>
  const t = (key: string, params?: Record<string, string | number>): string => params === undefined ? dict[key] ?? key : format(dict[key] ?? key, params)
  const [payload, setPayload] = useState<PanelPayload | undefined>(undefined)
  const [issues, setIssues] = useState<PanelIssue[]>([])
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const selectedRef = useRef('')

  /** Fetch one panel page; append or replace the visible issues. */
  const load = useCallback(async (projectId: string, cursor: string | undefined, append: boolean): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try {
      const params = new URLSearchParams()
      if (projectId.length > 0) params.set('projectId', projectId)
      if (cursor !== undefined && cursor.length > 0) params.set('cursor', cursor)
      const query = params.size === 0 ? '' : '?' + params.toString()
      const response = await fetch('/plugins/dsh-plane/panel' + query, { headers: { accept: 'application/json' } })
      const data = JSON.parse(await response.text()) as PanelPayload
      setPayload(data)
      const rows = data.issues ?? []
      setIssues(previous => append ? [...previous, ...rows] : rows)
      const effective = data.projectId ?? ''
      if (effective !== selectedRef.current) {
        selectedRef.current = effective
        setSelected(effective)
      }
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load('', undefined, false)
    const timer = setInterval(() => { void load(selectedRef.current, undefined, false) }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [load])

  if (payload !== undefined && !payload.ok) {
    const banner = payload.error === 'no-workspace' ? t('panelNoWorkspace') : t('panelNotConfigured')
    return (
      <div style={paneStyle}>
        <p style={bannerStyle}>{banner}</p>
        {payload.baseUrl !== undefined && <p style={metaStyle}>{payload.baseUrl}</p>}
      </div>
    )
  }
  const projects = payload?.projects ?? []
  const nextCursor = payload?.nextCursor
  return (
    <div style={paneStyle}>
      <div style={toolbarStyle}>
        <select
          style={selectStyle}
          value={selected}
          disabled={projects.length === 0}
          onChange={event => {
            const id = event.target.value
            selectedRef.current = id
            setSelected(id)
            setIssues([])
            void load(id, undefined, false)
          }}
        >
          {projects.length === 0 && <option value="">{loading ? t('panelLoading') : t('panelProjects')}</option>}
          {projects.map(project => (
            <option key={project.id} value={project.id}>{project.identifier.length > 0 ? project.identifier + ' · ' : ''}{project.name}</option>
          ))}
        </select>
        <button type="button" style={iconButtonStyle} title={t('panelRefresh')} disabled={loading} onClick={() => { void load(selectedRef.current, undefined, false) }}>↻</button>
      </div>
      {payload?.workspace !== undefined && payload.workspace.length > 0 && (
        <p style={metaStyle}>{payload.workspace}{payload.totalCount !== undefined ? ' · ' + t('panelIssuesCount', { n: payload.totalCount }) : ''}</p>
      )}
      {error !== undefined && <p style={bannerStyle}>{t('panelError')}: {error} <button type="button" style={linkStyle} onClick={() => { void load(selectedRef.current, undefined, false) }}>{t('panelRetry')}</button></p>}
      {payload?.issueError !== undefined && <p style={bannerStyle}>{payload.issueError}</p>}
      {issues.length === 0 && !loading && error === undefined && payload?.issueError === undefined && (
        <p style={emptyStyle}>{t('panelEmpty')}</p>
      )}
      <div style={listStyle}>
        {issues.map(issue => (
          <div key={issue.id} style={rowStyle}>
            <div style={rowTitleStyle}>
              <span style={keyStyle}>{issue.identifier}</span>
              <span style={nameStyle}>{issue.name}</span>
            </div>
            <div style={rowMetaStyle}>
              <span style={stateStyle}>{issue.state}</span>
              <span style={priorityStyle(issue.priority)}>{issue.priority}</span>
              {issue.assignees.length > 0 && <span>{issue.assignees.join(', ')}</span>}
            </div>
          </div>
        ))}
        {loading && <p style={emptyStyle}>{t('panelLoading')}</p>}
      </div>
      {nextCursor !== undefined && nextCursor.length > 0 && (
        <button type="button" style={moreStyle} disabled={loading} onClick={() => { void load(selectedRef.current, nextCursor, true) }}>{t('panelMore')}</button>
      )}
    </div>
  )
}

/** Priority accent color for one Plane priority name. */
function priorityStyle(priority: string): CSSProperties {
  const accent = priority === 'urgent'
    ? 'var(--dsw-alias-danger, #d05050)'
    : priority === 'high'
      ? 'var(--dsw-alias-warning, #d09040)'
      : 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.9))'
  return { ...chipStyle, color: accent }
}

const paneStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, padding: 10, height: '100%', boxSizing: 'border-box', overflowY: 'auto' }
const toolbarStyle: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center' }
const selectStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '4px 8px',
  fontSize: 12,
  borderRadius: 7,
  border: '1px solid var(--dsw-alias-border, rgba(128, 128, 128, 0.32))',
  background: 'var(--dsw-alias-surface-0, transparent)',
  color: 'var(--dsw-alias-label-primary, inherit)',
}
const iconButtonStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '3px 8px',
  borderRadius: 7,
  fontSize: 13,
  border: '1px solid var(--dsw-alias-border, rgba(128, 128, 128, 0.32))',
  color: 'var(--dsw-alias-label-secondary, inherit)',
}
const moreStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  textAlign: 'center',
  padding: '5px 0',
  fontSize: 12,
  color: 'var(--dsw-alias-accent, #4c8bf5)',
}
const metaStyle: CSSProperties = { margin: 0, fontSize: 11, color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.9))' }
const bannerStyle: CSSProperties = { margin: 0, fontSize: 11.5, lineHeight: 1.5, padding: '6px 8px', borderRadius: 7, background: 'var(--dsw-alias-surface-2, rgba(128,128,128,0.12))', color: 'var(--dsw-alias-label-secondary, inherit)' }
const emptyStyle: CSSProperties = { ...metaStyle, padding: '8px 2px' }
const listStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }
const rowStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 3, padding: '7px 9px', borderRadius: 8, border: '1px solid var(--dsw-alias-border, rgba(128, 128, 128, 0.22))' }
const rowTitleStyle: CSSProperties = { display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 }
const keyStyle: CSSProperties = { flex: 'none', fontSize: 10.5, fontWeight: 600, color: 'var(--dsw-alias-accent, #4c8bf5)' }
const nameStyle: CSSProperties = { fontSize: 12, color: 'var(--dsw-alias-label-primary, inherit)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const rowMetaStyle: CSSProperties = { display: 'flex', gap: 6, fontSize: 10.5, color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.9))', flexWrap: 'wrap' }
const chipStyle: CSSProperties = { padding: '0 5px', borderRadius: 5, background: 'var(--dsw-alias-surface-2, rgba(128,128,128,0.14))' }
const stateStyle: CSSProperties = chipStyle
const linkStyle: CSSProperties = { all: 'unset', cursor: 'pointer', color: 'var(--dsw-alias-accent, #4c8bf5)' }