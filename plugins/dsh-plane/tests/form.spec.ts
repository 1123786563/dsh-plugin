/**
 * Settings-card staged form: seeding, staging, validation gating, secret
 * handling, and save/write behavior against a scripted scope.
 */

import { describe, expect, it, vi } from 'vitest'
import { PlaneSettingsCardController } from '../src/client/form.ts'

/** Build a scripted scope with callable writes. */
function scope(snapshot: {
  status?: string
  value?: Record<string, unknown>
  user?: Record<string, unknown>
  writable?: boolean
}) {
  const set = vi.fn(async () => {})
  const unset = vi.fn(async () => {})
  const listeners = new Set<() => void>()
  let current = {
    status: snapshot.status ?? 'ready',
    writable: snapshot.writable ?? true,
    ...(snapshot.value === undefined ? {} : { value: snapshot.value }),
    ...(snapshot.user === undefined ? {} : { user: snapshot.user }),
  }
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set,
    unset,
    /** Push a new snapshot (simulates a settings commit). */
    publish: (next: typeof current) => {
      current = next
      for (const listener of [...listeners]) listener()
    },
  }
}

describe('PlaneSettingsCardController', () => {
  it('seeds field text from the resolved value and marks user overrides', () => {
    const controller = new PlaneSettingsCardController(scope({
      value: { baseUrl: 'https://plane.example.com', workspaceSlug: 'team', perPage: 25 },
      user: { baseUrl: 'https://plane.example.com' },
    }))
    const state = controller.inject().hooks.planeSettingsCard.getSnapshot()
    expect(state.available).toBe(true)
    expect(state.fields.baseUrl.text).toBe('https://plane.example.com')
    expect(state.fields.baseUrl.overridden).toBe(true)
    expect(state.fields.workspaceSlug.overridden).toBe(false)
    expect(state.fields.perPage.text).toBe('25')
    expect(state.dirty).toBe(false)
  })

  it('renders nothing while the namespace is loading', () => {
    const controller = new PlaneSettingsCardController(scope({ status: 'loading' }))
    expect(controller.inject().hooks.planeSettingsCard.getSnapshot().available).toBe(false)
  })

  it('flags an unavailable namespace as not exposed', () => {
    const controller = new PlaneSettingsCardController(scope({ status: 'unavailable' }))
    expect(controller.inject().hooks.planeSettingsCard.getSnapshot().exposed).toBe(false)
  })

  it('stages edits as dirty and blocks save on an invalid perPage', async () => {
    const bound = scope({ value: { perPage: 50 } })
    const controller = new PlaneSettingsCardController(bound)
    const face = controller.inject()
    face.edit('perPage', '101')
    let state = controller.inject().hooks.planeSettingsCard.getSnapshot()
    expect(state.dirty).toBe(true)
    expect(state.invalid).toBe(true)
    expect(state.fields.perPage.invalid).toBe(true)
    await controller.save()
    expect(bound.set).not.toHaveBeenCalled()
    face.edit('perPage', '20')
    state = controller.inject().hooks.planeSettingsCard.getSnapshot()
    expect(state.invalid).toBe(false)
    await controller.save()
    expect(bound.set).toHaveBeenCalledWith('perPage', 20)
    expect(controller.inject().hooks.planeSettingsCard.getSnapshot().dirty).toBe(false)
  })

  it('treats an empty apiKey draft as no change (redacted secret)', async () => {
    const bound = scope({ value: { apiKey: 'secret-value' }, user: { apiKey: 'redacted-or-set' } })
    const controller = new PlaneSettingsCardController(bound)
    const face = controller.inject()
    expect(face.hooks.planeSettingsCard.getSnapshot().fields.apiKey.text).toBe('')
    face.edit('apiKey', '')
    await controller.save()
    expect(bound.set).not.toHaveBeenCalled()
  })

  it('stages a reset as an unset write', async () => {
    const bound = scope({ value: { workspaceSlug: 'team' }, user: { workspaceSlug: 'team' } })
    const controller = new PlaneSettingsCardController(bound)
    controller.inject().resetField('workspaceSlug')
    await controller.save()
    expect(bound.unset).toHaveBeenCalledWith('workspaceSlug')
  })

  it('re-seeds from scope commits when nothing is staged', () => {
    const bound = scope({ value: { workspaceSlug: 'old' } })
    const controller = new PlaneSettingsCardController(bound)
    const store = controller.inject().hooks.planeSettingsCard
    bound.publish({ status: 'ready', writable: true, value: { workspaceSlug: 'new' } })
    expect(store.getSnapshot().fields.workspaceSlug.text).toBe('new')
  })

  it('keeps staged drafts across a scope commit', () => {
    const bound = scope({ value: { workspaceSlug: 'old' } })
    const controller = new PlaneSettingsCardController(bound)
    controller.inject().edit('workspaceSlug', 'drafted')
    bound.publish({ status: 'ready', writable: true, value: { workspaceSlug: 'new' } })
    const state = controller.inject().hooks.planeSettingsCard.getSnapshot()
    expect(state.fields.workspaceSlug.text).toBe('drafted')
    expect(state.dirty).toBe(true)
  })

  it('reports a failed save with its reason and clears it on the next edit', async () => {
    const bound = scope({ value: {} })
    bound.set.mockRejectedValueOnce(new Error('SETTINGS_CONFLICT'))
    const controller = new PlaneSettingsCardController(bound)
    controller.inject().edit('workspaceSlug', 'team')
    await controller.save()
    let state = controller.inject().hooks.planeSettingsCard.getSnapshot()
    expect(state.failed).toBe(true)
    expect(state.failedReason).toBe('SETTINGS_CONFLICT')
    controller.inject().edit('workspaceSlug', 'team2')
    state = controller.inject().hooks.planeSettingsCard.getSnapshot()
    expect(state.failed).toBe(false)
  })

  it('notifies store subscribers on publish', () => {
    const controller = new PlaneSettingsCardController(scope({ value: {} }))
    const store = controller.inject().hooks.planeSettingsCard
    const listener = vi.fn()
    store.subscribe(listener)
    controller.inject().edit('workspaceSlug', 'x')
    expect(listener).toHaveBeenCalled()
    controller.dispose()
  })
})
