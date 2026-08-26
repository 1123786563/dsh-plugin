import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MeteringWal } from '../src/wal.ts'
import { buildWalRecord } from '../src/cloudevent.ts'

let dir: string | undefined

afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

function record(subject: string): ReturnType<typeof buildWalRecord> {
  return buildWalRecord(
    { subject, provider: 'p', model: 'm', usage: { inputTokens: 1, outputTokens: 1 }, capturedAt: Date.now() },
    'dsh.llm.call',
    'dsh',
  )
}

describe('MeteringWal', () => {
  it('appends durably and reports pending until confirmed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'omwal-'))
    const wal = new MeteringWal(dir)
    await wal.append(record('a'))
    await wal.append(record('b'))
    expect(wal.pending().length).toBe(2)
  })

  it('confirms only the acknowledged ids and keeps stats', async () => {
    dir = await mkdtemp(join(tmpdir(), 'omwal-'))
    const wal = new MeteringWal(dir)
    const first = record('a')
    const second = record('b')
    await wal.append(first)
    await wal.append(second)
    await wal.confirm([first.id], 1_000)
    expect(wal.pending().map(item => item.id)).toEqual([second.id])
    expect(wal.stats().confirmedRecent).toBe(1)
  })

  it('replays safely after a restart: in-memory confirmations become re-deliveries, torn lines drop', async () => {
    dir = await mkdtemp(join(tmpdir(), 'omwal-'))
    const wal = new MeteringWal(dir)
    const first = record('a')
    const second = record('b')
    await wal.append(first)
    await wal.append(second)
    // Confirmation is in-memory until compaction: after a restart the first
    // record re-delivers (at-least-once; OpenMeter dedupes by id).
    await wal.confirm([first.id], Date.now())
    const { readFile, writeFile } = await import('node:fs/promises')
    const text = await readFile(join(dir, 'wal.jsonl'), 'utf8')
    await writeFile(join(dir, 'wal.jsonl'), text.slice(0, -20) + '\n{"id": tor', 'utf8')
    const replayed = new MeteringWal(dir)
    await replayed.load()
    const pending = replayed.pending()
    expect(pending.length).toBe(1)
    expect(pending[0]?.id).toBe(first.id)
  })

  it('drops pending records older than the dedupe window (never double-bill)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'omwal-'))
    const wal = new MeteringWal(dir)
    const ancient = buildWalRecord(
      { subject: 'a', provider: 'p', model: 'm', usage: { inputTokens: 1, outputTokens: 1 }, capturedAt: Date.now() - 40 * 24 * 60 * 60 * 1000 },
      'dsh.llm.call',
      'dsh',
    )
    await wal.append(ancient)
    const replayed = new MeteringWal(dir)
    await replayed.load()
    expect(replayed.pending().length).toBe(0)
  })

  it('compaction drops confirmed records older than the dedupe window', async () => {
    dir = await mkdtemp(join(tmpdir(), 'omwal-'))
    const wal = new MeteringWal(dir)
    const old = record('a')
    await wal.append(old)
    await wal.confirm([old.id], Date.now() - 40 * 24 * 60 * 60 * 1000)
    const fresh = record('b')
    await wal.append(fresh)
    await wal.compact(Date.now())
    expect(wal.stats().total).toBe(1)
    expect(wal.pending().length).toBe(1)
  })

  it('noteFailure increments failure counters for backoff', async () => {
    dir = await mkdtemp(join(tmpdir(), 'omwal-'))
    const wal = new MeteringWal(dir)
    const one = record('a')
    await wal.append(one)
    wal.noteFailure([one.id])
    wal.noteFailure([one.id])
    expect(wal.pending()[0]?.failures).toBe(2)
  })
})
