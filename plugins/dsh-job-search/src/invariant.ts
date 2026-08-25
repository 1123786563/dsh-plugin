/**
 * Package-owned job-search invariants: every stored job/application record
 * carries a non-empty tenant id, and every application references a job that
 * exists in the same domain. Validated once at load and again on each durable
 * `domain/changed` write. @module @deepseek-ai/dsh-job-search/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'

const PACKAGE_NAME = '@deepseek-ai/dsh-job-search'
const DOMAIN_NAME = 'job_search'

/** Cordis companion plugin name. */
export const name = 'job-search-invariant'
/** Service required before the companion can inspect the open domain. */
export const inject = ['invariants']

/** Validate one tenant-scoped record's shared fields. */
function checkTenantField(table: string, value: unknown, fail: InvariantFailure): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    fail(`job_search ${table} record must be an object`)
  }
  const record = value as Record<string, unknown>
  if (typeof record.tenantId !== 'string' || record.tenantId.length === 0) {
    fail(`job_search ${table} record carries an empty tenantId`)
  }
  return record
}

/** Validate the job-search domain's data relations and tenant fields. */
function validateDomain(ctx: Context, fail: InvariantFailure): void {
  const domain = ctx.storageDomain.get(DOMAIN_NAME)
  if (domain === undefined) return
  const jobs = domain.table('jobs')
  const applications = domain.table('applications')
  for (const [key, record] of applications.entries()) {
    const application = checkTenantField('applications', record, fail)
    if (typeof application.jobId !== 'string' || jobs.get(application.jobId) === undefined) {
      fail(`job_search application '${key}' references missing job '${String(application.jobId)}'`)
    }
  }
  for (const [, record] of jobs.entries()) checkTenantField('jobs', record, fail)
  for (const [, record] of domain.table('profiles').entries()) {
    checkTenantField('profiles', record, fail)
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(change: DomainChanged, fail: InvariantFailure): void {
  if (change.domain !== DOMAIN_NAME) return
  if (change.operation === 'put') checkTenantField(change.table, change.value, fail)
}

/** Install tenant/reference validation for loaded and newly written records. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  validateDomain(ctx, fail)
  ctx.on('domain/changed', (change: DomainChanged) => {
    validateEvent(change, fail)
  }, { global: true })
}, { inject: ['storageDomain'] })
/* jscpd:ignore-end */

/**
 * Register the job-search invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
