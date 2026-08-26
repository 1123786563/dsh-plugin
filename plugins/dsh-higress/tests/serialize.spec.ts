/** serializeRequest: harness request -> OpenAI-compatible wire body. */
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { serializeRequest } from '../src/serialize.ts'

const msg = (role: Message['role'], content: Message['content']): Message => ({
  id: crypto.randomUUID() as Message['id'],
  role,
  content,
  source: role === 'assistant'
    ? { kind: 'model', provider: 'higress', model: 'deepseek-chat' }
    : role === 'system'
      ? { kind: 'plugin', plugin: 'test' }
      : { kind: 'user' },
})

describe('serializeRequest', () => {
  it('builds the streaming skeleton with system first', () => {
    const body = serializeRequest({
      provider: 'higress',
      model: 'deepseek-chat',
      system: 'be brief',
      messages: [msg('user', [{ type: 'text', text: 'hi' }])],
    })
    expect(body.model).toBe('deepseek-chat')
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.messages).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('passes assistant reasoning back as reasoning_content and tool calls as tool_calls', () => {
    const body = serializeRequest({
      provider: 'higress',
      model: 'deepseek-chat',
      messages: [msg('assistant', [
        { type: 'reasoning', text: 'think' },
        { type: 'text', text: 'answer' },
        { type: 'tool-call', id: 'call_1' as never, name: 'get_weather', arguments: '{"city":"hz"}' },
      ])],
    })
    expect(body.messages[0]).toEqual({
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'think',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"hz"}' } }],
    })
  })

  it('expands tool results into role:tool messages with a non-empty fallback', () => {
    const body = serializeRequest({
      provider: 'higress',
      model: 'deepseek-chat',
      messages: [msg('user', [
        { type: 'text', text: 'run it' },
        { type: 'tool-result', toolCallId: 'call_1' as never, content: [{ type: 'text', text: '' }] },
      ])],
    })
    expect(body.messages).toEqual([
      { role: 'user', content: 'run it' },
      { role: 'tool', tool_call_id: 'call_1', content: '(no output)' },
    ])
  })

  it('maps tools, sampling, and thinking fields', () => {
    const body = serializeRequest({
      provider: 'higress',
      model: 'deepseek-chat',
      messages: [msg('user', [{ type: 'text', text: 'hi' }])],
      tools: [{ name: 'get_weather', description: 'weather', parameters: { type: 'object' } }],
      temperature: 0.2,
      maxTokens: 1024,
      stop: ['END'],
      reasoningEffort: 'low',
    })
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'get_weather', description: 'weather', parameters: { type: 'object' } } }])
    expect(body.temperature).toBe(0.2)
    expect(body.max_tokens).toBe(1024)
    expect(body.stop).toEqual(['END'])
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('low')
  })

  it('disables thinking for session-title purpose and for off effort', () => {
    const base = { provider: 'higress' as const, model: 'deepseek-chat', messages: [msg('user', [{ type: 'text', text: 'hi' }])] }
    expect(serializeRequest({ ...base, purpose: 'session-title' }).thinking).toEqual({ type: 'disabled' })
    expect(serializeRequest({ ...base, reasoningEffort: 'off' }).thinking).toEqual({ type: 'disabled' })
    expect(serializeRequest({ ...base, reasoningEffort: 'off' }).reasoning_effort).toBeUndefined()
  })

  it('omits thinking entirely when neither request nor defaults ask for it', () => {
    const body = serializeRequest({
      provider: 'higress',
      model: 'deepseek-chat',
      messages: [msg('user', [{ type: 'text', text: 'hi' }])],
    })
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('rejects image content as UNSUPPORTED_CONTENT', () => {
    expect(() => serializeRequest({
      provider: 'higress',
      model: 'deepseek-chat',
      messages: [msg('user', [{ type: 'image', attachment: {} as never }])],
    })).toThrowError(/text-only/)
  })
})
