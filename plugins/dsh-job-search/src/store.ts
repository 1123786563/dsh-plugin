/**
 * The job-search store (`ctx.jobSearch`): tenant-isolated read/write over the
 * `job_search` storage domain. Every mutation returns an owned snapshot — the
 * storage-domain returns stored objects directly, so this service copies
 * before they cross its boundary. Queries always filter by the caller's
 * {@link TenantId}; there is no path that lists another tenant's rows.
 *
 * @module @deepseek-ai/dsh-job-search/src/store
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { jobSearchDomainSpec } from './spec.ts'
import type {
  ApplicationId,
  ApplicationRecord,
  ApplicationStatus,
  CandidateProfile,
  JobId,
  JobRecord,
  TenantId,
} from './types.ts'
import { ApplicationId as brandApplicationId, JobId as brandJobId } from './types.ts'

/** Copy one profile so storage-domain never exposes a mutable alias. */
function snapshotProfile(profile: CandidateProfile): CandidateProfile {
  return {
    ...profile,
    contact: { ...profile.contact, ...(profile.contact.links === undefined ? {} : { links: [...profile.contact.links] }) },
    skills: [...profile.skills],
    experience: profile.experience.map(entry => ({ ...entry, highlights: [...entry.highlights] })),
    education: profile.education.map(entry => ({ ...entry })),
    languages: profile.languages.map(entry => ({ ...entry })),
    preferences: {
      ...profile.preferences,
      roles: [...profile.preferences.roles],
      locations: [...profile.preferences.locations],
      dealBreakers: [...profile.preferences.dealBreakers],
    },
  }
}

/** Copy one job record. */
function snapshotJob(job: JobRecord): JobRecord {
  return { ...job }
}

/** Copy one application record. */
function snapshotApplication(application: ApplicationRecord): ApplicationRecord {
  return { ...application }
}

/**
 * Tenant-isolated durable store for candidate profiles, scraped jobs, and
 * tracked applications. Opens the `job_search` domain on init and owns its
 * close through the plugin fiber.
 */
export class JobSearchStore {
  private profiles?: KvTable<TenantId, CandidateProfile>
  private jobs?: KvTable<JobId, JobRecord>
  private applications?: KvTable<ApplicationId, ApplicationRecord>

  /**
   * @param ctx - Host context carrying the storage-domain facility.
   */
  constructor(private readonly ctx: Context) {}

  /** Open the domain and own its close. Must run before any read or write. */
  async init(): Promise<void> {
    const domain = await this.ctx.storageDomain.open(jobSearchDomainSpec)
    this.profiles = domain.table('profiles')
    this.jobs = domain.table('jobs')
    this.applications = domain.table('applications')
    this.ctx.effect(() => () => domain.close(), 'job-search.domainClose')
  }

  /** Read the candidate profile for one tenant, or `undefined`. */
  getProfile(tenantId: TenantId): CandidateProfile | undefined {
    const profile = this.requireProfiles().get(tenantId)
    return profile === undefined ? undefined : snapshotProfile(profile)
  }

  /** Create or replace one tenant's candidate profile. */
  async putProfile(profile: CandidateProfile): Promise<CandidateProfile> {
    await this.requireProfiles().put(profile.tenantId, snapshotProfile(profile))
    return snapshotProfile(profile)
  }

  /** Read one job by id, or `undefined`. */
  getJob(jobId: JobId): JobRecord | undefined {
    const job = this.requireJobs().get(jobId)
    return job === undefined ? undefined : snapshotJob(job)
  }

  /** Insert or replace one job record. */
  async putJob(job: JobRecord): Promise<JobRecord> {
    await this.requireJobs().put(job.jobId, snapshotJob(job))
    return snapshotJob(job)
  }

  /** List one tenant's jobs, newest first. */
  listJobs(tenantId: TenantId): JobRecord[] {
    const rows: JobRecord[] = []
    for (const [, job] of this.requireJobs().entries()) {
      if (job.tenantId === tenantId) rows.push(snapshotJob(job))
    }
    return rows.sort((left, right) => right.scrapedAt - left.scrapedAt)
  }

  /** Read one application by id, or `undefined`. */
  getApplication(applicationId: ApplicationId): ApplicationRecord | undefined {
    const application = this.requireApplications().get(applicationId)
    return application === undefined ? undefined : snapshotApplication(application)
  }

  /** Insert or replace one application record. */
  async putApplication(application: ApplicationRecord): Promise<ApplicationRecord> {
    await this.requireApplications().put(application.applicationId, snapshotApplication(application))
    return snapshotApplication(application)
  }

  /** List one tenant's applications, newest first. */
  listApplications(tenantId: TenantId): ApplicationRecord[] {
    const rows: ApplicationRecord[] = []
    for (const [, application] of this.requireApplications().entries()) {
      if (application.tenantId === tenantId) rows.push(snapshotApplication(application))
    }
    return rows.sort((left, right) => right.updatedAt - left.updatedAt)
  }

  /** Count one tenant's applications grouped by status. */
  countApplicationsByStatus(tenantId: TenantId): Record<ApplicationStatus, number> {
    const counts: Record<ApplicationStatus, number> = {
      drafted: 0,
      applied: 0,
      interview: 0,
      offer: 0,
      rejected: 0,
      withdrawn: 0,
    }
    for (const application of this.listApplications(tenantId)) counts[application.status]++
    return counts
  }

  /** Build an id for a newly scraped job, unique within this process. */
  newJobId(): JobId {
    return brandJobId(randomUUID())
  }

  /** Build an id for a newly tracked application. */
  newApplicationId(): ApplicationId {
    return brandApplicationId(randomUUID())
  }

  private requireProfiles(): KvTable<TenantId, CandidateProfile> {
    if (this.profiles === undefined) throw new Error('job-search: store is not initialized')
    return this.profiles
  }

  private requireJobs(): KvTable<JobId, JobRecord> {
    if (this.jobs === undefined) throw new Error('job-search: store is not initialized')
    return this.jobs
  }

  private requireApplications(): KvTable<ApplicationId, ApplicationRecord> {
    if (this.applications === undefined) throw new Error('job-search: store is not initialized')
    return this.applications
  }
}
