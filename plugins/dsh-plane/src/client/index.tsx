/**
 * dsh-plane, browser half: the settings card (the Plugins section pairs it
 * with the Host's plane settings namespace) and the sidebar panel (a
 * better-sidebar tab fed by the Host's read-only panel route, so the API key
 * never reaches the browser).
 *
 * Failure policy: mounting problems are logged, never thrown — the web shell
 * fails the whole boot when a plugin apply throws, and an external plugin
 * must not take the GUI down.
 *
 * @module dsh-plane/client
 */

import { createElement } from 'react'
import { PlaneSettingsCardController } from './form.ts'
import type { PlaneSettingsScope } from './form.ts'
import { PlaneSettingsCard } from './card.tsx'
import { PlanePanelTab } from './panel.tsx'
import { dictionary, en, zh } from './locales.ts'

/** Locale namespace this plugin owns. */
const NS = 'plane'

/** Settings namespace the card edits (the Host plugin registers it). */
const PLANE_NS = 'plane'

/** Minimal client-context surface this plugin uses (services are duck-typed). */
interface PlaneClientContext {
  effect(register: () => (() => void) | void, label?: string): () => void
  inject(deps: readonly string[], callback: (scoped: PlaneClientContext & Record<string, unknown>) => void, label?: string): unknown
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
 * Mount the browser half: locale dictionaries, the settings card (the
 * official plugin-configuration tab, keyed by the plane namespace), and —
 * when better-sidebar is installed — the Plane panel tab.
 * @param ctx - client root context.
 */
export function apply(ctx: PlaneClientContext): void {
  try {
    ctx.effect(() => {
      try {
        return ctx.locale.register(NS, { zh, en })
      } catch {
        return () => {}
      }
    }, 'plane: dictionaries')
  } catch {
    // The card and panel keep their navigator-language fallback dictionaries.
  }
  mountSettingsCard(ctx)
  mountSidebarTab(ctx)
}

/**
 * Register the settings card into the official plugin-configuration slot,
 * keyed by the plane namespace the Host registers — the tab pairs the two
 * automatically. Exactly one registration, so the card appears in one
 * place; the fork's Web UI family section is deliberately left alone. The
 * Web UI group's compatibility binder wins when present (rc.6-era fork),
 * else the official settings scope.
 * @param ctx - client root context.
 */
function mountSettingsCard(ctx: PlaneClientContext): void {
  try {
    const binder = (ctx.get('webUiSettings') as { bind: PlaneClientContext['settingsScope']['bind'] } | undefined) ?? ctx.settingsScope
    const scope = binder.bind<PlaneSettingsScope>({ namespace: PLANE_NS })
    const card = new PlaneSettingsCardController(scope)
    ctx.slots.inject('settings.plugin.item', () => {
      try {
        const unregister = ctx.slots.register({
          name: 'settings.plugin.item',
          key: PLANE_NS,
          locale: NS,
          inject: () => card.inject(),
        }, PlaneSettingsCard as never)
        return () => {
          card.dispose()
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
 * Register the Plane panel tab when the betterSidebar service exists; its
 * absence never blocks the settings card (dynamic inject).
 * @param ctx - client root context.
 */
function mountSidebarTab(ctx: PlaneClientContext): void {
  try {
    ctx.inject(['betterSidebar'], scoped => {
      const sidebar = (scoped as { betterSidebar?: { registerTab(descriptor: SidebarTabDescriptor): () => void } }).betterSidebar
      if (sidebar === undefined) return
      try {
        scoped.effect(() => sidebar.registerTab({
          id: 'dsh-plane:panel',
          title: () => dictionary().tabTitle,
          icon: size => createElement('span', { 'aria-hidden': true, style: { fontSize: Math.max(12, size - 2), lineHeight: 1 } }, '📋'),
          order: 55,
          single: true,
          component: () => PlanePanelTab(),
        }), 'plane: better-sidebar tab')
      } catch {
        // A tab-type collision (double injection) breaks nothing else.
      }
    }, 'plane: sidebar')
  } catch {
    // Without better-sidebar the plugin contributes only the settings card.
  }
}