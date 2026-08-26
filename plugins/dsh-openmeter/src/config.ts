/**
 * Plugin configuration for dsh-openmeter: where the self-hosted OpenMeter
 * fork lives, which OpenMeter objects metering flows into, and how aggressive
 * the balance gate is.
 *
 * @module dsh-openmeter/config
 */

import Schema from '@deepseek-ai/schemastery'

/** Resolved plugin configuration after schemastery defaults. */
export interface Config {
  /** Origin of the OpenMeter fork API (server component), e.g. http://127.0.0.1:8888. */
  endpoint: string
  /** Optional bearer token; OSS ingest enforces no auth by default, so this stays empty on loopback. */
  token: string
  /** Subject key that unbound sessions (operator's own work) meter into; never blocked. */
  houseSubject: string
  /** Feature key the balance gate checks via governance/query. */
  featureKey: string
  /** CloudEvents `type` of the emitted metering event. */
  eventType: string
  /** CloudEvents `source` of the emitted metering event. */
  eventSource: string
  /** Slug of the meter aggregating billed tokens. */
  meterSlug: string
  /** Currency used for local estimates and cashier display. */
  quoteCurrency: string
  /** Master switch for the hard block; false = warn only. */
  blockEnabled: boolean
  /** TTL of the cached governance access answer, milliseconds. */
  accessCacheTtlMs: number
  /** Interval between llm-cost price refreshes, milliseconds. */
  priceRefreshMs: number
  /** Max events per ingest batch POST. */
  batchSize: number
  /** Directory holding the WAL and plugin state; defaults under $DSH_HOME when empty. */
  dataDir: string
}

/** Defaults applied by the schemastery layer and again defensively in resolveConfig. */
export const DEFAULT_CONFIG: Config = {
  endpoint: 'http://127.0.0.1:8888',
  token: '',
  houseSubject: 'house',
  featureKey: 'dsh_llm',
  eventType: 'dsh.llm.call',
  eventSource: 'dsh',
  meterSlug: 'dsh_llm_tokens',
  quoteCurrency: 'CNY',
  blockEnabled: true,
  accessCacheTtlMs: 60_000,
  priceRefreshMs: 300_000,
  batchSize: 100,
  dataDir: '',
}

/** Schemastery configuration for the dsh-openmeter plugin consumer. */
export const Config: Schema<Config> = Schema.object({
  endpoint: Schema.string().default(DEFAULT_CONFIG.endpoint).description(
    'OpenMeter fork API origin (the server component), e.g. http://127.0.0.1:8888.',
  ),
  token: Schema.string().role('secret').default(DEFAULT_CONFIG.token).description(
    'Optional bearer token for the OpenMeter API. The OSS server enforces no token auth by default, so this stays empty on loopback deployments.',
  ),
  houseSubject: Schema.string().default(DEFAULT_CONFIG.houseSubject).description(
    "Subject key that sessions without a preset binding meter into (the operator's own account): always metered, never blocked.",
  ),
  featureKey: Schema.string().default(DEFAULT_CONFIG.featureKey).description(
    'Feature key the balance gate evaluates via governance/query (e.g. dsh_llm). Create it with the bootstrap script.',
  ),
  eventType: Schema.string().default(DEFAULT_CONFIG.eventType).description(
    'CloudEvents type of the emitted metering event.',
  ),
  eventSource: Schema.string().default(DEFAULT_CONFIG.eventSource).description(
    'CloudEvents source of the emitted metering event.',
  ),
  meterSlug: Schema.string().default(DEFAULT_CONFIG.meterSlug).description(
    'Slug of the meter aggregating billed tokens; created by the bootstrap script.',
  ),
  quoteCurrency: Schema.string().default(DEFAULT_CONFIG.quoteCurrency).description(
    'ISO-4217 currency used for local estimates and cashier display (prices come from the llm-cost catalog).',
  ),
  blockEnabled: Schema.boolean().default(DEFAULT_CONFIG.blockEnabled).description(
    'Hard-block model calls when the customer balance is exhausted; false = meter and warn only.',
  ),
  accessCacheTtlMs: Schema.number().default(DEFAULT_CONFIG.accessCacheTtlMs).description(
    'TTL of the cached governance access answer in milliseconds.',
  ),
  priceRefreshMs: Schema.number().default(DEFAULT_CONFIG.priceRefreshMs).description(
    'Interval between llm-cost price refreshes in milliseconds.',
  ),
  batchSize: Schema.number().default(DEFAULT_CONFIG.batchSize).description(
    'Max metering events per ingest batch POST.',
  ),
  dataDir: Schema.string().default(DEFAULT_CONFIG.dataDir).description(
    'Directory for the WAL and plugin state files; empty = $DSH_HOME/openmeter.',
  ),
}) as Schema<Config>

/**
 * Normalize a loader-supplied partial config onto the defaults.
 * @param raw - the entry config the loader passed to apply.
 * @returns the fully resolved config.
 */
export function resolveConfig(raw: Partial<Config> | undefined): Config {
  const merged: Record<string, unknown> = { ...DEFAULT_CONFIG }
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value !== undefined) merged[key] = value
  }
  const config = merged as unknown as Config
  config.endpoint = config.endpoint.trim().replace(/\/+$/, '')
  if (config.endpoint.length === 0) config.endpoint = DEFAULT_CONFIG.endpoint
  for (const key of ['houseSubject', 'featureKey', 'eventType', 'eventSource', 'meterSlug'] as const) {
    if (config[key].trim().length === 0) config[key] = DEFAULT_CONFIG[key]
  }
  if (!Number.isFinite(config.accessCacheTtlMs) || config.accessCacheTtlMs < 5_000) {
    config.accessCacheTtlMs = DEFAULT_CONFIG.accessCacheTtlMs
  }
  if (!Number.isFinite(config.priceRefreshMs) || config.priceRefreshMs < 30_000) {
    config.priceRefreshMs = DEFAULT_CONFIG.priceRefreshMs
  }
  if (!Number.isInteger(config.batchSize) || config.batchSize < 1 || config.batchSize > 1_000) {
    config.batchSize = DEFAULT_CONFIG.batchSize
  }
  return config
}
