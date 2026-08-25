/**
 * Pure domain types of the job-search capability: branded cross-boundary ids
 * and the value records the store and tools exchange. This module holds no
 * runtime code beyond the id factories, so `./types` stays safe for client
 * aggregates that need the wire shapes.
 *
 * Tenant scoping: every job and application carries a {@link TenantId}. The
 * store keys profiles by tenant and filters jobs/applications by the caller's
 * tenant, so one tenant's data never reaches another. The tenant itself is an
 * opaque string supplied by the caller (a hosted gateway maps it to an
 * authenticated account); a single-host deployment falls back to
 * `Config.defaultTenantId`.
 *
 * @module @deepseek-ai/dsh-job-search/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** One isolated job seeker (a SaaS tenant / account). */
export type TenantId = Branded<'job-search-tenant'>
/** One scraped job posting. */
export type JobId = Branded<'job-search-job'>
/** One tracked application targeting a job. */
export type ApplicationId = Branded<'job-search-application'>

/** Brand a string as a {@link TenantId}. */
export function TenantId(id: string): TenantId {
  return id as TenantId
}

/** Brand a string as a {@link JobId}. */
export function JobId(id: string): JobId {
  return id as JobId
}

/** Brand a string as an {@link ApplicationId}. */
export function ApplicationId(id: string): ApplicationId {
  return id as ApplicationId
}

/** One employment history entry. */
export interface ExperienceEntry {
  /** Company or organization. */
  company: string
  /** Role title. */
  title: string
  /** Start date, free-form or ISO (e.g. `2021-03`). */
  start: string
  /** End date, `present` or ISO. */
  end: string
  /** Concrete achievements and responsibilities. */
  highlights: string[]
}

/** One education entry. */
export interface EducationEntry {
  school: string
  degree: string
  field: string
  /** Graduation year, free-form or ISO. */
  end: string
}

/** One declared working language and its level. */
export interface LanguageEntry {
  language: string
  /** Self-declared level, e.g. `native`, `fluent`, `B2`. */
  level: string
}

/** A candidate's durable profile, the anchor for every fit evaluation. */
export interface CandidateProfile {
  tenantId: TenantId
  name: string
  headline: string
  contact: {
    email: string
    phone?: string
    location?: string
    links?: string[]
  }
  summary: string
  skills: string[]
  experience: ExperienceEntry[]
  education: EducationEntry[]
  languages: LanguageEntry[]
  preferences: {
    /** Target role titles or families. */
    roles: string[]
    /** Target locations. */
    locations: string[]
    /** Whether remote work is acceptable. */
    remote: boolean
    /** Hard requirements a posting must satisfy to be considered. */
    dealBreakers: string[]
    /** Free-form salary expectation, e.g. `>= 30k CNY/month`. */
    salary?: string
  }
  createdAt: number
  updatedAt: number
}

/** One scraped job posting, tenant-scoped and stored durably. */
export interface JobRecord {
  jobId: JobId
  tenantId: TenantId
  /** Portal adapter that produced this posting. */
  portalId: string
  title: string
  company: string
  location?: string
  url?: string
  description: string
  salary?: string
  /** Epoch millis the posting was first published, when the portal reports it. */
  postedAt?: number
  /** Epoch millis this record was scraped. */
  scrapedAt: number
}

/** The lifecycle status of one tracked application. */
export type ApplicationStatus =
  | 'drafted'
  | 'applied'
  | 'interview'
  | 'offer'
  | 'rejected'
  | 'withdrawn'

/** One tracked application, tenant-scoped. */
export interface ApplicationRecord {
  applicationId: ApplicationId
  tenantId: TenantId
  jobId: JobId
  status: ApplicationStatus
  /** Optional interview stage or free-form detail (e.g. `2nd round`). */
  stage?: string
  /** Fit score captured when the application was drafted, 0–100. */
  fitScore?: number
  /** Free-form notes recorded by the candidate or the outcome tool. */
  notes?: string
  createdAt: number
  updatedAt: number
}

/** A fit evaluation over one posting against a profile. */
export interface FitEvaluation {
  jobId: JobId
  /** 0–100 composite score. */
  score: number
  /** Skills the profile supports and the posting asks for. */
  matchedSkills: string[]
  /** Posting skills the profile does not declare. */
  missingSkills: string[]
  /** Deal-breakers the posting violates, when any. */
  violatedDealBreakers: string[]
  /** Human-readable strengths and gaps for the model to reuse. */
  strengths: string[]
  gaps: string[]
}

/** Wire view of one recent scraped job, capped by the pipeline view's list bound. */
export interface PipelineJobView {
  jobId: string
  title: string
  company: string
  location?: string
  url?: string
  scrapedAt: number
}

/** Wire view of one recent tracked application, joined with its job's title and company. */
export interface PipelineApplicationView {
  applicationId: string
  jobTitle: string
  company: string
  status: ApplicationStatus
  stage?: string
  updatedAt: number
}

/** Wire view of one tenant's whole pipeline, the dashboard's single read. */
export interface JobSearchPipelineView {
  tenantId: string
  hasProfile: boolean
  profileName?: string
  jobsCount: number
  applications: Record<ApplicationStatus, number>
  recentJobs: PipelineJobView[]
  recentApplications: PipelineApplicationView[]
}
