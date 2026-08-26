/**
 * Tenant billing policy: resolve one verified Casdoor identity to exactly one
 * OpenMeter subject through the operator-maintained tenant-to-subject mapping,
 * plus the tenant-manager / operator role flags derived from that identity.
 *
 * Invariants (spec sections 访问与归属边界 / 错误、降级与兼容性):
 * - The explicit tenant-to-subject mapping is the only billing attribution
 *   source; a subject is never inferred from client input, never auto-created
 *   at read time, and never falls back to another tenant's subject.
 * - Identity comes only from the verified Casdoor identity supplied by the
 *   host; client-supplied tenant identifiers carry no authority here.
 * - Unknown or misconfigured subjects fail closed: an unmapped tenant is an
 *   error, a mapping onto the reserved house subject is forbidden, and the
 *   internal house account is never silently billed for a tenant.
 *
 * Pure and synchronous: no network, no IO, no clock, and no logging of
 * identity values.
 *
 * @module dsh-openmeter/tenant-policy
 */

/** Structural subset of CasdoorIdentity; displayName is not needed here. */
export interface TenantPolicyIdentity {
  readonly tenantId: string
  readonly userId: string
  readonly roles: readonly string[]
}

/** Why a policy could not be resolved; routes map these to 401/403. */
export type PolicyErrorCode = 'unauthenticated' | 'tenant-unmapped' | 'forbidden'

/** The resolved billing policy for one authenticated identity. */
export interface TenantPolicy {
  readonly ok: true
  /** Trimmed tenant identifier the mapping was looked up under. */
  readonly tenantId: string
  /** Trimmed user identifier: the accountable principal inside the tenant. */
  readonly principal: string
  /** The one OpenMeter subject this identity bills to (from the mapping). */
  readonly subject: string
  /** True when the identity holds a tenant-manager (budget-write) role. */
  readonly isTenantManager: boolean
  /** True when the identity holds a platform-operator role. */
  readonly isOperator: boolean
}

/** Fail-closed resolution failure; never carries identity values. */
export interface PolicyError {
  readonly ok: false
  readonly code: PolicyErrorCode
}

/** Optional seams so later tasks can wire config without changing calls. */
export interface TenantPolicyOptions {
  /** Roles allowed to modify the tenant budget; default ['owner']. */
  readonly managerRoles?: readonly string[]
  /** Platform operator roles; default ['dsh-admin'] (gateway adminRoles). */
  readonly operatorRoles?: readonly string[]
  /** Reserved internal subject that must never bill for a tenant; default 'house'. */
  readonly houseSubject?: string
}

/** Defaults applied when an option is omitted; matches the plugin config. */
export const DEFAULT_TENANT_POLICY_OPTIONS: Required<TenantPolicyOptions> = {
  managerRoles: ['owner'],
  operatorRoles: ['dsh-admin'],
  houseSubject: 'house',
}

/** Case-sensitive match of trimmed non-empty roles against a trimmed allow-list. */
function hasAnyRole(roles: readonly string[], allowed: readonly string[]): boolean {
  const wanted = new Set<string>()
  for (const role of allowed) {
    const trimmed = role.trim()
    if (trimmed.length > 0) wanted.add(trimmed)
  }
  for (const role of roles) {
    const trimmed = role.trim()
    if (trimmed.length > 0 && wanted.has(trimmed)) return true
  }
  return false
}

/**
 * Resolve the billing policy for one identity against the explicit mapping.
 * Own properties of the mapping only (inherited/prototype keys count as
 * unmapped), every identifier trimmed, and expected failures returned as
 * typed errors instead of exceptions.
 * @param identity - CasdoorIdentity-compatible shape (displayName not required).
 * @param mapping - operator-maintained tenantId -> OpenMeter subject table.
 * @param options - role lists and reserved house subject overrides.
 * @returns the policy, or a typed fail-closed error.
 */
export function resolveTenantPolicy(
  identity: TenantPolicyIdentity | null | undefined,
  mapping: Readonly<Record<string, string>>,
  options?: TenantPolicyOptions,
): TenantPolicy | PolicyError {
  if (identity === null || identity === undefined) return { ok: false, code: 'unauthenticated' }
  const tenantId = identity.tenantId.trim()
  const principal = identity.userId.trim()
  if (tenantId.length === 0 || principal.length === 0) return { ok: false, code: 'unauthenticated' }
  // Own-property lookup only: a key like 'constructor' must read as unmapped,
  // never as an inherited non-string value that would throw.
  if (!Object.prototype.hasOwnProperty.call(mapping, tenantId)) return { ok: false, code: 'tenant-unmapped' }
  const subject = (mapping[tenantId] ?? '').trim()
  if (subject.length === 0) return { ok: false, code: 'tenant-unmapped' }
  const houseSubject = (options?.houseSubject ?? DEFAULT_TENANT_POLICY_OPTIONS.houseSubject).trim()
  if (subject === houseSubject) return { ok: false, code: 'forbidden' }
  return {
    ok: true,
    tenantId,
    principal,
    subject,
    isTenantManager: hasAnyRole(identity.roles, options?.managerRoles ?? DEFAULT_TENANT_POLICY_OPTIONS.managerRoles),
    isOperator: hasAnyRole(identity.roles, options?.operatorRoles ?? DEFAULT_TENANT_POLICY_OPTIONS.operatorRoles),
  }
}

/** Guard a resolved policy on the tenant-manager role; otherwise forbidden. */
export function requireTenantManager(policy: TenantPolicy | PolicyError): TenantPolicy | PolicyError {
  return policy.ok && policy.isTenantManager ? policy : { ok: false, code: 'forbidden' }
}

/** Guard a resolved policy on the operator role; otherwise forbidden. */
export function requireOperator(policy: TenantPolicy | PolicyError): TenantPolicy | PolicyError {
  return policy.ok && policy.isOperator ? policy : { ok: false, code: 'forbidden' }
}
