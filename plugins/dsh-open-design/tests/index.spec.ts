import { describe, expect, it } from 'vitest'
import { basename } from 'node:path'
import { apply, bundledSkillsDir, Config, inject, name, PROVIDER_NAME } from '../src/index.ts'

/** Minimal fake Context capturing ctx.plugin child applications. */
function fakeContext() {
  const applied: Array<{ plugin: unknown; config: Record<string, unknown> }> = []
  return {
    applied,
    plugin(plugin: unknown, config: Record<string, unknown>) {
      applied.push({ plugin, config })
    },
  }
}

describe('dsh-open-design', () => {
  it('declares the skills injection and stable plugin identity', () => {
    expect(name).toBe('open-design')
    expect(inject).toContain('skills')
  })

  it('applies the filesystem provider isolated against the bundled catalog', () => {
    const ctx = fakeContext()
    apply(ctx as never)
    expect(ctx.applied).toHaveLength(1)
    const { plugin, config } = ctx.applied[0]!
    expect((plugin as { name: string }).name).toBe('skill-filesystem')
    expect(config.providerName).toBe(PROVIDER_NAME)
    expect(config.includeDefaultRoots).toBe(false)
    expect(config.customSkillDirs).toEqual([bundledSkillsDir()])
  })

  it('appends configured custom roots after the bundled catalog', () => {
    const ctx = fakeContext()
    apply(ctx as never, { ...Config(), customSkillDirs: ['/extra/skills'] })
    const { config } = ctx.applied[0]!
    expect(config.customSkillDirs).toEqual([bundledSkillsDir(), '/extra/skills'])
  })

  it('points the bundled catalog at the packaged skills directory', () => {
    expect(basename(bundledSkillsDir())).toBe('skills')
  })
})
