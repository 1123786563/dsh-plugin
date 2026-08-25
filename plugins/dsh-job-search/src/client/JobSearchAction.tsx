/**
 * The session-header job-search dashboard entry: a trigger (visible only once
 * the tenant's pipeline carries content) opening a popover with the profile
 * line, application funnel, and capped recent jobs/applications. All live
 * data arrives through the `usePipeline` hook the client entry binds from the
 * shared controller; props are duck-typed to keep the client bundle free of
 * host module imports.
 *
 * @module dsh-job-search/client/JobSearchAction
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { JobSearchDashboardView } from './controller.ts'
import type { JobSearchPipelineView } from '../types.ts'
import { dictionary, format } from './locales.ts'
import css from './JobSearchAction.module.css'

/** Copy reader: unknown keys fall back to the key itself (never crashes a render). */
type T = (key: string, params?: Record<string, string | number>) => string

/** Application status vocabulary carried on the wire. */
type AppStatus = 'drafted' | 'applied' | 'interview' | 'offer' | 'rejected' | 'withdrawn'

/** Props the slot renderer binds: the locale seat and the injected face. */
export interface JobSearchActionProps {
  t?: T
  usePipeline?: <V>(select: (view: JobSearchDashboardView) => V) => V
  refresh?: () => Promise<void>
}

const FUNNEL_ORDER: readonly AppStatus[] = [
  'drafted', 'applied', 'interview', 'offer', 'rejected', 'withdrawn',
]

/** Whether the pipeline carries anything worth a header control. */
function hasContent(pipeline: JobSearchPipelineView | null): boolean {
  if (pipeline === null) return false
  if (pipeline.hasProfile || pipeline.jobsCount > 0) return true
  return FUNNEL_ORDER.some(status => (pipeline.applications[status] ?? 0) > 0)
}

/** Stable `YYYY-MM-DD` from epoch millis; keeps rendering locale-independent. */
function formatDate(epochMillis: number): string {
  const date = new Date(epochMillis)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Chevron icon, inlined so the bundle imports no icon package. */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"
      className={open ? css.triggerOpen : undefined}
    >
      <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * The session-header job-search dashboard entry.
 * @param props - the locale seat plus the pipeline hook and refresh verb.
 * @returns the trigger and its popover panel, or null while there is nothing to show.
 */
export function JobSearchAction({ t, usePipeline, refresh }: JobSearchActionProps) {
  const dict = dictionary() as Record<string, string>
  const translate = (key: string, params?: Record<string, string | number>): string => {
    const seated = t
    if (seated !== undefined) return seated(key, params)
    const raw = dict[key] ?? key
    return params === undefined ? raw : format(raw, params)
  }
  const view = usePipeline !== undefined ? usePipeline(snapshot => snapshot) : undefined
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Outside-pointer dismiss (no hook import: a plain document listener).
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [open])

  const pipeline = view?.pipeline ?? null
  const visible = useMemo(() => hasContent(pipeline), [pipeline])
  const loading = view?.status === 'loading'

  useEffect(() => {
    if (!visible && open) setOpen(false)
  }, [visible, open])

  if (!visible) return null

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div ref={rootRef} className={css.root} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-expanded={open}
        aria-label={translate('panel.aria')}
        onClick={() => { setOpen(current => !current) }}
      >
        <span className={css.count}>{loading ? translate('status.loading') : translate('trigger')}</span>
        <Chevron open={open} />
      </button>
      {open && pipeline !== null
        ? (
          <div className={css.menu} aria-label={translate('panel.aria')}>
            <p className={css.profile}>
              {pipeline.hasProfile && pipeline.profileName !== undefined
                ? translate('profile.present', { name: pipeline.profileName })
                : translate('profile.absent')}
            </p>
            <p className={css.jobsCount}>{translate('jobs.count', { count: pipeline.jobsCount })}</p>
            <h4 className={css.sectionTitle}>{translate('funnel.title')}</h4>
            <p className={css.funnel}>
              {FUNNEL_ORDER.map(status => translate(`funnel.${status}`, {
                count: pipeline.applications[status] ?? 0,
              })).join('\u2002·\u2002')}
            </p>
            <h4 className={css.sectionTitle}>{translate('applications.title')}</h4>
            {pipeline.recentApplications.length === 0
              ? <p className={css.empty}>{translate('applications.empty')}</p>
              : (
                <ul className={css.list}>
                  {pipeline.recentApplications.map(application => (
                    <li key={application.applicationId} className={css.row}>
                      <span className={css.rowMain} title={`${application.jobTitle} · ${application.company}`}>
                        <span className={css.rowTitle}>{application.jobTitle}</span>
                        <span className={css.rowCompany}>{application.company}</span>
                      </span>
                      <span className={css.rowStatus}>{translate(`appstatus.${application.status}`)}</span>
                      <span className={css.rowDate}>{formatDate(application.updatedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            <h4 className={css.sectionTitle}>{translate('jobs.title')}</h4>
            {pipeline.recentJobs.length === 0
              ? <p className={css.empty}>{translate('jobs.empty')}</p>
              : (
                <ul className={css.list}>
                  {pipeline.recentJobs.map(job => (
                    <li key={job.jobId} className={css.row}>
                      <span className={css.rowMain} title={`${job.title} · ${job.company}`}>
                        <span className={css.rowTitle}>{job.title}</span>
                        <span className={css.rowCompany}>{job.company}</span>
                      </span>
                      {job.url !== undefined
                        ? (
                          <a className={css.rowLink} href={job.url} target="_blank" rel="noopener noreferrer">
                            {translate('job.url')}
                          </a>
                        )
                        : null}
                      <span className={css.rowDate}>{formatDate(job.scrapedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            {view?.status === 'error' && view.error !== null
              ? <p className={css.error}>{translate('status.error', { message: view.error })}</p>
              : null}
            {refresh !== undefined
              ? (
                <button type="button" className={css.refresh} onClick={() => { void refresh() }}>
                  {translate('action.refresh')}
                </button>
              )
              : null}
          </div>
        )
        : null}
    </div>
  )
}
