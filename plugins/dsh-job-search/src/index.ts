/**
 * Job search capability, standalone-bundle form: a tenant-isolated
 * candidate/job/application store over the storage-domain form, a pluggable
 * portal-adapter seam, the model-facing tools (`job_search_setup`,
 * `job_search_scrape`, `job_search_rank`, `job_search_apply`,
 * `job_search_interview_prep`, `job_search_outcome`), and one read-only
 * `/plugins/dsh-job-search/pipeline.json` route the browser dashboard fetches.
 * The plugin mounts as a Cordis Service under `ctx.jobSearch`.
 *
 * @module dsh-job-search
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { JsonFeedPortal, PortalRegistry } from './portals.ts'
import { mountPipelineRoute, PIPELINE_PATH } from './routes.ts'
import type { JobSearchWebServer } from './routes.ts'
import { JobSearchStore } from './store.ts'
import { registerTools } from './tools.ts'
import { Config } from './config.ts'
import type { Config as ConfigType, ToolConfig } from './config.ts'
import type { JobSearchPipelineView, TenantId } from './types.ts'

export type * from './types.ts'
export { TenantId, JobId, ApplicationId } from './types.ts'
export { jobSearchDomainSpec, profileSchema, jobRecordSchema, applicationRecordSchema } from './spec.ts'
export { JobSearchStore } from './store.ts'
export { PortalRegistry, JsonFeedPortal, PortalSearchError } from './portals.ts'
export type { PortalAdapter, JobDraft, PortalSearchRequest } from './portals.ts'
export type { PortalConfig, ToolConfig } from './config.ts'
export { Config } from './config.ts'
export { mountPipelineRoute, PIPELINE_PATH } from './routes.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    jobSearch: JobSearchService
  }
}

/** How many recent items each pipeline list carries. */
const RECENT_LIMIT = 8

/**
 * The job-search Service: opens the tenant-isolated store, registers the
 * model-facing tools over the enabled portal adapters, and (when a webServer
 * exists) serves the read-only pipeline route for the browser dashboard.
 */
export class JobSearchService extends Service {
  static inject = ['storageDomain', 'tools']

  /** Loader validation for the default tenant and portal list. */
  static Config = Config

  private readonly config: ConfigType
  private storeImpl?: JobSearchStore

  /**
   * @param ctx - Host context carrying the storage-domain form and tool registry.
   * @param config - default tenant and portal list.
   */
  constructor(ctx: Context, config: ConfigType) {
    super(ctx, 'jobSearch')
    this.config = config
  }

  /** Open the domain, register the tools, and keep both on this Service's fiber. */
  protected async [Service.init](): Promise<void> {
    const store = new JobSearchStore(this.ctx)
    await store.init()
    this.storeImpl = store
    const adapters = this.config.portals
      .filter(portal => portal.enabled)
      .map(portal => new JsonFeedPortal(portal.id, portal.label, portal.searchUrl))
    const toolConfig: ToolConfig = { defaultTenantId: this.config.defaultTenantId }
    this.ctx.effect(() => registerTools(this.ctx, store, new PortalRegistry(adapters), toolConfig), 'job-search: tools')

    // Sentinel inject: headless profiles without a webServer still load the
    // tools; a web profile additionally serves the dashboard route.
    this.ctx.inject(['webServer'], (scoped) => {
      scoped.effect(() => mountPipelineRoute((scoped as unknown as { webServer: unknown }).webServer as JobSearchWebServer, this), 'job-search: pipeline route')
    })
  }

  /** The tenant-isolated store this Service opened; undefined before init. */
  get store(): JobSearchStore | undefined {
    return this.storeImpl
  }

  /**
   * One tenant's whole pipeline for the dashboard: profile presence, job
   * count, the application status histogram, and capped recent lists. An
   * omitted tenant resolves to the deployment's default tenant; an unknown
   * tenant is a valid empty pipeline, not a failure.
   * @param request - the tenant to read (default tenant when omitted).
   * @returns the tenant's current pipeline snapshot.
   */
  async pipeline(request: { tenantId?: string }): Promise<JobSearchPipelineView> {
    const store = this.requireStore()
    const resolved = request.tenantId ?? this.config.defaultTenantId
    const tenantId = resolved as TenantId
    const profile = store.getProfile(tenantId)
    const jobs = store.listJobs(tenantId)
    const applications = store.listApplications(tenantId)
    return {
      tenantId: resolved,
      hasProfile: profile !== undefined,
      ...(profile === undefined ? {} : { profileName: profile.name }),
      jobsCount: jobs.length,
      applications: store.countApplicationsByStatus(tenantId),
      recentJobs: jobs.slice(0, RECENT_LIMIT).map(job => ({
        jobId: job.jobId,
        title: job.title,
        company: job.company,
        ...(job.location === undefined ? {} : { location: job.location }),
        ...(job.url === undefined ? {} : { url: job.url }),
        scrapedAt: job.scrapedAt,
      })),
      recentApplications: applications.slice(0, RECENT_LIMIT).map((application) => {
        const job = store.getJob(application.jobId)
        return {
          applicationId: application.applicationId,
          jobTitle: job?.title ?? '',
          company: job?.company ?? '',
          status: application.status,
          ...(application.stage === undefined ? {} : { stage: application.stage }),
          updatedAt: application.updatedAt,
        }
      }),
    }
  }

  /** Resolve the initialized store or fail a broken service lifecycle. */
  private requireStore(): JobSearchStore {
    if (this.storeImpl === undefined) {
      throw new Error('job-search: durable store is not initialized')
    }
    return this.storeImpl
  }
}

export default JobSearchService
