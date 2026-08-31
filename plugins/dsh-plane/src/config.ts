/**
 * Plugin configuration for dsh-plane: where the Plane instance lives, how to
 * authenticate, and which workspace/project the tools fall back to.
 *
 * @module dsh-plane/config
 */

import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_WORKSPACE_SLUG } from './engine/models.ts'

/** Resolved plugin configuration after schemastery defaults. */
export interface Config {
  /** Where plane_* tools are served from: the in-process engine or a remote Plane instance. */
  backend: 'local' | 'remote'
  /** Origin of the Plane API (remote backend): https://api.plane.so on Plane Cloud, or the instance origin when self-hosted. */
  baseUrl: string
  /** Personal access token sent as X-API-Key (remote backend); when empty every remote call fails with setup instructions. */
  apiKey: string
  /** Default workspace slug; per-call workspace arguments override it. The local engine seeds 'dsh'. */
  workspaceSlug: string
  /** Default project id for project-scoped tools; per-call projectId arguments override it. */
  defaultProjectId: string
  /** Directory holding the local engine's store.json (local backend). */
  dataDir: string
  /** Per-request timeout in milliseconds (remote backend). */
  timeoutMs: number
  /** Default page size for list tools (Plane caps per_page at 100). */
  perPage: number
}

/** Defaults applied by the schemastery layer and again defensively in resolveConfig. */
export const DEFAULT_CONFIG: Config = {
  backend: 'local',
  baseUrl: 'https://api.plane.so',
  apiKey: '',
  workspaceSlug: '',
  defaultProjectId: '',
  dataDir: '',
  timeoutMs: 30_000,
  perPage: 50,
}

/** Schemastery configuration for the dsh-plane plugin consumer. */
export const Config: Schema<Config> = Schema.object({
  backend: Schema.string().default(DEFAULT_CONFIG.backend).description(
    'Where the plane tools are served from: "local" runs the in-process Plane-compatible engine (no external service, '
    + 'data under dataDir), "remote" talks to Plane Cloud or a self-hosted instance over REST.',
  ),
  baseUrl: Schema.string().default(DEFAULT_CONFIG.baseUrl).description(
    'Remote backend only: Plane API origin, https://api.plane.so on Plane Cloud or your self-hosted instance origin.',
  ),
  apiKey: Schema.string().role('secret').default(DEFAULT_CONFIG.apiKey).description(
    'Remote backend only: personal access token sent as X-API-Key (Plane: Profile Settings, Personal Access Tokens). '
    + 'The local engine manages its own key.',
  ),
  workspaceSlug: Schema.string().default(DEFAULT_CONFIG.workspaceSlug).description(
    'Default workspace slug used when a tool call does not pass workspace (the URL segment after the host). '
    + 'The local engine seeds a workspace named dsh.',
  ),
  defaultProjectId: Schema.string().default(DEFAULT_CONFIG.defaultProjectId).description(
    'Optional default project id used when a tool call does not pass projectId.',
  ),
  dataDir: Schema.string().default(DEFAULT_CONFIG.dataDir).description(
    'Local backend only: directory holding the engine store. Empty resolves to $DSH_HOME/plane '
    + '(or $DSH_PLANE_DATA_DIR). Changing it takes effect after a restart.',
  ),
  timeoutMs: Schema.number().default(DEFAULT_CONFIG.timeoutMs).description('Remote backend: per-request timeout in milliseconds.'),
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
  if (config.backend !== 'local' && config.backend !== 'remote') config.backend = DEFAULT_CONFIG.backend
  config.baseUrl = normalizeBaseUrl(config.baseUrl)
  config.workspaceSlug = config.workspaceSlug.trim()
  if (config.backend === 'local' && config.workspaceSlug.length === 0) {
    config.workspaceSlug = DEFAULT_WORKSPACE_SLUG
  }
  config.dataDir = config.dataDir.trim()
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
