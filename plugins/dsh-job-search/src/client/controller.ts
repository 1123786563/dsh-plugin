/**
 * Browser-local object layer over the host pipeline route. One controller
 * instance backs the whole plugin (the pipeline is host-global, not
 * per-session): it loads `/plugins/dsh-job-search/pipeline.json` on demand,
 * publishes one frozen view, and collapses concurrent loads into one request.
 * @module dsh-job-search/client/controller
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { JobSearchPipelineView } from '../types.ts'

/** The host pipeline route this controller fetches. */
export const PIPELINE_URL = '/plugins/dsh-job-search/pipeline.json'

/** Load state of the one pipeline read that seeds the dashboard. */
export type JobSearchStatus = 'cold' | 'loading' | 'ready' | 'error'

/** Immutable view published to the dashboard entry. */
export interface JobSearchDashboardView {
  readonly status: JobSearchStatus
  /** The last successfully loaded pipeline; retained across refreshes. */
  readonly pipeline: JobSearchPipelineView | null
  /** Reason the last load failed, cleared by the next successful load. */
  readonly error: string | null
}

const INITIAL_VIEW: JobSearchDashboardView = Object.freeze({
  status: 'cold',
  pipeline: null,
  error: null,
})

/** The fetch surface, replaceable in tests. */
export type PipelineFetch = (url: string) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

/**
 * The dashboard's data source: one host-global pipeline snapshot with
 * on-demand refresh. The Host owns all tenant scoping; the client passes no
 * tenant id and reads whatever the deployment's default tenant resolved to.
 */
export class JobSearchDashboardController implements HostObservable<JobSearchDashboardView> {
  private view = INITIAL_VIEW
  private readonly listeners = new Set<() => void>()
  private loadPromise: Promise<void> | null = null
  private disposed = false

  /**
   * @param fetchImpl - fetch implementation (defaults to window.fetch).
   */
  constructor(private readonly fetchImpl: PipelineFetch = (url) => fetch(url)) {}

  /** @returns the current view; the same reference until the state moves. */
  getSnapshot(): JobSearchDashboardView {
    return this.view
  }

  /**
   * Subscribe to view changes.
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /**
   * Load the pipeline once if nothing has loaded yet; collapse concurrent
   * callers into the in-flight request.
   * @returns resolution after the view settled.
   */
  ensure(): Promise<void> {
    this.loadPromise ??= this.load()
    return this.loadPromise
  }

  /**
   * Reload the pipeline unconditionally (the refresh action).
   * @returns resolution after the view settled.
   */
  refresh(): Promise<void> {
    this.loadPromise = this.load()
    return this.loadPromise
  }

  /** Drop every listener; later loads still settle but notify nobody. */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }

  private async load(): Promise<void> {
    this.publish({ status: 'loading', pipeline: this.view.pipeline, error: null })
    try {
      const response = await this.fetchImpl(PIPELINE_URL)
      if (this.disposed) return
      if (!response.ok) {
        this.publish({ status: 'error', pipeline: this.view.pipeline, error: `HTTP ${response.status}` })
        return
      }
      const body = await response.json() as JobSearchPipelineView
      if (this.disposed) return
      this.publish({ status: 'ready', pipeline: body, error: null })
    } catch (error) {
      if (this.disposed) return
      this.publish({
        status: 'error',
        pipeline: this.view.pipeline,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private publish(view: JobSearchDashboardView): void {
    this.view = Object.freeze(view)
    for (const listener of this.listeners) listener()
  }
}
