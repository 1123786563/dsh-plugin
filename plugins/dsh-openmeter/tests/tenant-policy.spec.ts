import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TENANT_POLICY_OPTIONS,
  requireOperator,
  requireTenantManager,
  resolveTenantPolicy,
} from '../src/tenant-policy.ts'
import type { PolicyError, TenantPolicy } from '../src/tenant-policy.ts'

const MAPPING: Readonly<Record<string, string>> = {
  'tenant-a': 'cust-a',
  'tenant-house': 'house',
  'tenant-blank': '   ',
}

function makeIdentity(
  overrides: { tenantId?: string, userId?: string, roles?: readonly string[] } = {},
): { tenantId: string, userId: string, displayName: string, roles: readonly string[] } {
  return {
    tenantId: overrides.tenantId ?? 'tenant-a',
    userId: overrides.userId ?? 'user-1',
    displayName: 'Alice',
    roles: overrides.roles ?? ['member'],
  }
}

describe('resolveTenantPolicy', () => {
  it('resolves a mapped tenant to exactly one subject and principal', () => {
    const result = resolveTenantPolicy(makeIdentity(), MAPPING)
    expect(result).toEqual({
      ok: true,
      tenantId: 'tenant-a',
      principal: 'user-1',
      subject: 'cust-a',
      isTenantManager: false,
      isOperator: false,
    })
  })

  it('trims tenant, user, and role identifiers before resolving', () => {
    const result = resolveTenantPolicy(
      makeIdentity({ tenantId: '  tenant-a  ', userId: '  user-1  ', roles: ['  owner  '] }),
      { 'tenant-a': '  cust-a  ' },
    )
    expect(result).toEqual({
      ok: true,
      tenantId: 'tenant-a',
      principal: 'user-1',
      subject: 'cust-a',
      isTenantManager: true,
      isOperator: false,
    })
  })

  it('flags the default manager role (owner)', () => {
    const result = resolveTenantPolicy(makeIdentity({ roles: ['owner'] }), MAPPING)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.isTenantManager).toBe(true)
  })

  it('flags the default operator role (dsh-admin)', () => {
    const result = resolveTenantPolicy(makeIdentity({ roles: ['dsh-admin'] }), MAPPING)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.isOperator).toBe(true)
  })

  it('keeps role matching case-sensitive and ignores empty role strings', () => {
    const cased = resolveTenantPolicy(makeIdentity({ roles: ['Owner', 'Dsh-Admin'] }), MAPPING)
    expect(cased.ok).toBe(true)
    if (cased.ok) {
      expect(cased.isTenantManager).toBe(false)
      expect(cased.isOperator).toBe(false)
    }
    const blank = resolveTenantPolicy(makeIdentity({ roles: ['', '   '] }), MAPPING)
    expect(blank.ok).toBe(true)
    if (blank.ok) {
      expect(blank.isTenantManager).toBe(false)
      expect(blank.isOperator).toBe(false)
    }
  })

  it('applies custom options over the defaults', () => {
    const options = { managerRoles: ['billing-manager'], operatorRoles: ['ops'], houseSubject: 'internal' }
    const manager = resolveTenantPolicy(
      makeIdentity({ roles: ['billing-manager', 'dsh-admin'] }),
      MAPPING,
      options,
    )
    expect(manager.ok).toBe(true)
    if (manager.ok) {
      expect(manager.isTenantManager).toBe(true)
      expect(manager.isOperator).toBe(false)
    }
    const operator = resolveTenantPolicy(makeIdentity({ roles: ['ops'] }), MAPPING, options)
    expect(operator.ok).toBe(true)
    if (operator.ok) expect(operator.isOperator).toBe(true)
    const houseAlias = resolveTenantPolicy(
      makeIdentity({ tenantId: 'tenant-a' }),
      { 'tenant-a': 'internal' },
      options,
    )
    expect(houseAlias).toEqual({ ok: false, code: 'forbidden' })
  })

  it('returns tenant-unmapped when the mapping has no entry for the tenant', () => {
    const result = resolveTenantPolicy(makeIdentity({ tenantId: 'tenant-b' }), MAPPING)
    expect(result).toEqual({ ok: false, code: 'tenant-unmapped' })
  })

  it('returns tenant-unmapped for a cross-tenant identity absent from the mapping', () => {
    const mapping: Readonly<Record<string, string>> = { 'tenant-a': 'cust-a' }
    const result = resolveTenantPolicy(makeIdentity({ tenantId: 'tenant-z' }), mapping)
    expect(result).toEqual({ ok: false, code: 'tenant-unmapped' })
  })

  it('returns tenant-unmapped for an empty or whitespace mapping value', () => {
    const result = resolveTenantPolicy(makeIdentity({ tenantId: 'tenant-blank' }), MAPPING)
    expect(result).toEqual({ ok: false, code: 'tenant-unmapped' })
  })

  it('returns tenant-unmapped for a corrupt non-string mapping value instead of throwing', () => {
    const corrupt = { 'tenant-a': 42 } as unknown as Readonly<Record<string, string>>
    expect(resolveTenantPolicy(makeIdentity(), corrupt)).toEqual({ ok: false, code: 'tenant-unmapped' })
  })

  it('returns forbidden when the mapping resolves to the reserved house subject', () => {
    const result = resolveTenantPolicy(makeIdentity({ tenantId: 'tenant-house' }), MAPPING)
    expect(result).toEqual({ ok: false, code: 'forbidden' })
  })

  it('returns unauthenticated for an absent identity', () => {
    expect(resolveTenantPolicy(undefined, MAPPING)).toEqual({ ok: false, code: 'unauthenticated' })
    expect(resolveTenantPolicy(null, MAPPING)).toEqual({ ok: false, code: 'unauthenticated' })
  })

  it('returns unauthenticated for a blank tenantId or userId', () => {
    expect(resolveTenantPolicy(makeIdentity({ tenantId: '' }), MAPPING)).toEqual({ ok: false, code: 'unauthenticated' })
    expect(resolveTenantPolicy(makeIdentity({ tenantId: '   ' }), MAPPING)).toEqual({ ok: false, code: 'unauthenticated' })
    expect(resolveTenantPolicy(makeIdentity({ userId: '' }), MAPPING)).toEqual({ ok: false, code: 'unauthenticated' })
    expect(resolveTenantPolicy(makeIdentity({ userId: '  ' }), MAPPING)).toEqual({ ok: false, code: 'unauthenticated' })
  })

  it('ignores inherited and prototype mapping keys (fail closed)', () => {
    const inherited = Object.create({ 'tenant-a': 'cust-a' }) as Record<string, string>
    expect(resolveTenantPolicy(makeIdentity(), inherited)).toEqual({ ok: false, code: 'tenant-unmapped' })
    expect(resolveTenantPolicy(makeIdentity({ tenantId: 'constructor' }), { 'tenant-a': 'cust-a' })).toEqual({
      ok: false,
      code: 'tenant-unmapped',
    })
  })

  it('is a pure synchronous function that never mutates its inputs', () => {
    const mapping: Record<string, string> = { 'tenant-a': 'cust-a' }
    const identity = makeIdentity({ roles: ['owner'] })
    const options = { managerRoles: ['owner'], operatorRoles: ['ops'], houseSubject: 'house' }
    const mappingBefore = JSON.stringify(mapping)
    const identityBefore = JSON.stringify(identity)
    const optionsBefore = JSON.stringify(options)
    const result = resolveTenantPolicy(identity, mapping, options)
    expect(result).not.toBeInstanceOf(Promise)
    expect(JSON.stringify(mapping)).toBe(mappingBefore)
    expect(JSON.stringify(identity)).toBe(identityBefore)
    expect(JSON.stringify(options)).toBe(optionsBefore)
  })
})

describe('role guard helpers', () => {
  it('pass through a policy that satisfies the role', () => {
    const policy: TenantPolicy = {
      ok: true,
      tenantId: 'tenant-a',
      principal: 'user-1',
      subject: 'cust-a',
      isTenantManager: true,
      isOperator: true,
    }
    expect(requireTenantManager(policy)).toBe(policy)
    expect(requireOperator(policy)).toBe(policy)
  })

  it('preserve an incoming error verbatim instead of flattening it to forbidden', () => {
    const unauthenticated: PolicyError = { ok: false, code: 'unauthenticated' }
    expect(requireTenantManager(unauthenticated)).toBe(unauthenticated)
    expect(requireOperator(unauthenticated)).toBe(unauthenticated)
    const unmapped: PolicyError = { ok: false, code: 'tenant-unmapped' }
    expect(requireTenantManager(unmapped)).toBe(unmapped)
    expect(requireOperator(unmapped)).toBe(unmapped)
  })

  it('return forbidden only for an authenticated policy whose role flag is false', () => {
    const member = resolveTenantPolicy(makeIdentity(), MAPPING)
    expect(member.ok).toBe(true)
    expect(requireTenantManager(member)).toEqual({ ok: false, code: 'forbidden' })
    expect(requireOperator(member)).toEqual({ ok: false, code: 'forbidden' })
  })

  it('keep an absent identity unauthenticated when composed after resolveTenantPolicy', () => {
    const guarded = requireTenantManager(resolveTenantPolicy(undefined, MAPPING))
    expect(guarded).toEqual({ ok: false, code: 'unauthenticated' })
  })
})

describe('DEFAULT_TENANT_POLICY_OPTIONS', () => {
  it('matches the documented defaults', () => {
    expect(DEFAULT_TENANT_POLICY_OPTIONS).toEqual({
      managerRoles: ['owner'],
      operatorRoles: ['dsh-admin'],
      houseSubject: 'house',
    })
  })
})
