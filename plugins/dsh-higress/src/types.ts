/**
 * Lean OpenAI-compatible wire shapes for the Higress chat-completions
 * endpoint (what the ai-proxy plugin exposes under /v1).
 *
 * @module dsh-higress/types
 */

/** One serialized conversation message. */
export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoning_content?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  tool_call_id?: string
}

/** One declared tool. */
export interface WireTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** The chat-completions request body. */
export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options: { include_usage: true }
  thinking?: { type: 'enabled' | 'disabled' }
  reasoning_effort?: 'low' | 'high' | 'max'
  tools?: WireTool[]
  temperature?: number
  max_tokens?: number
  stop?: string[]
}

/** One streamed choice delta. */
export interface WireChunkDelta {
  content?: string
  reasoning_content?: string
  tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
}

export interface WireChunkChoice {
  delta?: WireChunkDelta
  finish_reason?: string
}

export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  prompt_tokens_details?: { cached_tokens?: number }
  prompt_cache_hit_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
}

export interface WireChunk {
  choices?: WireChunkChoice[]
  usage?: WireUsage
}

export interface WireErrorBody {
  code?: string
  type?: string
  message?: string
}

export interface WireError {
  error?: WireErrorBody
}
