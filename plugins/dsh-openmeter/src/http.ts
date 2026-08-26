/**
 * HTTP helpers for the plugin's /api/openmeter routes: loopback+same-origin
 * request guard (the webServer applies none of its own), bounded JSON body
 * reading, and JSON writing. Mirrors the task-board patterns.
 *
 * @module dsh-openmeter/http
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Max accepted request body (bindings/grants are tiny). */
const BODY_LIMIT = 64 * 1024

/** Minimal request shape the guard inspects. */
export interface GuardedRequest {
  method?: string | undefined
  url?: string | undefined
  headers: IncomingMessage['headers']
  socket: { remoteAddress: string | undefined }
}

/** Minimal response shape the writers use. */
export interface GuardedResponse {
  writeHead(status: number, headers: Record<string, string>): void
  end(body: string): void
}

/**
 * Whether an address is loopback (127/8, ::1, ::ffff:127/8).
 * @param address - the socket peer address.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  if (address === '::1' || address === '::ffff:127.0.0.1') return true
  return address.startsWith('127.')
}

/**
 * Same-origin/loopback trust check: loopback socket AND loopback Host header
 * AND no cross-site sec-fetch-site AND (no Origin or Origin matches Host).
 * @param req - the incoming request.
 */
export function isTrustedRequest(req: GuardedRequest): boolean {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false
  const host = req.headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  const hostname = host.split(':')[0] ?? ''
  if (!isLoopbackAddress(hostname) && hostname !== 'localhost') return false
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  return true
}

/**
 * Reject untrusted requests with 403.
 * @param req - the incoming request.
 * @param res - the response.
 * @returns true when the request was rejected (handler must return).
 */
export function guard(req: GuardedRequest, res: GuardedResponse): boolean {
  if (isTrustedRequest(req)) return false
  writeJson(res, 403, { ok: false, error: 'forbidden' })
  return true
}

/**
 * Read one bounded JSON body.
 * @param req - the incoming request.
 * @returns the parsed value (unknown).
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > BODY_LIMIT) throw new Error('body-too-large')
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw.length === 0 ? {} : JSON.parse(raw)
}

/**
 * Write one JSON response.
 * @param res - the response.
 * @param status - HTTP status.
 * @param body - the payload.
 */
export function writeJson(res: GuardedResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
