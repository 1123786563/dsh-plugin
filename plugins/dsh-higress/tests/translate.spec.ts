/** translate: wire deltas -> harness StreamChunk protocol. */
import { describe, expect, it } from 'vitest'
import { translate } from '../src/translate.ts'

async function chunksOf(payloads: readonly string[]): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const chunk of translate((async function* () { yield* payloads })())) out.push(chunk)
  return out
}

describe('translate', () => {
  it('emits reasoning before text with correlated block indexes', async () => {
    const out = await chunksOf([
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'think' } }] }),
      JSON.stringify({ choices: [{ delta: { reasoning_content: ' more' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'answer' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      '[DONE]',
    ])
    expect(out).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'think' },
      { type: 'reasoning-delta', index: 0, text: ' more' },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'answer' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think more' } },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('aggregates streamed tool-call deltas by wire index and closes with tool-calls', async () => {
    const out = await chunksOf([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city"' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"hz"}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      '[DONE]',
    ])
    expect(out.filter(c => c.type === 'block-end')).toEqual([
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"hz"}' } },
    ])
    expect(out[out.length - 1]).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('keeps only the latest usage (trailing usage-only chunk wins) and subtracts cached tokens', async () => {
    const out = await chunksOf([
      JSON.stringify({ choices: [{ delta: { content: 'x' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 4 } }),
      JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 2 } } }),
      '[DONE]',
    ])
    // translate defers usage to [DONE] and keeps only the latest payload.
    expect(out.filter(c => c.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 6, cacheReadTokens: 2 } },
    ])
  })

  it('maps length to max-tokens and unknown reasons to an error finish', async () => {
    const out = await chunksOf([
      JSON.stringify({ choices: [{ delta: { content: 'x' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
      '[DONE]',
    ])
    expect(out[out.length - 1]).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })

    const bad = await chunksOf([
      JSON.stringify({ choices: [{ delta: { content: 'x' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'content_filter' }] }),
      '[DONE]',
    ])
    expect(bad[bad.length - 1]).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'CONTENT_FILTER' } } })
  })

  it('turns an empty stop completion into an EMPTY_RESPONSE error finish', async () => {
    const out = await chunksOf(['[DONE]'])
    expect(out).toEqual([{
      type: 'finish',
      reason: { kind: 'error', failure: { message: expect.stringContaining('no content'), code: expect.any(String) } },
    }])
  })

  it('throws MALFORMED_RESPONSE on a non-JSON payload', async () => {
    await expect(chunksOf(['{not json', '[DONE]'])).rejects.toMatchObject({ failure: { code: 'MALFORMED_RESPONSE' } })
  })
})
