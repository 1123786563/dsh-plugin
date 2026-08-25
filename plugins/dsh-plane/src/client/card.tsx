/**
 * The plane settings card: one staged form over the plane settings namespace
 * the Host half registers. Owns its chrome (the official card chrome cannot
 * be imported across the client bundle-purity gate) and its staging (the
 * controller in form.ts).
 *
 * @module dsh-plane/client/card
 */

import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { PlaneCardState, PlaneField, PlaneFieldState } from './form.ts'
import { dictionary, format } from './locales.ts'

/** Copy reader: unknown keys fall back to the key itself (never crashes a render). */
type T = (key: string, params?: Record<string, string | number>) => string

/** Props the slot renderer binds: the locale seat and the injected face. */
export interface PlaneSettingsCardProps {
  t?: T
  usePlaneSettingsCard?: <T>(select: (state: PlaneCardState) => T) => T
  edit?: (field: PlaneField, text: string) => void
  resetField?: (field: PlaneField) => void
  save?: () => void
  discard?: () => void
}

/** Compose the copy reader: the renderer seat when present, the fallback otherwise. */
function reader(props: PlaneSettingsCardProps): T {
  const dict = dictionary() as Record<string, string>
  const seated = props.t
  return (key, params) => {
    const raw = seated !== undefined ? seated(key, params) : dict[key] ?? key
    return params === undefined ? raw : format(raw, params)
  }
}

/**
 * Render the plane settings card.
 * @param props - the locale seat and the card's injected snapshot and actions.
 * @returns the card, or null while the namespace is still loading.
 */
export function PlaneSettingsCard(props: PlaneSettingsCardProps): ReactNode {
  const t = reader(props)
  const state = props.usePlaneSettingsCard !== undefined ? props.usePlaneSettingsCard(snapshot => snapshot) : undefined
  const [open, setOpen] = useState(true)
  if (state === undefined || !state.available) return null
  if (!state.exposed) {
    return <p style={hintStyle}>{t('notExposed')}</p>
  }
  const disabled = !state.writable || state.saving
  const fieldProps = { t, disabled }
  return (
    <section style={cardStyle}>
      <button type="button" style={headerStyle} onClick={() => { setOpen(!open) }}>
        <span style={chevronStyle}>{open ? '▾' : '▸'}</span>
        <span style={titleStyle}>{t('title')}</span>
        {state.dirty && <span style={dirtyBadgeStyle}>•</span>}
      </button>
      {open && (
        <div style={bodyStyle}>
          <p style={hintStyle}>{t('description')}</p>
          {!state.writable && <p style={warnStyle}>{t('readOnly')}</p>}
          {state.failed && (
            <p style={warnStyle}>{t('saveFailed')}{state.failedReason === undefined ? '' : ': ' + state.failedReason}</p>
          )}
          <TextField {...fieldProps} id="plane-base-url" field="baseUrl" state={state.fields.baseUrl} onEdit={props.edit} onReset={props.resetField} />
          <TextField {...fieldProps} id="plane-api-key" field="apiKey" state={state.fields.apiKey} secret onEdit={props.edit} onReset={props.resetField} />
          <TextField {...fieldProps} id="plane-workspace" field="workspaceSlug" state={state.fields.workspaceSlug} onEdit={props.edit} onReset={props.resetField} />
          <TextField {...fieldProps} id="plane-project" field="defaultProjectId" state={state.fields.defaultProjectId} onEdit={props.edit} onReset={props.resetField} />
          <TextField {...fieldProps} id="plane-per-page" field="perPage" state={state.fields.perPage} numeric onEdit={props.edit} onReset={props.resetField} />
          <div style={footerStyle}>
            <button type="button" style={buttonStyle} disabled={!state.dirty || disabled} onClick={() => { props.discard?.() }}>{t('discard')}</button>
            <button type="button" style={primaryButtonStyle} disabled={!state.dirty || state.invalid || disabled} onClick={() => { props.save?.() }}>{state.saving ? t('saving') : t('save')}</button>
          </div>
        </div>
      )}
    </section>
  )
}

/** One labeled text field with an override badge and reset. */
function TextField(props: {
  t: T
  id: string
  field: PlaneField
  state: PlaneFieldState
  secret?: boolean
  numeric?: boolean
  disabled: boolean
  onEdit?: ((field: PlaneField, text: string) => void) | undefined
  onReset?: ((field: PlaneField) => void) | undefined
}) {
  const { t, state } = props
  return (
    <div style={fieldStyle}>
      <div style={labelRowStyle}>
        <label style={labelStyle} htmlFor={props.id}>{t(props.field)}</label>
        {state.overridden && (
          <>
            <span style={badgeStyle}>{t('overridden')}</span>
            <button type="button" style={resetStyle} disabled={props.disabled} onClick={() => { props.onReset?.(props.field) }}>{t('reset')}</button>
          </>
        )}
      </div>
      <input
        id={props.id}
        style={state.invalid ? invalidInputStyle : inputStyle}
        type={props.secret === true ? 'password' : 'text'}
        inputMode={props.numeric === true ? 'numeric' : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={props.disabled}
        value={state.text}
        placeholder={props.secret === true ? '••••••••' : ''}
        onChange={event => { props.onEdit?.(props.field, event.target.value) }}
      />
      {state.invalid && <p style={invalidHintStyle}>{t('invalidNumber')}</p>}
      <p style={hintStyle}>{t(props.field + 'Hint')}</p>
    </div>
  )
}

const cardStyle: CSSProperties = {
  border: '1px solid var(--dsw-alias-border, rgba(128, 128, 128, 0.28))',
  borderRadius: 10,
  background: 'var(--dsw-alias-surface-1, transparent)',
  marginBottom: 12,
  overflow: 'hidden',
}
const headerStyle: CSSProperties = {
  all: 'unset',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  boxSizing: 'border-box',
  padding: '10px 14px',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--dsw-alias-label-primary, inherit)',
}
const chevronStyle: CSSProperties = { fontSize: 11, opacity: 0.7 }
const titleStyle: CSSProperties = { flex: 1, minWidth: 0 }
const dirtyBadgeStyle: CSSProperties = { color: 'var(--dsw-alias-accent, #4c8bf5)' }
const bodyStyle: CSSProperties = { padding: '2px 14px 12px', display: 'flex', flexDirection: 'column', gap: 10 }
const hintStyle: CSSProperties = { margin: 0, fontSize: 11.5, lineHeight: 1.5, color: 'var(--dsw-alias-label-tertiary, rgba(128,128,128,0.9))' }
const warnStyle: CSSProperties = { margin: 0, fontSize: 11.5, lineHeight: 1.5, color: 'var(--dsw-alias-danger, #d05050)' }
const fieldStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 }
const labelRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }
const labelStyle: CSSProperties = { fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-label-secondary, inherit)' }
const badgeStyle: CSSProperties = { fontSize: 10, padding: '1px 6px', borderRadius: 999, background: 'var(--dsw-alias-surface-2, rgba(128,128,128,0.15))', color: 'var(--dsw-alias-label-tertiary, inherit)' }
const inputBase: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 10px',
  fontSize: 12.5,
  borderRadius: 7,
  border: '1px solid var(--dsw-alias-border, rgba(128, 128, 128, 0.32))',
  background: 'var(--dsw-alias-surface-0, transparent)',
  color: 'var(--dsw-alias-label-primary, inherit)',
}
const inputStyle: CSSProperties = inputBase
const invalidInputStyle: CSSProperties = { ...inputBase, borderColor: 'var(--dsw-alias-danger, #d05050)' }
const invalidHintStyle: CSSProperties = { ...hintStyle, color: 'var(--dsw-alias-danger, #d05050)' }
const resetStyle: CSSProperties = { all: 'unset', cursor: 'pointer', fontSize: 11, color: 'var(--dsw-alias-accent, #4c8bf5)' }
const footerStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8 }
const buttonStyle: CSSProperties = {
  all: 'unset',
  cursor: 'pointer',
  padding: '5px 12px',
  borderRadius: 7,
  fontSize: 12,
  border: '1px solid var(--dsw-alias-border, rgba(128, 128, 128, 0.32))',
  color: 'var(--dsw-alias-label-secondary, inherit)',
}
const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: 'var(--dsw-alias-accent, #4c8bf5)',
  borderColor: 'transparent',
  color: '#fff',
}
