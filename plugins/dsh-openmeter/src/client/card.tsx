/**
 * The openmeter settings card: one staged form over the openmeter settings
 * namespace the Host half registers. Owns its chrome (bundle-purity gate).
 *
 * @module dsh-openmeter/client/card
 */

import { useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { AnyField, CardState } from './form.ts'
import { dictionary, format } from './locales.ts'

/** Copy reader. */
type T = (key: string, params?: Record<string, string | number>) => string

/** Props the slot renderer binds. */
export interface OpenMeterSettingsCardProps {
  t?: T
  useOpenMeterSettingsCard?: <T>(select: (state: CardState) => T) => T
  edit?: (field: AnyField, value: string | boolean) => void
  resetField?: (field: AnyField) => void
  save?: () => void
  discard?: () => void
}

/**
 * Render the openmeter settings card.
 * @param props - the locale seat and the card's injected snapshot and actions.
 * @returns the card, or null while the namespace is still loading.
 */
export function OpenMeterSettingsCard(props: OpenMeterSettingsCardProps): ReactNode {
  const t = (key: string, params?: Record<string, string | number>): string => {
    const dict = dictionary() as Record<string, string>
    const seated = props.t
    const raw = seated !== undefined ? seated(key, params) : dict[key] ?? key
    return params === undefined ? raw : format(raw, params)
  }
  const state = props.useOpenMeterSettingsCard !== undefined ? props.useOpenMeterSettingsCard(snapshot => snapshot) : undefined
  const [open, setOpen] = useState(true)
  if (state === undefined || !state.available) return null
  const disabled = !state.writable || state.saving
  const textFields = Object.entries(state.textFields) as Array<[string, CardState['textFields'][keyof CardState['textFields']]]>
  const numberFields = Object.entries(state.numberFields) as Array<[string, CardState['numberFields'][keyof CardState['numberFields']]]>
  return (
    <section style={cardStyle}>
      <button type="button" style={headerStyle} onClick={() => { setOpen(!open) }}>
        <span style={chevronStyle}>{open ? '▾' : '▸'}</span>
        <span style={titleStyle}>{t('card.title')}</span>
        {state.dirty && <span style={dirtyBadgeStyle}>•</span>}
      </button>
      {open && (
        <div style={bodyStyle}>
          <p style={hintStyle}>{t('card.description')}</p>
          {!state.writable && <p style={warnStyle}>{t('card.readOnly')}</p>}
          {state.failed && (
            <p style={warnStyle}>{t('card.saveFailed')}{state.failedReason === undefined ? '' : ': ' + state.failedReason}</p>
          )}
          {textFields.map(([field, fieldState]) => (
            <Row
              key={field}
              label={t(`field.${field}`)}
              value={fieldState.text}
              overridden={fieldState.overridden}
              disabled={disabled}
              secret={field === 'token'}
              onChange={text => { props.edit?.(field as AnyField, text) }}
              onReset={() => { props.resetField?.(field as AnyField) }}
            />
          ))}
          {numberFields.map(([field, fieldState]) => (
            <Row
              key={field}
              label={t(`field.${field}`)}
              value={fieldState.text}
              overridden={fieldState.overridden}
              invalid={fieldState.invalid}
              disabled={disabled}
              onChange={text => { props.edit?.(field as AnyField, text) }}
              onReset={() => { props.resetField?.(field as AnyField) }}
            />
          ))}
          <label style={rowStyle}>
            <input
              type="checkbox"
              checked={state.blockEnabled.value}
              disabled={disabled}
              onChange={event => { props.edit?.('blockEnabled', event.target.checked) }}
            />
            <span>{t('field.blockEnabled')}</span>
            {state.blockEnabled.overridden && (
              <button type="button" style={resetStyle} disabled={disabled} onClick={() => { props.resetField?.('blockEnabled') }}>↺</button>
            )}
          </label>
          <div style={footerStyle}>
            <button type="button" style={buttonStyle} disabled={!state.dirty || disabled} onClick={() => { props.discard?.() }}>{t('card.discard')}</button>
            <button type="button" style={primaryButtonStyle} disabled={!state.dirty || state.invalid || disabled} onClick={() => { props.save?.() }}>{state.saving ? t('card.saving') : t('card.save')}</button>
          </div>
        </div>
      )}
    </section>
  )
}

/** One text/number row. */
function Row(props: {
  label: string
  value: string
  overridden: boolean
  invalid?: boolean
  disabled: boolean
  secret?: boolean
  onChange: (text: string) => void
  onReset: () => void
}): ReactNode {
  return (
    <label style={rowStyle}>
      <span style={labelStyle}>{props.label}</span>
      <input
        style={{ ...inputStyle, ...(props.invalid === true ? invalidStyle : {}) }}
        type={props.secret === true ? 'password' : 'text'}
        value={props.value}
        disabled={props.disabled}
        onChange={event => { props.onChange(event.target.value) }}
      />
      {props.overridden && (
        <button type="button" style={resetStyle} disabled={props.disabled} onClick={props.onReset}>↺</button>
      )}
    </label>
  )
}

const cardStyle: CSSProperties = { border: '1px solid rgba(127,127,127,.25)', borderRadius: 8, padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 6 }
const headerStyle: CSSProperties = { all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }
const chevronStyle: CSSProperties = { width: 12 }
const titleStyle: CSSProperties = { fontWeight: 600 }
const dirtyBadgeStyle: CSSProperties = { color: '#d2482d' }
const bodyStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }
const hintStyle: CSSProperties = { margin: 0, opacity: 0.7, fontSize: 12 }
const warnStyle: CSSProperties = { margin: 0, color: '#d2482d', fontSize: 12 }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 }
const labelStyle: CSSProperties = { minWidth: 150, fontSize: 12 }
const inputStyle: CSSProperties = { flex: 1, padding: '2px 6px', border: '1px solid rgba(127,127,127,.35)', borderRadius: 6, background: 'transparent', fontSize: 12 }
const invalidStyle: CSSProperties = { borderColor: '#d2482d' }
const resetStyle: CSSProperties = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12 }
const footerStyle: CSSProperties = { display: 'flex', gap: 6, justifyContent: 'flex-end' }
const buttonStyle: CSSProperties = { padding: '2px 10px', border: '1px solid rgba(127,127,127,.35)', borderRadius: 6, background: 'transparent', cursor: 'pointer', fontSize: 12 }
const primaryButtonStyle: CSSProperties = { ...buttonStyle, fontWeight: 600 }
