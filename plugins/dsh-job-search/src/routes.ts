/**
 * Read-only web route for the job-search dashboard: the browser half fetches
 * one tenant's pipeline snapshot. Mounted through dynamic webServer inject
 * (sentinel pattern), so headless profiles without a webServer service still
 * load the tools. Tenant data itself never leaves the host: only the capped
 * pipeline view crosses the wire.
 *
 * @module dsh-job-search/routes
 */

/** The dashboard-data route. */
export const PIPELINE_PATH = '/plugins/dsh-job-search/pipeline.json'

/** The webServer registration surface the route mounts through. */
export interface JobSearchWebServer {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: JobSearchIncomingMessage, res: JobSearchServerResponse) => void
  }): () => void
}

/** Minimal Node http shapes the handler uses. */
export interface JobSearchIncomingMessage {
  method?: string | undefined
  url?: string | undefined
}

/** Minimal Node http response shape the handler uses. */
export interface JobSearchServerResponse {
  writeHead(status: number, headers: Record<string, string>): void
  end(body: string): void
}

/** The pipeline surface the route reads from the Service. */
export interface PipelineSource {
  pipeline(request: { tenantId?: string }): Promise<{
    tenantId: string
    hasProfile: boolean
    profileName?: string
    jobsCount: number
    applications: Record<string, number>
    recentJobs: unknown[]
    recentApplications: unknown[]
  }>
}

/** Whether one tenant id is safe to serve (no path/control characters). */
function safeTenantId(value: string | null): boolean {
  return value === null || (/^[\w.-]{1,128}$/u.test(value))
}

/**
 * Mount the pipeline route on one webServer.
 * @param webServer - the host webServer service.
 * @param source - the JobSearchService exposing the pipeline read.
 * @returns the disposer unregistering the route.
 */
export function mountPipelineRoute(
  webServer: JobSearchWebServer,
  source: PipelineSource,
): () => void {
  return webServer.register({
    kind: 'exact',
    path: PIPELINE_PATH,
    handler: (req, res) => {
      void (async () => {
        try {
          const query = new URL(req.url ?? '/', 'http://localhost').searchParams
          const tenantId = query.get('tenant')
          if (!safeTenantId(tenantId)) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'invalid tenant' }))
            return
          }
          const view = await source.pipeline(tenantId === null ? {} : { tenantId })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(view))
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        }
      })()
    },
  })
}
