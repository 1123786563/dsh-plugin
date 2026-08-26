/** parseSse: framing via eventsource-parser, [DONE] sentinel, truncation. */
import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { parseSse } from '../src/sse.ts'

const encoder = new TextEncoder()

function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = []
  for await (const data of parseSse(stream)) out.push(data)
  return out
}

describe('parseSse', () => {
  it('yields data payloads in order with [DONE] last', async () => {
    const payloads = await collect(streamOf([
      'data: {"a":1}\n\n',
      'data: {"b":2}\n\n',
      'data: [DONE]\n\n',
    ]))
    expect(payloads).toEqual(['{"a":1}', '{"b":2}', '[DONE]'])
  })

  it('reassembles payloads split across arbitrary byte boundaries (mid-UTF-8 included)', async () => {
    const text = 'data: {"text":"你好"}\n\ndata: [DONE]\n\n'
    const bytes = encoder.encode(text)
    const chunks: string[] = []
    for (let i = 0; i < bytes.length; i += 3) chunks.push(Buffer.from(bytes.subarray(i, i + 3)).toString('binary'))
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(Buffer.from(chunk, 'binary'))
        controller.close()
      },
    })
    const payloads = await collect(stream)
    expect(payloads).toEqual(['{"text":"你好"}', '[DONE]'])
  })

  it('joins multi-line data fields and tolerates CRLF', async () => {
    const payloads = await collect(streamOf(['data: line1\r\ndata: line2\r\n\r\ndata: [DONE]\r\n\r\n']))
    expect(payloads).toEqual(['line1\nline2', '[DONE]'])
  })

  it('skips comments and reports them through onComment', async () => {
    const comments: string[] = []
    const payloads: string[] = []
    for await (const data of parseSse(streamOf([': keep-alive\n\ndata: {"a":1}\n\ndata: [DONE]\n\n']), c => comments.push(c))) {
      payloads.push(data)
    }
    expect(comments).toContain('keep-alive')
    expect(payloads).toEqual(['{"a":1}', '[DONE]'])
  })

  it('throws STREAM_CLOSED when the stream ends without [DONE]', async () => {
    await expect(collect(streamOf(['data: {"a":1}\n\n']))).rejects.toMatchObject({ failure: { code: 'STREAM_CLOSED' } })
    await expect(collect(streamOf(['data: {"a":1}\n\ndata: [DONE]\n\n']))).resolves.toBeDefined()
  })
})
