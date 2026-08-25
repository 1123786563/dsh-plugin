/**
 * dsh-job-search, browser half: one better-sidebar tab rendering the
 * deployment's job-search pipeline (profile line, application funnel, recent
 * jobs and applications) from the Host's read-only pipeline route. One shared
 * controller backs the panel; the Host owns all tenant scoping.
 *
 * Failure policy: mounting problems are logged, never thrown — the web shell
 * must not lose a session because one plugin's UI half misbehaved.
 *
 * @module dsh-job-search/client
 */

import { createElement } from 'react'
import { JobSearchDashboardController } from './controller.ts'
import { JobSearchPanel } from './JobSearchPanel.tsx'
import type { PanelController } from './JobSearchPanel.tsx'
import { dictionary, en, NS, zh } from './locales.ts'

/** Minimal client-context surface this plugin uses (services are duck-typed). */
interface JobSearchClientContext {
  effect(register: () => (() => void) | void, label?: string): () => void
  inject(deps: readonly string[], callback: (scoped: JobSearchClientContext & Record<string, unknown>) => void, label?: string): unknown
  on(event: string, listener: () => void): () => void
  locale: { register(ns: string, dicts: { zh: unknown, en: unknown }): () => void }
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

/** Required services: the locale dictionaries (the tab injects betterSidebar dynamically). */
export const inject = ['locale']

/**
 * Mount the browser half: locale dictionaries plus — when better-sidebar is
 * installed — the left-side pipeline panel, with one shared controller.
 * @param ctx - client root context.
 */
export function apply(ctx: JobSearchClientContext): void {
  const controller = new JobSearchDashboardController()
  // Seed the view once the plugin activates, so the panel is populated before
  // the first open; `ensure` never rejects.
  void controller.ensure()

  try {
    ctx.effect(() => {
      try {
        return ctx.locale.register(NS, { zh, en })
      } catch {
        return () => {}
      }
    }, 'job-search: dictionaries')
  } catch {
    // The panel keeps its navigator-language fallback dictionary.
  }

  try {
    ctx.on('connection/reset', () => {
      if (controller.getSnapshot().status !== 'cold') void controller.refresh()
    })
  } catch {
    // A context without the connection event simply never refreshes on reconnect.
  }

  mountSidebarTab(ctx, controller)

  try {
    ctx.effect(() => () => {
      controller.dispose()
    }, 'job-search: controller')
  } catch {
    // Disposal registration failing leaves the controller listener-less; harmless.
  }
}

/**
 * Register the pipeline panel tab when the betterSidebar service exists; its
 * absence never blocks the rest of the plugin (dynamic inject).
 * @param ctx - client root context.
 * @param controller - the shared pipeline controller.
 */
function mountSidebarTab(ctx: JobSearchClientContext, controller: JobSearchDashboardController): void {
  try {
    ctx.inject(['betterSidebar'], scoped => {
      const sidebar = (scoped as { betterSidebar?: { registerTab(descriptor: SidebarTabDescriptor): () => void } }).betterSidebar
      if (sidebar === undefined) return
      try {
        scoped.effect(() => sidebar.registerTab({
          id: 'dsh-job-search:panel',
          title: () => dictionary()['tab.title'],
          icon: size => createElement('span', { 'aria-hidden': true, style: { fontSize: Math.max(12, size - 2), lineHeight: 1 } }, '🧭'),
          order: 56,
          single: true,
          component: () => JobSearchPanel({ controller: controller as unknown as PanelController }),
        }), 'job-search: better-sidebar tab')
      } catch {
        // A tab-type collision (double injection) breaks nothing else.
      }
    }, 'job-search: sidebar')
  } catch {
    // Without better-sidebar the plugin contributes nothing browser-side.
  }
}

export { JobSearchPanel }
export type { JobSearchActionProps } from './JobSearchAction.tsx'
export type { JobSearchDashboardView, JobSearchStatus, PipelineFetch } from './controller.ts'
export { JobSearchDashboardController, PIPELINE_URL } from './controller.ts'
