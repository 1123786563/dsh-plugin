/**
 * Plugin configuration for dsh-casdoor-auth: where the gateway's JWKS lives,
 * how the DshIdentityToken is addressed, and the (optional) per-tenant MCP
 * server wiring handed to the dsh-multi-tenant runtime.
 *
 * @module dsh-casdoor-auth/config
 */

import Schema from '@deepseek-ai/schemastery'
import type { TenantMcpConfig, TenantMcpServer } from 'dsh-multi-tenant'

/** Loose operator-facing shape of one tenant MCP server. */
export interface McpServerConfig {
  readonly serverName: string
  readonly transport: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly toolCallTimeoutMs?: number
}

/** Resolved plugin configuration after schemastery defaults. */
export interface Config {
  /** JWKS endpoint of the dsh-casdoor-gateway (public keys are public). */
  gatewayJwksUrl: string
  /**
   * Pinned gateway public key (ADR-0004: pin first, JWKS fallback): PEM SPKI
   * or JSON-serialized JWK string. Empty disables the pin (remote-JWKS
   * behavior unchanged); malformed material fails activation loudly instead
   * of silently weakening into the JWKS fallback.
   */
  identityPublicKey: string
  /** Header the gateway carries the DshIdentityToken in. */
  identityHeader: string
  /** Expected `iss` of the DshIdentityToken. */
  issuer: string
  /** Expected `aud` of the DshIdentityToken. */
  audience: string
  /** Mount path of the multi-tenant web bridge. */
  basePath: string
  /** Serve the bridge's small identity/admission control page. */
  controlPage: boolean
  /** MCP servers offered to every tenant unless overridden per tenant. */
  mcpServers: readonly McpServerConfig[]
  /** Per-tenant MCP server overrides (wins over mcpServers). */
  mcpServersByTenant: Readonly<Record<string, readonly McpServerConfig[]>>
  /** Static principal credentials handed to the MCP integration (v1: shared; name→value). */
  credentials: Readonly<Record<string, string>>
  /** Data directory of the companion dsh-casdoor-gateway service (launch-token handoff). */
  gatewayDataDir: string
  /**
   * Zero-trust private-port guard switch (escape hatch): false keeps the
   * pre-gate behavior byte-identical; true claims the host webserver's
   * guard seat and vetoes every request without a valid credential.
   */
  guardEnabled: boolean
}

export const DEFAULT_CONFIG: Config = {
  gatewayJwksUrl: 'http://127.0.0.1:3080/.well-known/jwks.json',
  identityPublicKey: '',
  identityHeader: 'x-dsh-identity',
  issuer: 'dsh-casdoor-gateway',
  audience: 'dsh-casdoor-auth',
  basePath: '/_dsh-multi-tenant',
  controlPage: true,
  mcpServers: [],
  mcpServersByTenant: {},
  credentials: {},
  gatewayDataDir: '~/.dsh-casdoor-gateway',
  guardEnabled: false,
}

// Schemastery's inferred object-schema types do not line up with interfaces
// carrying optional fields under exactOptionalPropertyTypes, so these schemas
// keep their inferred types; resolveConfig below normalizes to Config.
const serverSchema = Schema.object({
  serverName: Schema.string().required().description('Logical product-facing server name.'),
  transport: Schema.string().default('stdio').description("'stdio' or 'streamable-http'."),
  command: Schema.string().description('stdio: executable to launch.'),
  args: Schema.array(String).description('stdio: argv.'),
  env: Schema.dict(String).description('stdio: static environment variables.'),
  cwd: Schema.string().description('stdio: working directory.'),
  url: Schema.string().description('streamable-http: server URL.'),
  headers: Schema.dict(String).description('streamable-http: static headers.'),
  toolCallTimeoutMs: Schema.number().description('Per-call tool timeout, milliseconds.'),
})

/** Schemastery configuration for the dsh-casdoor-auth plugin consumer. */
// The cast keeps the declaration portable (TS2742: schemastery's inferred
// schema types reference cosmokit internals) while exactOptionalPropertyTypes
// forbids the direct Schema<Config> assignment for optional nested fields.
export const Config: Schema<Config> = Schema.object({
  gatewayJwksUrl: Schema.string().default(DEFAULT_CONFIG.gatewayJwksUrl).description(
    'JWKS endpoint of the dsh-casdoor-gateway; the plugin verifies every DshIdentityToken against it.',
  ),
  identityPublicKey: Schema.string().default(DEFAULT_CONFIG.identityPublicKey).description(
    'Pinned gateway identity public key (PEM SPKI or JSON JWK); when set, tokens verify locally with no JWKS fetch. Empty keeps the JWKS fallback.',
  ),
  identityHeader: Schema.string().default(DEFAULT_CONFIG.identityHeader).description(
    'Header the gateway forwards the DshIdentityToken in.',
  ),
  issuer: Schema.string().default(DEFAULT_CONFIG.issuer).description(
    'Expected issuer of the DshIdentityToken.',
  ),
  audience: Schema.string().default(DEFAULT_CONFIG.audience).description(
    'Expected audience of the DshIdentityToken.',
  ),
  basePath: Schema.string().default(DEFAULT_CONFIG.basePath).description(
    'Mount path of the dsh-multi-tenant web bridge (identity + agent admission routes).',
  ),
  controlPage: Schema.boolean().default(DEFAULT_CONFIG.controlPage).description(
    'Serve the bridge control page at basePath.',
  ),
  mcpServers: Schema.array(serverSchema).default([]).description(
    'Tenant MCP servers offered to every tenant unless mcpServersByTenant overrides the tenant.',
  ),
  mcpServersByTenant: Schema.dict(Schema.array(serverSchema)).default({}).description(
    'Per-tenant MCP server overrides keyed by tenant id (casdoor organization).',
  ),
  credentials: Schema.dict(Schema.string().role('secret')).default({}).description(
    'Static principal credentials (name → value) handed to the MCP integration; v1 is shared across principals.',
  ),
  gatewayDataDir: Schema.string().default(DEFAULT_CONFIG.gatewayDataDir).description(
    'Data directory of the dsh-casdoor-gateway service; the plugin publishes the webserver launch token there for the gateway to exchange.',
  ),
  guardEnabled: Schema.boolean().default(DEFAULT_CONFIG.guardEnabled).description(
    'Zero-trust private-port guard: veto every webserver request (HTTP and WebSocket upgrade) that carries no valid DshIdentityToken or launch token; false keeps the pre-gate behavior. Requires a host core patched with scripts/host-patches/deepseek-harness.dsh-request-guard.patch.',
  ),
}) as unknown as Schema<Config>

/** Defaults applied defensively for hand-built contexts (the loader fills schema defaults). */
export function resolveConfig(input: Partial<Config> | undefined): Config {
  return { ...DEFAULT_CONFIG, ...(input ?? {}) }
}

function toTenantServer(server: McpServerConfig): TenantMcpServer {
  if (server.transport === 'streamable-http') {
    if (server.url === undefined || server.url.length === 0) {
      throw new Error(`casdoor-auth mcp server ${JSON.stringify(server.serverName)}: streamable-http requires url`)
    }
    if (server.url.startsWith('http://') || server.url.startsWith('https://')) {
      return {
        transport: 'streamable-http',
        serverName: server.serverName,
        url: server.url,
        ...(server.headers === undefined ? {} : { headers: server.headers }),
        ...(server.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: server.toolCallTimeoutMs }),
      }
    }
    throw new Error(`casdoor-auth mcp server ${JSON.stringify(server.serverName)}: url must be http(s)`)
  }
  if (server.transport !== 'stdio') {
    throw new Error(`casdoor-auth mcp server ${JSON.stringify(server.serverName)}: unknown transport ${JSON.stringify(server.transport)}`)
  }
  if (server.command === undefined || server.command.length === 0) {
    throw new Error(`casdoor-auth mcp server ${JSON.stringify(server.serverName)}: stdio requires command`)
  }
  return {
    transport: 'stdio',
    serverName: server.serverName,
    command: server.command,
    ...(server.args === undefined ? {} : { args: server.args }),
    ...(server.env === undefined ? {} : { env: server.env }),
    ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    ...(server.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: server.toolCallTimeoutMs }),
  }
}

/** The TenantMcpConfig for one tenant: per-tenant override wins over the global list. */
export function mcpServersFor(config: Config, tenantId: string): TenantMcpConfig {
  const configured = config.mcpServersByTenant[tenantId] ?? config.mcpServers
  return { servers: configured.map(server => toTenantServer(server)) }
}
