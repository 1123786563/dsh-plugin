import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

describe('plugin manifest', () => {
  it('declares the bundle patch and the plugin name', () => {
    expect(pkg.name).toBe('dsh-casdoor-auth')
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('peers on cordis, schemastery, and the vendored multi-tenant runtime', () => {
    expect(pkg.peerDependencies?.['@deepseek-ai/cordis']).toBeDefined()
    expect(pkg.peerDependencies?.['@deepseek-ai/schemastery']).toBeDefined()
    expect(pkg.peerDependencies?.['dsh-multi-tenant']).toBeDefined()
  })

  it('bundles jose (the host does not provide it)', () => {
    expect(pkg.dependencies?.jose).toBeDefined()
  })
})

describe('cordis.patch.yml', () => {
  it('moves the webserver onto the loopback private port', () => {
    expect(patch).toContain('- id: webserver')
    expect(patch).toContain('host: 127.0.0.1')
    expect(patch).toContain("process.env.DSH_CASDOOR_DSH_PORT ?? 38080")
  })

  it('inserts the plugin row with env-driven defaults', () => {
    expect(patch).toContain('- id: casdoor-auth')
    expect(patch).toContain("name: dsh-casdoor-auth")
    expect(patch).toContain('DSH_CASDOOR_GATEWAY_JWKS_URL')
    expect(patch).toContain("identityPublicKey: !!js process.env.DSH_CASDOOR_IDENTITY_PUBLIC_KEY ?? ''")
  })
})
