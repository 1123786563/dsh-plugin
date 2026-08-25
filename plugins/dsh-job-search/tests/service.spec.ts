import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import JobSearchService from '../src/index.ts'
import { mountPipelineRoute, PIPELINE_PATH } from '../src/routes.ts'
import type { JobSearchWebServer, JobSearchServerResponse } from '../src/routes.ts'
import { JobSearchDashboardController, PIPELINE_URL } from '../src/client/controller.ts'
import { TenantId, JobId } from '../src/types.ts'
import type { CandidateProfile, JobRecord } from '../src/types.ts'

/** Boot the real storage/domain composition plus the Service. */
async function harness() {
  const pool = new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const registered: { name: string }[] = []
  ctx.provide('tools', {
    register: (tool: { name: string }) => {
      registered.push(tool)
      return () => {}
    },
  } as never)
  const fiber = ctx.plugin(JobSearchService, { defaultTenantId: 'default', portals: [] })
  await fiber.await()
  return { ctx, fiber, registered, service: ctx.jobSearch }
}

function profile(tenantId: string): CandidateProfile {
  return {
    tenantId: TenantId(tenantId),
    name: 'Ada Lovelace',
    headline: 'Backend engineer',
    contact: { email: 'ada@example.com' },
    summary: 'Backend engineer.',
    skills: ['Python'],
    experience: [],
    education: [],
    languages: [],
    preferences: { roles: [], locations: [], remote: true, dealBreakers: [] },
    createdAt: 1,
    updatedAt: 1,
  }
}

function job(tenantId: string, id: string, title: string): JobRecord {
  return {
    jobId: JobId(id),
    tenantId: TenantId(tenantId),
    portalId: 'test',
    title,
    company: 'Example Corp',
    description: 'python',
    scrapedAt: 1,
  }
}

/** Record the responses one route handler produced. */
function fakeWebServer(): { webServer: JobSearchWebServer; served: { status: number; body: string }[] } {
  const served: { status: number; body: string }[] = []
  return {
    served,
    webServer: {
      register: (route) => {
        const handler = route.handler
        // Re-dispatch through the original register shape by invoking the
        // captured handler on demand: tests call dispatch() explicitly.
        capturedHandler = handler
        return () => { capturedHandler = undefined }
      },
    },
  }
}

let capturedHandler: ((req: { method?: string, url?: string }, res: JobSearchServerResponse) => void) | undefined

/** Dispatch one request to the captured handler and await its async body. */
async function dispatch(url: string): Promise<{ status: number; body: string }> {
  if (capturedHandler === undefined) throw new Error('no route mounted')
  const result = { status: 0, body: '' }
  const settled = new Promise<void>(resolve => {
    const response: JobSearchServerResponse = {
      writeHead: (status: number) => { result.status = status },
      end: (body: string) => { result.body = body; resolve() },
    }
    capturedHandler({ method: 'GET', url }, response)
  })
  await Promise.race([settled, new Promise<void>(resolve => { setTimeout(resolve, 1000) })])
  return result
}

describe('JobSearchService', () => {
  it('registers every model-facing tool on init', async () => {
    const { registered } = await harness()
    expect(registered.map(tool => tool.name)).toEqual([
      'job_search_setup',
      'job_search_scrape',
      'job_search_rank',
      'job_search_apply',
      'job_search_interview_prep',
      'job_search_outcome',
    ])
  })

  it('pipeline() reports an empty default tenant without failure', async () => {
    const { service } = await harness()
    const view = await service.pipeline({})
    expect(view.tenantId).toBe('default')
    expect(view.hasProfile).toBe(false)
    expect(view.jobsCount).toBe(0)
    expect(view.recentJobs).toEqual([])
    expect(view.recentApplications).toEqual([])
  })

  it('pipeline() reads one tenant and joins applications with their jobs', async () => {
    const { service } = await harness()
    const store = service.store
    if (store === undefined) throw new Error('store missing')
    await store.putProfile(profile('default'))
    await store.putJob(job('default', 'j1', 'Backend'))
    const applicationId = store.newApplicationId()
    await store.putApplication({
      applicationId,
      tenantId: TenantId('default'),
      jobId: JobId('j1'),
      status: 'applied',
      stage: '1st round',
      createdAt: 1,
      updatedAt: 5,
    })
    const view = await service.pipeline({})
    expect(view.hasProfile).toBe(true)
    expect(view.profileName).toBe('Ada Lovelace')
    expect(view.jobsCount).toBe(1)
    expect(view.applications.applied).toBe(1)
    expect(view.recentApplications[0]).toMatchObject({
      applicationId,
      jobTitle: 'Backend',
      company: 'Example Corp',
      status: 'applied',
      stage: '1st round',
    })
  })

  it('serves the pipeline route with tenant validation', async () => {
    const { service, ctx } = await harness()
    const { webServer } = fakeWebServer()
    const dispose = mountPipelineRoute(webServer, service)
    await service.store?.putProfile(profile('default'))

    const ok = await dispatch(`${PIPELINE_PATH}?tenant=default`)
    expect(ok.status).toBe(200)
    expect(JSON.parse(ok.body).profileName).toBe('Ada Lovelace')

    const bad = await dispatch(`${PIPELINE_PATH}?tenant=${encodeURIComponent('bad/tenant')}`)
    expect(bad.status).toBe(400)

    dispose()
  })

  it('fiber teardown closes the domain', async () => {
    const { ctx, fiber } = await harness()
    expect(ctx.get('storageDomain')?.get('job_search')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('storageDomain')?.get('job_search')).toBeUndefined()
  })
})

describe('JobSearchDashboardController', () => {
  it('publishes the ready view from a successful fetch', async () => {
    const controller = new JobSearchDashboardController(async (url) => {
      expect(url).toBe(PIPELINE_URL)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tenantId: 'default', hasProfile: false, jobsCount: 0,
          applications: { drafted: 0, applied: 0, interview: 0, offer: 0, rejected: 0, withdrawn: 0 },
          recentJobs: [], recentApplications: [],
        }),
      }
    })
    await controller.ensure()
    expect(controller.getSnapshot().status).toBe('ready')
    controller.dispose()
  })

  it('publishes an error view on a failing fetch and recovers on refresh', async () => {
    let failing = true
    const controller = new JobSearchDashboardController(async () => {
      if (failing) return { ok: false, status: 503, json: async () => ({}) }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tenantId: 'default', hasProfile: true, profileName: 'Ada', jobsCount: 0,
          applications: { drafted: 0, applied: 0, interview: 0, offer: 0, rejected: 0, withdrawn: 0 },
          recentJobs: [], recentApplications: [],
        }),
      }
    })
    await controller.refresh()
    expect(controller.getSnapshot().status).toBe('error')
    expect(controller.getSnapshot().error).toBe('HTTP 503')
    failing = false
    await controller.refresh()
    expect(controller.getSnapshot().status).toBe('ready')
    controller.dispose()
  })

  it('collapses concurrent ensure calls into one request', async () => {
    let calls = 0
    const controller = new JobSearchDashboardController(async () => {
      calls++
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tenantId: 'default', hasProfile: false, jobsCount: 0,
          applications: { drafted: 0, applied: 0, interview: 0, offer: 0, rejected: 0, withdrawn: 0 },
          recentJobs: [], recentApplications: [],
        }),
      }
    })
    await Promise.all([controller.ensure(), controller.ensure(), controller.ensure()])
    expect(calls).toBe(1)
    controller.dispose()
  })
})
