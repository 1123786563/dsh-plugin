/**
 * The local API key guarding the engine's HTTP surface. Generated once on
 * first boot, persisted in the store, and replaceable from the settings card.
 *
 * @module dsh-plane/engine/key
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'

/** Prefix marking engine-issued keys so they are recognizable on sight. */
export const LOCAL_KEY_PREFIX = 'plane_local_'

/**
 * Generate one fresh local API key.
 * @returns the key string.
 */
export function generateLocalKey(): string {
  return LOCAL_KEY_PREFIX + randomBytes(24).toString('hex')
}

/**
 * Check one presented key against the persisted key without leaking the
 * comparison through timing.
 * @param presented - the X-API-Key header value.
 * @param stored - the persisted key.
 * @returns true when the key matches.
 */
export function keyMatches(presented: string | undefined, stored: string): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(stored)
  if (a.length !== b.length) {
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}
