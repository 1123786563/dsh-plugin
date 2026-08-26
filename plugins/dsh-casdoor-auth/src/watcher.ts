/**
 * The 401 login-redirect watcher: a tiny inline script injected into the SPA
 * shell via webServer.tapIndex (server-side, no client-half service
 * dependency). When a login session expires mid-use, the SPA's fetches start
 * answering 401; the watcher turns the first same-origin 401 into a redirect
 * to the gateway's /login with the current location as returnTo.
 *
 * @module dsh-casdoor-auth/watcher
 */

export const WATCHER_SCRIPT = `<script>(function () {
  if (typeof window.fetch !== 'function') return
  var redirecting = false
  var original = window.fetch.bind(window)
  window.fetch = function (input, init) {
    return Promise.resolve(original(input, init)).then(function (response) {
      try {
        if (response && response.status === 401 && !redirecting) {
          var url = typeof input === 'string' ? input : (input && input.url) || location.href
          if (new URL(url, location.origin).origin === location.origin) {
            redirecting = true
            location.assign('/login?returnTo=' + encodeURIComponent(location.pathname + location.search))
          }
        }
      } catch (error) { /* never let the watcher break the fetch chain */ }
      return response
    })
  }
})()</script>`

/**
 * Inject the watcher into one rendered index.html body (tapIndex transform).
 * Idempotent: an already-injected document passes through unchanged.
 */
export function inject401Watcher(html: string): string {
  if (html.includes('dsh-casdoor-auth-401-watcher')) return html
  const tagged = WATCHER_SCRIPT.replace('<script>', '<script data-dsh-casdoor-auth-401-watcher>')
  const anchor = html.lastIndexOf('</head>')
  if (anchor === -1) return tagged + html
  return html.slice(0, anchor) + tagged + html.slice(anchor)
}
