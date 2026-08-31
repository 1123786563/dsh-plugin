/**
 * Vitest configuration: isolate every test from the real $DSH_HOME so any
 * code path that opens the local engine (deliberately or by regression)
 * lands in a throwaway directory instead of the user's ~/.dsh.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    env: {
      DSH_HOME: mkdtempSync(join(tmpdir(), 'dsh-plane-test-home-')),
    },
  },
})
