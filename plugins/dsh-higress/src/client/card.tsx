/**
 * The llm-higress settings card: endpoint, credential reference, and the
 * one-id-per-line model catalog. zh-first strings with an en fallback (no
 * locale-service dependency in v1).
 *
 * @module dsh-higress/client/card
 */

import { useSyncExternalStore } from 'react'
import type { CardFace } from './form.ts'

const STRINGS = {
  zh: {
    title: 'Higress AI 网关',
    baseURL: '网关端点（OpenAI 兼容前缀）',
    apiKeyEnv: '凭据引用（consumer key 的环境变量名）',
    models: '模型目录（每行一个模型 ID）',
    save: '保存',
    discard: '放弃',
    reset: '重置',
    overridden: '已覆盖默认',
    saving: '保存中…',
    failed: '保存失败',
    unavailable: '设置服务不可用',
  },
  en: {
    title: 'Higress AI gateway',
    baseURL: 'Gateway endpoint (OpenAI-compatible prefix)',
    apiKeyEnv: 'Credential reference (env var holding the consumer key)',
    models: 'Model catalog (one model id per line)',
    save: 'Save',
    discard: 'Discard',
    reset: 'Reset',
    overridden: 'Overrides default',
    saving: 'Saving…',
    failed: 'Save failed',
    unavailable: 'Settings service unavailable',
  },
} as const

function strings(): (typeof STRINGS)['zh'] {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en
}

/**
 * Build the card component bound to one face.
 * @param face - the injected card face.
 * @returns the React component the slot renders.
 */
export function makeSettingsCard(face: CardFace): () => JSX.Element {
  return function HigressSettingsCard(): JSX.Element {
    const t = strings()
    const state = useSyncExternalStore(face.hooks.higressSettingsCard.subscribe, face.hooks.higressSettingsCard.getSnapshot)
    const textInput = (field: 'baseURL' | 'apiKeyEnv', label: string): JSX.Element => (
      <label style={{ display: 'block', marginBottom: 12 }}>
        <span style={{ display: 'block', fontWeight: 500 }}>{label}{state[field].overridden ? ` · ${t.overridden}` : ''}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{ flex: 1, padding: '4px 8px' }}
            value={state[field].text}
            disabled={!state.writable}
            onChange={event => face.edit(field, event.target.value)}
          />
          {state[field].overridden ? <button onClick={() => face.resetField(field)}>{t.reset}</button> : null}
        </div>
      </label>
    )
    return (
      <section>
        <h3>{t.title}</h3>
        {!state.available ? <p>{t.unavailable}</p> : (
          <form onSubmit={event => { event.preventDefault(); face.save() }}>
            {textInput('baseURL', t.baseURL)}
            {textInput('apiKeyEnv', t.apiKeyEnv)}
            <label style={{ display: 'block', marginBottom: 12 }}>
              <span style={{ display: 'block', fontWeight: 500 }}>{t.models}{state.models.overridden ? ` · ${t.overridden}` : ''}</span>
              <textarea
                style={{ width: '100%', minHeight: 96, padding: '4px 8px', fontFamily: 'monospace' }}
                value={state.models.text}
                disabled={!state.writable}
                onChange={event => face.edit('models', event.target.value)}
              />
            </label>
            {state.failed ? <p style={{ color: '#c0392b' }}>{t.failed}{state.failedReason ? `：${state.failedReason}` : ''}</p> : null}
            <button type="submit" disabled={!state.dirty || state.saving || !state.writable}>{state.saving ? t.saving : t.save}</button>
            {' '}
            <button type="button" onClick={face.discard} disabled={!state.dirty || state.saving}>{t.discard}</button>
          </form>
        )}
      </section>
    )
  }
}
