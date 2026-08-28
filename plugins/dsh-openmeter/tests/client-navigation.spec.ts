import { describe, expect, it } from 'vitest'
import { buildBillingNavigation } from '../src/client/navigation.ts'

/**
 * Issue #10 (租户导航清理): the billing navigation is derived from the
 * authenticated capability set — tenants always get the three self-service
 * entries (overview, detail, budget); operator surfaces (cashier, operator
 * settings) appear only for operators. Hiding entries never replaces the
 * server-side operator authorization (#9).
 */

const tenantEntryIds = ['overview', 'detail', 'budget']
const operatorEntryIds = ['cashier', 'settings']

describe('buildBillingNavigation', () => {
  it('gives a plain member exactly the three tenant entries', () => {
    const entries = buildBillingNavigation({ operator: false, manager: false })
    expect(entries.map(entry => entry.id)).toEqual(tenantEntryIds)
  })

  it('gives a manager the same three entries (manager affects budget editing, not navigation)', () => {
    const entries = buildBillingNavigation({ operator: false, manager: true })
    expect(entries.map(entry => entry.id)).toEqual(tenantEntryIds)
  })

  it('adds operator entries only for operators, after the tenant entries', () => {
    const entries = buildBillingNavigation({ operator: true, manager: false })
    expect(entries.map(entry => entry.id)).toEqual([...tenantEntryIds, ...operatorEntryIds])
  })

  it('treats missing capability fields as plain tenant (total function, never throws)', () => {
    expect(buildBillingNavigation({} as Record<string, never>).map(entry => entry.id)).toEqual(tenantEntryIds)
    expect(buildBillingNavigation({ operator: undefined, manager: undefined }).map(entry => entry.id)).toEqual(tenantEntryIds)
    expect(buildBillingNavigation(undefined).map(entry => entry.id)).toEqual(tenantEntryIds)
  })

  it('marks operator entries as operator-only and points them at their views', () => {
    const entries = buildBillingNavigation({ operator: true, manager: true })
    for (const entry of entries) {
      const operatorOnly = operatorEntryIds.includes(entry.id)
      expect(entry.operatorOnly).toBe(operatorOnly)
      expect(entry.view).toBe(entry.id)
      expect(typeof entry.labelKey).toBe('string')
      expect(entry.labelKey.length).toBeGreaterThan(0)
    }
  })

  it('keeps locale keys stable for the tenant entries', () => {
    const entries = buildBillingNavigation({ operator: false, manager: false })
    expect(entries.map(entry => entry.labelKey)).toEqual(['panel.overview', 'detail.title', 'budget.title'])
  })
})
