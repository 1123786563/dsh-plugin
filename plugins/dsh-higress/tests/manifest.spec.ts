/** Package + bundle manifest invariants for dsh-higress. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(new URL('.', import.meta.url).pathname, '..')

describe('dsh-higress manifest', () => {
  it('declares the dsh bundle and web client halves', async () => {
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as Record<string, unknown>
    const dsh = pkg.dsh as Record<string, unknown>
    expect(dsh.bundle).toMatchObject({ patch: './cordis.patch.yml' })
    expect(dsh.client).toMatchObject({ platform: 'web' })
    expect(pkg.name).toBe('dsh-higress')
    expect(pkg.type).toBe('module')
  })

  it('inserts the plugin into the bundle with the llm-higress id', async () => {
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: llm-higress')
    expect(patch).toContain('name: dsh-higress')
  })
})
