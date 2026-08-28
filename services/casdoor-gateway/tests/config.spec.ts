import { describe, expect, it } from 'vitest'
import { loadGatewayConfig } from '../src/config.ts'

const BASE_ENV: NodeJS.ProcessEnv = {
  CASDOOR_CLIENT_ID: 'cid',
  CASDOOR_CLIENT_SECRET: 'csecret',
}

describe('loadGatewayConfig casdoorInternalIssuer', () => {
  it('defaults to the resolved casdoorIssuer (default zero split)', () => {
    const config = loadGatewayConfig({ ...BASE_ENV, CASDOOR_ISSUER: 'http://10.0.0.5:8001' })
    expect(config.casdoorInternalIssuer.href).toBe(config.casdoorIssuer.href)
    expect(config.casdoorInternalIssuer.href).toBe('http://10.0.0.5:8001/')
  })

  it('defaults both bases to the built-in casdoor origin when nothing is configured', () => {
    const config = loadGatewayConfig({ ...BASE_ENV })
    expect(config.casdoorIssuer.href).toBe('http://127.0.0.1:8001/')
    expect(config.casdoorInternalIssuer.href).toBe('http://127.0.0.1:8001/')
  })

  it('parses an explicit CASDOOR_INTERNAL_ISSUER independently of CASDOOR_ISSUER', () => {
    const config = loadGatewayConfig({
      ...BASE_ENV,
      CASDOOR_ISSUER: 'http://casdoor.example.com:8001',
      CASDOOR_INTERNAL_ISSUER: 'http://127.0.0.1:8001',
    })
    expect(config.casdoorIssuer.href).toBe('http://casdoor.example.com:8001/')
    expect(config.casdoorInternalIssuer.href).toBe('http://127.0.0.1:8001/')
  })

  it('treats an empty CASDOOR_INTERNAL_ISSUER as unset (fallback applies)', () => {
    const config = loadGatewayConfig({ ...BASE_ENV, CASDOOR_ISSUER: 'http://10.0.0.5:8001', CASDOOR_INTERNAL_ISSUER: '' })
    expect(config.casdoorInternalIssuer.href).toBe('http://10.0.0.5:8001/')
  })

  it('rejects an internal issuer with a path, naming CASDOOR_INTERNAL_ISSUER', () => {
    expect(() =>
      loadGatewayConfig({ ...BASE_ENV, CASDOOR_INTERNAL_ISSUER: 'http://127.0.0.1:8001/casdoor' }),
    ).toThrowError(/CASDOOR_INTERNAL_ISSUER/)
  })

  it('rejects a non-http(s) internal issuer, naming CASDOOR_INTERNAL_ISSUER', () => {
    expect(() =>
      loadGatewayConfig({ ...BASE_ENV, CASDOOR_INTERNAL_ISSUER: 'ftp://127.0.0.1:8001' }),
    ).toThrowError(/CASDOOR_INTERNAL_ISSUER/)
  })
})
