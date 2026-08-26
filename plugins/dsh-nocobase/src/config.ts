/**
 * Plugin configuration for dsh-nocobase: where the NocoBase instance lives.
 * The casdoor login wiring itself lives in NocoBase (the @dsh/plugin-auth-casdoor
 * authenticator) — this only configures the dsh-facing surface.
 *
 * @module dsh-nocobase/config
 */

import Schema from '@deepseek-ai/schemastery'

/** Resolved plugin configuration after schemastery defaults. */
export interface Config {
  /** Origin of the NocoBase web app (the root docker-compose maps it to 127.0.0.1:13000). */
  baseUrl: string
  /** Health-check timeout in milliseconds. */
  timeoutMs: number
}

/** Defaults applied by the schemastery layer and again defensively in resolveConfig. */
export const DEFAULT_CONFIG: Config = {
  baseUrl: 'http://127.0.0.1:13000',
  timeoutMs: 5_000,
}

/** Schemastery configuration for the dsh-nocobase plugin consumer. */
export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string().default(DEFAULT_CONFIG.baseUrl).description(
    'NocoBase origin, e.g. http://127.0.0.1:13000 (the root docker-compose mapping).',
  ),
  timeoutMs: Schema.number().default(DEFAULT_CONFIG.timeoutMs).description('Health-check timeout in milliseconds.'),
}) as Schema<Config>

/**
 * Normalize a loader-supplied partial config onto the defaults, dropping
 * undefined values so an unset js-expression entry falls through to defaults.
 * @param raw - the entry config the loader passed to apply.
 * @returns the fully resolved config.
 */
export function resolveConfig(raw: Partial<Config> | undefined): Config {
  const merged: Record<string, unknown> = { ...DEFAULT_CONFIG }
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value !== undefined) merged[key] = value
  }
  const config = merged as unknown as Config
  config.baseUrl = normalizeBaseUrl(config.baseUrl)
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    config.timeoutMs = DEFAULT_CONFIG.timeoutMs
  }
  return config
}

/**
 * Strip trailing slashes so path building stays concatenation-only.
 * @param baseUrl - the configured origin.
 * @returns the origin without a trailing slash.
 */
function normalizeBaseUrl(baseUrl: string): string {
  let trimmed = baseUrl.trim()
  if (trimmed.length === 0) trimmed = DEFAULT_CONFIG.baseUrl
  return trimmed.replace(/\/+$/, '')
}
