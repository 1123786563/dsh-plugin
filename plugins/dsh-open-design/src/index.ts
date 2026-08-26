/**
 * dsh-open-design: the OpenDesign design-engine skill catalog as a DeepSeek
 * Harness plugin.
 *
 * Applies the official filesystem skill provider in isolated mode against the
 * package's bundled `skills/` directory, registering it on the host
 * `ctx.skills` registry under the provider name `open-design`. Every session
 * in a profile that bundles this plugin sees the catalog through the ordinary
 * skill registry merge: 75 portable OpenDesign skills plus two packaged
 * entries — `od-deck-framework` (fixed slide-deck HTML framework) and
 * `od-design-systems` (152 brand-grade design systems).
 *
 * The provider reuses `@deepseek-ai/dsh-skill-filesystem` (parsing, watch,
 * invalidation) with `includeDefaultRoots: false`, so it contributes exactly
 * its own roots and nothing else. `customSkillDirs` config appends extra
 * local roots after the bundled catalog.
 *
 * Provenance: ported from nexu-io/open-design (Apache-2.0); see README.md
 * for the selection rules and what was deliberately left out.
 *
 * @module dsh-open-design
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'

/** Cordis plugin name; keep this stable after publishing. */
export const name = 'open-design'

/** Services that must exist before the plugin is applied. */
export const inject: string[] = ['skills']

/** Provider name the bundled catalog registers under on `ctx.skills`. */
export const PROVIDER_NAME = 'open-design'

/** Plugin configuration. */
export interface Config {
  /** Extra local skill roots scanned after the bundled catalog. */
  customSkillDirs: string[]
  /** Watch bundled and custom roots for catalog changes (default true). */
  watch: boolean
}

export const Config: Schema<Config> = z.object({
  customSkillDirs: z.array(z.string()).default([]),
  watch: z.boolean().default(true),
})

/**
 * The bundled catalog directory, resolved from this module so it travels with
 * the package whether consumed from `lib/` or `src/`.
 */
export function bundledSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
}

export function apply(ctx: Context, config: Config = Config()): void {
  ctx.plugin(skillFilesystem, {
    providerName: PROVIDER_NAME,
    includeDefaultRoots: false,
    customSkillDirs: [bundledSkillsDir(), ...config.customSkillDirs],
    watch: config.watch,
  })
}
