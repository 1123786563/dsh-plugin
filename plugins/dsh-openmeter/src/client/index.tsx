/**
 * dsh-openmeter, browser half: the settings card (Settings > Plugins, the
 * openmeter namespace the Host registers) and the billing sidebar panel
 * (better-sidebar tab reading the Host's /api/openmeter routes — the token
 * never reaches the browser).
 *
 * Failure policy: mounting problems are logged, never thrown — the web shell
 * fails the whole boot when a plugin apply throws.
 *
 * @module dsh-openmeter/client
 */

import { createElement } from 'react'
import { cardFace } from './form.ts'
import type { OpenMeterSettingsScope } from './form.ts'
import { OpenMeterSettingsCard } from './card.tsx'
import { BillingPanel } from './panel.tsx'
import { dictionary, en, zh } from './locales.ts'

/** Locale namespace this plugin owns. */
const NS = 'openmeter'

/** Settings namespace the card edits. */
const OPENMETER_NS = 'openmeter'

/** Minimal client-context surface this plugin uses (services are duck-typed). */
interface ClientContext {
  effect(register: () => (() => void) | void, label?: string): () => void
  inject(deps: readonly string[], callback: (scoped: ClientContext & Record<string, unknown>) => void, label?: string): unknown
  get(name: string): unknown
  locale: { register(ns: string, dicts: { zh: unknown, en: unknown }): () => void }
  slots: {
    inject(name: string, register: () => (() => void) | void): void
    register(options: Record<string, unknown>, component: (props: never) => unknown): () => void
  }
  settingsScope: { bind<S>(spec: { namespace: string }): S }
}

/** better-sidebar's tab descriptor, duck-typed. */
interface SidebarTabDescriptor {
  id: string
  title: () => string
  icon: (size: number) => unknown
  order?: number
  single?: boolean
  component: () => unknown
}

/** Required services: slot registry, locale dictionaries, settings scope. */
export const inject: string[] = ['slots', 'locale', 'settingsScope']

/**
 * Mount the browser half: locale dictionaries, the settings card, and — when
 * better-sidebar is installed — the billing panel tab.
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
    // The card and panel keep their navigator-language fallback dictionaries.
  }
  mountSettingsCard(ctx)
  mountSidebarTab(ctx)
}

/**
 * Register the settings card into the official plugin-configuration slot.
 * @param ctx - client root context.
 */
function mountSettingsCard(ctx: ClientContext): void {
  try {
    const binder = (ctx.get('webUiSettings') as { bind: ClientContext['settingsScope']['bind'] } | undefined) ?? ctx.settingsScope
    const scope = binder.bind<OpenMeterSettingsScope>({ namespace: OPENMETER_NS })
    const face = cardFace(scope)
    ctx.slots.inject('settings.plugin.item', () => {
      try {
        const unregister = ctx.slots.register({
          name: 'settings.plugin.item',
          key: OPENMETER_NS,
          locale: NS,
          inject: () => face,
        }, OpenMeterSettingsCard as never)
        return () => {
          unregister()
        }
      } catch {
        return () => {}
      }
    })
  } catch {
    // Without a settings scope the card stays absent; the panel still works.
  }
}

/**
 * Register the billing panel tab when betterSidebar exists.
 * @param ctx - client root context.
 */
function mountSidebarTab(ctx: ClientContext): void {
  try {
    ctx.inject(['betterSidebar'], scoped => {
      const sidebar = (scoped as { betterSidebar?: { registerTab(descriptor: SidebarTabDescriptor): () => void } }).betterSidebar
      if (sidebar === undefined) return
      try {
        scoped.effect(() => sidebar.registerTab({
          id: 'dsh-openmeter:panel',
          title: () => dictionary()['tab.title'] ?? '计费',
          icon: size => createElement('span', { 'aria-hidden': true, style: { fontSize: Math.max(12, size - 2), lineHeight: 1 } }, '💰'),
          order: 56,
          single: true,
          component: () => BillingPanel(),
        }), 'openmeter: better-sidebar tab')
      } catch {
        // A tab-type collision breaks nothing else.
      }
    }, 'openmeter: sidebar')
  } catch {
    // Without better-sidebar the plugin contributes only the settings card.
  }
}
