/**
 * dsh-plane: Plane (makeplane) project tracking as DeepSeek Harness tools,
 * settings, and a web panel.
 *
 * Registers the plane_* tool family over the Plane REST API on the host tools
 * service, installs the plane settings namespace (the settings card edits it;
 * committed changes reconfigure the tools live, no restart), and — when a
 * webServer service exists — mounts the read-only routes the browser half's
 * sidebar panel reads. Booting without an apiKey still registers everything;
 * calls then fail with setup instructions instead of failing the tree.
 *
 * @module dsh-plane
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { PlaneClient } from './client.ts'
import { Config, resolveConfig } from './config.ts'
import type { Config as ConfigShape } from './config.ts'
import { mountPlaneRoutes } from './routes.ts'
import type { PlaneWebServer } from './routes.ts'
import { registerPlaneTools } from './tools.ts'

/** Cordis plugin name; keep this stable after publishing. */
export const name = 'plane'

/** Services that must exist before the plugin is applied. */
export const inject: string[] = ['tools']

/** The settings namespace this plugin owns (the card's slot key matches it). */
export const PLANE_NS = settingsNamespace('plane')

export { Config }
export type { ConfigShape }
export { PlaneClient, resolveConfig }
export { mountPlaneRoutes, STATE_PATH, PANEL_PATH } from './routes.ts'
export { issueLine, projectKeys, issueKeys, commentKeys, metadataKeys, projectRows } from './view.ts'
export type { MetadataResource } from './view.ts'
export type { Page, QueryValue, ItemScope } from './client.ts'
export { PlaneApiError } from './client.ts'

/**
 * Activate the plugin: resolve configuration, install the settings section,
 * register the plane tools over a live config source, and mount the panel
 * routes when a webServer service exists.
 * @param ctx - host context carrying the tools service.
 * @param config - loader-supplied entry config.
 */
export function apply(ctx: Context, config: Partial<ConfigShape> | undefined): void {
  const entry = resolveConfig(config)
  // The authoritative source: the resolved settings scope while one is
  // attached (setSource rewires it), the composition entry otherwise.
  let authoritative: () => ConfigShape = () => entry
  let current = entry
  const getConfig = (): Config => current
  const client = new PlaneClient(getConfig)
  registerPlaneTools(ctx, client, getConfig)
  installSettingsSection(ctx, PLANE_NS, Config, entry, {
    setSource: read => {
      authoritative = read as () => ConfigShape
    },
    onChange: () => {
      current = resolveConfig(authoritative())
    },
  })
  ctx.inject(['webServer'], scoped => {
    scoped.effect(() => mountPlaneRoutes(scoped.webServer as unknown as PlaneWebServer, getConfig), 'plane: routes')
  })
}