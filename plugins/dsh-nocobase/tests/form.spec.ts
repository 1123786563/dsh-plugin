/**
 * Staged-form controller: draft staging, URL validation, save/unset writes,
 * failure capture, and override resets — all pure state, driven by a fake
 * settings scope.
 */

import { describe, expect, it } from 'vitest'
import { NocobaseSettingsCardController } from '../src/client/form.ts'
import type { NocobaseScopeSnapshot, NocobaseSettingsScope } from '../src/client/form.ts'

function fakeScope(initial: Record<string, unknown> = {}, user: Record<string, unknown> = {}) {
  const written: Array<{ field: string, value: unknown }> = []
  const unset: string[] = []
  const listeners = new Set<() => void>()
  let value = initial
  let userLayer = user
  const scope: NocobaseSettingsScope = {
    getSnapshot: () => ({ status: 'ready', value, user: userLayer, writable: true }) satisfies NocobaseScopeSnapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set: async (field, next) => {
      written.push({ field, value: next })
      userLayer = { ...userLayer, [field]: next }
      value = { ...value, [field]: next }
      for (const listener of [...listeners]) listener()
    },
    unset: async field => {
      unset.push(field)
      delete userLayer[field]
      for (const listener of [...listeners]) listener()
    },
  }
  return { scope, written, unset }
}

describe('NocobaseSettingsCardController', () => {
  it('seeds the card from the scope snapshot', () => {
    const { scope } = fakeScope({ baseUrl: 'http://127.0.0.1:13000' })
    const card = new NocobaseSettingsCardController(scope)
    const state = card.inject().hooks.nocobaseSettingsCard.getSnapshot()
    expect(state.available).toBe(true)
    expect(state.exposed).toBe(true)
    expect(state.fields.baseUrl.text).toBe('http://127.0.0.1:13000')
    expect(state.fields.baseUrl.overridden).toBe(false)
    card.dispose()
  })

  it('renders nothing while the namespace loads and hides when unavailable', () => {
    const loading = new NocobaseSettingsCardController({
      getSnapshot: () => ({ status: 'loading', writable: false }) as NocobaseScopeSnapshot,
      subscribe: () => () => {},
      set: async () => {}, unset: async () => {},
    })
    expect(loading.inject().hooks.nocobaseSettingsCard.getSnapshot().available).toBe(false)
    const unavailable = new NocobaseSettingsCardController({
      getSnapshot: () => ({ status: 'unavailable', writable: false }) as NocobaseScopeSnapshot,
      subscribe: () => () => {},
      set: async () => {}, unset: async () => {},
    })
    expect(unavailable.inject().hooks.nocobaseSettingsCard.getSnapshot().exposed).toBe(false)
  })

  it('stages drafts and marks dirty without writing the scope', () => {
    const { scope, written } = fakeScope({ baseUrl: 'http://127.0.0.1:13000' })
    const card = new NocobaseSettingsCardController(scope)
    card.edit('baseUrl', 'http://10.0.0.9:13000/')
    const state = card.inject().hooks.nocobaseSettingsCard.getSnapshot()
    expect(state.dirty).toBe(true)
    expect(state.fields.baseUrl.text).toBe('http://10.0.0.9:13000/')
    expect(written).toEqual([])
    card.dispose()
  })

  it('blocks saving an invalid origin', async () => {
    const { scope, written } = fakeScope({ baseUrl: 'http://127.0.0.1:13000' })
    const card = new NocobaseSettingsCardController(scope)
    card.edit('baseUrl', 'not a url')
    expect(card.inject().hooks.nocobaseSettingsCard.getSnapshot().invalid).toBe(true)
    await card.save()
    expect(written).toEqual([])
    card.dispose()
  })

  it('strips trailing slashes on save', async () => {
    const { scope, written } = fakeScope({ baseUrl: 'http://127.0.0.1:13000' })
    const card = new NocobaseSettingsCardController(scope)
    card.edit('baseUrl', 'http://10.0.0.9:13000///')
    await card.save()
    expect(written).toEqual([{ field: 'baseUrl', value: 'http://10.0.0.9:13000' }])
    card.dispose()
  })

  it('resets an override through unset', async () => {
    const { scope, unset } = fakeScope({ baseUrl: 'http://127.0.0.1:13000' }, { baseUrl: 'http://10.0.0.9:13000' })
    const card = new NocobaseSettingsCardController(scope)
    expect(card.inject().hooks.nocobaseSettingsCard.getSnapshot().fields.baseUrl.overridden).toBe(true)
    card.resetField('baseUrl')
    await card.save()
    expect(unset).toEqual(['baseUrl'])
    card.dispose()
  })

  it('captures save failures for the card to render', async () => {
    const scope: NocobaseSettingsScope = {
      getSnapshot: () => ({ status: 'ready', value: { baseUrl: 'http://127.0.0.1:13000' }, writable: true }),
      subscribe: () => () => {},
      set: async () => { throw new Error('document locked') },
      unset: async () => {},
    }
    const card = new NocobaseSettingsCardController(scope)
    card.edit('baseUrl', 'http://10.0.0.9:13000')
    await card.save()
    const state = card.inject().hooks.nocobaseSettingsCard.getSnapshot()
    expect(state.failed).toBe(true)
    expect(state.failedReason).toBe('document locked')
    expect(state.dirty).toBe(true)
    card.dispose()
  })

  it('discard drops staged edits', async () => {
    const { scope, written } = fakeScope({ baseUrl: 'http://127.0.0.1:13000' })
    const card = new NocobaseSettingsCardController(scope)
    card.edit('baseUrl', 'http://10.0.0.9:13000')
    card.discard()
    expect(card.inject().hooks.nocobaseSettingsCard.getSnapshot().dirty).toBe(false)
    await card.save()
    expect(written).toEqual([])
    card.dispose()
  })
})
