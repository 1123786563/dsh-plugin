/**
 * dsh-higress, browser half: the Settings > Plugins config card for the
 * llm-higress namespace the Host registers.
 *
 * Failure policy: mounting problems are logged, never thrown — the web shell
 * fails the whole boot when a plugin apply throws.
 *
 * @module dsh-higress/client
 */

import { makeSettingsCard } from './card.tsx'
import { cardFace } from './form.ts'
import type { HigressSettingsScope } from './form.ts'

/** Settings namespace the card edits. */
const HIGRESS_NS = 'llm-higress'

/** Minimal client-context surface this plugin uses (services are duck-typed). */
interface ClientContext {
  effect(register: () => (() => void) | void, label?: string): () => void
  get(name: string): unknown
  slots: {
    inject(name: string, register: () => (() => void) | void): void
    register(options: Record<string, unknown>, component: (props: never) => unknown): () => void
  }
  settingsScope: { bind<S>(spec: { namespace: string }): S }
}

/** Required services: slot registry and settings scope. */
export const inject: string[] = ['slots', 'settingsScope']

/**
 * Mount the browser half: the settings card.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  try {
    const binder = (ctx.get('webUiSettings') as { bind: ClientContext['settingsScope']['bind'] } | undefined) ?? ctx.settingsScope
    const scope = binder.bind<HigressSettingsScope>({ namespace: HIGRESS_NS })
    const face = cardFace(scope)
    ctx.slots.inject('settings.plugin.item', () => {
      try {
        const unregister = ctx.slots.register({
          name: 'settings.plugin.item',
          key: HIGRESS_NS,
          inject: () => face,
        }, makeSettingsCard(face) as never)
        return () => {
          unregister()
        }
      } catch {
        return () => {}
      }
    })
  } catch {
    // Without a settings scope the card stays absent.
  }
}
