/** resolveConfig: priority, env fallback, defaults, validation. */
import { describe, expect, it } from 'vitest'
import { DEFAULT_MODELS, resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('uses built-in defaults with an empty env', () => {
    const resolved = resolveConfig(undefined, {})
    expect(resolved.baseURL).toBe('http://127.0.0.1:8080/v1')
    expect(resolved.apiKeyEnv).toBe('HIGRESS_API_KEY')
    expect(resolved.models).toEqual(DEFAULT_MODELS)
    expect(resolved.defaultContextWindow).toBe(65_536)
    expect(resolved.maxTokens).toBeUndefined()
    expect(resolved.retryPolicy).toBeDefined()
  })

  it('prefers settings over env over default for baseURL', () => {
    expect(resolveConfig({ baseURL: 'https://gw.example.com/v1' }, { HIGRESS_BASE_URL: 'http://ignored:1/v1' }).baseURL)
      .toBe('https://gw.example.com/v1')
    expect(resolveConfig(undefined, { HIGRESS_BASE_URL: 'https://env.example.com/v1' }).baseURL)
      .toBe('https://env.example.com/v1')
  })

  it('normalizes trailing slashes off the baseURL', () => {
    expect(resolveConfig({ baseURL: 'http://127.0.0.1:8080/v1/' }, {}).baseURL).toBe('http://127.0.0.1:8080/v1')
  })

  it('keeps thinking defaults detached', () => {
    const resolved = resolveConfig({ thinking: 'disabled', reasoningEffort: 'low' }, {})
    expect(resolved.defaults).toEqual({ thinking: 'disabled', reasoningEffort: 'low' })
  })

  it('rejects non-http(s) and site-root baseURLs', () => {
    expect(() => resolveConfig({ baseURL: 'ftp://x/v1' }, {})).toThrow(/http/)
    expect(() => resolveConfig({ baseURL: 'not a url' }, {})).toThrow(/valid URL/)
    expect(() => resolveConfig({ baseURL: 'http://127.0.0.1:8080/' }, {})).toThrow(/prefix/)
  })

  it('rejects out-of-range numerics', () => {
    expect(() => resolveConfig({ defaultContextWindow: 0 }, {})).toThrow(/defaultContextWindow/)
    expect(() => resolveConfig({ streamIdleTimeoutMs: 0 }, {})).toThrow(/streamIdleTimeoutMs/)
    expect(() => resolveConfig({ maxTokens: -1 }, {})).toThrow(/maxTokens/)
  })
})
