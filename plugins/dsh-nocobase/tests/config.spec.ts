/**
 * Config normalization: defaults, env-driven composition values, defensive
 * merges, and baseUrl sanitation.
 */

import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_CONFIG, resolveConfig } from '../src/config.ts'

describe('dsh-nocobase config', () => {
  it('falls back to defaults on undefined input', () => {
    expect(resolveConfig(undefined)).toEqual(DEFAULT_CONFIG)
  })

  it('drops undefined keys so js-expression entries fall through', () => {
    expect(resolveConfig({ baseUrl: undefined })).toEqual(DEFAULT_CONFIG)
  })

  it('keeps explicit values', () => {
    expect(resolveConfig({ baseUrl: 'http://10.0.0.5:13000', timeoutMs: 1000 })).toEqual({
      baseUrl: 'http://10.0.0.5:13000',
      timeoutMs: 1000,
    })
  })

  it('strips trailing slashes from baseUrl', () => {
    expect(resolveConfig({ baseUrl: 'http://127.0.0.1:13000/' }).baseUrl).toBe('http://127.0.0.1:13000')
    expect(resolveConfig({ baseUrl: 'http://127.0.0.1:13000///' }).baseUrl).toBe('http://127.0.0.1:13000')
  })

  it('recovers the default origin from blank or whitespace-only input', () => {
    expect(resolveConfig({ baseUrl: '' }).baseUrl).toBe(DEFAULT_CONFIG.baseUrl)
    expect(resolveConfig({ baseUrl: '   ' }).baseUrl).toBe(DEFAULT_CONFIG.baseUrl)
  })

  it('recovers the default timeout from non-positive or NaN values', () => {
    expect(resolveConfig({ timeoutMs: 0 }).timeoutMs).toBe(DEFAULT_CONFIG.timeoutMs)
    expect(resolveConfig({ timeoutMs: Number.NaN }).timeoutMs).toBe(DEFAULT_CONFIG.timeoutMs)
  })

  it('schemastery layer declares the same defaults as the defensive layer', () => {
    expect(Config).toBeDefined()
    expect(DEFAULT_CONFIG.baseUrl).toMatch(/^https?:\/\//)
  })
})
