/**
 * PlaneClient behavior: URL composition, auth header, error mapping, item
 * segment negotiation, and list-envelope normalization, all against a stubbed
 * fetch.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlaneClient, PlaneApiError } from '../src/client.ts'
import { resolveConfig } from '../src/config.ts'

/** Recorded outbound request. */
interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

/**
 * Install a fetch stub serving one response per URL-prefix match, recording calls.
 * @param routes - ordered [matcher, response] pairs; the first matching wins.
 * @returns the recorded calls.
 */
function stubFetch(routes: [string | RegExp, { status?: number, body?: string }][]): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body === undefined ? undefined : String(init.body),
    })
    for (const [matcher, route] of routes) {
      if (typeof matcher === 'string' ? url.includes(matcher) : matcher.test(url)) {
        const status = route.status ?? 200
        return new Response(route.body ?? '', { status, headers: { 'content-type': 'application/json' } })
      }
    }
    return new Response('', { status: 404 })
  }))
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PlaneClient.request', () => {
  it('sends the API key header and composes the /api/v1 path with query', async () => {
    const calls = stubFetch([['/api/v1/workspaces/team/projects/', { body: JSON.stringify({ results: [] }) }]])
    const client = new PlaneClient(() => resolveConfig({ apiKey: 'plane_api_x', baseUrl: 'https://api.plane.so/' }))
    await client.request('GET', '/workspaces/team/projects/', { query: { per_page: 50 } })
    expect(calls[0]?.url).toBe('https://api.plane.so/api/v1/workspaces/team/projects/?per_page=50')
    expect(calls[0]?.headers['X-API-Key']).toBe('plane_api_x')
    expect(calls[0]?.method).toBe('GET')
  })

  it('accepts a self-hosted base url with a stray /api/v1 suffix', async () => {
    const calls = stubFetch([['/api/v1/workspaces/t/p/', { body: '[]' }]])
    const client = new PlaneClient(() => resolveConfig({ apiKey: 'k', baseUrl: 'https://plane.example.com/api/v1/' }))
    await client.request('GET', '/workspaces/t/p/')
    expect(calls[0]?.url).toBe('https://plane.example.com/api/v1/workspaces/t/p/')
  })

  it('fails with setup instructions when the api key is unset', async () => {
    stubFetch([])
    const client = new PlaneClient(() => resolveConfig({}))
    await expect(client.request('GET', '/workspaces/t/p/')).rejects.toThrow(/PLANE_API_KEY/)
  })

  it('maps 401 responses onto a key-rejection message', async () => {
    stubFetch([['/api/v1/workspaces/t/p/', { status: 401, body: '{"error": "invalid"}' }]])
    const client = new PlaneClient(() => resolveConfig({ apiKey: 'bad' }))
    const error = await client.request('GET', '/workspaces/t/p/').catch(e => e as PlaneApiError)
    expect(error).toBeInstanceOf(PlaneApiError)
    expect(error.status).toBe(401)
    expect(error.message).toContain('rejected the API key')
  })

  it('rejects absolute URLs and upward traversal', async () => {
    const client = new PlaneClient(() => resolveConfig({ apiKey: 'k' }))
    await expect(client.request('GET', 'https://evil.example.com/x')).rejects.toThrow(/API-relative/)
    await expect(client.request('GET', '/workspaces/t/../../p/')).rejects.toThrow(/traverse/)
  })

  it('rejects non-JSON success bodies', async () => {
    stubFetch([['/api/v1/x/', { body: '<html>oops</html>' }]])
    const client = new PlaneClient(() => resolveConfig({ apiKey: 'k' }))
    await expect(client.request('GET', '/x/')).rejects.toThrow(/non-JSON/)
  })
})

describe('PlaneClient.requestItems', () => {
  it('falls back from work-items to issues on 404 and caches the segment', async () => {
    const calls = stubFetch([
      ['/work-items/', { status: 404, body: '{"detail": "not found"}' }],
      ['/issues/', { body: JSON.stringify({ results: [{ id: 'i1' }] }) }],
    ])
    const client = new PlaneClient(() => resolveConfig({ apiKey: 'k' }))
    const first = await client.requestItems('GET', { workspace: 'team', project: 'p1' })
    expect(JSON.stringify(first)).toContain('i1')
    expect(calls.map(call => call.url).join(' ')).toContain('/work-items/')
    expect(calls.map(call => call.url).join(' ')).toContain('/issues/')
    await client.requestItems('GET', { workspace: 'team', project: 'p1', tail: 'i1/comments' })
    expect(calls.length).toBe(3)
    expect(calls[2]?.url).toContain('/issues/i1/comments')
  })

  it('keeps the first error when both segments miss', async () => {
    stubFetch([['/api/v1/', { status: 404, body: '{"detail": "no"}' }]])
    const client = new PlaneClient(() => resolveConfig({ apiKey: 'k' }))
    const error = await client.requestItems('GET', { workspace: 'team', project: 'p' }).catch(e => e as PlaneApiError)
    expect(error).toBeInstanceOf(PlaneApiError)
    expect(error.status).toBe(404)
  })

  it('throws non-404 errors immediately without probing the second segment', async () => {
    const calls = stubFetch([['/work-items/', { status: 400, body: '{"detail": "bad"}' }]])
    const client = new PlaneClient(() => resolveConfig({ apiKey: 'k' }))
    await expect(client.requestItems('POST', { workspace: 't', project: 'p' })).rejects.toThrow(/400/)
    expect(calls.length).toBe(1)
  })
})

describe('PlaneClient.pageOf', () => {
  it('normalizes a cursor envelope', () => {
    const client = new PlaneClient(() => resolveConfig({ apiKey: 'k' }))
    const page = client.pageOf({
      results: [{ id: 'a' }, { id: 'b' }],
      total_count: 31,
      next_cursor: '20:1:0',
      next_page_results: true,
    })
    expect(page.results).toHaveLength(2)
    expect(page.totalCount).toBe(31)
    expect(page.nextCursor).toBe('20:1:0')
    expect(page.hasNextPage).toBe(true)
  })

  it('treats a plain array as a complete single page', () => {
    const client = new PlaneClient(() => resolveConfig({ apiKey: 'k' }))
    const page = client.pageOf([{ id: 'a' }])
    expect(page.results).toHaveLength(1)
    expect(page.hasNextPage).toBe(false)
    expect(page.nextCursor).toBeUndefined()
  })
})
