/**
 * Durable storage-domain declaration for job search: identity, layout, and
 * record schemas. Zod is the durable-boundary validator; branded ids are
 * plain strings on the medium, re-branded by the transform below.
 *
 * @module @deepseek-ai/dsh-job-search/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type {
  ApplicationId,
  ApplicationRecord,
  ApplicationStatus,
  CandidateProfile,
  JobId,
  JobRecord,
  TenantId,
} from './types.ts'

const nonNegativeSafeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/** Tenant id at the durable boundary. */
const tenantId = z.string().min(1).transform(value => value as TenantId)
/** Job id at the durable boundary. */
const jobId = z.string().min(1).transform(value => value as JobId)
/** Application id at the durable boundary. */
const applicationId = z.string().min(1).transform(value => value as ApplicationId)

const languageSchema = z.object({
  language: z.string().min(1),
  level: z.string().min(1),
})

const experienceSchema = z.object({
  company: z.string().min(1),
  title: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1),
  highlights: z.array(z.string().min(1)),
})

const educationSchema = z.object({
  school: z.string().min(1),
  degree: z.string().min(1),
  field: z.string().min(1),
  end: z.string().min(1),
})

/** Durable schema for one candidate profile. */
export const profileSchema = z.object({
  tenantId,
  name: z.string().min(1),
  headline: z.string(),
  contact: z.object({
    email: z.string().min(1),
    phone: z.string().optional(),
    location: z.string().optional(),
    links: z.array(z.string()).optional(),
  }),
  summary: z.string(),
  skills: z.array(z.string().min(1)),
  experience: z.array(experienceSchema),
  education: z.array(educationSchema),
  languages: z.array(languageSchema),
  preferences: z.object({
    roles: z.array(z.string().min(1)),
    locations: z.array(z.string().min(1)),
    remote: z.boolean(),
    dealBreakers: z.array(z.string().min(1)),
    salary: z.string().optional(),
  }),
  createdAt: nonNegativeSafeInteger,
  updatedAt: nonNegativeSafeInteger,
}) as unknown as z.ZodType<CandidateProfile>

/** Durable schema for one scraped job record. */
export const jobRecordSchema = z.object({
  jobId,
  tenantId,
  portalId: z.string().min(1),
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string().optional(),
  url: z.string().optional(),
  description: z.string(),
  salary: z.string().optional(),
  postedAt: nonNegativeSafeInteger.optional(),
  scrapedAt: nonNegativeSafeInteger,
}) as unknown as z.ZodType<JobRecord>

/** Durable schema for the closed application-status vocabulary. */
const applicationStatusSchema = z.union([
  z.literal('drafted'),
  z.literal('applied'),
  z.literal('interview'),
  z.literal('offer'),
  z.literal('rejected'),
  z.literal('withdrawn'),
]) satisfies z.ZodType<ApplicationStatus>

/** Durable schema for one tracked application. */
export const applicationRecordSchema = z.object({
  applicationId,
  tenantId,
  jobId,
  status: applicationStatusSchema,
  stage: z.string().optional(),
  fitScore: z.number().int().min(0).max(100).optional(),
  notes: z.string().optional(),
  createdAt: nonNegativeSafeInteger,
  updatedAt: nonNegativeSafeInteger,
}) as unknown as z.ZodType<ApplicationRecord>

/**
 * The job-search domain. Profiles are keyed by tenant; jobs and applications
 * are keyed by their own ids and carry `tenantId` so queries filter by tenant.
 */
export const jobSearchDomainSpec = defineDomain({
  name: 'job_search',
  version: 0,
  tables: {
    profiles: domainTable<TenantId, CandidateProfile>(profileSchema),
    jobs: domainTable<JobId, JobRecord>(jobRecordSchema),
    applications: domainTable<ApplicationId, ApplicationRecord>(applicationRecordSchema),
  },
})
