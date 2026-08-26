#!/usr/bin/env node
/**
 * End-to-end smoke for the Higress AI gateway + DSH contract: one streamed
 * chat completion through the OpenAI-compatible endpoint.
 *
 * Reads GATEWAY_HTTP_PORT / HIGRESS_BASE_URL / HIGRESS_API_KEY / SMOKE_MODEL
 * from the environment or a sibling .env (simple KEY=VALUE lines).
 * Exit codes: 0 ok · 1 config · 2 http · 3 stream.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function loadEnv() {
  const file = resolve(import.meta.dirname, '.env')
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (match !== null && process.env[match[1]] === undefined) process.env[match[1]] = match[2]
  }
}

loadEnv()

const baseURL = process.env.HIGRESS_BASE_URL ?? `http://127.0.0.1:${process.env.GATEWAY_HTTP_PORT ?? '8080'}/v1`
const apiKey = process.env.HIGRESS_API_KEY ?? ''
const model = process.env.SMOKE_MODEL ?? 'deepseek-chat'

if (apiKey.length === 0) {
  console.error('smoke: set HIGRESS_API_KEY (the gateway consumer key) in the environment or services/higress-gateway/.env')
  process.exit(1)
}

let text = ''
let usage = null
let events = 0

// Network/transport failures (bad URL, ECONNREFUSED, mid-stream errors) exit 2,
// the http/transport class: 0 ok · 1 config · 2 http · 3 stream.
try {
  const response = await fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: '用一个汉字回答：1+1=?' }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  })

  if (!response.ok) {
    console.error(`smoke: HTTP ${response.status} from ${baseURL}`)
    console.error((await response.text()).slice(0, 500))
    process.exit(2)
  }
  if (response.body === null) {
    console.error('smoke: gateway returned no body')
    process.exit(2)
  }

  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      try {
        const parsed = JSON.parse(data)
        events += 1
        text += parsed.choices?.[0]?.delta?.content ?? ''
        if (parsed.usage !== undefined) usage = parsed.usage
      } catch {
        // ignore keep-alive-ish payloads
      }
    }
  }
} catch (error) {
  console.error(`smoke: ${error}`)
  process.exit(2)
}

if (events === 0) {
  console.error('smoke: stream produced no data events')
  process.exit(3)
}
console.log(`smoke: ok — model=${model} events=${events} text="${text.trim().slice(0, 40)}"`)
if (usage !== null) console.log(`smoke: usage=${JSON.stringify(usage)}`)
