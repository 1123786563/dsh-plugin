/**
 * The forwarding core: HTTP stream piping and WebSocket upgrade piping into
 * the loopback-only dsh webserver. Hand-written on node:http so the request
 * body is never buffered (dsh /api allows 300 MiB attachment envelopes) and
 * so the fence-critical header rewrites are explicit:
 *
 *  - `host` is rewritten to the upstream authority (the dsh DNS-rebinding
 *    fence binds every request to loopback/trusted authorities);
 *  - `origin`, when the browser attached one, is rewritten to the upstream
 *    origin (the fence requires Origin and Host to agree);
 *  - the login cookie is dropped (the dsh side never consumes it) and the
 *    DshIdentityToken header is added.
 *
 * @module dsh-casdoor-gateway/proxy
 */

import type { IncomingHttpHeaders, Server } from 'node:http'
import http from 'node:http'
import type { Duplex } from 'node:stream'

export interface ProxyTarget {
  readonly upstream: URL
  readonly identityHeader: string
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Copy request headers into upstream shape with the fence rewrites applied. */
export function upstreamHeaders(
  headers: IncomingHttpHeaders,
  target: ProxyTarget,
  identityToken: string,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (HOP_BY_HOP.has(name)) continue
    if (name === 'cookie' || name === 'host' || name === 'origin' || name === 'referer') continue
    out[name] = Array.isArray(value) ? value.join(', ') : value
  }
  out.host = target.upstream.host
  if (headers.origin !== undefined) out.origin = target.upstream.origin
  out[target.identityHeader] = identityToken
  return out
}

/**
 * Forward one HTTP request to the upstream and pipe the response back.
 *
 * fastify buffers every request body before the route handler runs (its
 * content-type parser consumes the stream by design — there is no true
 * streaming path through a fastify handler), so the body travels as the
 * assembled Buffer `req.body` and is written to the upstream in one `end()`.
 * The gateway's bodyLimit therefore covers the dsh /api 300 MiB attachment
 * envelope (see server.ts and ADR-0003 for the memory trade-off).
 */
export function proxyHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: ProxyTarget,
  identityToken: string,
  body: Buffer | undefined,
): void {
  const headers = upstreamHeaders(req.headers, target, identityToken)
  const upstream = http.request(target.upstream, {
    method: req.method,
    headers,
    path: req.url,
  })
  upstream.on('response', upstreamRes => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
    upstreamRes.pipe(res)
  })
  upstream.on('error', err => {
    if (res.headersSent) {
      res.destroy(err)
      return
    }
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: 'upstream-unreachable', message: String(err) }))
  })
  if (body === undefined || body.length === 0) {
    upstream.end()
  } else {
    upstream.end(body)
  }
}

export interface UpgradeDeps<S> {
  readonly target: ProxyTarget
  /** Resolve the login session from the upgrade request headers; undefined rejects. */
  resolveSession(headers: IncomingHttpHeaders): Promise<S | undefined>
  /** Mint the DshIdentityToken for an accepted upgrade. */
  mint(session: S): Promise<string>
  onError(error: unknown): void
}

function rejectUpgrade(socket: Duplex): void {
  socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
  socket.destroy()
}

/**
 * Attach the WebSocket upgrade proxy to the gateway's HTTP server. The two
 * downlink sockets (/api/events.mux, /api/events.host) are the only upgrade
 * paths the stock web app opens; every upgrade is gated on the login cookie.
 */
export function installUpgradeProxy<S>(server: Server, deps: UpgradeDeps<S>): void {
  server.on('upgrade', (req, socket, clientHead) => {
    void (async () => {
      let session: S | undefined
      try {
        session = await deps.resolveSession(req.headers)
      } catch (error) {
        deps.onError(error)
      }
      if (session === undefined) {
        rejectUpgrade(socket)
        return
      }
      try {
        const token = await deps.mint(session)
        const headers = upstreamHeaders(req.headers, deps.target, token)
        headers.connection = 'Upgrade'
        headers.upgrade = 'websocket'
        const proxied = http.request(deps.target.upstream, {
          method: 'GET',
          headers,
          path: req.url,
        })
        proxied.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
          let switching = 'HTTP/1.1 101 Switching Protocols\r\n'
          for (const [name, value] of Object.entries(upstreamRes.headers)) {
            switching += `${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`
          }
          switching += '\r\n'
          socket.write(switching)
          if (upstreamHead.length > 0) socket.write(upstreamHead)
          if (clientHead.length > 0) upstreamSocket.write(clientHead)
          upstreamSocket.pipe(socket)
          socket.pipe(upstreamSocket)
          const die = (): void => {
            upstreamSocket.destroy()
            socket.destroy()
          }
          upstreamSocket.on('error', die)
          socket.on('error', die)
        })
        proxied.on('response', upstreamRes => {
          // Non-101 answers (e.g. the fence refusing): relay status and drop.
          socket.write(`HTTP/1.1 ${upstreamRes.statusCode ?? 502} Gateway Error\r\nconnection: close\r\n\r\n`)
          upstreamRes.resume()
          socket.destroy()
        })
        proxied.on('error', error => {
          deps.onError(error)
          socket.destroy()
        })
        if (clientHead.length > 0) proxied.write(clientHead)
        proxied.end()
      } catch (error) {
        deps.onError(error)
        rejectUpgrade(socket)
      }
    })()
  })
}
