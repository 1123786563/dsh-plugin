/**
 * Plugin configuration for dsh-higress: where the Higress AI gateway's
 * OpenAI-compatible endpoint lives, which credential reference carries the
 * consumer key, and the advisory model catalog the route advertises.
 *
 * @module dsh-higress/config
 */

import Schema from '@deepseek-ai/schemastery'
import { RetryPolicySchema, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ModelModality, ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'

/** One advisory model entry this route can advertise. */
export interface HigressCatalogModel {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: readonly ModelModality[]
}

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-higress` settings-section shape. Every field is optional in
 * yml: the consumer key resolves through {@link Config.apiKeyEnv} per request,
 * and an omitted baseURL falls back to $HIGRESS_BASE_URL then the loopback
 * default.
 */
export interface Config {
  /** Credential reference resolved per request; defaults to `HIGRESS_API_KEY`. */
  apiKeyEnv?: string
  /** OpenAI-compatible endpoint prefix; falls back to $HIGRESS_BASE_URL, then http://127.0.0.1:8080/v1. */
  baseURL?: string
  /** Deployment thinking policy forwarded to deepseek-flavored upstreams. */
  thinking?: 'enabled' | 'disabled'
  /** Default thinking effort when a request omits one. */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Context capacity used when a model entry has none (default 65,536). */
  defaultContextWindow?: number
  /** Default per-request output cap; omission leaves it to the gateway. */
  maxTokens?: number
  /** Advisory models shown by discovery consumers; defaults to deepseek-chat. */
  models?: HigressCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy?: RetryPolicyConfig
}

const MODEL_MODALITIES = ['text', 'image'] as const satisfies readonly ModelModality[]

/** Loopback default of a Docker-deployed Higress AI gateway. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8080/v1'

/** Environment variable honored only from the launching process environment. */
const BASE_URL_ENV = 'HIGRESS_BASE_URL'

const DEFAULT_API_KEY_ENV = 'HIGRESS_API_KEY'
const DEFAULT_CONTEXT_WINDOW = 65_536
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** The shipped catalog: one entry, because gateway-side routing is unknown to the plugin. */
export const DEFAULT_MODELS: readonly HigressCatalogModel[] = [
  { id: 'deepseek-chat', name: 'DeepSeek Chat (via Higress)', contextWindow: DEFAULT_CONTEXT_WINDOW },
]

const catalogModel = Schema.object({
  id: Schema.string().required(),
  name: Schema.string(),
  description: Schema.string(),
  contextWindow: Schema.number().step(1).min(1),
  maxTokens: Schema.number().step(1).min(1),
  inputModalities: Schema.array(Schema.union(MODEL_MODALITIES)).min(1).default(['text']),
})

export const Config: Schema<Config> = Schema.object({
  apiKeyEnv: Schema.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: Schema.string(),
  thinking: Schema.union(['enabled', 'disabled']),
  reasoningEffort: Schema.union(['off', 'low', 'high', 'max']),
  defaultContextWindow: Schema.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  maxTokens: Schema.number().step(1).min(1),
  // Schemastery's static object type marks every property required, while the
  // runtime schema treats unset ones as optional; cast the shipped catalog to
  // the schema's own output type rather than duplicating it.
  models: Schema.array(catalogModel).default([...DEFAULT_MODELS] as ReturnType<typeof catalogModel>[]),
  streamIdleTimeoutMs: Schema.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema,
}) as unknown as Schema<Config>

/** One resolution's complete request facts. */
export interface ResolvedHigressOptions {
  apiKeyEnv: string
  baseURL: string
  defaults: { thinking?: 'enabled' | 'disabled'; reasoningEffort?: 'off' | 'low' | 'high' | 'max' }
  defaultContextWindow: number
  maxTokens: number | undefined
  models: readonly HigressCatalogModel[]
  streamIdleTimeoutMs: number
  retryPolicy: ResolvedRetryPolicy
}

/**
 * Resolve, validate, and detach one configuration generation.
 * @param config - raw entry/settings shape (all fields optional).
 * @param env - launching environment for the baseURL fallback (default process.env).
 * @returns the frozen request facts for this generation.
 */
export function resolveConfig(
  config: Partial<Config> | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedHigressOptions {
  const baseURLRaw = config?.baseURL ?? env[BASE_URL_ENV] ?? DEFAULT_BASE_URL
  let parsed: URL
  try {
    parsed = new URL(baseURLRaw)
  } catch {
    throw new Error(`llm-higress: baseURL is not a valid URL: ${baseURLRaw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`llm-higress: baseURL must be an http(s) URL: ${baseURLRaw}`)
  }
  if (parsed.pathname === '' || parsed.pathname === '/') {
    throw new Error('llm-higress: baseURL must include the OpenAI-compatible prefix (e.g. http://127.0.0.1:8080/v1), not the site root')
  }

  const defaultContextWindow = config?.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isSafeInteger(defaultContextWindow) || defaultContextWindow < 1) {
    throw new Error('llm-higress: defaultContextWindow must be a positive integer')
  }
  const streamIdleTimeoutMs = config?.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isSafeInteger(streamIdleTimeoutMs) || streamIdleTimeoutMs < 1) {
    throw new Error('llm-higress: streamIdleTimeoutMs must be a positive integer')
  }
  const maxTokens = config?.maxTokens
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) {
    throw new Error('llm-higress: maxTokens must be a positive integer when set')
  }

  return {
    apiKeyEnv: config?.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    baseURL: baseURLRaw.replace(/\/+$/, ''),
    defaults: {
      ...(config?.thinking !== undefined && { thinking: config.thinking }),
      ...(config?.reasoningEffort !== undefined && { reasoningEffort: config.reasoningEffort }),
    },
    defaultContextWindow,
    maxTokens,
    models: config?.models ?? DEFAULT_MODELS,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config?.retryPolicy, 'llm-higress: retryPolicy'),
  }
}
