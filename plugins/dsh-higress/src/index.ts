/**
 * dsh-higress: the Higress AI gateway model route for DeepSeek Harness.
 *
 * @module dsh-higress
 */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name; keep this stable after publishing. */
export const name = 'llm-higress'

/** The `llm` service must exist before this plugin is applied. */
export const inject: string[] = ['llm']

/** Activate the plugin (fully wired by later tasks). */
export function apply(_ctx: Context, _config: unknown): void {}
