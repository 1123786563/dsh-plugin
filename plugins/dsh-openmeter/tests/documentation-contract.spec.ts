/**
 * Documentation contract: README.md and CONTEXT.md must keep documenting the
 * implemented billing surface. The exact paths mountRoutes() registers in
 * src/routes.ts are the single source of truth for the HTTP face — the README
 * documents exactly that set, no more, no less — and the CONTEXT glossary
 * keeps the terms the acceptance record
 * (docs/superpowers/plans/2026-08-26-tenant-billing-self-service-acceptance.md)
 * cites. Drift in either direction fails here.
 *
 * @module dsh-openmeter/tests/documentation-contract
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const readme = readFileSync(join(pluginRoot, 'README.md'), 'utf8')
const context = readFileSync(join(pluginRoot, 'CONTEXT.md'), 'utf8')
const routesSource = readFileSync(join(pluginRoot, 'src', 'routes.ts'), 'utf8')

/** Every exact path mountRoutes registers, in source order. */
const mountedPaths = [...routesSource.matchAll(/route\('(\/api\/openmeter[^']*)'/g)].map(match => match[1]!)

/**
 * Every /api/openmeter path token the README mentions. Prefix-glob mentions
 * (a token immediately followed by `/*`) document a family, not one mounted
 * path, so they contribute no token.
 */
const documentedPaths = [...readme.matchAll(/\/api\/openmeter\/[a-z-]+(?:\/[a-z-]+)*/g)]
  .filter(match => readme.slice(match.index! + match[0].length, match.index! + match[0].length + 2) !== '/*')
  .map(match => match[0])
const uniqueDocumentedPaths = [...new Set(documentedPaths)]

/**
 * One glossary section: from its heading to the next heading of the same or
 * higher level (or end of file).
 * @param text - the glossary markdown.
 * @param heading - the exact heading line, e.g. '### 报价币种'.
 * @returns the section body including the heading line.
 */
function sectionOf(text: string, heading: string): string {
  const start = text.indexOf(heading)
  expect(start, `CONTEXT.md must contain the heading ${heading}`).toBeGreaterThanOrEqual(0)
  const rest = text.slice(start + heading.length)
  const next = rest.search(/^#{2,3} /m)
  return next === -1 ? text.slice(start) : text.slice(start, start + heading.length + next)
}

describe('README documents the implemented route face', () => {
  it('documents exactly the mounted route set — no missing path, no unmounted path', () => {
    expect(uniqueDocumentedPaths.sort()).toEqual([...new Set(mountedPaths)].sort())
  })

  it('documents the tenant self-service /me surface with methods and body/query contracts', () => {
    expect(readme).toContain('/api/openmeter/me/summary')
    expect(readme).toContain('/api/openmeter/me/usage')
    expect(readme).toContain('/api/openmeter/me/budget')
    // Query contract points: subject selection from client input is rejected.
    expect(readme).toContain('subject-not-allowed')
    // Honest degradation codes of the two ledger-backed surfaces.
    expect(readme).toContain('ledger-unavailable')
    expect(readme).toContain('budget-unavailable')
    // Budget write body contract: only monthlyBudgetCny is accepted.
    expect(readme).toContain('monthlyBudgetCny')
  })

  it('keeps the operator migration table and the 410 route-migrated semantics', () => {
    for (const segment of ['customers', 'grants', 'block', 'bindings']) {
      expect(readme).toContain(`/api/openmeter/operator/${segment}`)
    }
    expect(readme).toContain('410')
    expect(readme).toContain('route-migrated')
  })

  it('has a role matrix across tenant member / operator / stock loopback columns', () => {
    const matrixLine = readme.split('\n').find(line => line.includes('租户成员') && line.includes('运营者') && line.includes('stock 回环'))
    expect(matrixLine, 'README needs a role-matrix table header naming the three caller columns').toBeDefined()
    // The matrix covers the tenant surfaces, the operator surface, and the retired paths.
    expect(readme).toContain('/me/summary')
    expect(readme).toContain('/me/budget')
    expect(readme).toContain('/operator/')
    expect(readme).toContain('route-migrated')
  })

  it('has a migration/rollback heading under the operator migration section', () => {
    expect(readme).toMatch(/^#{2,3} .*回滚.*$/m)
  })

  it('states the verification commands verbatim', () => {
    expect(readme).toContain('pnpm --dir plugins/dsh-openmeter test')
    expect(readme).toContain('pnpm --dir plugins/dsh-openmeter typecheck')
    expect(readme).toContain('pnpm --dir plugins/dsh-openmeter build')
  })
})

describe('CONTEXT glossary keeps the acceptance-record terms', () => {
  it('tenant→subject mapping term names the only attribution source', () => {
    const section = sectionOf(context, '### 租户计费主体映射')
    expect(section).toContain('OpenMeter subject')
    expect(section).toContain('唯一')
    expect(section).toContain('house')
  })

  it('quote-currency term separates Token balances from CNY amounts', () => {
    const section = sectionOf(context, '### 报价币种')
    expect(section).toContain('CNY')
    expect(section).toContain('Token')
  })

  it('error-semantics term covers 401/403 and the honest degradation states', () => {
    const section = sectionOf(context, '### 错误语义')
    expect(section).toContain('401')
    expect(section).toContain('403')
    expect(section).toContain('降级')
  })

  it('policy-resolution term names the resolved policy shape and the operator gate', () => {
    const section = sectionOf(context, '### 策略解析')
    expect(section).toContain('TenantPolicy')
    expect(section).toContain('isOperator')
  })
})
