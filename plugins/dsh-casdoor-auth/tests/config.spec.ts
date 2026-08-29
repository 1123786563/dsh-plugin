import { describe, expect, it } from 'vitest'
import { mcpServersFor, resolveConfig, type Config } from '../src/config.ts'

describe('resolveConfig', () => {
  it('fills defaults for a bare input', () => {
    const config = resolveConfig(undefined)
    expect(config.gatewayJwksUrl).toBe('http://127.0.0.1:3080/.well-known/jwks.json')
    expect(config.identityHeader).toBe('x-dsh-identity')
    expect(config.issuer).toBe('dsh-casdoor-gateway')
    expect(config.audience).toBe('dsh-casdoor-auth')
    expect(config.basePath).toBe('/_dsh-multi-tenant')
    expect(config.mcpServers).toEqual([])
    expect(config.credentials).toEqual({})
  })

  it('keeps operator overrides', () => {
    const config = resolveConfig({ gatewayJwksUrl: 'http://10.0.0.9:3080/.well-known/jwks.json' })
    expect(config.gatewayJwksUrl).toBe('http://10.0.0.9:3080/.well-known/jwks.json')
  })

  it('defaults guardEnabled to false and reads the operator override', () => {
    expect(resolveConfig(undefined).guardEnabled).toBe(false)
    expect(resolveConfig({ guardEnabled: true }).guardEnabled).toBe(true)
  })
})

const base: Config = resolveConfig({
  mcpServers: [
    { serverName: 'demo', transport: 'stdio', command: 'node', args: ['demo.mjs'] },
  ],
  mcpServersByTenant: {
    globex: [
      { serverName: 'http-one', transport: 'streamable-http', url: 'https://mcp.globex.example.com/mcp', headers: { Authorization: 'Bearer x' } },
    ],
  },
})

describe('mcpServersFor', () => {
  it('maps global stdio servers into TenantMcpConfig', () => {
    const config = mcpServersFor(base, 'acme')
    expect(config.servers).toHaveLength(1)
    expect(config.servers[0]).toEqual({
      transport: 'stdio',
      serverName: 'demo',
      command: 'node',
      args: ['demo.mjs'],
    })
  })

  it('prefers the per-tenant override', () => {
    const config = mcpServersFor(base, 'globex')
    expect(config.servers).toHaveLength(1)
    expect(config.servers[0]).toMatchObject({
      transport: 'streamable-http',
      serverName: 'http-one',
      url: 'https://mcp.globex.example.com/mcp',
    })
  })

  it('rejects incomplete server definitions loudly', () => {
    expect(() => mcpServersFor(resolveConfig({ mcpServers: [{ serverName: 'x', transport: 'stdio' }] }), 't'))
      .toThrow(/stdio requires command/)
    expect(() => mcpServersFor(resolveConfig({ mcpServers: [{ serverName: 'x', transport: 'streamable-http' }] }), 't'))
      .toThrow(/streamable-http requires url/)
    expect(() => mcpServersFor(resolveConfig({ mcpServers: [{ serverName: 'x', transport: 'streamable-http', url: 'ftp://nope' }] }), 't'))
      .toThrow(/must be http/)
  })
})
