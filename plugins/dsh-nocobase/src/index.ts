/**
 * dsh-nocobase: NocoBase integration host half. Owns the nocobase settings
 * namespace (baseUrl the card edits, live reconfigure without restart) and —
 * when a webServer service exists — mounts the status route the browser half
 * reads. Deployment and the casdoor login wiring live outside this process:
 * compose (NocoBase + postgres) and plugins/dsh-nocobase/scripts/bootstrap.mjs.
 *
 * @module dsh-nocobase
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Config, resolveConfig } from './config.ts'
import type { Config as ConfigShape } from './config.ts'
import { mountNocobaseRoutes } from './routes.ts'
import type { NocobaseWebServer } from './routes.ts'

/** Cordis plugin name; keep this stable after publishing. */
export const name = 'nocobase'

/** Services that must exist before the plugin is applied (none: only settings). */
export const inject: string[] = []

/** The settings namespace this plugin owns (the card's slot key matches it). */
export const NOCOBASE_NS = settingsNamespace('nocobase')

export { Config }
export type { ConfigShape }
export { resolveConfig }
export { probeNocobase } from './nocobase.ts'
export type { NocobaseHealth } from './nocobase.ts'
export { mountNocobaseRoutes, STATUS_PATH } from './routes.ts'

/**
 * Activate the plugin: resolve configuration, install the settings section,
 * and mount the status route when a webServer service exists.
 * @param ctx - host context.
 * @param config - loader-supplied entry config.
 */
export function apply(ctx: Context, config: Partial<ConfigShape> | undefined): void {
  const entry = resolveConfig(config)
  let authoritative: () => ConfigShape = () => entry
  let current = entry
  installSettingsSection(ctx, NOCOBASE_NS, Config, entry, {
    setSource: read => {
      authoritative = read as () => ConfigShape
    },
    onChange: () => {
      current = resolveConfig(authoritative())
    },
  })
  ctx.inject(['webServer'], scoped => {
    scoped.effect(() => mountNocobaseRoutes(scoped.webServer as unknown as NocobaseWebServer, () => current), 'nocobase: routes')
  })
}
