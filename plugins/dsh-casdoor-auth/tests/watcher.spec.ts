import { describe, expect, it } from 'vitest'
import { WATCHER_SCRIPT, inject401Watcher } from '../src/watcher.ts'

const html = '<html><head><title>t</title></head><body></body></html>'

describe('inject401Watcher', () => {
  it('injects the watcher exactly once, before </head>', () => {
    const injected = inject401Watcher(html)
    expect(injected).toContain('dsh-casdoor-auth-401-watcher')
    expect(injected.indexOf('dsh-casdoor-auth-401-watcher')).toBeLessThan(injected.indexOf('</head>'))
    expect(injected.match(/dsh-casdoor-auth-401-watcher/g)).toHaveLength(1)
  })

  it('is idempotent', () => {
    const once = inject401Watcher(html)
    expect(inject401Watcher(once)).toBe(once)
  })

  it('prepends when no </head> anchor exists', () => {
    const injected = inject401Watcher('<body></body>')
    expect(injected.startsWith('<script')).toBe(true)
    expect(injected.endsWith('<body></body>')).toBe(true)
  })

  it('the script only ever navigates same-origin on 401', () => {
    expect(WATCHER_SCRIPT).toContain('response.status === 401')
    expect(WATCHER_SCRIPT).toContain("location.assign('/login?returnTo='")
    expect(WATCHER_SCRIPT).toContain('location.origin')
  })
})
