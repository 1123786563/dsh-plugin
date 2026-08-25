import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from './helpers/memory-backend.ts'
import { JobSearchStore } from '../src/store.ts'
import { TenantId, JobId } from '../src/types.ts'
import type { CandidateProfile, JobRecord } from '../src/types.ts'

/** Boot the real storage/domain composition over an in-memory backend. */
async function harness() {
  const pool = new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const store = new JobSearchStore(ctx)
  await store.init()
  return { ctx, store, pool }
}

function profile(tenantId: string, skills: string[]): CandidateProfile {
  return {
    tenantId: TenantId(tenantId),
    name: 'Ada Lovelace',
    headline: 'Backend engineer',
    contact: { email: 'ada@example.com' },
    summary: 'Backend engineer focused on Python services.',
    skills,
    experience: [],
    education: [],
    languages: [{ language: 'English', level: 'fluent' }],
    preferences: {
      roles: ['backend engineer'],
      locations: ['Remote'],
      remote: true,
      dealBreakers: ['no on-call'],
    },
    createdAt: 1,
    updatedAt: 1,
  }
}

function job(tenantId: string, id: string, title: string, description: string): JobRecord {
  return {
    jobId: JobId(id),
    tenantId: TenantId(tenantId),
    portalId: 'test',
    title,
    company: 'Example Corp',
    description,
    scrapedAt: 1,
  }
}

describe('JobSearchStore', () => {
  it('round-trips a profile', async () => {
    const { store } = await harness()
    await store.putProfile(profile('a', ['Python']))
    expect(store.getProfile(TenantId('a'))?.name).toBe('Ada Lovelace')
  })

  it('isolates jobs by tenant', async () => {
    const { store } = await harness()
    await store.putJob(job('a', 'a-1', 'Backend', 'python api'))
    await store.putJob(job('a', 'a-2', 'Frontend', 'react'))
    await store.putJob(job('b', 'b-1', 'Backend', 'python api'))
    expect(store.listJobs(TenantId('a'))).toHaveLength(2)
    expect(store.listJobs(TenantId('b'))).toHaveLength(1)
    expect(store.listJobs(TenantId('b'))[0]?.jobId).toBe(JobId('b-1'))
  })

  it('counts applications by status within one tenant', async () => {
    const { store } = await harness()
    await store.putJob(job('a', 'a-1', 'Backend', 'python'))
    const application = store.newApplicationId()
    await store.putApplication({
      applicationId: application,
      tenantId: TenantId('a'),
      jobId: JobId('a-1'),
      status: 'applied',
      createdAt: 1,
      updatedAt: 1,
    })
    const counts = store.countApplicationsByStatus(TenantId('a'))
    expect(counts.applied).toBe(1)
    expect(counts.drafted).toBe(0)
  })
})
