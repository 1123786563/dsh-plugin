/**
 * dsh-higress: the Higress AI gateway model route for DeepSeek Harness.
 * Registers one provider route (`higress`) whose adapter streams OpenAI-
 * compatible chat completions through the gateway, beside the untouched
 * `deepseek-official` direct route. Host half only; the browser half is the
 * settings card under `./client`.
 *
 * @module dsh-higress
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { HigressAdapter } from './adapter.ts'
import { Config, resolveConfig } from './config.ts'
import type { Config as ConfigShape, ResolvedHigressOptions } from './config.ts'

/** Cordis plugin name; keep this stable after publishing. */
export const name = 'llm-higress'

/** The `llm` service must exist before this plugin is applied. */
export const inject: string[] = ['llm']

/** The single provider route this plugin owns. */
export const PROVIDER = 'higress'

/** The settings namespace this plugin owns (the card's slot key matches it). */
export const NS = settingsNamespace('llm-higress')

export { Config }
export type { ConfigShape }
export { HigressAdapter, httpErrorCode } from './adapter.ts'
export { resolveConfig } from './config.ts'
export { DEFAULT_BASE_URL, DEFAULT_MODELS } from './config.ts'
export type { HigressCatalogModel, ResolvedHigressOptions } from './config.ts'
export { parseSse, DONE } from './sse.ts'
export { mapFinishReason, mapUsage, translate } from './translate.ts'
export { serializeRequest } from './serialize.ts'
export type { RequestDefaults } from './serialize.ts'

/** Minimal credentials-service surface this plugin consumes. */
export interface CredentialsLike {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/**
 * Resolve the gateway consumer key: the credentials service first (the web
 * Models page writes it), the launching environment only when that service
 * is absent, `MISSING_CREDENTIAL` otherwise.
 * @param ref - credential reference (environment-variable name).
 * @param credentials - the live credentials service, when present.
 * @param env - the launching process environment.
 * @returns the usable key value.
 */
export async function resolveConsumerKey(
  ref: string,
  credentials: CredentialsLike | undefined,
  env: Record<string, string | undefined>,
): Promise<string> {
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-higress', ref)
  } else {
    const ambient = env[ref]
    if (ambient !== undefined && ambient.length > 0) return assertUsableApiKey(ambient, 'llm-higress', ref)
  }
  throw new LlmError(
    `llm-higress: no consumer key for provider route "${PROVIDER}"; store ${ref} through the credentials`
    + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
    'MISSING_CREDENTIAL',
  )
}

/**
 * Activate the plugin: resolve configuration with last-good semantics,
 * register the `higress` adapter route and its Models-page directory entry,
 * and own the `llm-higress` settings section.
 * @param ctx - host context.
 * @param config - loader-supplied entry config.
 */
export function apply(ctx: Context, config: Partial<ConfigShape> | undefined): void {
  const entry = resolveConfig(config)
  // Type-only deviation from the brief (`() => entry` there): `entry` is a
  // ResolvedHigressOptions, which cannot flow into a `() => ConfigShape` under
  // exactOptionalPropertyTypes (maxTokens undefined / readonly models), and
  // re-resolving it would drop `defaults.*` fields that resolveConfig nests.
  // The raw composition entry is the same shape `setSource` later installs,
  // cast exactly like the `installSettingsSection` entry below.
  let authoritative: () => ConfigShape = () => config as ConfigShape
  let current = entry
  let lastRaw: Partial<ConfigShape> | undefined
  let lastGood: ResolvedHigressOptions | undefined
  const options = (): ResolvedHigressOptions => {
    const raw = authoritative()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveConfig(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-higress: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const adapter = new HigressAdapter({
    options,
    resolveApiKey: async connection => resolveConsumerKey(
      connection.apiKeyEnv,
      ctx.get('credentials') as CredentialsLike | undefined,
      process.env,
    ),
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Higress', settingsNs: NS, settingsPath: [] },
  ])
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below.
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = JSON.stringify(options().retryPolicy)
  const ensureRegistrationFacts = (): void => {
    const policy = JSON.stringify(options().retryPolicy)
    if (policy === registeredPolicy) return
    // The registry captures the retry policy at registration, so it is the one
    // fact per-request resolution cannot refresh. `replace` re-reads it in one
    // synchronous registry section: disposing and re-registering instead would
    // publish an empty route set between the two.
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  installSettingsSection(ctx, NS, Config, config as ConfigShape, {
    setSource: source => {
      authoritative = source as () => ConfigShape
    },
    onChange: ensureRegistrationFacts,
  })
}
