/**
 * Model-facing job-search tools. The model supplies a tenant id (or the
 * deployment default applies); the store enforces that isolation. Generation
 * tools (`apply`, `interview_prep`) return an assembled brief and fit
 * evaluation — the model in the session writes the actual CV, cover letter,
 * and answers using that context, mirroring the drafter role of the original
 * workflow.
 *
 * @module @deepseek-ai/dsh-job-search/src/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PortalRegistry } from './portals.ts'
import type { ToolConfig } from './config.ts'
import type { JobSearchStore } from './store.ts'
import type {
  ApplicationRecord,
  ApplicationStatus,
  CandidateProfile,
  FitEvaluation,
  JobRecord,
  TenantId,
} from './types.ts'
import {
  ApplicationId as brandApplicationId,
  JobId as brandJobId,
  TenantId as brandTenantId,
} from './types.ts'

const APPLICATION_STATUSES: ApplicationStatus[] = [
  'drafted', 'applied', 'interview', 'offer', 'rejected', 'withdrawn',
]

/** Resolve the tenant one call targets: explicit arg, else the deployment default. */
function resolveTenant(args: { tenant_id?: string }, config: ToolConfig): TenantId {
  return brandTenantId(args.tenant_id ?? config.defaultTenantId)
}

/** Lowercase the text for case-insensitive matching. */
function normalize(text: string): string {
  return text.toLowerCase()
}

/** Whether a profile skill token appears in the posting text. */
function skillMatches(skill: string, haystack: string): boolean {
  const token = normalize(skill).trim()
  if (token.length === 0) return false
  return normalize(haystack).includes(token)
}

/**
 * Heuristic fit evaluation: skill overlap, role-title overlap, location
 * overlap, and deal-breaker violations. This is a deterministic first pass for
 * ranking; a human or the model refines it. `missingSkills` is empty because
 * inferring a posting's required skills from free text needs NLP, which is
 * deferred.
 */
function evaluateFit(profile: CandidateProfile | undefined, job: JobRecord): FitEvaluation {
  const haystack = `${job.title}\n${job.description}`
  const matchedSkills = profile?.skills.filter(skill => skillMatches(skill, haystack)) ?? []
  const roleMatch = profile?.preferences.roles.some(role => skillMatches(role, job.title)) ?? false
  const locationMatch = profile?.preferences.locations.some(location =>
    job.location !== undefined && skillMatches(location, job.location),
  ) ?? false
  const violatedDealBreakers = profile?.preferences.dealBreakers.filter(term => skillMatches(term, haystack)) ?? []

  let score = 20 + Math.min(matchedSkills.length, 8) * 8 + (roleMatch ? 16 : 0) + (locationMatch ? 8 : 0)
  score = Math.max(0, Math.min(100, score))

  return {
    jobId: job.jobId,
    score,
    matchedSkills,
    missingSkills: [],
    violatedDealBreakers,
    strengths: matchedSkills.map(skill => `declares skill "${skill}" the posting asks for`),
    gaps: violatedDealBreakers.map(term => `violates deal-breaker "${term}"`),
  }
}

/** Build the canonical `CandidateProfile` from a setup call's input. */
function toProfile(input: SetupProfileInput, tenantId: TenantId, now: number): CandidateProfile {
  return {
    tenantId,
    name: input.name,
    headline: input.headline,
    contact: {
      email: input.contact.email,
      ...(input.contact.phone === undefined ? {} : { phone: input.contact.phone }),
      ...(input.contact.location === undefined ? {} : { location: input.contact.location }),
      ...(input.contact.links === undefined ? {} : { links: input.contact.links }),
    },
    summary: input.summary,
    skills: input.skills,
    experience: input.experience,
    education: input.education,
    languages: input.languages,
    preferences: {
      roles: input.preferences.roles,
      locations: input.preferences.locations,
      remote: input.preferences.remote,
      dealBreakers: input.preferences.dealBreakers,
      ...(input.preferences.salary === undefined ? {} : { salary: input.preferences.salary }),
    },
    createdAt: now,
    updatedAt: now,
  }
}

/** The model-supplied profile body (tenant id and timestamps are stamped). */
interface SetupProfileInput {
  name: string
  headline: string
  contact: { email: string; phone?: string; location?: string; links?: string[] }
  summary: string
  skills: string[]
  experience: { company: string; title: string; start: string; end: string; highlights: string[] }[]
  education: { school: string; degree: string; field: string; end: string }[]
  languages: { language: string; level: string }[]
  preferences: {
    roles: string[]
    locations: string[]
    remote: boolean
    dealBreakers: string[]
    salary?: string
  }
}

/**
 * Register every job-search tool.
 * @param ctx - Host context carrying the tool registry.
 * @param store - tenant-isolated store.
 * @param portals - enabled portal registry.
 * @param config - deployment policy (default tenant).
 * @returns the disposer that unregisters every tool this call registered.
 */
export function registerTools(
  ctx: Context,
  store: JobSearchStore,
  portals: PortalRegistry,
  config: ToolConfig,
): () => void {
  const disposers: Array<() => void> = []
  const register = (tool: Parameters<Context['tools']['register']>[0]): void => {
    disposers.push(ctx.tools.register(tool))
  }
  register(defineTool({
    name: 'job_search_setup',
    description:
      'Create or replace the candidate profile for one tenant. The profile anchors every fit '
      + 'evaluation; richer input produces sharper tailored output. Send the whole profile each call.',
    parameters: {
      profile: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true, description: 'Full name.' },
          headline: { type: 'string', required: true, description: 'One-line professional headline.' },
          contact: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              email: { type: 'string', required: true },
              phone: { type: 'string' },
              location: { type: 'string' },
              links: { type: 'array', items: { type: 'string' } },
            },
          },
          summary: { type: 'string', required: true, description: 'Career summary paragraph.' },
          skills: { type: 'array', required: true, items: { type: 'string' }, description: 'Skills, in context when possible.' },
          experience: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                company: { type: 'string', required: true },
                title: { type: 'string', required: true },
                start: { type: 'string', required: true },
                end: { type: 'string', required: true },
                highlights: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
          education: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                school: { type: 'string', required: true },
                degree: { type: 'string', required: true },
                field: { type: 'string', required: true },
                end: { type: 'string', required: true },
              },
            },
          },
          languages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                language: { type: 'string', required: true },
                level: { type: 'string', required: true },
              },
            },
          },
          preferences: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              roles: { type: 'array', required: true, items: { type: 'string' } },
              locations: { type: 'array', required: true, items: { type: 'string' } },
              remote: { type: 'boolean', required: true },
              dealBreakers: { type: 'array', required: true, items: { type: 'string' } },
              salary: { type: 'string' },
            },
          },
        },
        description: 'The complete candidate profile.',
      },
      tenant_id: { type: 'string', description: 'Tenant scope; defaults to the deployment default.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { tenant_id: { type: 'string', required: true } } },
      render: (_args, value) => [{
        type: 'text',
        text: `Saved candidate profile for tenant "${value.tenant_id}".`,
      }],
    },
    async execute(args) {
      const tenantId = resolveTenant(args, config)
      const now = Date.now()
      await store.putProfile(toProfile(args.profile, tenantId, now))
      return { tenant_id: tenantId }
    },
    presentCall: () => ({ card: 'generic', title: 'Set up candidate profile', kind: 'other' }),
  }))

  register(defineTool({
    name: 'job_search_scrape',
    description:
      'Search every enabled job portal for postings matching a query, deduplicate, and store the '
      + 'results for the tenant. Returns the count and a compact list; run job_search_rank next for a scored shortlist.',
    parameters: {
      query: { type: 'string', required: true, description: 'Role or skills to search for.' },
      location: { type: 'string', description: 'Optional location constraint.' },
      tenant_id: { type: 'string', description: 'Tenant scope; defaults to the deployment default.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stored: { type: 'integer', required: true },
          jobs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                job_id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                company: { type: 'string', required: true },
                location: { type: 'string' },
                url: { type: 'string' },
              },
            },
          },
          portal_failures: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                portal_id: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Scraped ${value.stored} job(s) from ${value.jobs.length === 0 ? 'no portals' : 'enabled portals'}.`,
      }],
    },
    async execute(args) {
      const tenantId = resolveTenant(args, config)
      const { drafts, failures } = await portals.searchAll({
        query: args.query,
        ...(args.location === undefined ? {} : { location: args.location }),
      })
      const seen = new Set<string>()
      const stored: JobRecord[] = []
      for (const draft of drafts) {
        const dedupeKey = `${normalize(draft.company)}|${normalize(draft.title)}`
        if (seen.has(dedupeKey)) continue
        seen.add(dedupeKey)
        const job: JobRecord = {
          jobId: store.newJobId(),
          tenantId,
          portalId: draft.portalId,
          title: draft.title,
          company: draft.company,
          ...(draft.location === undefined ? {} : { location: draft.location }),
          ...(draft.url === undefined ? {} : { url: draft.url }),
          description: draft.description,
          ...(draft.salary === undefined ? {} : { salary: draft.salary }),
          ...(draft.postedAt === undefined ? {} : { postedAt: draft.postedAt }),
          scrapedAt: Date.now(),
        }
        await store.putJob(job)
        stored.push(job)
      }
      return {
        stored: stored.length,
        jobs: stored.map(job => ({
          job_id: job.jobId,
          title: job.title,
          company: job.company,
          ...(job.location === undefined ? {} : { location: job.location }),
          ...(job.url === undefined ? {} : { url: job.url }),
        })),
        portal_failures: failures.map(failure => ({ portal_id: failure.portalId, message: failure.message })),
      }
    },
    presentCall: args => ({ card: 'generic', title: `Scrape jobs: ${args.query}`, kind: 'search' }),
  }))

  register(defineTool({
    name: 'job_search_rank',
    description:
      'Score every stored (or a chosen subset of) job for a tenant against the candidate profile '
      + 'and return a ranked shortlist with per-job strengths and gaps.',
    parameters: {
      tenant_id: { type: 'string', description: 'Tenant scope; defaults to the deployment default.' },
      job_ids: { type: 'array', items: { type: 'string' }, description: 'Optional job ids to rank; all stored jobs when omitted.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ranked: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                job_id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                company: { type: 'string', required: true },
                score: { type: 'integer', required: true },
                matched_skills: { type: 'array', required: true, items: { type: 'string' } },
                strengths: { type: 'array', required: true, items: { type: 'string' } },
                gaps: { type: 'array', required: true, items: { type: 'string' } },
                violated_deal_breakers: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Ranked ${value.ranked.length} job(s) by fit.`,
      }],
    },
    execute(args) {
      const tenantId = resolveTenant(args, config)
      const profile = store.getProfile(tenantId)
      const wanted = args.job_ids === undefined ? undefined : new Set(args.job_ids)
      const jobs = store.listJobs(tenantId).filter(job => wanted === undefined || wanted.has(job.jobId))
      const ranked = jobs
        .map(job => ({ job, fit: evaluateFit(profile, job) }))
        .sort((left, right) => right.fit.score - left.fit.score)
        .map(({ job, fit }) => ({
          job_id: job.jobId,
          title: job.title,
          company: job.company,
          score: fit.score,
          matched_skills: fit.matchedSkills,
          strengths: fit.strengths,
          gaps: fit.gaps,
          violated_deal_breakers: fit.violatedDealBreakers,
        }))
      return Promise.resolve({ ranked })
    },
    presentCall: () => ({ card: 'generic', title: 'Rank jobs by fit', kind: 'other' }),
  }))

  register(defineTool({
    name: 'job_search_apply',
    description:
      'Prepare an application for one stored job: evaluate fit, record a drafted application, and '
      + 'return the brief (profile, posting, fit, and writing instructions). The model then writes '
      + 'the tailored CV and cover letter from that brief.',
    parameters: {
      job_id: { type: 'string', required: true, description: 'Stored job id to apply to.' },
      tenant_id: { type: 'string', description: 'Tenant scope; defaults to the deployment default.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          application_id: { type: 'string', required: true },
          fit_score: { type: 'integer', required: true },
          profile: { type: 'string', required: true },
          job: { type: 'string', required: true },
          instructions: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Prepared application "${value.application_id}" (fit ${value.fit_score}/100).`,
      }],
    },
    async execute(args) {
      const tenantId = resolveTenant(args, config)
      const job = store.getJob(brandJobId(args.job_id))
      if (job === undefined) throw new Error(`no stored job with id "${args.job_id}"`)
      const profile = store.getProfile(tenantId)
      const fit = evaluateFit(profile, job)
      const now = Date.now()
      const application: ApplicationRecord = {
        applicationId: store.newApplicationId(),
        tenantId,
        jobId: job.jobId,
        status: 'drafted',
        fitScore: fit.score,
        createdAt: now,
        updatedAt: now,
      }
      await store.putApplication(application)
      return {
        application_id: application.applicationId,
        fit_score: fit.score,
        profile: profile === undefined
          ? 'No profile stored for this tenant yet; run job_search_setup first.'
          : JSON.stringify(profile),
        job: JSON.stringify(job),
        instructions:
          'Write a tailored CV and cover letter from the profile and job above. Keep every claim '
          + 'verifiable against the profile; acknowledge genuine gaps instead of inventing experience. '
          + `Fit score ${fit.score}/100. Matched skills: ${fit.matchedSkills.join(', ') || 'none'}. `
          + `Deal-breakers violated: ${fit.violatedDealBreakers.join(', ') || 'none'}.`,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Apply to job', kind: 'other' }),
  }))

  register(defineTool({
    name: 'job_search_interview_prep',
    description:
      'Build a stage-specific interview prep brief for one stored job: the posting, the profile, and '
      + 'guidance to map likely questions to the candidate\'s concrete experience.',
    parameters: {
      job_id: { type: 'string', required: true, description: 'Stored job id to prepare for.' },
      application_id: { type: 'string', description: 'Optional tracked application id.' },
      tenant_id: { type: 'string', description: 'Tenant scope; defaults to the deployment default.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          job: { type: 'string', required: true },
          profile: { type: 'string', required: true },
          stage: { type: 'string', required: true },
          guidance: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Prepared interview brief (${value.stage}).` }],
    },
    execute(args) {
      const tenantId = resolveTenant(args, config)
      const job = store.getJob(brandJobId(args.job_id))
      if (job === undefined) throw new Error(`no stored job with id "${args.job_id}"`)
      const profile = store.getProfile(tenantId)
      const stage = args.application_id === undefined
        ? 'first round'
        : store.getApplication(brandApplicationId(args.application_id))?.stage ?? 'next round'
      return Promise.resolve({
        job: JSON.stringify(job),
        profile: profile === undefined ? 'No profile stored; run job_search_setup first.' : JSON.stringify(profile),
        stage,
        guidance:
          'Map likely questions for this role to concrete STAR examples from the profile\'s experience. '
          + 'For gaps, prepare honest bridge answers instead of invented experience. '
          + 'Offer a mock interview following the questions you surface.',
      })
    },
    presentCall: () => ({ card: 'generic', title: 'Interview prep', kind: 'other' }),
  }))

  register(defineTool({
    name: 'job_search_outcome',
    description:
      'Record what happened to one tracked application: its status, optional stage, and notes. '
      + 'Updates the tenant\'s application tracker.',
    parameters: {
      application_id: { type: 'string', required: true, description: 'Tracked application id.' },
      status: {
        type: 'string',
        required: true,
        enum: [...APPLICATION_STATUSES],
        description: 'drafted | applied | interview | offer | rejected | withdrawn.',
      },
      stage: { type: 'string', description: 'Optional stage detail, e.g. "2nd round".' },
      notes: { type: 'string', description: 'Optional free-form notes.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          application_id: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: [...APPLICATION_STATUSES] },
          stage: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Recorded outcome for "${value.application_id}": ${value.status}.`,
      }],
    },
    async execute(args) {
      const applicationId = brandApplicationId(args.application_id)
      const application = store.getApplication(applicationId)
      if (application === undefined) throw new Error(`no tracked application with id "${args.application_id}"`)
      const updated: ApplicationRecord = {
        ...application,
        status: args.status,
        ...(args.stage === undefined ? {} : { stage: args.stage }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        updatedAt: Date.now(),
      }
      await store.putApplication(updated)
      return {
        application_id: updated.applicationId,
        status: updated.status,
        ...(updated.stage === undefined ? {} : { stage: updated.stage }),
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Record outcome', kind: 'other' }),
  }))

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}
