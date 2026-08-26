/** HigressAdapter: request dispatch, SSE end-to-end, error mapping. */
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HigressAdapter } from '../src/adapter.ts'
import { resolveConfig } from '../src/config.ts'

const encoder = new TextEncoder()

function sseResponse(lines: readonly string[], init?: ResponseInit): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' }, ...init },
  )
}

const userMessage: Message = {
  id: crypto.randomUUID() as Message['id'],
  role: 'user',
  content: [{ type: 'text', text: 'hi' }],
  source: { kind: 'user' },
}

const request: GenerateOptions = { provider: 'higress', model: 'deepseek-chat', messages: [userMessage] }

function makeAdapter(overrides: Partial<ReturnType<typeof resolveConfig>> = {}): HigressAdapter {
  return new HigressAdapter({
    options: () => ({ ...resolveConfig(undefined, {}), ...overrides }),
    resolveApiKey: async () => 'consumer-key',
  })
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const chunk of iterable) out.push(chunk)
  return out
}

afterEach(() => vi.unstubAllGlobals())

describe('HigressAdapter', () => {
  it('lists the configured catalog and resolves model metadata', async () => {
    const adapter = makeAdapter()
    const models = await adapter.listModels('higress')
    expect(models.map(m => m.id)).toEqual(['deepseek-chat'])
    const resolved = await adapter.resolveModel('higress', 'deepseek-chat')
    expect(resolved.context?.contextWindow).toBe(65_536)
    const unknown = await adapter.resolveModel('higress', 'qwen-max')
    expect(unknown.inputModalities).toEqual(['text'])
  })

  it('POSTs the serialized body with the consumer key and yields translated chunks', async () => {
    const fetchMock = vi.fn(async () => sseResponse([
      'data: {"choices":[{"delta":{"reasoning_content":"t"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const out = await collect(makeAdapter().stream(request))
    expect(out.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(out.some(c => c.type === 'usage')).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:8080/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer consumer-key')
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'deepseek-chat', stream: true })
  })

  it('maps 401 to AUTH with the consumer-key hint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"Unauthorized"}}', { status: 401 })))
    await expect(collect(makeAdapter().stream(request))).rejects.toMatchObject({
      failure: { code: 'AUTH', status: 401 },
      message: expect.stringContaining('key-auth'),
    })
  })

  it('maps a gateway 502 to SERVER with the raw body as cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream connect error', { status: 502 })))
    const error = await collect(makeAdapter().stream(request)).then(
      () => { throw new Error('expected rejection') },
      (e: LlmError) => e,
    )
    expect(error.failure.code).toBe('SERVER')
    expect(String((error as Error & { cause?: Error }).cause)).toContain('upstream connect error')
  })

  it('rejects image content as UNSUPPORTED_CONTENT before any fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(collect(makeAdapter().stream({
      provider: 'higress',
      model: 'deepseek-chat',
      messages: [{ ...userMessage, content: [{ type: 'image', attachment: {} as never }] }],
    }))).rejects.toMatchObject({ failure: { code: 'UNSUPPORTED_CONTENT' } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps caller aborts to ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
      return sseResponse(['data: [DONE]\n\n'])
    }))
    const controller = new AbortController()
    controller.abort('stop')
    await expect(collect(makeAdapter().stream({ ...request, signal: controller.signal })))
      .rejects.toMatchObject({ failure: { code: 'ABORTED' } })
  })
})
