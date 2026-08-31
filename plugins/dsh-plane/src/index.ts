/**
 * dsh-plane: Plane (makeplane) project tracking as DeepSeek Harness tools,
 * settings, and a web panel — either from the in-process engine (local, no
 * external service) or a remote Plane instance over REST.
 *
 * Registers the plane_* tool family, installs the plane settings namespace
 * (the settings card edits it; committed changes reconfigure the tools live,
 * no restart — including flipping the backend), and — when a webServer
 * service exists — mounts the routes the browser half reads plus the
 * X-API-Key-guarded v1-compatible HTTP surface external tools can target.
 *
 * @module dsh-plane
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { LocalBackend } from './backend.ts'
import type { PlaneBackend } from './backend.ts'
import { PlaneClient } from './client.ts'
import { Config, resolveConfig } from './config.ts'
import type { Config as ConfigShape } from './config.ts'
import { createV1Router } from './api/router.ts'
import { openEngine } from './engine/engine.ts'
import type { PlaneEngine } from './engine/engine.ts'
import { FsStoreAdapter } from './engine/store.ts'
import { JsonStore } from './engine/store.ts'
import { resolveDshHome } from './engine/dsh-home.ts'
import { mountPlaneRoutes } from './routes.ts'
import type { PlaneWebServer } from './routes.ts'
import { registerPlaneTools } from './tools.ts'
import { join } from 'node:path'

/** Cordis plugin name; keep this stable after publishing. */
export const name = 'plane'

/** Services that must exist before the plugin is applied. */
export const inject: string[] = ['tools']

/** The settings namespace this plugin owns (the card's slot key matches it). */
export const PLANE_NS = settingsNamespace('plane')

export { Config }
export type { ConfigShape }
export { PlaneClient, resolveConfig }
export type { PlaneBackend }
export { LocalBackend, createV1Router, openEngine, JsonStore, FsStoreAdapter, resolveDshHome }
export { mountPlaneRoutes, STATE_PATH, PANEL_PATH } from './routes.ts'
export { issueLine, projectKeys, issueKeys, commentKeys, metadataKeys, projectRows } from './view.ts'
export type { MetadataResource } from './view.ts'
export type { Page, QueryValue, ItemScope } from './client.ts'
export { PlaneApiError } from './client.ts'

/**
 * Activate the plugin: resolve configuration, install the settings section,
 * register the plane tools over a live backend source, and mount the routes
 * when a webServer service exists.
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
  const remote = new PlaneClient(getConfig)
  let local: Promise<PlaneBackend> | undefined
  let enginePromise: Promise<PlaneEngine> | undefined
  let engineDataDir = ''

  /**
   * Open (once) the local engine under the data directory configured at the
   * time of the first local-backend use. Changing dataDir later requires a
   * restart; the settings card says so.
   */
  const localBackend = (): Promise<PlaneBackend> => {
    const dataDir = resolveDataDir(getConfig())
    if (local === undefined || dataDir !== engineDataDir) {
      engineDataDir = dataDir
      enginePromise = openEngine(new JsonStore(new FsStoreAdapter(dataDir)))
      local = enginePromise.then(engine => new LocalBackend(createV1Router(engine)))
    }
    return local
  }

  /** The engine behind the HTTP surfaces; refuses while the remote backend is selected. */
  const getEngine = async (): Promise<PlaneEngine> => {
    if (getConfig().backend !== 'local') {
      throw new Error('the dsh-plane local engine is not active: switch backend to local in the plugin settings')
    }
    if (enginePromise === undefined) localBackend()
    return enginePromise as Promise<PlaneEngine>
  }

  const getBackend = (): PlaneBackend | Promise<PlaneBackend> => (getConfig().backend === 'remote' ? remote : localBackend())
  registerPlaneTools(ctx, getBackend, getConfig)
  installSettingsSection(ctx, PLANE_NS, Config, entry, {
    setSource: read => {
      authoritative = read as () => ConfigShape
    },
    onChange: () => {
      current = resolveConfig(authoritative())
    },
  })
  ctx.inject(['webServer'], scoped => {
    scoped.effect(() => mountPlaneRoutes(scoped.webServer as unknown as PlaneWebServer, getConfig, getBackend, getEngine), 'plane: routes')
  })
}

/**
 * Resolve the local engine's data directory: the configured value, else the
 * environment override, else $DSH_HOME/plane.
 * @param config - the live resolved config.
 * @returns the absolute directory path.
 */
function resolveDataDir(config: Config): string {
  if (config.dataDir.length > 0) return config.dataDir
  const override = process.env.DSH_PLANE_DATA_DIR
  if (override !== undefined && override.trim().length > 0) return override
  return join(resolveDshHome(), 'plane')
}
