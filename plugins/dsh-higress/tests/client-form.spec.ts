/** Client form staging: parse/format models text, save/discard lifecycle. */
import { describe, expect, it } from 'vitest'
import { cardFace, formatModelsText, parseModelsText } from '../src/client/form.ts'

function scopeWith(value: Record<string, unknown> = {}) {
  const listeners = new Set<() => void>()
  const snapshot = { status: 'ready', value, user: {}, writable: true }
  const writes: Array<[string, unknown]> = []
  return {
    writes,
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
      set: async (field: string, v: unknown) => { writes.push([field, v]); Object.assign(snapshot.value, { [field]: v }) },
      unset: async (field: string) => { writes.push([field, undefined]) },
    },
  }
}

describe('models text', () => {
  it('parses one id per line, preserving prior metadata for known ids', () => {
    const existing = [{ id: 'deepseek-chat', name: 'DeepSeek Chat (via Higress)', contextWindow: 65_536 }]
    const parsed = parseModelsText('deepseek-chat\n\n  qwen-max  \n', existing, 32_768)
    expect(parsed).toEqual([
      { id: 'deepseek-chat', name: 'DeepSeek Chat (via Higress)', contextWindow: 65_536 },
      { id: 'qwen-max', name: 'qwen-max', contextWindow: 32_768 },
    ])
  })

  it('formats ids one per line and tolerates undefined', () => {
    expect(formatModelsText([{ id: 'a' }, { id: 'b' }])).toBe('a\nb')
    expect(formatModelsText(undefined)).toBe('')
  })
})

describe('CardStore', () => {
  it('stages edits and writes them on save', async () => {
    const { scope, writes } = scopeWith({ baseURL: 'http://127.0.0.1:8080/v1', apiKeyEnv: 'HIGRESS_API_KEY', models: [{ id: 'deepseek-chat' }] })
    const face = cardFace(scope)
    face.edit('baseURL', 'https://gw.example.com/v1')
    face.edit('models', 'deepseek-chat\nqwen-max')
    expect(face.hooks.higressSettingsCard.getSnapshot().dirty).toBe(true)
    await face.hooks.higressSettingsCard.save()
    expect(writes).toContainEqual(['baseURL', 'https://gw.example.com/v1'])
    expect(writes).toContainEqual(['models', [{ id: 'deepseek-chat' }, { id: 'qwen-max', name: 'qwen-max', contextWindow: 65_536 }]])
    expect(face.hooks.higressSettingsCard.getSnapshot().dirty).toBe(false)
  })

  it('discards staged drafts without writing', async () => {
    const { scope, writes } = scopeWith({})
    const face = cardFace(scope)
    face.edit('apiKeyEnv', 'OTHER_KEY')
    face.discard()
    expect(face.hooks.higressSettingsCard.getSnapshot().dirty).toBe(false)
    await face.hooks.higressSettingsCard.save()
    expect(writes).toEqual([])
  })
})
