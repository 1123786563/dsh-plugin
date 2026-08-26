/**
 * `HigressAdapter`: fetch + SSE against a Higress AI gateway's
 * OpenAI-compatible chat-completions endpoint, emitting harness StreamChunks.
 * Transport-only: connection facts arrive through a thunk resolved once per
 * operation and the consumer key through a per-request resolver, so the
 * registering plugin owns validation, layering, and credential policy.
 *
 * @module dsh-higress/adapter
 */

import {
  attributionHeaders,
  contentHasImage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedAdapterCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { HigressCatalogModel, ResolvedHigressOptions } from './config.ts'
import { serializeRequest } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import type { WireError, WireErrorBody, WireRequest } from './types.ts'

/** Dependencies the registering plugin supplies. */
export interface HigressAdapterOptions {
  /** Live accessor for the current configuration generation. */
  options(): ResolvedHigressOptions
  /** Resolve the consumer key for one connection snapshot. */
  resolveApiKey(connection: ResolvedHigressOptions): Promise<string>
}

const STREAM_IDLE_TIMEOUT_CODE = 'HIGRESS_STREAM_IDLE'

/** Suffix that names the likely fix for a gateway 401/403. */
const CONSUMER_KEY_HINT = 'the Higress consumer key may not be enabled for key-auth on the gateway route, or it is no longer valid'

/**
 * Map an HTTP status to a stable LlmError code.
 * @param status - status of a non-2xx gateway response.
 * @param error - parsed gateway error body, when available.
 * @returns the normalized harness error code.
 */
export function httpErrorCode(status: number, error?: WireErrorBody): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(' ')
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

function modelInfo(provider: string, model: HigressCatalogModel): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description !== undefined ? { description: model.description } : {},
    ...model.inputModalities !== undefined ? { inputModalities: model.inputModalities } : {},
  }
}

/**
 * The Higress route adapter. One instance serves every model name it was
 * registered under (the harness model name IS the wire model name the
 * gateway routes on).
 */
export class HigressAdapter extends LlmAdapter {
  constructor(private readonly config: HigressAdapterOptions) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'Higress' }
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.config.options().retryPolicy
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.config.options().models.map(model => modelInfo(provider, model)))
  }

  override resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve(this.modelInfoFor(this.config.options(), provider, model))
  }

  private modelInfoFor(
    connection: ResolvedHigressOptions,
    provider: string,
    model: string,
  ): LlmResolvedModelInfo {
    const configured = connection.models.find(entry => entry.id === model)
    const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow
    return {
      // An uncatalogued endpoint is safely treated as text-only.
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      context: { contextWindow },
      ...configured?.maxTokens !== undefined ? { defaultMaxTokens: configured.maxTokens } : {},
      ...configured === undefined && connection.maxTokens !== undefined ? { defaultMaxTokens: connection.maxTokens } : {},
    }
  }

  override prepareCall(provider: string, model: string, _signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const connection = this.config.options()
    return Promise.resolve({
      model: this.modelInfoFor(connection, provider, model),
      stream: options => this.streamWithConnection(options, connection),
    })
  }

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.streamWithConnection(options, this.config.options())
  }

  private async * streamWithConnection(
    options: GenerateOptions,
    connection: ResolvedHigressOptions,
  ): AsyncIterable<StreamChunk> {
    // One resolution per stream call: connection facts and the credential
    // freeze here and hold for this whole request, so an in-flight stream
    // never observes a configuration change.
    if (options.messages.some(message => contentHasImage(message.content))) {
      throw new LlmError(
        'The Higress route is text-only in v1; route image-carrying sessions through deepseek-official.',
        'UNSUPPORTED_CONTENT',
      )
    }
    const apiKey = await this.config.resolveApiKey(connection)
    const consumer = new AbortController()
    const upstream = options.signal === undefined
      ? consumer.signal
      : AbortSignal.any([options.signal, consumer.signal])
    using watchdog = idleWatchdog(upstream, connection.streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_CODE)
    const iterator = this.request(options, watchdog.signal, connection, apiKey, () => { watchdog.pulse() })[Symbol.asyncIterator]()
    let exhausted = false
    try {
      while (true) {
        const result = await watchdog.next(iterator)
        if (result.done) {
          exhausted = true
          return
        }
        yield result.value
      }
    } catch (error: unknown) {
      if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== undefined) {
        throw new LlmError(`Higress stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, 'TIMEOUT', { cause: error })
      }
      if (options.signal?.aborted) {
        throw new LlmError('Higress request aborted by caller', 'ABORTED', { cause: error })
      }
      if (error instanceof LlmError) throw error
      throw new LlmError(`Higress API stream from ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    } finally {
      consumer.abort('Higress stream consumer stopped')
      if (!exhausted && iterator.return !== undefined) {
        try {
          await iterator.return()
        } catch {
          // The consumer controller already owns termination.
        }
      }
    }
  }

  private async * request(
    options: GenerateOptions,
    signal: AbortSignal,
    connection: ResolvedHigressOptions,
    apiKey: string,
    onActivity: () => void,
  ): AsyncIterable<StreamChunk> {
    const headers = {
      ...attributionHeaders(),
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'accept': 'text/event-stream',
    }
    const body: WireRequest = serializeRequest(options, connection.defaults)
    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      })
    } catch (error: unknown) {
      if (signal.aborted) throw error
      throw new LlmError(`Higress API request to ${connection.baseURL} failed`, 'TRANSPORT', { cause: error })
    }

    if (!response.ok) {
      let message = `Higress gateway error (HTTP ${response.status})`
      let providerError: WireErrorBody | undefined
      const rawResponse = await response.text()
      try {
        providerError = (JSON.parse(rawResponse) as WireError).error
        if (providerError?.message) message = providerError.message
      } catch {
        // The HTTP status remains authoritative when the gateway returns malformed JSON.
      }
      if (response.status === 401 || response.status === 403) {
        message = `${message} (${CONSUMER_KEY_HINT})`
      }
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        cause: new Error(rawResponse.length > 0 ? rawResponse : `Higress HTTP ${response.status}`),
        status: response.status,
      })
    }
    if (!response.body) {
      throw new LlmError('Higress gateway returned no response body', 'EMPTY_RESPONSE')
    }

    yield* translate(parseSse(response.body, onActivity))
  }
}
