/**
 * The job-search sidebar panel (better-sidebar tab): the deployment's whole
 * pipeline — profile line, application funnel, recent jobs and applications —
 * served by the Host's read-only pipeline route. Polls on mount, every 60 s,
 * and on demand; props are duck-typed to keep the bundle host-module-free.
 *
 * @module dsh-job-search/client/JobSearchPanel
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { JobSearchPipelineView } from '../types.ts'
import { dictionary, format } from './locales.ts'
import css from './JobSearchPanel.module.css'

/** Copy reader: unknown keys fall back to the key itself (never crashes a render). */
type T = (key: string, params?: Record<string, string | number>) => string

/** Panel refresh interval. */
const POLL_MS = 60_000

/** Application status vocabulary carried on the wire. */
type AppStatus = 'drafted' | 'applied' | 'interview' | 'offer' | 'rejected' | 'withdrawn'

const FUNNEL_ORDER: readonly AppStatus[] = [
  'drafted', 'applied', 'interview', 'offer', 'rejected', 'withdrawn',
]

/** The controller surface the panel reads (duck-typed from the client entry). */
export interface PanelController {
  getSnapshot(): { status: 'cold' | 'loading' | 'ready' | 'error'; pipeline: JobSearchPipelineView | null; error: string | null }
  subscribe(fn: () => void): () => void
  ensure(): Promise<void>
  refresh(): Promise<void>
}

/** Stable `YYYY-MM-DD` from epoch millis; keeps rendering locale-independent. */
function formatDate(epochMillis: number): string {
  const date = new Date(epochMillis)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Render the job-search sidebar tab.
 * @returns the panel.
 */
export function JobSearchPanel(props: { controller?: PanelController }): ReactNode {
  const dict = dictionary() as Record<string, string>
  const t = (key: string, params?: Record<string, string | number>): string => {
    const raw = dict[key] ?? key
    return params === undefined ? raw : format(raw, params)
  }
  const controller = props.controller
  const [pipeline, setPipeline] = useState<JobSearchPipelineView | null>(() => controller?.getSnapshot().pipeline ?? null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sync = useCallback((): void => {
    if (controller === undefined) return
    const snapshot = controller.getSnapshot()
    setPipeline(snapshot.pipeline)
    setError(snapshot.error)
    setLoading(snapshot.status === 'loading')
  }, [controller])

  useEffect(() => {
    if (controller === undefined) return
    sync()
    const unsubscribe = controller.subscribe(() => { sync() })
    void controller.ensure()
    const timer = setInterval(() => {
      void controller.refresh()
    }, POLL_MS)
    return () => {
      unsubscribe()
      clearInterval(timer)
    }
  }, [controller, sync])

  if (controller === undefined) {
    return <p className={css.empty}>{t('panel.unavailable')}</p>
  }

  return (
    <section className={css.root} aria-label={t('panel.aria')}>
      <header className={css.header}>
        <h3 className={css.heading}>{t('tab.title')}</h3>
        <button type="button" className={css.refresh} onClick={() => { void controller.refresh() }}>
          {loading ? t('status.loading') : t('action.refresh')}
        </button>
      </header>

      {error !== null
        ? <p className={css.error}>{t('status.error', { message: error })}</p>
        : null}

      {pipeline === null
        ? <p className={css.empty}>{loading ? t('status.loading') : t('panel.empty')}</p>
        : (
          <>
            <p className={css.profile}>
              {pipeline.hasProfile && pipeline.profileName !== undefined
                ? t('profile.present', { name: pipeline.profileName })
                : t('profile.absent')}
            </p>
            <p className={css.jobsCount}>{t('jobs.count', { count: pipeline.jobsCount })}</p>

            <h4 className={css.sectionTitle}>{t('funnel.title')}</h4>
            <ul className={css.funnel}>
              {FUNNEL_ORDER.map(status => (
                <li key={status} className={css.funnelRow} data-zero={(pipeline.applications[status] ?? 0) === 0}>
                  <span className={css.funnelLabel}>{t(`appstatus.${status}`)}</span>
                  <span className={css.funnelCount}>{pipeline.applications[status] ?? 0}</span>
                </li>
              ))}
            </ul>

            <h4 className={css.sectionTitle}>{t('applications.title')}</h4>
            {pipeline.recentApplications.length === 0
              ? <p className={css.empty}>{t('applications.empty')}</p>
              : (
                <ul className={css.list}>
                  {pipeline.recentApplications.map(application => (
                    <li key={application.applicationId} className={css.row}>
                      <span className={css.rowMain} title={`${application.jobTitle} · ${application.company}`}>
                        <span className={css.rowTitle}>{application.jobTitle}</span>
                        <span className={css.rowCompany}>{application.company}{application.stage === undefined ? '' : ` · ${application.stage}`}</span>
                      </span>
                      <span className={css.rowStatus}>{t(`appstatus.${application.status}`)}</span>
                      <span className={css.rowDate}>{formatDate(application.updatedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}

            <h4 className={css.sectionTitle}>{t('jobs.title')}</h4>
            {pipeline.recentJobs.length === 0
              ? <p className={css.empty}>{t('jobs.empty')}</p>
              : (
                <ul className={css.list}>
                  {pipeline.recentJobs.map(job => (
                    <li key={job.jobId} className={css.row}>
                      <span className={css.rowMain} title={`${job.title} · ${job.company}`}>
                        <span className={css.rowTitle}>{job.title}</span>
                        <span className={css.rowCompany}>{job.company}{job.location === undefined ? '' : ` · ${job.location}`}</span>
                      </span>
                      {job.url !== undefined
                        ? (
                          <a
                            className={css.rowLink} href={job.url} target="_blank" rel="noopener noreferrer"
                            title={t('job.url')}
                          >
                            ↗
                          </a>
                        )
                        : null}
                      <span className={css.rowDate}>{formatDate(job.scrapedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
          </>
        )}
    </section>
  )
}
