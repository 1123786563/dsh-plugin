/**
 * Read-only web routes for the dsh-nocobase card and sidebar tab: one status
 * route proxying the NocoBase health probe, so the browser never parses
 * cross-origin answers.
 *
 * @module dsh-nocobase/routes
 */

import type { Config } from './config.ts'
import { probeNocobase } from './nocobase.ts'

/** Status route the settings card and sidebar tab read. */
export const STATUS_PATH = '/plugins/dsh-nocobase/status'

/** The webServer registration surface the route mounts through. */
export interface NocobaseWebServer {
  register(route: { kind: 'exact', path: string, handler: (req: NocobaseIncomingMessage, res: NocobaseServerResponse) => void }): () => void
}

/** Minimal Node http shapes the handler uses. */
export interface NocobaseIncomingMessage {
  method?: string | undefined
  url?: string | undefined
}

/** Minimal Node http response shape the handler uses. */
export interface NocobaseServerResponse {
  writeHead(status: number, headers: Record<string, string>): void
  end(body: string): void
}

/**
 * Mount the nocobase routes on one webServer.
 * @param webServer - the host webServer service.
 * @param getConfig - live config accessor (settings-resolved when attached).
 * @returns the disposer unregistering the route.
 */
export function mountNocobaseRoutes(webServer: NocobaseWebServer, getConfig: () => Config): () => void {
  return webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }))
        return
      }
      probeNocobase(getConfig).then(
        health => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, health }))
        },
        error => {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        },
      )
    },
  })
}
