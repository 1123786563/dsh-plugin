/**
 * dsh-openmeter, browser half: one top-level Settings section — 计费 — with
 * three views over the Host's /api/openmeter routes (the token never reaches
 * the browser): 用量, 收银台, and 设置 (the staged config card bound to the
 * openmeter namespace the Host registers).
 *
 * Failure policy: mounting problems are logged, never thrown — the web shell
 * fails the whole boot when a plugin apply throws.
 *
 * @module dsh-openmeter/client
 */

import { createElement, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { cardFace } from './form.ts'
import type { CardFace, CardState, OpenMeterSettingsScope } from './form.ts'
import { OpenMeterSettingsCard } from './card.tsx'
import { BillingPanel } from './panel.tsx'
import { dictionary, en, zh } from './locales.ts'

/** Locale namespace this plugin owns. */
const NS = 'openmeter'

/** Settings namespace the config card edits. */
const OPENMETER_NS = 'openmeter'

/** Settings nav id (between `plugins` order 15 and `agent-presets` order 20). */
const SECTION_ID = 'openmeter'

/** Minimal client-context surface this plugin uses (services are duck-typed). */
interface ClientContext {
  effect(register: () => (() => void) | void, label?: string): () => void
  get(name: string): unknown
  locale: { register(ns: string, dicts: { zh: unknown, en: unknown }): () => void }
  slots: {
    inject(name: string, register: () => (() => void) | void): void
    register(options: Record<string, unknown>, component: (props: never) => unknown): () => void
  }
  settingsScope: { bind<S>(spec: { namespace: string }): S }
}

/** Required services: slot registry, locale dictionaries, settings scope. */
export const inject: string[] = ['slots', 'locale', 'settingsScope']

/**
 * Mount the browser half: locale dictionaries and the Settings nav entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  try {
    ctx.effect(() => {
      try {
        return ctx.locale.register(NS, { zh, en })
      } catch {
        return () => {}
      }
    }, 'openmeter: dictionaries')
  } catch {
    // The section keeps its navigator-language fallback dictionaries.
  }
  mountBillingSection(ctx)
}

/**
 * Register the 计费 section as its own Settings page, with the config card
 * embedded as the 设置 view.
 * @param ctx - client root context.
 */
function mountBillingSection(ctx: ClientContext): void {
  try {
    let config: ReturnType<typeof buildConfigCard> | undefined
    ctx.slots.inject('settings.section', () => {
      try {
        const unregister = ctx.slots.register({
          name: 'settings.section',
          id: SECTION_ID,
          order: 16,
          label: () => dictionary()['nav.title'] ?? '计费',
          locale: NS,
        }, () => {
          config ??= buildConfigCard(ctx)
          return createElement(BillingPanel, { config } as never)
        })
        return () => {
          unregister()
        }
      } catch {
        return () => {}
      }
    })
  } catch {
    // Without the settings shell the section stays absent.
  }
}

/**
 * Build the config card node: the staged form bound to the openmeter
 * settings namespace.
 * @param ctx - client root context.
 * @returns the card element.
 */
function buildConfigCard(ctx: ClientContext): ReactNode {
  const binder = (ctx.get('webUiSettings') as { bind: ClientContext['settingsScope']['bind'] } | undefined) ?? ctx.settingsScope
  const scope = binder.bind<OpenMeterSettingsScope>({ namespace: OPENMETER_NS })
  return createElement(ConfigCard, { face: cardFace(scope) })
}

/**
 * The config card wrapped for direct mounting: adapts the card store into the
 * selector hook the card expects (the slot renderer normally binds this).
 * @param props - the staged-form face.
 * @returns the card.
 */
function ConfigCard(props: { face: CardFace }): ReactNode {
  const store = props.face.hooks.openmeterSettingsCard
  const useCard = <T,>(select: (state: CardState) => T): T => select(useSyncExternalStore(store.subscribe, store.getSnapshot))
  return createElement(OpenMeterSettingsCard, {
    useOpenMeterSettingsCard: useCard,
    edit: props.face.edit,
    resetField: props.face.resetField,
    save: props.face.save,
    discard: props.face.discard,
  })
}
