/**
 * Portal adapter seam for job scraping. A portal adapter turns one job board's
 * results into the shared {@link JobDraft} shape; the registry fans a search
 * out across every enabled adapter and flattens the drafts. Adapters are
 * pluggable: a hosted operator adds one module per job board (an authorized
 * API client for BOSS直聘/拉勾, an RSS/JSON feed, a JSON-LD scrape) without
 * touching the store or tools.
 *
 * This package ships one reference adapter, {@link JsonFeedPortal}, that reads
 * a configurable JSON endpoint (an aggregator like freehire.me or an
 * operator-owned proxy). Direct scraping of auth-walled Chinese platforms is
 * deliberately out of scope: those boards require the operator's own
 * authorized access and their terms forbid unsolicited automation.
 *
 * @module @deepseek-ai/dsh-job-search/src/portals
 */

/** One posting as produced by a portal, before tenant/job ids are stamped. */
export interface JobDraft {
  title: string
  company: string
  location?: string
  url?: string
  description: string
  salary?: string
  /** Epoch millis the portal reports for first publication. */
  postedAt?: number
}

/** Search terms handed to every enabled portal. */
export interface PortalSearchRequest {
  /** Free-text query, e.g. role or skills. */
  query: string
  /** Optional location constraint. */
  location?: string
}

/** One pluggable job-board integration. */
export interface PortalAdapter {
  /** Stable id, also stamped on each scraped {@link JobRecord.portalId}. */
  readonly id: string
  /** Human-readable board name for tool output. */
  readonly label: string
  /**
   * Fetch matching postings.
   * @param request - query and optional location.
   * @returns normalized drafts; an empty array means "no results", not failure.
   */
  search(request: PortalSearchRequest): Promise<JobDraft[]>
}

/** Error raised when a portal cannot complete a search. */
export class PortalSearchError extends Error {
  /**
   * @param portalId - adapter id that failed.
   * @param message - human-readable reason.
   */
  constructor(readonly portalId: string, message: string) {
    super(`portal '${portalId}': ${message}`)
    this.name = 'PortalSearchError'
  }
}

/** Raw item shapes a JSON feed may use; mapping tolerates several spellings. */
interface RawJsonItem {
  title?: string
  name?: string
  company?: string
  employer?: string
  location?: string
  city?: string
  url?: string
  link?: string
  description?: string
  summary?: string
  salary?: string
  postedAt?: number | string
  date?: number | string
}

/** Normalize one raw JSON item into a {@link JobDraft}. */
function normalizeItem(raw: RawJsonItem): JobDraft | undefined {
  const title = raw.title ?? raw.name
  const company = raw.company ?? raw.employer
  if (title === undefined || company === undefined) return undefined
  const postedAt = coerceEpoch(raw.postedAt ?? raw.date)
  return {
    title,
    company,
    ...(raw.location !== undefined || raw.city !== undefined ? { location: String(raw.location ?? raw.city) } : {}),
    ...(raw.url !== undefined || raw.link !== undefined ? { url: String(raw.url ?? raw.link) } : {}),
    description: raw.description ?? raw.summary ?? '',
    ...(raw.salary !== undefined ? { salary: raw.salary } : {}),
    ...(postedAt === undefined ? {} : { postedAt }),
  }
}

/** Coerce a raw epoch (number, ISO string, or numeric string) to millis. */
function coerceEpoch(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

/**
 * A JSON-endpoint portal. `searchUrl` may contain `{query}` and `{location}`
 * placeholders; the response is an array of items or an object with an `items`,
 * `data`, or `jobs` array field.
 */
export class JsonFeedPortal implements PortalAdapter {
  /**
   * @param id - stable adapter id.
   * @param label - display name.
   * @param searchUrl - template URL with `{query}` / `{location}` placeholders.
   * @param timeoutMs - per-request timeout.
   */
  constructor(
    readonly id: string,
    readonly label: string,
    private readonly searchUrl: string,
    private readonly timeoutMs: number = 10_000,
  ) {}

  async search(request: PortalSearchRequest): Promise<JobDraft[]> {
    const url = this.searchUrl
      .replaceAll('{query}', encodeURIComponent(request.query))
      .replaceAll('{location}', encodeURIComponent(request.location ?? ''))
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.timeoutMs)
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      if (!response.ok) {
        throw new PortalSearchError(this.id, `responded HTTP ${response.status}`)
      }
      const body: unknown = await response.json()
      return extractItems(body).map(normalizeItem).filter((draft): draft is JobDraft => draft !== undefined)
    } catch (error) {
      if (error instanceof PortalSearchError) throw error
      const reason = controller.signal.aborted ? 'timed out' : String(error)
      throw new PortalSearchError(this.id, reason)
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Extract the item array from a JSON feed's possible envelope shapes. */
function extractItems(body: unknown): RawJsonItem[] {
  if (Array.isArray(body)) return body as RawJsonItem[]
  if (typeof body === 'object' && body !== null) {
    const record = body as Record<string, unknown>
    for (const key of ['items', 'data', 'jobs', 'results']) {
      const value = record[key]
      if (Array.isArray(value)) return value as RawJsonItem[]
    }
  }
  return []
}

/** Holds the enabled portal adapters for one deployment. */
export class PortalRegistry {
  /**
   * @param adapters - enabled adapters, in search order.
   */
  constructor(readonly adapters: readonly PortalAdapter[]) {}

  /** Ids and labels of every enabled adapter, for tool output. */
  list(): { id: string; label: string }[] {
    return this.adapters.map(adapter => ({ id: adapter.id, label: adapter.label }))
  }

  /**
   * Fan one search across every adapter and flatten the drafts, tagging each
   * with its source portal id. A failing adapter is reported in `failures`
   * rather than aborting the whole search.
   * @param request - query and optional location.
   * @returns source-tagged drafts and per-adapter failures.
   */
  async searchAll(request: PortalSearchRequest): Promise<{
    drafts: Array<JobDraft & { portalId: string }>
    failures: { portalId: string; message: string }[]
  }> {
    const drafts: Array<JobDraft & { portalId: string }> = []
    const failures: { portalId: string; message: string }[] = []
    await Promise.all(this.adapters.map(async (adapter) => {
      try {
        const results = await adapter.search(request)
        for (const draft of results) drafts.push({ ...draft, portalId: adapter.id })
      } catch (error) {
        failures.push({
          portalId: adapter.id,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }))
    return { drafts, failures }
  }
}
