/**
 * Duck-typed harness surfaces the plugin touches. Keeping them local (instead
 * of importing harness packages) matches the dsh-plane pattern: the plugin
 * compiles standalone, the runtime wires the real services.
 *
 * @module dsh-openmeter/types
 */

/** Session header subset the pipeline reads. */
export interface SessionHeaderLike {
  readonly id?: string
  readonly parentSession?: string
  readonly origin?: string
  readonly delegationDepth?: number
  readonly agentPreset?: string
}

/** Session subset the pipeline reads. */
export interface SessionLike {
  readonly id: string
  readonly header: SessionHeaderLike
}

/** SessionStore subset (live sessions only). */
export interface SessionsLike {
  get(id: string): SessionLike | undefined
}

/** GenerateOptions subset the gate reads. */
export interface StreamOptionsLike {
  provider: string
  model: string
  sessionId?: string
  purpose?: string
}

/** StreamChunk subset the pipeline passes through. */
export type StreamChunkLike =
  | { type: 'usage', usage: unknown }
  | { type: string, [key: string]: unknown }

/** SessionEvent subset the pipeline reads. */
export interface SessionEventLike {
  type: string
  seq: number
  time: number
  data?: {
    turn?: number
    step?: number
    usage?: unknown
    message?: { source?: { provider?: string, model?: string } }
  }
}
