/** resolveConsumerKey: credentials-service-first resolution with env fallback. */
import { describe, expect, it } from 'vitest'
import { resolveConsumerKey } from '../src/index.ts'

describe('resolveConsumerKey', () => {
  it('returns the credentials-service value when the service hits', async () => {
    const key = await resolveConsumerKey('HIGRESS_API_KEY', {
      resolve: async () => ({ value: 'managed-key' }),
    }, { HIGRESS_API_KEY: 'env-key' })
    expect(key).toBe('managed-key')
  })

  it('falls back to the environment only when the service is absent', async () => {
    expect(await resolveConsumerKey('HIGRESS_API_KEY', undefined, { HIGRESS_API_KEY: 'env-key' })).toBe('env-key')
    await expect(resolveConsumerKey('HIGRESS_API_KEY', { resolve: async () => undefined }, { HIGRESS_API_KEY: 'env-key' }))
      .rejects.toMatchObject({ failure: { code: 'MISSING_CREDENTIAL' } })
  })

  it('throws MISSING_CREDENTIAL naming the ref when nothing resolves', async () => {
    const error = await resolveConsumerKey('HIGRESS_API_KEY', undefined, {}).then(
      () => { throw new Error('expected rejection') },
      (e: Error) => e,
    )
    expect(error.message).toContain('HIGRESS_API_KEY')
    expect((error as { failure?: { code?: string } }).failure?.code).toBe('MISSING_CREDENTIAL')
  })

  it('rejects whitespace-only values through the usable-key check', async () => {
    // Brief deviation: assertUsableApiKey classifies a supplied-but-blank key
    // as INVALID_CREDENTIAL (its "is blank" diagnosis); MISSING_CREDENTIAL is
    // reserved for "nothing resolved". The brief's assertion said the latter.
    await expect(resolveConsumerKey('HIGRESS_API_KEY', undefined, { HIGRESS_API_KEY: '   ' }))
      .rejects.toMatchObject({ failure: { code: 'INVALID_CREDENTIAL' } })
  })
})
