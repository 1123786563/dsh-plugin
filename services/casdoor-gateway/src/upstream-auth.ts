/**
 * Upstream browser-auth session for dsh >= 0.1.2-alpha: the stock webserver
 * authenticates every request with its own signed cookie, minted by
 * exchanging the per-process launch token. The dsh-casdoor-auth plugin
 * publishes the current launch token to <dataDir>/webserver-token.json on
 * every webserver activation; this module exchanges it once, caches the
 * minted cookie, and re-exchanges after an upstream 401 (the cookie's
 * signing secret is durable, so a re-exchange only happens when no valid
 * cookie exists — first contact, or a rotated credentials store).
 *
 * @module dsh-casdoor-gateway/upstream-auth
 */

import { readFileSync } from 'node:fs'
import http from 'node:http'

interface LaunchTokenFile {
  readonly token?: unknown
}

/** Logger face decoupled from fastify so the module stays testable. */
export interface UpstreamAuthLog {
  warn(message: string, extra?: Record<string, unknown>): void
}

const EXCHANGE_TIMEOUT_MS = 5000
/** Backoff after a failed exchange: without it a browser-auth-less upstream (dsh < 0.1.2-alpha answers plain 200) would be re-probed on every request. */
const RETRY_BACKOFF_MS = 10_000

export class UpstreamAuth {
  private cookie: string | undefined
  private pending: Promise<string | undefined> | undefined
  private retryAt = 0
  private warned = false

  constructor(
    private readonly tokenFile: string,
    private readonly upstream: URL,
    private readonly log: UpstreamAuthLog,
  ) {}

  /** Drop the cached cookie; the next {@link ensure} re-exchanges. */
  invalidate(): void {
    this.cookie = undefined
  }

  /** The upstream browser-session cookie, exchanging the launch token when absent. */
  ensure(): Promise<string | undefined> {
    if (this.cookie !== undefined) return Promise.resolve(this.cookie)
    if (Date.now() < this.retryAt) return Promise.resolve(undefined)
    this.pending ??= this.exchange().finally(() => {
      this.pending = undefined
    })
    return this.pending
  }

  private fail(message: string, extra?: Record<string, unknown>): undefined {
    this.retryAt = Date.now() + RETRY_BACKOFF_MS
    if (!this.warned) {
      this.warned = true
      this.log.warn(message, extra)
    }
    return undefined
  }

  private readToken(): string | undefined {
    let raw: string
    try {
      raw = readFileSync(this.tokenFile, 'utf8')
    } catch {
      return undefined
    }
    try {
      const parsed = JSON.parse(raw) as LaunchTokenFile
      return typeof parsed.token === 'string' && parsed.token !== '' ? parsed.token : undefined
    } catch {
      return undefined
    }
  }

  private exchange(): Promise<string | undefined> {
    const token = this.readToken()
    if (token === undefined) {
      return Promise.resolve(this.fail(
        'upstream launch token file missing or invalid (expected on dsh cores without browser auth); retrying periodically',
        { file: this.tokenFile },
      ))
    }
    return new Promise(resolve => {
      const req = http.request(this.upstream, {
        method: 'GET',
        path: `/?token=${encodeURIComponent(token)}`,
        headers: { host: this.upstream.host, accept: 'text/html' },
        timeout: EXCHANGE_TIMEOUT_MS,
      }, res => {
        res.resume()
        const minted = (res.headers['set-cookie'] ?? []).find(value => value.startsWith('dsh-auth-'))
        if (res.statusCode !== 303 || minted === undefined) {
          if (res.statusCode === 200) {
            resolve(this.fail('upstream answers without browser auth (dsh < 0.1.2-alpha); forwarding without a cookie'))
            return
          }
          resolve(this.fail('upstream launch-token exchange failed', { status: res.statusCode }))
          return
        }
        this.warned = false
        this.retryAt = 0
        this.cookie = minted.split(';')[0] ?? minted
        resolve(this.cookie)
      })
      req.on('timeout', () => {
        req.destroy()
        resolve(this.fail('upstream launch-token exchange timed out'))
      })
      req.on('error', () => {
        resolve(this.fail('upstream launch-token exchange errored'))
      })
      req.end()
    })
  }
}
