/**
 * Plugin configuration for dsh-plane: where the Plane instance lives, how to
 * authenticate, and which workspace/project the tools fall back to.
 *
 * @module dsh-plane/config
 */

import Schema from '@deepseek-ai/schemastery'

/** Resolved plugin configuration after schemastery defaults. */
export interface Config {
  /** Origin of the Plane API: https://api.plane.so on Plane Cloud, or the instance origin when self-hosted. */
  baseUrl: string
  /** Personal access token sent as X-API-Key; when empty every call fails with setup instructions instead of failing boot. */
  apiKey: string
  /** Default workspace slug; per-call workspace arguments override it. */
  workspaceSlug: string
  /** Default project id for project-scoped tools; per-call projectId arguments override it. */
  defaultProjectId: string
  /** Per-request timeout in milliseconds. */
  timeoutMs: number
  /** Default page size for list tools (Plane caps per_page at 100). */
  perPage: number
}

/** Defaults applied by the schemastery layer and again defensively in resolveConfig. */
export const DEFAULT_CONFIG: Config = {
  baseUrl: 'https://api.plane.so',
  apiKey: '',
  workspaceSlug: '',
  defaultProjectId: '',
  timeoutMs: 30_000,
  perPage: 50,
}

/** Schemastery configuration for the dsh-plane plugin consumer. */
export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string().default(DEFAULT_CONFIG.baseUrl).description(
    'Plane API origin: https://api.plane.so on Plane Cloud, or your self-hosted instance origin (e.g. https://plane.example.com).',
  ),
  apiKey: Schema.string().role('secret').default(DEFAULT_CONFIG.apiKey).description(
    'Personal access token sent as X-API-Key (Plane: Profile Settings, Personal Access Tokens). Empty registers the tools but every call fails with setup instructions.',
  ),
  workspaceSlug: Schema.string().default(DEFAULT_CONFIG.workspaceSlug).description(
    'Default workspace slug used when a tool call does not pass workspace (the URL segment after the host, e.g. my-team in https://app.plane.so/my-team/projects/).',
  ),
  defaultProjectId: Schema.string().default(DEFAULT_CONFIG.defaultProjectId).description(
    'Optional default project id used when a tool call does not pass projectId.',
  ),
  timeoutMs: Schema.number().default(DEFAULT_CONFIG.timeoutMs).description('Per-request timeout in milliseconds.'),
  perPage: Schema.number().default(DEFAULT_CONFIG.perPage).description(
    'Default page size for list tools; Plane caps per_page at 100.',
  ),
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
  if (!Number.isInteger(config.perPage) || config.perPage < 1 || config.perPage > 100) {
    config.perPage = DEFAULT_CONFIG.perPage
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    config.timeoutMs = DEFAULT_CONFIG.timeoutMs
  }
  return config
}

/**
 * Strip trailing slashes and an accidental /api/v1 suffix so path building
 * stays concatenation-only.
 * @param baseUrl - the configured origin.
 * @returns the origin without a trailing slash or API prefix.
 */
function normalizeBaseUrl(baseUrl: string): string {
  let trimmed = baseUrl.trim()
  if (trimmed.length === 0) trimmed = DEFAULT_CONFIG.baseUrl
  trimmed = trimmed.replace(/\/+$/, '').replace(/\/api\/v1$/, '').replace(/\/+$/, '')
  return trimmed
}
