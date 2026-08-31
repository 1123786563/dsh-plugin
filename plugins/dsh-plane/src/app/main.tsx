/**
 * The standalone board page served at /plugins/dsh-plane/app: projects, a
 * list/board view over work items, and a detail drawer with comments — all
 * through the keyless same-origin ui surface. Bundled separately from the
 * settings-card half: this page ships its own React and never touches the
 * host module loader.
 *
 * @module dsh-plane/app
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

/** Base of the engine's same-origin surface. */
const UI = '/plugins/dsh-plane/ui/v1'

/** Plane's priority vocabulary, board order. */
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const

/** One project row. */
interface Project {
  id: string
  name: string
  identifier: string
}

/** One workflow state. */
interface State {
  id: string
  name: string
  group: string
  color: string
}

/** One work item row. */
interface Item {
  id: string
  name: string
  identifier: string
  sequence_id: number
  priority: string
  state: string
  description_html: string
  description_stripped: string
  start_date: string | null
  target_date: string | null
  is_draft: boolean
  created_at: string
}

/** One comment row. */
interface CommentRow {
  id: string
  comment_stripped: string
  comment_html: string
  created_at: string
}

/** Cursor envelope every list endpoint returns. */
interface Envelope<T> {
  results: T[]
  total_count: number
  next_cursor: string | null
}

/**
 * Issue one JSON call against the ui surface.
 * @param path - path below /plugins/dsh-plane/ui/v1.
 * @param method - HTTP verb.
 * @param body - decoded JSON body.
 * @returns the decoded response.
 */
async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(UI + path, {
    method,
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  const data = text.trim().length === 0 ? null : JSON.parse(text) as unknown
  if (!response.ok) {
    const detail = typeof data === 'object' && data !== null && 'error' in data ? String((data as Record<string, unknown>).error) : text.slice(0, 200)
    throw new Error('HTTP ' + response.status + ': ' + detail)
  }
  return data as T
}

/** The board page. */
function Board(): ReactNode {
  const [workspace, setWorkspace] = useState('')
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [states, setStates] = useState<State[]>([])
  const [items, setItems] = useState<Item[]>([])
  const [view, setView] = useState<'board' | 'list'>('board')
  const [openId, setOpenId] = useState('')
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  /** Load the resolved workspace and its projects once. */
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/plugins/dsh-plane/state', { headers: { accept: 'application/json' } })
        const data = JSON.parse(await response.text()) as { workspace?: string }
        const slug = (data.workspace ?? '').trim()
        setWorkspace(slug.length > 0 ? slug : 'dsh')
      } catch {
        setWorkspace('dsh')
      }
    })()
  }, [])

  /** Reload projects when the workspace resolves. */
  useEffect(() => {
    if (workspace.length === 0) return
    void (async () => {
      try {
        const envelope = await call<Envelope<Project>>('/workspaces/' + encodeURIComponent(workspace) + '/projects/?per_page=100')
        setProjects(envelope.results)
        setProjectId(previous => previous.length > 0 ? previous : (envelope.results[0]?.id ?? ''))
      } catch (loadError) {
        setError(describe(loadError))
      }
    })()
  }, [workspace])

  /** Reload states and all work-item pages when the project changes. */
  const reload = useCallback(async (): Promise<void> => {
    if (workspace.length === 0 || projectId.length === 0) return
    setLoading(true)
    setError('')
    try {
      const base = '/workspaces/' + encodeURIComponent(workspace) + '/projects/' + encodeURIComponent(projectId)
      const stateEnvelope = await call<Envelope<State>>(base + '/states/?per_page=100')
      setStates(stateEnvelope.results)
      const collected: Item[] = []
      let cursor: string | null = null
      for (let page = 0; page < 20; page += 1) {
        const suffix = cursor === null ? '' : '&cursor=' + encodeURIComponent(cursor)
        const envelope: Envelope<Item> = await call<Envelope<Item>>(base + '/work-items/?per_page=100&order_by=-created_at' + suffix)
        collected.push(...envelope.results)
        cursor = envelope.next_cursor
        if (cursor === null) break
      }
      setItems(collected)
    } catch (loadError) {
      setError(describe(loadError))
    } finally {
      setLoading(false)
    }
  }, [workspace, projectId])

  useEffect(() => { void reload() }, [reload])

  const stateName = useCallback((id: string): string => states.find(state => state.id === id)?.name ?? id, [states])

  /** Create one work item from the composer. */
  const createItem = useCallback(async (): Promise<void> => {
    const name = draft.trim()
    if (name.length === 0 || projectId.length === 0) return
    try {
      await call('/workspaces/' + encodeURIComponent(workspace) + '/projects/' + encodeURIComponent(projectId) + '/work-items/', 'POST', { name })
      setDraft('')
      await reload()
    } catch (createError) {
      setError(describe(createError))
    }
  }, [draft, projectId, reload, workspace])

  const boardColumns = useMemo(() => {
    return states.map(state => ({ state, cards: items.filter(item => item.state === state.id) }))
  }, [items, states])

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <strong style={brandStyle}>Plane</strong>
        <select style={selectStyle} value={projectId} onChange={event => { setProjectId(event.target.value); setOpenId('') }}>
          {projects.map(project => (
            <option key={project.id} value={project.id}>{project.identifier} · {project.name}</option>
          ))}
        </select>
        <div style={segStyle}>
          <button type="button" style={view === 'board' ? segActiveStyle : segStyleItem} onClick={() => { setView('board') }}>Board</button>
          <button type="button" style={view === 'list' ? segActiveStyle : segStyleItem} onClick={() => { setView('list') }}>List</button>
        </div>
        <div style={composerStyle}>
          <input
            style={composerInputStyle}
            placeholder="New work item…"
            value={draft}
            onChange={event => { setDraft(event.target.value) }}
            onKeyDown={event => { if (event.key === 'Enter') void createItem() }}
          />
          <button type="button" style={primaryButtonStyle} disabled={draft.trim().length === 0} onClick={() => { void createItem() }}>Create</button>
        </div>
        <button type="button" style={buttonStyle} disabled={loading} onClick={() => { void reload() }}>↻</button>
      </header>
      {error.length > 0 && <p style={bannerStyle}>{error}</p>}
      {loading && <p style={metaStyle}>Loading…</p>}
      {!loading && items.length === 0 && <p style={metaStyle}>No work items yet — create the first one above.</p>}
      {view === 'board' && (
        <div style={columnsStyle}>
          {boardColumns.map(({ state, cards }) => (
            <div key={state.id} style={columnStyle}>
              <div style={columnHeaderStyle}>
                <span style={dotStyle(state.color)} />
                <span>{state.name}</span>
                <span style={countStyle}>{cards.length}</span>
              </div>
              {cards.map(card => <Card key={card.id} item={card} onOpen={() => { setOpenId(card.id) }} />)}
            </div>
          ))}
        </div>
      )}
      {view === 'list' && (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Key</th>
              <th style={thStyle}>Title</th>
              <th style={thStyle}>State</th>
              <th style={thStyle}>Priority</th>
              <th style={thStyle}>Target</th>
            </tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id} style={trStyle} onClick={() => { setOpenId(item.id) }}>
                <td style={keyCellStyle}>{item.identifier}</td>
                <td style={nameCellStyle}>{item.name}</td>
                <td style={tdStyle}>{stateName(item.state)}</td>
                <td style={tdStyle}>{item.priority}</td>
                <td style={tdStyle}>{item.target_date ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {openId.length > 0 && (
        <Drawer
          workspace={workspace}
          projectId={projectId}
          itemId={openId}
          states={states}
          onClose={() => { setOpenId('') }}
          onChanged={() => { void reload() }}
        />
      )}
    </div>
  )
}

/** One board card. */
function Card(props: { item: Item, onOpen: () => void }): ReactNode {
  const accent = props.item.priority === 'urgent'
    ? 'var(--dsw-alias-danger, #d05050)'
    : props.item.priority === 'high'
      ? 'var(--dsw-alias-warning, #d09040)'
      : 'transparent'
  return (
    <button type="button" style={{ ...cardStyle, borderLeftColor: accent }} onClick={props.onOpen}>
      <span style={cardKeyStyle}>{props.item.identifier}</span>
      <span style={cardNameStyle}>{props.item.name}</span>
    </button>
  )
}

/** The detail drawer: edit fields, comments, delete. */
function Drawer(props: {
  workspace: string
  projectId: string
  itemId: string
  states: State[]
  onClose: () => void
  onChanged: () => void
}): ReactNode {
  const { workspace, projectId, itemId, states, onClose, onChanged } = props
  const base = '/workspaces/' + encodeURIComponent(workspace) + '/projects/' + encodeURIComponent(projectId) + '/work-items/' + encodeURIComponent(itemId)
  const [item, setItem] = useState<Item | undefined>(undefined)
  const [comments, setComments] = useState<CommentRow[]>([])
  const [commentDraft, setCommentDraft] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const reload = useCallback(async (): Promise<void> => {
    try {
      const detail = await call<Item>(base + '/')
      setItem(detail)
      setNameDraft(detail.name)
      const envelope = await call<Envelope<CommentRow>>(base + '/comments/?per_page=100')
      setComments(envelope.results)
    } catch (loadError) {
      setError(describe(loadError))
    }
  }, [base])

  useEffect(() => { void reload() }, [reload])

  /** PATCH the item and refresh. */
  const patch = useCallback(async (body: Record<string, unknown>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await call(base + '/', 'PATCH', body)
      await reload()
      onChanged()
    } catch (patchError) {
      setError(describe(patchError))
    } finally {
      setBusy(false)
    }
  }, [base, busy, onChanged, reload])

  /** Post one comment. */
  const addComment = useCallback(async (): Promise<void> => {
    const text = commentDraft.trim()
    if (text.length === 0 || busy) return
    setBusy(true)
    try {
      await call(base + '/comments/', 'POST', { comment_html: '<p>' + escapeHtml(text) + '</p>' })
      setCommentDraft('')
      await reload()
    } catch (commentError) {
      setError(describe(commentError))
    } finally {
      setBusy(false)
    }
  }, [base, busy, commentDraft, reload])

  /** Delete the item, then close the drawer. */
  const remove = useCallback(async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await call(base + '/', 'DELETE')
      onChanged()
      onClose()
    } catch (deleteError) {
      setError(describe(deleteError))
      setBusy(false)
    }
  }, [base, busy, onChanged, onClose])

  if (item === undefined) {
    return (
      <aside style={drawerStyle}>
        <button type="button" style={closeStyle} onClick={onClose}>✕</button>
        <p style={metaStyle}>{error.length > 0 ? error : 'Loading…'}</p>
      </aside>
    )
  }
  return (
    <aside style={drawerStyle}>
      <button type="button" style={closeStyle} onClick={onClose}>✕</button>
      <p style={keyHeadingStyle}>{item.identifier}</p>
      <input style={titleInputStyle} value={nameDraft} disabled={busy} onChange={event => { setNameDraft(event.target.value) }} onBlur={() => { if (nameDraft.trim() !== item.name) void patch({ name: nameDraft.trim() }) }} />
      <div style={fieldRowStyle}>
        <label style={labelStyle}>State</label>
        <select style={selectStyle} value={item.state} disabled={busy} onChange={event => { void patch({ state: event.target.value }) }}>
          {states.map(state => <option key={state.id} value={state.id}>{state.name}</option>)}
        </select>
        <label style={labelStyle}>Priority</label>
        <select style={selectStyle} value={item.priority} disabled={busy} onChange={event => { void patch({ priority: event.target.value }) }}>
          {PRIORITIES.map(priority => <option key={priority} value={priority}>{priority}</option>)}
        </select>
      </div>
      <div style={fieldRowStyle}>
        <label style={labelStyle}>Target date</label>
        <input
          style={dateInputStyle}
          type="date"
          value={item.target_date ?? ''}
          disabled={busy}
          onChange={event => { void patch({ target_date: event.target.value === '' ? null : event.target.value }) }}
        />
      </div>
      <p style={labelStyle}>Description</p>
      <p style={descriptionStyle}>{item.description_stripped.length > 0 ? item.description_stripped : '(no description)'}</p>
      <p style={labelStyle}>Comments ({comments.length})</p>
      <div style={commentsStyle}>
        {comments.map(comment => (
          <div key={comment.id} style={commentStyle}>
            <span style={commentDateStyle}>{comment.created_at.slice(0, 16).replace('T', ' ')}</span>
            <span>{comment.comment_stripped}</span>
          </div>
        ))}
        {comments.length === 0 && <p style={metaStyle}>No comments yet.</p>}
      </div>
      <div style={commentComposerStyle}>
        <input
          style={composerInputStyle}
          placeholder="Add a comment…"
          value={commentDraft}
          disabled={busy}
          onChange={event => { setCommentDraft(event.target.value) }}
          onKeyDown={event => { if (event.key === 'Enter') void addComment() }}
        />
        <button type="button" style={primaryButtonStyle} disabled={busy || commentDraft.trim().length === 0} onClick={() => { void addComment() }}>Post</button>
      </div>
      {error.length > 0 && <p style={bannerStyle}>{error}</p>}
      <button type="button" style={dangerButtonStyle} disabled={busy} onClick={() => { void remove() }}>Delete work item</button>
    </aside>
  )
}

/**
 * Escape user text before wrapping it in an HTML snippet.
 * @param text - the raw text.
 * @returns the escaped text.
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Describe one thrown error.
 * @param error - the thrown value.
 * @returns the message.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const pageStyle: CSSProperties = { minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--dsw-alias-surface-0, #f7f7f8)', color: 'var(--dsw-alias-label-primary, #1a1a1a)', fontFamily: 'system-ui, -apple-system, sans-serif' }
const headerStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.25))', flexWrap: 'wrap' }
const brandStyle: CSSProperties = { fontSize: 14, letterSpacing: 0.4 }
const selectStyle: CSSProperties = { padding: '5px 9px', fontSize: 12.5, borderRadius: 7, border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.32))', background: 'var(--dsw-alias-surface-1, #fff)', color: 'inherit' }
const segStyle: CSSProperties = { display: 'flex', border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.32))', borderRadius: 7, overflow: 'hidden' }
const segStyleItem: CSSProperties = { all: 'unset', cursor: 'pointer', padding: '5px 10px', fontSize: 12 }
const segActiveStyle: CSSProperties = { all: 'unset', cursor: 'pointer', padding: '5px 10px', fontSize: 12, background: 'var(--dsw-alias-accent, #4c8bf5)', color: '#fff' }
const composerStyle: CSSProperties = { display: 'flex', gap: 6, flex: 1, minWidth: 220 }
const composerInputStyle: CSSProperties = { flex: 1, minWidth: 0, padding: '5px 9px', fontSize: 12.5, borderRadius: 7, border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.32))', background: 'var(--dsw-alias-surface-1, #fff)', color: 'inherit' }
const buttonStyle: CSSProperties = { all: 'unset', cursor: 'pointer', padding: '5px 11px', fontSize: 12, borderRadius: 7, border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.32))' }
const primaryButtonStyle: CSSProperties = { all: 'unset', cursor: 'pointer', padding: '5px 11px', fontSize: 12, borderRadius: 7, background: 'var(--dsw-alias-accent, #4c8bf5)', color: '#fff' }
const dangerButtonStyle: CSSProperties = { all: 'unset', cursor: 'pointer', padding: '5px 11px', fontSize: 12, borderRadius: 7, border: '1px solid var(--dsw-alias-danger, #d05050)', color: 'var(--dsw-alias-danger, #d05050)', marginTop: 10 }
const columnsStyle: CSSProperties = { display: 'flex', gap: 10, padding: 14, overflowX: 'auto', alignItems: 'flex-start', flex: 1 }
const columnStyle: CSSProperties = { flex: '0 0 250px', display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--dsw-alias-surface-1, #fff)', border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.2))', borderRadius: 10, padding: 10, maxHeight: 'calc(100vh - 120px)', overflowY: 'auto' }
const columnHeaderStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600 }
const countStyle: CSSProperties = { fontSize: 10.5, opacity: 0.6 }
const cardStyle: CSSProperties = { all: 'unset', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 3, padding: '8px 9px', borderRadius: 8, border: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.25))', borderLeft: '3px solid transparent', background: 'var(--dsw-alias-surface-0, transparent)' }
const cardKeyStyle: CSSProperties = { fontSize: 10.5, fontWeight: 600, color: 'var(--dsw-alias-accent, #4c8bf5)' }
const cardNameStyle: CSSProperties = { fontSize: 12, lineHeight: 1.4 }
const tableStyle: CSSProperties = { width: 'calc(100% - 28px)', margin: 14, borderCollapse: 'collapse', fontSize: 12.5, background: 'var(--dsw-alias-surface-1, #fff)', borderRadius: 10 }
const thStyle: CSSProperties = { textAlign: 'left', padding: '7px 10px', borderBottom: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.25))', fontSize: 11, opacity: 0.7 }
const tdStyle: CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.15))' }
const trStyle: CSSProperties = { cursor: 'pointer' }
const keyCellStyle: CSSProperties = { ...tdStyle, fontWeight: 600, color: 'var(--dsw-alias-accent, #4c8bf5)', whiteSpace: 'nowrap' }
const nameCellStyle: CSSProperties = { ...tdStyle }
const drawerStyle: CSSProperties = { position: 'fixed', top: 0, right: 0, bottom: 0, width: 380, maxWidth: '92vw', boxSizing: 'border-box', padding: 16, display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto', background: 'var(--dsw-alias-surface-1, #fff)', borderLeft: '1px solid var(--dsw-alias-border, rgba(128,128,128,0.28))', boxShadow: '-8px 0 24px rgba(0,0,0,0.08)', zIndex: 40 }
const closeStyle: CSSProperties = { all: 'unset', cursor: 'pointer', alignSelf: 'flex-end', fontSize: 13, opacity: 0.6 }
const keyHeadingStyle: CSSProperties = { margin: 0, fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-accent, #4c8bf5)' }
const titleInputStyle: CSSProperties = { ...composerInputStyle, fontSize: 14, fontWeight: 600 }
const fieldRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
const labelStyle: CSSProperties = { fontSize: 11, fontWeight: 500, opacity: 0.7 }
const dateInputStyle: CSSProperties = { ...composerInputStyle, width: 150 }
const descriptionStyle: CSSProperties = { margin: 0, fontSize: 12.5, lineHeight: 1.5, whiteSpace: 'pre-wrap' }
const commentsStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, maxHeight: '30vh', overflowY: 'auto' }
const commentStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 8px', borderRadius: 8, background: 'var(--dsw-alias-surface-2, rgba(128,128,128,0.1))', fontSize: 12 }
const commentDateStyle: CSSProperties = { fontSize: 10, opacity: 0.6 }
const commentComposerStyle: CSSProperties = { display: 'flex', gap: 6 }
const bannerStyle: CSSProperties = { margin: '0 16px', fontSize: 12, color: 'var(--dsw-alias-danger, #d05050)' }
const metaStyle: CSSProperties = { margin: '0 16px', fontSize: 12, opacity: 0.7 }

/**
 * One state-group dot's color.
 * @param color - the state color.
 * @returns the dot style.
 */
function dotStyle(color: string): CSSProperties {
  return { width: 8, height: 8, borderRadius: 999, background: color.length > 0 ? color : 'rgba(128,128,128,0.5)', display: 'inline-block' }
}

const container = document.getElementById('root')
if (container === null) throw new Error('dsh-plane app: #root missing')
createRoot(container).render(<Board />)
