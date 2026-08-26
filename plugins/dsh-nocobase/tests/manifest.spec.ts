/**
 * Package manifest contract: the shape dsh plugin discovery relies on
 * (dsh.bundle.patch present, web client declared, patch carries the package
 * name and a stable row id).
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const patch = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')

describe('dsh-nocobase manifest', () => {
  it('declares the bundle patch the loader looks for', () => {
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('declares a web client half', () => {
    expect(pkg.dsh?.client?.platform).toBe('web')
    expect(Array.isArray(pkg.dsh?.client?.inject)).toBe(true)
    expect(pkg.dsh.client.inject.length).toBeGreaterThan(0)
  })

  it('names the plugin entry with the package name and a stable id', () => {
    expect(patch).toContain(`name: '${pkg.name}'`)
    expect(patch).toContain('id: nocobase')
  })

  it('exposes the client module through package exports', () => {
    expect(pkg.exports?.['./client']).toBeDefined()
    expect(pkg.main).toBe('lib/index.js')
  })
})
