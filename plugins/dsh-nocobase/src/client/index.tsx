/**
 * dsh-nocobase, browser half: the settings card (the Plugins section pairs it
 * with the Host's nocobase settings namespace) and — when better-sidebar is
 * installed — a sidebar tab with the health badge and the open link.
 *
 * Failure policy: mounting problems are logged, never thrown — the web shell
 * fails the whole boot when a plugin apply throws, and an external plugin
 * must not take the GUI down.
 *
 * @module dsh-nocobase/client
 */

import { createElement, useSyncExternalStore } from 'react'
import { NocobaseSettingsCardController } from './form.ts'
import type { NocobaseSettingsScope } from './form.ts'
import { NocobaseSettingsCard } from './card.tsx'
import { NocobasePanelTab } from './panel.tsx'
import { dictionary, en, zh } from './locales.ts'

/** Locale namespace this plugin owns. */
const NS = 'nocobase'

/** Settings namespace the card edits (the Host plugin registers it). */
const NOCOBASE_NS = 'nocobase'

/** Minimal client-context surface this plugin uses (services are duck-typed). */
interface NocobaseClientContext {
  effect(register: () => (() => void) | void, label?: string): () => void
  inject(deps: readonly string[], callback: (scoped: NocobaseClientContext & Record<string, unknown>) => void, label?: string): unknown
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
 * better-sidebar exists — the NocoBase tab.
 * @param ctx - client root context.
 */
export function apply(ctx: NocobaseClientContext): void {
  try {
    ctx.effect(() => {
      try {
        return ctx.locale.register(NS, { zh, en })
      } catch {
        return () => {}
      }
    }, 'nocobase: dictionaries')
  } catch {
    // The card and tab keep their navigator-language fallback dictionaries.
  }
  mountSettingsCard(ctx)
  mountSidebarTab(ctx)
}

/**
 * Register the settings card into the official plugin-configuration slot,
 * keyed by the nocobase namespace the Host registers — the tab pairs the two
 * automatically. The Web UI group's compatibility binder wins when present
 * (rc.6-era fork), else the official settings scope.
 * @param ctx - client root context.
 */
function mountSettingsCard(ctx: NocobaseClientContext): void {
  try {
    const binder = (ctx.get('webUiSettings') as { bind: NocobaseClientContext['settingsScope']['bind'] } | undefined) ?? ctx.settingsScope
    const scope = binder.bind<NocobaseSettingsScope>({ namespace: NOCOBASE_NS })
    const card = new NocobaseSettingsCardController(scope)
    ctx.slots.inject('settings.plugin.item', () => {
      try {
        const unregister = ctx.slots.register({
          name: 'settings.plugin.item',
          key: NOCOBASE_NS,
          locale: NS,
          inject: () => card.inject(),
        }, NocobaseSettingsCard as never)
        return () => {
          card.dispose()
          unregister()
        }
      } catch {
        return () => {}
      }
    })
  } catch {
    // Without a settings scope the card stays absent; the tab still works.
  }
}

/**
 * Register the NocoBase tab when the betterSidebar service exists; its
 * absence never blocks the settings card (dynamic inject).
 * @param ctx - client root context.
 */
function mountSidebarTab(ctx: NocobaseClientContext): void {
  try {
    ctx.inject(['betterSidebar'], scoped => {
      const sidebar = (scoped as { betterSidebar?: { registerTab(descriptor: SidebarTabDescriptor): () => void } }).betterSidebar
      if (sidebar === undefined) return
      try {
        scoped.effect(() => sidebar.registerTab({
          id: 'dsh-nocobase:panel',
          title: () => dictionary().tabTitle,
          icon: size => createElement('span', { 'aria-hidden': true, style: { fontSize: Math.max(12, size - 2), lineHeight: 1 } }, '🧩'),
          order: 56,
          single: true,
          component: () => NocobasePanelTab(),
        }), 'nocobase: better-sidebar tab')
      } catch {
        // A tab-type collision (double injection) breaks nothing else.
      }
    }, 'nocobase sidebar')
  } catch {
    // Without better-sidebar the plugin contributes only the settings card.
  }
}
