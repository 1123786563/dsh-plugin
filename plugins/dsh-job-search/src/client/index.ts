/**
 * dsh-job-search, browser half: one session-header action rendering the
 * deployment's job-search pipeline (profile line, application funnel, recent
 * jobs and applications) from the Host's read-only pipeline route. All data
 * crosses the inject face; the component holds no state of its own beyond
 * popover visibility.
 *
 * Failure policy: mounting problems are logged, never thrown — the web shell
 * must not lose a session because one plugin's UI half misbehaved.
 *
 * @module dsh-job-search/client
 */

import { JobSearchDashboardController } from './controller.ts'
import { JobSearchAction } from './JobSearchAction.tsx'
import { en, NS, zh } from './locales.ts'

/** Minimal client-context surface this plugin uses (services are duck-typed). */
interface JobSearchClientContext {
  effect(register: () => (() => void) | void, label?: string): () => void
  on(event: string, listener: () => void): () => void
  locale: { register(ns: string, dicts: { zh: unknown, en: unknown }): () => void }
  slots: {
    inject(name: string, register: () => (() => void) | void): void
    register(options: Record<string, unknown>, component: (props: never) => unknown): () => void
  }
}

/** Required services: the slot registry and the locale dictionaries. */
export const inject = ['slots', 'locale']

/**
 * Mount the browser half: locale dictionaries plus the session-header
 * dashboard action, with one shared controller (the pipeline is host-global,
 * not per-session).
 * @param ctx - client root context.
 */
export function apply(ctx: JobSearchClientContext): void {
  const controller = new JobSearchDashboardController()
  // Seed the view once the plugin activates, so the dashboard is populated
  // before the first interaction; `ensure` never rejects.
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
    // The header action keeps its navigator-language fallback dictionary.
  }

  try {
    ctx.on('connection/reset', () => {
      if (controller.getSnapshot().status !== 'cold') void controller.refresh()
    })
  } catch {
    // A context without the connection event simply never refreshes on reconnect.
  }

  try {
    ctx.slots.inject('conversation.session.header.actions', () => {
      try {
        return ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'job-search',
          // After the background-job list: process work reads before tenant data.
          order: 30,
          locale: NS,
          inject: () => ({
            hooks: { pipeline: controller },
            refresh: () => controller.refresh(),
          }),
        }, JobSearchAction as unknown as (props: never) => unknown)
      } catch (error) {
        console.error('[job-search] header action registration failed:', error)
        return () => {}
      }
    })
  } catch (error) {
    console.error('[job-search] slot inject failed:', error)
  }

  try {
    ctx.effect(() => () => {
      controller.dispose()
    }, 'job-search: controller')
  } catch {
    // Disposal registration failing leaves the controller listener-less; harmless.
  }
}

export { JobSearchAction }
export type { JobSearchActionProps } from './JobSearchAction.tsx'
export type { JobSearchDashboardView, JobSearchStatus, PipelineFetch } from './controller.ts'
export { JobSearchDashboardController, PIPELINE_URL } from './controller.ts'
