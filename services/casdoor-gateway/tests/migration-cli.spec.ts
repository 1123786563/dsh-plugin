import { describe, expect, it } from 'vitest'
import { MIGRATION_USAGE, parseMigrationArgs } from '../scripts/migrate-legacy-sessions.mjs'

const context = { cwd: '/srv/host', env: { MIGRATION_PASSWORD: 'env-pass' } }

describe('parseMigrationArgs', () => {
  it('applies the documented defaults: db under cwd, dsh-ops/dsh-admin target, no dry-run, loopback gateway', () => {
    const parsed = parseMigrationArgs(['--password', 'cli-pass'], { cwd: '/srv/host', env: {} })
    expect(parsed).toEqual({
      ok: true,
      help: false,
      options: {
        db: '/srv/host/.dsh-multi-tenant/session-ownership.sqlite',
        tenant: 'dsh-ops',
        user: 'dsh-admin',
        dryRun: false,
        gateway: 'http://127.0.0.1:3080',
        password: 'cli-pass',
      },
    })
  })

  it('falls back to MIGRATION_PASSWORD when --password is absent', () => {
    const parsed = parseMigrationArgs([], context)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.options.password).toBe('env-pass')
  })

  it('rejects a missing admin password with a message naming both sources', () => {
    const parsed = parseMigrationArgs([], { cwd: '/srv/host', env: {} })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error).toContain('MIGRATION_PASSWORD')
      expect(parsed.error).toContain('--password')
    }
  })

  it('turns on --dry-run', () => {
    const parsed = parseMigrationArgs(['--dry-run'], context)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.options.dryRun).toBe(true)
  })

  it('overrides db/tenant/user/gateway and accepts the --flag=value form; relative db resolves against cwd', () => {
    const spaced = parseMigrationArgs(
      ['--db', 'custom/owners.sqlite', '--tenant', 'acme', '--user', 'alice', '--gateway', 'http://127.0.0.1:3099'],
      context,
    )
    expect(spaced).toEqual({
      ok: true,
      help: false,
      options: {
        db: '/srv/host/custom/owners.sqlite',
        tenant: 'acme',
        user: 'alice',
        dryRun: false,
        gateway: 'http://127.0.0.1:3099',
        password: 'env-pass',
      },
    })
    const equaled = parseMigrationArgs(['--db=/abs/owners.sqlite'], context)
    expect(equaled.ok).toBe(true)
    if (equaled.ok) expect(equaled.options.db).toBe('/abs/owners.sqlite')
  })

  it('rejects unknown options, missing values, and empty values', () => {
    expect(parseMigrationArgs(['--wrong'], context)).toEqual({ ok: false, error: expect.stringContaining('--wrong') })
    const missing = parseMigrationArgs(['--db'], context)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toContain('--db')
    const empty = parseMigrationArgs(['--tenant', ''], context)
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error).toContain('--tenant')
  })

  it('rejects a gateway that is not an http(s) URL', () => {
    const parsed = parseMigrationArgs(['--gateway', '127.0.0.1:3080'], context)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('--gateway')
  })

  it('short-circuits to help without requiring a password, and the usage text names every option', () => {
    const parsed = parseMigrationArgs(['--help'], { cwd: '/srv/host', env: {} })
    expect(parsed).toEqual({ ok: true, help: true })
    for (const option of ['usage', '--db', '--tenant', '--user', '--dry-run', '--gateway', '--password', 'MIGRATION_PASSWORD']) {
      expect(MIGRATION_USAGE).toContain(option)
    }
  })
})
