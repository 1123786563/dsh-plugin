import { describe, expect, it } from 'vitest'
import {
  isAdmin,
  isAuthPlanePath,
  isCredentiallessAsset,
  privilegedMethodOf,
  safeReturnTo,
  wantsHtml,
} from '../src/gate.ts'
import type { LoginSession } from '../src/sessions.ts'

const privileged = new Set(['settings.describe', 'credentials.set'])

function session(roles: string[]): LoginSession {
  return {
    sid: 'sid',
    tenantId: 'acme',
    userId: 'u',
    displayName: '',
    roles,
    idToken: '',
    createdAtMs: 0,
    expiresAtMs: 1,
    lastSeenMs: 0,
  }
}

describe('auth-plane whitelist', () => {
  it('covers exactly the gateway-owned paths', () => {
    for (const path of ['/healthz', '/.well-known/jwks.json', '/login', '/casdoor/callback', '/logout']) {
      expect(isAuthPlanePath(path)).toBe(true)
    }
    expect(isAuthPlanePath('/')).toBe(false)
    expect(isAuthPlanePath('/api/session.list')).toBe(false)
    expect(isAuthPlanePath('/loginx')).toBe(false)
  })
})

describe('credentialless assets', () => {
  it('exempts web manifests (browser fetches them without cookies)', () => {
    expect(isCredentiallessAsset('/manifest.webmanifest')).toBe(true)
    expect(isCredentiallessAsset('/foo/bar.webmanifest')).toBe(true)
    expect(isCredentiallessAsset('/api/session.list')).toBe(false)
    expect(isCredentiallessAsset('/webmanifest')).toBe(false)
  })
})

describe('safeReturnTo', () => {
  it('keeps site-relative paths with search', () => {
    expect(safeReturnTo('/x/y?z=1')).toBe('/x/y?z=1')
    expect(safeReturnTo('/')).toBe('/')
  })
  it('neutralizes absolute, protocol-relative, and encoded targets', () => {
    expect(safeReturnTo('https://evil.example.com')).toBe('/')
    expect(safeReturnTo('//evil.example.com')).toBe('/')
    expect(safeReturnTo('/\\evil')).toBe('/')
    expect(safeReturnTo('\\\\evil')).toBe('/')
    expect(safeReturnTo(undefined)).toBe('/')
    expect(safeReturnTo('')).toBe('/')
  })
})

describe('wantsHtml', () => {
  it('is true only for GET/HEAD navigations carrying text/html in Accept', () => {
    expect(wantsHtml('GET', 'text/html,application/xhtml+xml')).toBe(true)
    expect(wantsHtml('HEAD', 'text/html')).toBe(true)
    expect(wantsHtml('GET', 'application/json')).toBe(false)
    expect(wantsHtml('POST', 'text/html')).toBe(false)
    expect(wantsHtml('GET', undefined)).toBe(false)
  })
})

describe('privilegedMethodOf', () => {
  it('matches POST /api/<method> only for configured methods', () => {
    expect(privilegedMethodOf('/api/settings.describe', 'POST', privileged)).toBe('settings.describe')
    expect(privilegedMethodOf('/api/session.list', 'POST', privileged)).toBeUndefined()
    expect(privilegedMethodOf('/api/settings.describe', 'GET', privileged)).toBeUndefined()
    expect(privilegedMethodOf('/api/', 'POST', privileged)).toBeUndefined()
    expect(privilegedMethodOf('/api/a/b', 'POST', privileged)).toBeUndefined()
  })
})

describe('isAdmin', () => {
  it('intersects session roles with the configured admin roles', () => {
    expect(isAdmin(session(['dsh-admin']), ['dsh-admin'])).toBe(true)
    expect(isAdmin(session(['ops']), ['dsh-admin'])).toBe(false)
    expect(isAdmin(session([]), ['dsh-admin'])).toBe(false)
  })
})
