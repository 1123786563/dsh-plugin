/**
 * $DSH_HOME resolution, vendored from the harness's @deepseek-ai/dsh-home-paths
 * semantics ($DSH_HOME with ~ expansion, default ~/.dsh) so the plugin carries
 * no extra dependency.
 *
 * @module dsh-plane/engine/dsh-home
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Resolve the DSH home directory.
 * @param env - environment (injectable for tests).
 * @returns absolute path to $DSH_HOME.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim().length > 0) {
    const expanded = raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw
    return resolve(expanded)
  }
  return join(homedir(), '.dsh')
}
