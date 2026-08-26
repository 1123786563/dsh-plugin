# dsh-higress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 DSH 新增 `higress` 模型 provider 路由（模型调用经 Higress AI 网关的 OpenAI 兼容端点转发），并交付网关部署模板 `services/higress-gateway/`。

**Architecture:** Cordis 插件 `plugins/dsh-higress`（host 半区 = schemastery 配置 + `HigressAdapter extends LlmAdapter`（OpenAI 兼容流式）+ `registerAdapter`/`registerConfigurableProviders` 装配；client 半区 = 设置卡片）+ `services/higress-gateway/` 部署模板（官方 install.sh 包装 + README checklist + smoke.mjs）。spec 见 `docs/superpowers/specs/2026-08-26-dsh-higress-design.md`。

**Tech Stack:** TypeScript (ESM, strict), Cordis 插件 API, schemastery, `eventsource-parser`（SSE 帧），`@deepseek-ai/dsh-timeout`（idle watchdog），vitest，tsdown + esbuild，React 18（仅 client 半区）。

## Global Constraints

- Node `^22.19.0 || >=24.0.0`；pnpm 11.7.0；所有包 `"type": "module"`。
- TS 配置逐字复制 `plugins/dsh-casdoor-auth/tsconfig.json`（strict + `exactOptionalPropertyTypes` + `allowImportingTsExtensions`）；相对导入带 `.ts` 扩展名。
- 宿主包版本：`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/dsh-timeout` 均 `0.1.1-rc.2`；`@deepseek-ai/cordis` `^4.0.1`；`@deepseek-ai/schemastery` `^3.18.1`。宿主包在 tsdown `deps.neverBundle` 中外部化（插件必须与宿主共享模块实例，`registerAdapter` 有 instanceof 语义）。
- provider 路由名固定 `higress`；settings 命名空间 `llm-higress`；凭据引用默认 `HIGRESS_API_KEY`；默认 baseURL `http://127.0.0.1:8080/v1`（adapter 追加 `/chat/completions`）。
- **v1 adapter 仅支持文本输入**：请求含 image block 时抛 `LlmError('UNSUPPORTED_CONTENT')`（宿主未导出 `prepareRequestImages` 图片归一化管线，无法安全复用；spec 已同步修订）。
- 提交信息风格仿仓库历史（`dsh-higress: ...`）。**Mimosa 提交钩子已知会因仓库既有误报拦截**：只暂存本任务文件后提交；若仍被拦截，不要使用 `--no-verify`（用户未授权），记录"提交待定"并继续下一任务，收尾时统一汇报。
- 每个任务目录内命令默认在 `plugins/dsh-higress/` 下执行（Task 9 在 `services/higress-gateway/` 下）；workspace 根为 `/Users/wuyongjun/trea/dsh-plugin`。

---

### Task 1: 插件脚手架（package.json / cordis.patch.yml / 构建 / manifest 测试）

**Files:**
- Create: `plugins/dsh-higress/package.json`
- Create: `plugins/dsh-higress/cordis.patch.yml`
- Create: `plugins/dsh-higress/tsconfig.json`
- Create: `plugins/dsh-higress/tsdown.config.ts`
- Create: `plugins/dsh-higress/src/index.ts`（最小可用插件，Task 7 会完整替换 apply 体）
- Test: `plugins/dsh-higress/tests/manifest.spec.ts`

**Interfaces:**
- Produces: 包名 `dsh-higress`；`export const name = 'llm-higress'`；`export const inject = ['llm']`；bundle patch 条目 `{ id: llm-higress, name: dsh-higress }`。后续任务的模块都从本包 `src/` 导出。

- [ ] **Step 1: 写 manifest 失败测试**

`tests/manifest.spec.ts`：

```ts
/** Package + bundle manifest invariants for dsh-higress. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(new URL('.', import.meta.url).pathname, '..')

describe('dsh-higress manifest', () => {
  it('declares the dsh bundle and web client halves', async () => {
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as Record<string, unknown>
    const dsh = pkg.dsh as Record<string, unknown>
    expect(dsh.bundle).toMatchObject({ patch: './cordis.patch.yml' })
    expect(dsh.client).toMatchObject({ platform: 'web' })
    expect(pkg.name).toBe('dsh-higress')
    expect(pkg.type).toBe('module')
  })

  it('inserts the plugin into the bundle with the llm-higress id', async () => {
    const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('id: llm-higress')
    expect(patch).toContain('name: dsh-higress')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd plugins/dsh-higress && pnpm exec vitest run tests/manifest.spec.ts`（先 `mkdir -p`）
Expected: FAIL（找不到 package.json / cordis.patch.yml）

- [ ] **Step 3: 创建脚手架文件**

`package.json`（Task 8 再加 client 相关字段）：

```json
{
  "name": "dsh-higress",
  "version": "0.1.0",
  "description": "Higress AI gateway route for DeepSeek Harness: streams model calls through a Higress OpenAI-compatible endpoint (consumer-key auth, gateway-side model routing and token observability) as an independent `higress` provider route beside deepseek-official",
  "type": "module",
  "license": "MIT",
  "keywords": [
    "dsh",
    "dsh-plugin",
    "deepseek",
    "deepseek-harness",
    "cordis",
    "higress",
    "ai-gateway",
    "openai-compatible"
  ],
  "packageManager": "pnpm@11.7.0",
  "engines": {
    "node": "^22.19.0 || >=24.0.0"
  },
  "scripts": {
    "build": "tsc -b && tsdown",
    "test": "vitest run",
    "typecheck": "tsc -b --pretty false"
  },
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "files": [
    "lib",
    "src",
    "cordis.patch.yml",
    "README.md"
  ],
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-llm": "*",
    "@deepseek-ai/dsh-settings": "*",
    "@deepseek-ai/dsh-timeout": "*",
    "@deepseek-ai/schemastery": "^3.18.1"
  },
  "dependencies": {
    "eventsource-parser": "^3.1.0"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-llm": "0.1.1-rc.2",
    "@deepseek-ai/dsh-settings": "0.1.1-rc.2",
    "@deepseek-ai/dsh-timeout": "0.1.1-rc.2",
    "@deepseek-ai/schemastery": "^3.18.1",
    "@types/node": "^24.13.3",
    "tsdown": "0.22.2",
    "typescript": "^5.5.0",
    "vitest": "^4.1.8"
  },
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-settings"
      ]
    }
  }
}
```

`cordis.patch.yml`：

```yaml
# dsh-higress bundle layer: activate the plugin with defaults from the
# launching environment. Endpoint/key resolution order inside the plugin is
# settings > HIGRESS_BASE_URL env > built-in default; nothing needs to be
# frozen here.
- insert:
    - id: llm-higress
      name: dsh-higress
```

`tsconfig.json`：逐字复制 `plugins/dsh-casdoor-auth/tsconfig.json` 的内容（target es2023 / module nodenext / strict 全开 / allowImportingTsExtensions / emitDeclarationOnly 到 `lib/types` / include `["src"]`）。

`tsdown.config.ts`：

```ts
import { defineConfig } from 'tsdown'

// Host-provided packages stay external so the plugin shares the running dsh
// process's own module instances (registerAdapter and the LlmAdapter contract
// have instanceof semantics). eventsource-parser is bundled.
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  outExtensions: () => ({ js: '.js' }),
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/schemastery',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-timeout',
    ],
  },
})
```

`src/index.ts`（最小真实插件；Task 7 替换为完整装配）：

```ts
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
```

- [ ] **Step 4: 安装并验证测试通过**

Run（workspace 根）: `pnpm install`，然后 `cd plugins/dsh-higress && pnpm exec vitest run tests/manifest.spec.ts`
Expected: 2 passed

Run: `pnpm run build`
Expected: `lib/index.js` 生成，无错误

- [ ] **Step 5: Commit**

```bash
git add plugins/dsh-higress pnpm-lock.yaml
git commit -m "dsh-higress: scaffold plugin package (bundle patch, tsdown, manifest test)"
```

---

### Task 2: 配置（config.ts：schema + resolveConfig）

**Files:**
- Create: `plugins/dsh-higress/src/config.ts`
- Test: `plugins/dsh-higress/tests/config.spec.ts`

**Interfaces:**
- Produces:
  - `interface HigressCatalogModel { id: string; name?: string; description?: string; contextWindow?: number; maxTokens?: number; inputModalities?: readonly ModelModality[] }`
  - `interface Config { apiKeyEnv?: string; baseURL?: string; thinking?: 'enabled' | 'disabled'; reasoningEffort?: 'off' | 'low' | 'high' | 'max'; defaultContextWindow?: number; maxTokens?: number; models?: HigressCatalogModel[]; streamIdleTimeoutMs?: number; retryPolicy?: RetryPolicyConfig }`
  - `interface ResolvedHigressOptions { apiKeyEnv: string; baseURL: string; defaults: { thinking?: 'enabled' | 'disabled'; reasoningEffort?: 'off' | 'low' | 'high' | 'max' }; defaultContextWindow: number; maxTokens: number | undefined; models: readonly HigressCatalogModel[]; streamIdleTimeoutMs: number; retryPolicy: ResolvedRetryPolicy }`
  - `const Config`（schemastery schema，同名双身份）、`const DEFAULT_MODELS: readonly HigressCatalogModel[]`
  - `function resolveConfig(config: Partial<Config> | undefined, env?: Record<string, string | undefined>): ResolvedHigressOptions`（默认 `env = process.env`）

- [ ] **Step 1: 写失败测试**

`tests/config.spec.ts`：

```ts
/** resolveConfig: priority, env fallback, defaults, validation. */
import { describe, expect, it } from 'vitest'
import { DEFAULT_MODELS, resolveConfig } from '../src/config.ts'

describe('resolveConfig', () => {
  it('uses built-in defaults with an empty env', () => {
    const resolved = resolveConfig(undefined, {})
    expect(resolved.baseURL).toBe('http://127.0.0.1:8080/v1')
    expect(resolved.apiKeyEnv).toBe('HIGRESS_API_KEY')
    expect(resolved.models).toEqual(DEFAULT_MODELS)
    expect(resolved.defaultContextWindow).toBe(65_536)
    expect(resolved.maxTokens).toBeUndefined()
    expect(resolved.retryPolicy).toBeDefined()
  })

  it('prefers settings over env over default for baseURL', () => {
    expect(resolveConfig({ baseURL: 'https://gw.example.com/v1' }, { HIGRESS_BASE_URL: 'http://ignored:1/v1' }).baseURL)
      .toBe('https://gw.example.com/v1')
    expect(resolveConfig(undefined, { HIGRESS_BASE_URL: 'https://env.example.com/v1' }).baseURL)
      .toBe('https://env.example.com/v1')
  })

  it('normalizes trailing slashes off the baseURL', () => {
    expect(resolveConfig({ baseURL: 'http://127.0.0.1:8080/v1/' }, {}).baseURL).toBe('http://127.0.0.1:8080/v1')
  })

  it('keeps thinking defaults detached', () => {
    const resolved = resolveConfig({ thinking: 'disabled', reasoningEffort: 'low' }, {})
    expect(resolved.defaults).toEqual({ thinking: 'disabled', reasoningEffort: 'low' })
  })

  it('rejects non-http(s) and site-root baseURLs', () => {
    expect(() => resolveConfig({ baseURL: 'ftp://x/v1' }, {})).toThrow(/http/)
    expect(() => resolveConfig({ baseURL: 'not a url' }, {})).toThrow(/valid URL/)
    expect(() => resolveConfig({ baseURL: 'http://127.0.0.1:8080/' }, {})).toThrow(/prefix/)
  })

  it('rejects out-of-range numerics', () => {
    expect(() => resolveConfig({ defaultContextWindow: 0 }, {})).toThrow(/defaultContextWindow/)
    expect(() => resolveConfig({ streamIdleTimeoutMs: 0 }, {})).toThrow(/streamIdleTimeoutMs/)
    expect(() => resolveConfig({ maxTokens: -1 }, {})).toThrow(/maxTokens/)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run tests/config.spec.ts`
Expected: FAIL（无法解析 `../src/config.ts`）

- [ ] **Step 3: 实现 config.ts**

```ts
/**
 * Plugin configuration for dsh-higress: where the Higress AI gateway's
 * OpenAI-compatible endpoint lives, which credential reference carries the
 * consumer key, and the advisory model catalog the route advertises.
 *
 * @module dsh-higress/config
 */

import Schema from '@deepseek-ai/schemastery'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ModelModality, ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'

/** One advisory model entry this route can advertise. */
export interface HigressCatalogModel {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  maxTokens?: number
  inputModalities?: readonly ModelModality[]
}

/**
 * Plugin config, validated by the same-named schemastery schema and doubling
 * as the `llm-higress` settings-section shape. Every field is optional in
 * yml: the consumer key resolves through {@link Config.apiKeyEnv} per request,
 * and an omitted baseURL falls back to $HIGRESS_BASE_URL then the loopback
 * default.
 */
export interface Config {
  /** Credential reference resolved per request; defaults to `HIGRESS_API_KEY`. */
  apiKeyEnv?: string
  /** OpenAI-compatible endpoint prefix; falls back to $HIGRESS_BASE_URL, then http://127.0.0.1:8080/v1. */
  baseURL?: string
  /** Deployment thinking policy forwarded to deepseek-flavored upstreams. */
  thinking?: 'enabled' | 'disabled'
  /** Default thinking effort when a request omits one. */
  reasoningEffort?: 'off' | 'low' | 'high' | 'max'
  /** Context capacity used when a model entry has none (default 65,536). */
  defaultContextWindow?: number
  /** Default per-request output cap; omission leaves it to the gateway. */
  maxTokens?: number
  /** Advisory models shown by discovery consumers; defaults to deepseek-chat. */
  models?: HigressCatalogModel[]
  /** Maximum provider idle time while one stream read is outstanding (default five minutes). */
  streamIdleTimeoutMs?: number
  /** Provider-owned model-request retry policy; omission uses normal mode with five retries. */
  retryPolicy?: RetryPolicyConfig
}

const MODEL_MODALITIES = ['text', 'image'] as const satisfies readonly ModelModality[]

/** Loopback default of a Docker-deployed Higress AI gateway. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8080/v1'

/** Environment variable honored only from the launching process environment. */
const BASE_URL_ENV = 'HIGRESS_BASE_URL'

const DEFAULT_API_KEY_ENV = 'HIGRESS_API_KEY'
const DEFAULT_CONTEXT_WINDOW = 65_536
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** The shipped catalog: one entry, because gateway-side routing is unknown to the plugin. */
export const DEFAULT_MODELS: readonly HigressCatalogModel[] = [
  { id: 'deepseek-chat', name: 'DeepSeek Chat (via Higress)', contextWindow: DEFAULT_CONTEXT_WINDOW },
]

const catalogModel = Schema.object({
  id: Schema.string().required(),
  name: Schema.string(),
  description: Schema.string(),
  contextWindow: Schema.number().step(1).min(1),
  maxTokens: Schema.number().step(1).min(1),
  inputModalities: Schema.array(Schema.union(MODEL_MODALITIES)).min(1).default(['text']),
})

export const Config = Schema.object({
  apiKeyEnv: Schema.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: Schema.string(),
  thinking: Schema.union(['enabled', 'disabled']),
  reasoningEffort: Schema.union(['off', 'low', 'high', 'max']),
  defaultContextWindow: Schema.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  maxTokens: Schema.number().step(1).min(1),
  models: Schema.array(catalogModel).default(DEFAULT_MODELS),
  streamIdleTimeoutMs: Schema.number().min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: Schema.object({}),
})

/** One resolution's complete request facts. */
export interface ResolvedHigressOptions {
  apiKeyEnv: string
  baseURL: string
  defaults: { thinking?: 'enabled' | 'disabled'; reasoningEffort?: 'off' | 'low' | 'high' | 'max' }
  defaultContextWindow: number
  maxTokens: number | undefined
  models: readonly HigressCatalogModel[]
  streamIdleTimeoutMs: number
  retryPolicy: ResolvedRetryPolicy
}

/**
 * Resolve, validate, and detach one configuration generation.
 * @param config - raw entry/settings shape (all fields optional).
 * @param env - launching environment for the baseURL fallback (default process.env).
 * @returns the frozen request facts for this generation.
 */
export function resolveConfig(
  config: Partial<Config> | undefined,
  env: Record<string, string | undefined> = process.env,
): ResolvedHigressOptions {
  const baseURLRaw = config?.baseURL ?? env[BASE_URL_ENV] ?? DEFAULT_BASE_URL
  let parsed: URL
  try {
    parsed = new URL(baseURLRaw)
  } catch {
    throw new Error(`llm-higress: baseURL is not a valid URL: ${baseURLRaw}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`llm-higress: baseURL must be an http(s) URL: ${baseURLRaw}`)
  }
  if (parsed.pathname === '' || parsed.pathname === '/') {
    throw new Error('llm-higress: baseURL must include the OpenAI-compatible prefix (e.g. http://127.0.0.1:8080/v1), not the site root')
  }

  const defaultContextWindow = config?.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW
  if (!Number.isSafeInteger(defaultContextWindow) || defaultContextWindow < 1) {
    throw new Error('llm-higress: defaultContextWindow must be a positive integer')
  }
  const streamIdleTimeoutMs = config?.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
  if (!Number.isSafeInteger(streamIdleTimeoutMs) || streamIdleTimeoutMs < 1) {
    throw new Error('llm-higress: streamIdleTimeoutMs must be a positive integer')
  }
  const maxTokens = config?.maxTokens
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) {
    throw new Error('llm-higress: maxTokens must be a positive integer when set')
  }

  return {
    apiKeyEnv: config?.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
    baseURL: baseURLRaw.replace(/\/+$/, ''),
    defaults: { thinking: config?.thinking, reasoningEffort: config?.reasoningEffort },
    defaultContextWindow,
    maxTokens,
    models: config?.models ?? DEFAULT_MODELS,
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config?.retryPolicy, 'llm-higress: retryPolicy'),
  }
}
```

注：`Config` schema 中的 `retryPolicy: Schema.object({})` 是宽松占位形状——真实校验由 `resolveRetryPolicy` 在 resolve 时做（与 llm-deepseek 的分层一致：schema 收形，resolver 收值域）。若 `@deepseek-ai/dsh-llm` 导出 `RetryPolicySchema`（已确认导出于 `retry-policy.ts`），改用它替换该行：

```ts
import { RetryPolicySchema } from '@deepseek-ai/dsh-llm'
// ...
retryPolicy: RetryPolicySchema,
```

（实现时先尝试 `RetryPolicySchema` 导入；类型报错才退回 `Schema.object({})`。）

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run tests/config.spec.ts`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add plugins/dsh-higress/src/config.ts plugins/dsh-higress/tests/config.spec.ts
git commit -m "dsh-higress: settings schema and resolver (env fallback, validation)"
```

---

### Task 3: wire 类型 + 请求序列化（types.ts / serialize.ts）

**Files:**
- Create: `plugins/dsh-higress/src/types.ts`
- Create: `plugins/dsh-higress/src/serialize.ts`
- Test: `plugins/dsh-higress/tests/serialize.spec.ts`

**Interfaces:**
- Consumes: `GenerateOptions`、`Message`、`ContentBlock`（`@deepseek-ai/dsh-llm` 类型）
- Produces:
  - `types.ts`: `WireMessage`、`WireTool`、`WireRequest`、`WireChunk`、`WireUsage`、`WireError`（OpenAI 兼容 wire 形状；Task 5/6 消费 `WireChunk`/`WireUsage`/`WireError`）
  - `serialize.ts`: `interface RequestDefaults { thinking?: 'enabled' | 'disabled'; reasoningEffort?: 'off' | 'low' | 'high' | 'max' }`；`function serializeRequest(options: GenerateOptions, defaults?: RequestDefaults): WireRequest`

- [ ] **Step 1: 写失败测试**

`tests/serialize.spec.ts`：

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run tests/serialize.spec.ts`
Expected: FAIL（无法解析 `../src/serialize.ts`）

- [ ] **Step 3: 实现 types.ts 和 serialize.ts**

`src/types.ts`：

```ts
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
```

`src/serialize.ts`：

```ts
/**
 * Serialize harness messages into the gateway's OpenAI-compatible chat
 * completions body. Text-only: image content is rejected up front (v1).
 *
 * @module dsh-higress/serialize
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { WireMessage, WireRequest, WireTool } from './types.ts'

/** Adapter-level request defaults (from plugin config). */
export interface RequestDefaults {
  thinking?: 'enabled' | 'disabled' | undefined
  reasoningEffort?: 'off' | 'low' | 'high' | 'max' | undefined
}

interface ResolvedThinking {
  thinking?: 'enabled' | 'disabled'
  reasoningEffort?: 'low' | 'high' | 'max'
}

function resolveThinking(options: GenerateOptions, defaults: RequestDefaults): ResolvedThinking {
  if (options.purpose === 'session-title') return { thinking: 'disabled' }
  const effort = options.reasoningEffort ?? defaults.reasoningEffort
  if (effort === undefined) {
    return defaults.thinking === undefined ? {} : { thinking: defaults.thinking }
  }
  if (effort === 'off') return { thinking: 'disabled' }
  return { thinking: 'enabled', reasoningEffort: effort }
}

function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError(
      'The Higress route is text-only in v1; route image-carrying sessions through deepseek-official.',
      'UNSUPPORTED_CONTENT',
    )
  }
}

function serializeAssistant(message: Message): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))
  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null; some gateways reject null outright.
    content: text,
    ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

function serializeMessages(messages: readonly Message[]): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    const toolResults = message.content.filter(block => block.type === 'tool-result')
    const text = flattenText(message.content)
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      wire.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/**
 * Build the full wire request. Always streaming (usage reporting on);
 * optional fields are omitted rather than sent as null.
 * @param options - the harness request.
 * @param defaults - adapter-level thinking defaults; undefined fields put nothing on the wire.
 */
export function serializeRequest(options: GenerateOptions, defaults: RequestDefaults = {}): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages))

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  const resolvedThinking = resolveThinking(options, defaults)
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...resolvedThinking.thinking !== undefined ? { thinking: { type: resolvedThinking.thinking } } : {},
    ...resolvedThinking.reasoningEffort !== undefined ? { reasoning_effort: resolvedThinking.reasoningEffort } : {},
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run tests/serialize.spec.ts`
Expected: 7 passed

- [ ] **Step 5: Commit**

```bash
git add plugins/dsh-higress/src/types.ts plugins/dsh-higress/src/serialize.ts plugins/dsh-higress/tests/serialize.spec.ts
git commit -m "dsh-higress: OpenAI-compatible wire types and text-only request serializer"
```

---

### Task 4: SSE 帧解析（sse.ts）

**Files:**
- Create: `plugins/dsh-higress/src/sse.ts`
- Test: `plugins/dsh-higress/tests/sse.spec.ts`

**Interfaces:**
- Produces: `const DONE = '[DONE]'`；`function parseSse(stream: ReadableStream<BufferSource>, onComment?: (comment: string) => void): AsyncGenerator<string>`（`[DONE]` 作为最后一个值 yield；EOF 无 `[DONE]` 抛 `LlmError('STREAM_CLOSED')`）

- [ ] **Step 1: 写失败测试**

`tests/sse.spec.ts`：

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run tests/sse.spec.ts`
Expected: FAIL（无法解析 `../src/sse.ts`）

- [ ] **Step 3: 实现 sse.ts**

```ts
/**
 * Decode an SSE byte stream into event `data` payloads. Framing — chunk
 * reassembly, UTF-8/CRLF/BOM handling, comment and non-data field skipping,
 * multi-`data:` joining — is `eventsource-parser`'s. This module keeps the
 * gateway protocol: the literal `[DONE]` is yielded so the caller owns final
 * flushing, and EOF before it raises {@link LlmError}. Framing is
 * spec-strict: an event dispatches only on its blank-line terminator.
 *
 * @module dsh-higress/sse
 */

import { EventSourceParserStream } from 'eventsource-parser/stream'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** The terminal payload OpenAI-compatible servers send after the last chunk. */
export const DONE = '[DONE]'

/**
 * Parse an SSE byte stream into data payloads.
 * @param stream - raw SSE bytes; reads may split anywhere, including mid-UTF-8 sequence.
 * @param onComment - optional transport-activity callback; comments never enter the yielded payload stream.
 * @returns each event's data payload in arrival order, the `[DONE]` sentinel last.
 */
export async function* parseSse(
  stream: ReadableStream<BufferSource>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }))
  for await (const { data } of events) {
    yield data
    if (data === DONE) return
  }
  throw new LlmError('SSE stream ended without [DONE]', 'STREAM_CLOSED')
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run tests/sse.spec.ts`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add plugins/dsh-higress/src/sse.ts plugins/dsh-higress/tests/sse.spec.ts
git commit -m "dsh-higress: SSE framing with [DONE] sentinel and truncation detection"
```

---

### Task 5: chunk 翻译（translate.ts）

**Files:**
- Create: `plugins/dsh-higress/src/translate.ts`
- Test: `plugins/dsh-higress/tests/translate.spec.ts`

**Interfaces:**
- Consumes: `parseSse` 的 payload 序列（string，`[DONE]` 结尾）、`WireChunk`/`WireUsage`
- Produces: `function mapFinishReason(reason: string): FinishReason`；`function mapUsage(usage: WireUsage): TokenUsage`；`async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk>`

- [ ] **Step 1: 写失败测试**

`tests/translate.spec.ts`：

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run tests/translate.spec.ts`
Expected: FAIL（无法解析 `../src/translate.ts`）

- [ ] **Step 3: 实现 translate.ts**

逐字移植 `deepseek-harness/packages/llm/llm-deepseek/src/translate.ts`（协议相同），仅改模块 doc 头为 `@module dsh-higress/translate`、错误消息前缀沿用（`malformed SSE payload: ...` 等无需改名）。完整代码：

```ts
/**
 * Translate gateway SSE payloads with one stateful harness block per content,
 * reasoning, or tool call index. An empty initial reasoning delta does not
 * open a block. Finish reason and the latest usage are deferred until
 * `[DONE]`, covering both finish-attached and trailing usage-only shapes
 * while ensuring no chunk follows `finish`.
 *
 * @module dsh-higress/translate
 */

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { DONE } from './sse.ts'
import type { WireChunk, WireUsage } from './types.ts'

/** One open block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  /** tool-call only */
  callId?: string
  name?: string
}

/**
 * Map the wire finish_reason vocabulary to the harness FinishReason.
 * @param reason - the wire `finish_reason` string.
 * @returns the mapped reason; unrecognized values (content_filter, …) become `{kind: 'error'}` with the uppercased value as `code`.
 */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
      }
  }
}

/**
 * Map wire usage fields. DeepSeek's `prompt_tokens` INCLUDES cache hits; the
 * harness TokenUsage convention is DISJOINT counts, so cache reads are
 * subtracted out of `inputTokens`.
 * @param usage - wire usage from the finish chunk or the trailing usage-only chunk.
 * @returns disjoint harness counts; cache/reasoning fields present only when the wire reported them.
 */
export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/**
 * Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
 * Malformed JSON payloads abort the stream with `MALFORMED_RESPONSE`.
 * @param payloads - SSE data payloads from {@link parseSse}, `[DONE]`-terminated.
 * @returns deltas as they arrive; `block-end`s, `usage`, and `finish` are all deferred to the `[DONE]` sentinel.
 */
export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  function open(kind: OpenBlock['kind']): OpenBlock {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
            kind: 'error',
            failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
          }
          : reason,
      }
      return
    }

    let chunk: WireChunk
    try {
      chunk = JSON.parse(payload) as WireChunk
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (call.id !== undefined) block.callId = call.id
        if (call.function?.name !== undefined) block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...block.name !== undefined ? { name: block.name } : {},
          argumentsDelta: fragment,
        }
      }

      if (typeof choice.finish_reason === 'string') {
        pendingFinish = mapFinishReason(choice.finish_reason)
      }
    }

    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
  }

  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run tests/translate.spec.ts`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add plugins/dsh-higress/src/translate.ts plugins/dsh-higress/tests/translate.spec.ts
git commit -m "dsh-higress: wire chunk translation (reasoning/text/tool blocks, usage, finish)"
```

---

### Task 6: HigressAdapter（adapter.ts）

**Files:**
- Create: `plugins/dsh-higress/src/adapter.ts`
- Test: `plugins/dsh-higress/tests/adapter.spec.ts`

**Interfaces:**
- Consumes: `ResolvedHigressOptions`（Task 2）、`serializeRequest`（Task 3）、`parseSse`（Task 4）、`translate`（Task 5）
- Produces:
  - `interface HigressAdapterOptions { options(): ResolvedHigressOptions; resolveApiKey(connection: ResolvedHigressOptions): Promise<string> }`
  - `class HigressAdapter extends LlmAdapter`（`providerInfo` / `providerRetryPolicy` / `listModels` / `resolveModel` / `prepareCall` / `stream`）
  - `function httpErrorCode(status: number, error?: WireErrorBody): string`

- [ ] **Step 1: 写失败测试**

`tests/adapter.spec.ts`：

```ts
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
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run tests/adapter.spec.ts`
Expected: FAIL（无法解析 `../src/adapter.ts`）

- [ ] **Step 3: 实现 adapter.ts**

```ts
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
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm exec vitest run tests/adapter.spec.ts && pnpm run typecheck`
Expected: 6 passed；typecheck 无错误

- [ ] **Step 5: Commit**

```bash
git add plugins/dsh-higress/src/adapter.ts plugins/dsh-higress/tests/adapter.spec.ts
git commit -m "dsh-higress: streaming adapter (fetch + SSE, error mapping, idle watchdog)"
```

---

### Task 7: 插件装配（index.ts 完整 apply）

**Files:**
- Modify: `plugins/dsh-higress/src/index.ts`（替换 Task 1 的最小版本）
- Test: `plugins/dsh-higress/tests/credentials.spec.ts`

**Interfaces:**
- Consumes: `Config`/`resolveConfig`（Task 2）、`HigressAdapter`（Task 6）、`installSettingsSection`/`settingsNamespace`（`@deepseek-ai/dsh-settings`）
- Produces:
  - `export const name = 'llm-higress'`；`export const inject = ['llm']`
  - `export const PROVIDER = 'higress'`；`export const NS`（settings 命名空间串）
  - `export interface CredentialsLike { resolve(ref: string): Promise<{ value: string } | undefined> }`
  - `export async function resolveConsumerKey(ref: string, credentials: CredentialsLike | undefined, env: Record<string, string | undefined>): Promise<string>`
  - `export function apply(ctx: Context, config: Partial<Config> | undefined): void`

- [ ] **Step 1: 写失败测试**

`tests/credentials.spec.ts`：

```ts
/** resolveConsumerKey: credentials-service-first resolution with env fallback. */
import { describe, expect, it } from 'vitest'
import { resolveConsumerKey } from '../src/index.ts'

describe('resolveConsumerKey', () => {
  it('returns the credentials-service value when the service hits', async () => {
    const key = await resolveConsumerKey('HIGRESS_API_KEY', {
      resolve: async () => ({ value: 'managed-key' }),
    }, { HIGRESS_API_KEY: 'env-key' })
    expect(key).toBe('managed-key')
  })

  it('falls back to the environment only when the service is absent', async () => {
    expect(await resolveConsumerKey('HIGRESS_API_KEY', undefined, { HIGRESS_API_KEY: 'env-key' })).toBe('env-key')
    await expect(resolveConsumerKey('HIGRESS_API_KEY', { resolve: async () => undefined }, { HIGRESS_API_KEY: 'env-key' }))
      .rejects.toMatchObject({ failure: { code: 'MISSING_CREDENTIAL' } })
  })

  it('throws MISSING_CREDENTIAL naming the ref when nothing resolves', async () => {
    const error = await resolveConsumerKey('HIGRESS_API_KEY', undefined, {}).then(
      () => { throw new Error('expected rejection') },
      (e: Error) => e,
    )
    expect(error.message).toContain('HIGRESS_API_KEY')
    expect((error as { failure?: { code?: string } }).failure?.code).toBe('MISSING_CREDENTIAL')
  })

  it('rejects whitespace-only values through the usable-key check', async () => {
    // assertUsableApiKey throws INVALID_CREDENTIAL (not MISSING_CREDENTIAL)
    // for supplied-but-blank values — verified against @deepseek-ai/dsh-llm
    // 0.1.1-rc.2 (lib/index.js assertUsableApiKey / INVALID_CREDENTIAL_CODE).
    await expect(resolveConsumerKey('HIGRESS_API_KEY', undefined, { HIGRESS_API_KEY: '   ' }))
      .rejects.toMatchObject({ failure: { code: 'INVALID_CREDENTIAL' } })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run tests/credentials.spec.ts`
Expected: FAIL（`resolveConsumerKey` 未导出）

- [ ] **Step 3: 完整替换 src/index.ts**

```ts
/**
 * dsh-higress: the Higress AI gateway model route for DeepSeek Harness.
 * Registers one provider route (`higress`) whose adapter streams OpenAI-
 * compatible chat completions through the gateway, beside the untouched
 * `deepseek-official` direct route. Host half only; the browser half is the
 * settings card under `./client`.
 *
 * @module dsh-higress
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { HigressAdapter } from './adapter.ts'
import { Config, resolveConfig } from './config.ts'
import type { Config as ConfigShape, ResolvedHigressOptions } from './config.ts'

/** Cordis plugin name; keep this stable after publishing. */
export const name = 'llm-higress'

/** The `llm` service must exist before this plugin is applied. */
export const inject: string[] = ['llm']

/** The single provider route this plugin owns. */
export const PROVIDER = 'higress'

/** The settings namespace this plugin owns (the card's slot key matches it). */
export const NS = settingsNamespace('llm-higress')

export { Config }
export type { ConfigShape }
export { HigressAdapter, httpErrorCode } from './adapter.ts'
export { resolveConfig } from './config.ts'
export { DEFAULT_BASE_URL, DEFAULT_MODELS } from './config.ts'
export type { HigressCatalogModel, ResolvedHigressOptions } from './config.ts'
export { parseSse, DONE } from './sse.ts'
export { mapFinishReason, mapUsage, translate } from './translate.ts'
export { serializeRequest } from './serialize.ts'
export type { RequestDefaults } from './serialize.ts'

/** Minimal credentials-service surface this plugin consumes. */
export interface CredentialsLike {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/**
 * Resolve the gateway consumer key: the credentials service first (the web
 * Models page writes it), the launching environment only when that service
 * is absent, `MISSING_CREDENTIAL` otherwise.
 * @param ref - credential reference (environment-variable name).
 * @param credentials - the live credentials service, when present.
 * @param env - the launching process environment.
 * @returns the usable key value.
 */
export async function resolveConsumerKey(
  ref: string,
  credentials: CredentialsLike | undefined,
  env: Record<string, string | undefined>,
): Promise<string> {
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    if (hit !== undefined) return assertUsableApiKey(hit.value, 'llm-higress', ref)
  } else {
    const ambient = env[ref]
    if (ambient !== undefined && ambient.length > 0) return assertUsableApiKey(ambient, 'llm-higress', ref)
  }
  throw new LlmError(
    `llm-higress: no consumer key for provider route "${PROVIDER}"; store ${ref} through the credentials`
    + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
    'MISSING_CREDENTIAL',
  )
}

/**
 * Activate the plugin: resolve configuration with last-good semantics,
 * register the `higress` adapter route and its Models-page directory entry,
 * and own the `llm-higress` settings section.
 * @param ctx - host context.
 * @param config - loader-supplied entry config.
 */
export function apply(ctx: Context, config: Partial<ConfigShape> | undefined): void {
  const entry = resolveConfig(config)
  let authoritative: () => ConfigShape = () => entry
  let current = entry
  let lastRaw: Partial<ConfigShape> | undefined
  let lastGood: ResolvedHigressOptions | undefined
  const options = (): ResolvedHigressOptions => {
    const raw = authoritative()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveConfig(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing a beyond-schema bound:
      // keep serving the last good facts and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-higress: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  options()

  const adapter = new HigressAdapter({
    options,
    resolveApiKey: async connection => resolveConsumerKey(
      connection.apiKeyEnv,
      ctx.get('credentials') as CredentialsLike | undefined,
      process.env,
    ),
  })
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Higress', settingsNs: NS, settingsPath: [] },
  ])
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below.
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  let registeredPolicy = JSON.stringify(options().retryPolicy)
  const ensureRegistrationFacts = (): void => {
    const policy = JSON.stringify(options().retryPolicy)
    if (policy === registeredPolicy) return
    // The registry captures the retry policy at registration, so it is the one
    // fact per-request resolution cannot refresh. `replace` re-reads it in one
    // synchronous registry section: disposing and re-registering instead would
    // publish an empty route set between the two.
    registration.replace([PROVIDER])
    registeredPolicy = policy
  }

  installSettingsSection(ctx, NS, Config, config as ConfigShape, {
    setSource: source => {
      authoritative = source as () => ConfigShape
    },
    onChange: ensureRegistrationFacts,
  })
}
```

类型提示：`ctx.llm` 的访问需要 `inject: ['llm']` 声明（已声明）且 cordis 的 `Context` 类型带相应 service 声明合并——若 `@deepseek-ai/dsh-llm` 的类型包没有把 `llm` 合并进 cordis `Context`（typecheck 报错），将 `ctx.llm` 访问改为 `const llm = (ctx as unknown as { llm: LlmRuntimeLike }).llm`，`LlmRuntimeLike` 定义最小接口 `{ registerAdapter(providers: string[], adapter: HigressAdapter): { (): void; replace(providers: string[]): void }; registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): void }`（对齐 casdoor/openmeter 的 duck-typing 惯例）。`installSettingsSection` 的第 4 参以 llm-deepseek 同款方式传 entry（它接受 schema 收形后的原始 entry）。

- [ ] **Step 4: 运行确认通过 + 全量 typecheck**

Run: `pnpm exec vitest run tests/credentials.spec.ts && pnpm run typecheck && pnpm run build`
Expected: 4 passed；typecheck/build 无错误

- [ ] **Step 5: Commit**

```bash
git add plugins/dsh-higress/src/index.ts plugins/dsh-higress/tests/credentials.spec.ts
git commit -m "dsh-higress: wire the adapter into the llm registry with settings hot-reload"
```

---

### Task 8: 浏览器半区（设置卡片）

**Files:**
- Create: `plugins/dsh-higress/src/client/form.ts`
- Create: `plugins/dsh-higress/src/client/card.tsx`
- Create: `plugins/dsh-higress/src/client/index.tsx`
- Create: `plugins/dsh-higress/scripts/build-client.mjs`
- Modify: `plugins/dsh-higress/package.json`（exports/files/build/devDeps）
- Test: `plugins/dsh-higress/tests/client-form.spec.ts`

**Interfaces:**
- Consumes: settings scope（宿主 client 服务）、`HigressCatalogModel`（Task 2）
- Produces:
  - `parseModelsText(text: string, existing: readonly HigressCatalogModel[], defaultContextWindow: number): HigressCatalogModel[]`
  - `formatModelsText(models: readonly HigressCatalogModel[] | undefined): string`
  - `class CardStore`、`interface CardFace { hooks: { higressSettingsCard: CardStore }; edit(field: 'baseURL' | 'apiKeyEnv' | 'models', value: string): void; resetField(field): void; save(): void; discard(): void }`、`cardFace(scope: HigressSettingsScope): CardFace`
  - `makeSettingsCard(face: CardFace): () => JSX.Element`（card.tsx）
  - client 入口 `apply(ctx)`（index.tsx）

- [ ] **Step 1: 写失败测试**

`tests/client-form.spec.ts`：

```ts
/** Client form staging: parse/format models text, save/discard lifecycle. */
import { describe, expect, it } from 'vitest'
import { cardFace, formatModelsText, parseModelsText } from '../src/client/form.ts'

function scopeWith(value: Record<string, unknown> = {}) {
  const listeners = new Set<() => void>()
  const snapshot = { status: 'ready', value, user: {}, writable: true }
  const writes: Array<[string, unknown]> = []
  return {
    writes,
    scope: {
      getSnapshot: () => snapshot,
      subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } },
      set: async (field: string, v: unknown) => { writes.push([field, v]); Object.assign(snapshot.value, { [field]: v }) },
      unset: async (field: string) => { writes.push([field, undefined]) },
    },
  }
}

describe('models text', () => {
  it('parses one id per line, preserving prior metadata for known ids', () => {
    const existing = [{ id: 'deepseek-chat', name: 'DeepSeek Chat (via Higress)', contextWindow: 65_536 }]
    const parsed = parseModelsText('deepseek-chat\n\n  qwen-max  \n', existing, 32_768)
    expect(parsed).toEqual([
      { id: 'deepseek-chat', name: 'DeepSeek Chat (via Higress)', contextWindow: 65_536 },
      { id: 'qwen-max', name: 'qwen-max', contextWindow: 32_768 },
    ])
  })

  it('formats ids one per line and tolerates undefined', () => {
    expect(formatModelsText([{ id: 'a' }, { id: 'b' }])).toBe('a\nb')
    expect(formatModelsText(undefined)).toBe('')
  })
})

describe('CardStore', () => {
  it('stages edits and writes them on save', async () => {
    const { scope, writes } = scopeWith({ baseURL: 'http://127.0.0.1:8080/v1', apiKeyEnv: 'HIGRESS_API_KEY', models: [{ id: 'deepseek-chat' }] })
    const face = cardFace(scope)
    face.edit('baseURL', 'https://gw.example.com/v1')
    face.edit('models', 'deepseek-chat\nqwen-max')
    expect(face.hooks.higressSettingsCard.getSnapshot().dirty).toBe(true)
    await face.hooks.higressSettingsCard.save()
    expect(writes).toContainEqual(['baseURL', 'https://gw.example.com/v1'])
    expect(writes).toContainEqual(['models', [{ id: 'deepseek-chat' }, { id: 'qwen-max', name: 'qwen-max', contextWindow: 65_536 }]])
    expect(face.hooks.higressSettingsCard.getSnapshot().dirty).toBe(false)
  })

  it('discards staged drafts without writing', async () => {
    const { scope, writes } = scopeWith({})
    const face = cardFace(scope)
    face.edit('apiKeyEnv', 'OTHER_KEY')
    face.discard()
    expect(face.hooks.higressSettingsCard.getSnapshot().dirty).toBe(false)
    await face.hooks.higressSettingsCard.save()
    expect(writes).toEqual([])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm exec vitest run tests/client-form.spec.ts`
Expected: FAIL（无法解析 `../src/client/form.ts`）

- [ ] **Step 3: 实现 client 三件套 + 构建脚本**

`src/client/form.ts`：

```ts
/**
 * Staged-form model behind the llm-higress settings card (same pattern as
 * dsh-openmeter): stage what the user types, write only on save. Pure state,
 * testable in Node.
 *
 * @module dsh-higress/client/form
 */

import type { HigressCatalogModel } from '../config.ts'

/** Minimal settings-scope contract this form needs. */
export interface HigressSettingsScope {
  getSnapshot(): HigressScopeSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** Minimal scope-snapshot contract. */
export interface HigressScopeSnapshot {
  status: string
  value?: Readonly<Record<string, unknown>>
  user?: Readonly<Record<string, unknown>>
  writable: boolean
}

/** The editable fields. */
export type AnyField = 'baseURL' | 'apiKeyEnv' | 'models'

const TEXT_FIELDS: readonly AnyField[] = ['baseURL', 'apiKeyEnv']

/** One field as the card renders it. */
export interface FieldState {
  text: string
  overridden: boolean
}

/** Card state the component renders. */
export interface CardState {
  available: boolean
  writable: boolean
  dirty: boolean
  saving: boolean
  failed: boolean
  failedReason?: string
  baseURL: FieldState
  apiKeyEnv: FieldState
  models: FieldState
}

/** The face the card's slot entry injects. */
export interface CardFace {
  hooks: { higressSettingsCard: CardStore }
  edit: (field: AnyField, value: string) => void
  resetField: (field: AnyField) => void
  save: () => void
  discard: () => void
}

const DEFAULT_CONTEXT_WINDOW = 65_536

/** Parse the models textarea: one model id per line, prior metadata preserved. */
export function parseModelsText(
  text: string,
  existing: readonly HigressCatalogModel[],
  defaultContextWindow: number = DEFAULT_CONTEXT_WINDOW,
): HigressCatalogModel[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(id => existing.find(model => model.id === id) ?? { id, name: id, contextWindow: defaultContextWindow })
}

/** Format the catalog as the textarea shows it: one id per line. */
export function formatModelsText(models: readonly HigressCatalogModel[] | undefined): string {
  return (models ?? []).map(model => model.id).join('\n')
}

function catalogOf(value: unknown): readonly HigressCatalogModel[] {
  return Array.isArray(value) ? value as HigressCatalogModel[] : []
}

/** Observable card store (subscribe + snapshot for useSyncExternalStore). */
export class CardStore {
  private staging: Partial<Record<AnyField, string>> = {}
  private state: CardState
  private readonly listeners = new Set<() => void>()

  /**
   * @param scope - the bound settings scope.
   */
  constructor(private readonly scope: HigressSettingsScope) {
    this.state = derive(scope.getSnapshot(), this.staging)
    scope.subscribe(() => this.reattach())
  }

  /** Current snapshot. */
  getSnapshot = (): CardState => this.state

  /** Subscribe to replacements. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Stage a draft for one field. */
  edit = (field: AnyField, value: string): void => {
    this.staging[field] = value
    this.reattach()
  }

  /** Reset one field back to the composition layer. */
  resetField = (field: AnyField): void => {
    delete this.staging[field]
    void this.scope.unset(field)
    this.reattach()
  }

  /** Write staged drafts into the user layer. */
  save = (): Promise<void> => {
    const snapshot = this.scope.getSnapshot()
    const writes: Array<Promise<void>> = []
    for (const field of TEXT_FIELDS) {
      const draft = this.staging[field]
      if (draft === undefined) continue
      const base = typeof snapshot.value?.[field] === 'string' ? snapshot.value[field] as string : ''
      if (draft === base) {
        if (snapshot.user?.[field] !== undefined) writes.push(this.scope.unset(field))
        continue
      }
      writes.push(this.scope.set(field, draft))
    }
    const modelsDraft = this.staging.models
    if (modelsDraft !== undefined) {
      writes.push(this.scope.set('models', parseModelsText(modelsDraft, catalogOf(snapshot.value?.models))))
    }
    this.state = { ...this.state, saving: true, failed: false }
    this.emit()
    return Promise.all(writes).then(
      () => {
        this.staging = {}
        this.state = { ...derive(this.scope.getSnapshot(), this.staging), saving: false }
        this.emit()
      },
      (error: unknown) => {
        this.state = { ...this.state, saving: false, failed: true, failedReason: error instanceof Error ? error.message : String(error) }
        this.emit()
      },
    )
  }

  /** Drop staged drafts. */
  discard = (): void => {
    this.staging = {}
    this.reattach()
  }

  private reattach(): void {
    this.state = derive(this.scope.getSnapshot(), this.staging)
    this.emit()
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

function fieldOf(snapshot: HigressScopeSnapshot, staging: Partial<Record<AnyField, string>>, field: AnyField, base: string): FieldState {
  return {
    text: staging[field] ?? base,
    overridden: snapshot.user?.[field] !== undefined,
  }
}

function derive(snapshot: HigressScopeSnapshot, staging: Partial<Record<AnyField, string>>): CardState {
  const ready = snapshot.status === 'ready'
  const value = snapshot.value ?? {}
  const baseURLBase = typeof value.baseURL === 'string' ? value.baseURL : 'http://127.0.0.1:8080/v1'
  const apiKeyEnvBase = typeof value.apiKeyEnv === 'string' ? value.apiKeyEnv : 'HIGRESS_API_KEY'
  return {
    available: ready,
    writable: snapshot.writable,
    dirty: Object.keys(staging).length > 0,
    saving: false,
    failed: false,
    baseURL: fieldOf(snapshot, staging, 'baseURL', baseURLBase),
    apiKeyEnv: fieldOf(snapshot, staging, 'apiKeyEnv', apiKeyEnvBase),
    models: fieldOf(snapshot, staging, 'models', formatModelsText(catalogOf(value.models))),
  }
}

/**
 * Bind the card face the slot entry injects.
 * @param scope - the bound settings scope.
 * @returns the face (hooks + actions).
 */
export function cardFace(scope: HigressSettingsScope): CardFace {
  const store = new CardStore(scope)
  return {
    hooks: { higressSettingsCard: store },
    edit: store.edit,
    resetField: store.resetField,
    save: () => { void store.save() },
    discard: store.discard,
  }
}
```

`src/client/card.tsx`：

```tsx
/**
 * The llm-higress settings card: endpoint, credential reference, and the
 * one-id-per-line model catalog. zh-first strings with an en fallback (no
 * locale-service dependency in v1).
 *
 * @module dsh-higress/client/card
 */

import { useSyncExternalStore } from 'react'
import type { CardFace } from './form.ts'

const STRINGS = {
  zh: {
    title: 'Higress AI 网关',
    baseURL: '网关端点（OpenAI 兼容前缀）',
    apiKeyEnv: '凭据引用（consumer key 的环境变量名）',
    models: '模型目录（每行一个模型 ID）',
    save: '保存',
    discard: '放弃',
    reset: '重置',
    overridden: '已覆盖默认',
    saving: '保存中…',
    failed: '保存失败',
    unavailable: '设置服务不可用',
  },
  en: {
    title: 'Higress AI gateway',
    baseURL: 'Gateway endpoint (OpenAI-compatible prefix)',
    apiKeyEnv: 'Credential reference (env var holding the consumer key)',
    models: 'Model catalog (one model id per line)',
    save: 'Save',
    discard: 'Discard',
    reset: 'Reset',
    overridden: 'Overrides default',
    saving: 'Saving…',
    failed: 'Save failed',
    unavailable: 'Settings service unavailable',
  },
} as const

function strings(): (typeof STRINGS)['zh'] {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? STRINGS.zh : STRINGS.en
}

/**
 * Build the card component bound to one face.
 * @param face - the injected card face.
 * @returns the React component the slot renders.
 */
export function makeSettingsCard(face: CardFace): () => JSX.Element {
  return function HigressSettingsCard(): JSX.Element {
    const t = strings()
    const state = useSyncExternalStore(face.hooks.higressSettingsCard.subscribe, face.hooks.higressSettingsCard.getSnapshot)
    const textInput = (field: 'baseURL' | 'apiKeyEnv', label: string): JSX.Element => (
      <label style={{ display: 'block', marginBottom: 12 }}>
        <span style={{ display: 'block', fontWeight: 500 }}>{label}{state[field].overridden ? ` · ${t.overridden}` : ''}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            style={{ flex: 1, padding: '4px 8px' }}
            value={state[field].text}
            disabled={!state.writable}
            onChange={event => face.edit(field, event.target.value)}
          />
          {state[field].overridden ? <button onClick={() => face.resetField(field)}>{t.reset}</button> : null}
        </div>
      </label>
    )
    return (
      <section>
        <h3>{t.title}</h3>
        {!state.available ? <p>{t.unavailable}</p> : (
          <form onSubmit={event => { event.preventDefault(); face.save() }}>
            {textInput('baseURL', t.baseURL)}
            {textInput('apiKeyEnv', t.apiKeyEnv)}
            <label style={{ display: 'block', marginBottom: 12 }}>
              <span style={{ display: 'block', fontWeight: 500 }}>{t.models}{state.models.overridden ? ` · ${t.overridden}` : ''}</span>
              <textarea
                style={{ width: '100%', minHeight: 96, padding: '4px 8px', fontFamily: 'monospace' }}
                value={state.models.text}
                disabled={!state.writable}
                onChange={event => face.edit('models', event.target.value)}
              />
            </label>
            {state.failed ? <p style={{ color: '#c0392b' }}>{t.failed}{state.failedReason ? `：${state.failedReason}` : ''}</p> : null}
            <button type="submit" disabled={!state.dirty || state.saving || !state.writable}>{state.saving ? t.saving : t.save}</button>
            {' '}
            <button type="button" onClick={face.discard} disabled={!state.dirty || state.saving}>{t.discard}</button>
          </form>
        )}
      </section>
    )
  }
}
```

`src/client/index.tsx`：

```tsx
/**
 * dsh-higress, browser half: the Settings > Plugins config card for the
 * llm-higress namespace the Host registers.
 *
 * Failure policy: mounting problems are logged, never thrown — the web shell
 * fails the whole boot when a plugin apply throws.
 *
 * @module dsh-higress/client
 */

import { makeSettingsCard } from './card.tsx'
import { cardFace } from './form.ts'
import type { HigressSettingsScope } from './form.ts'

/** Settings namespace the card edits. */
const HIGRESS_NS = 'llm-higress'

/** Minimal client-context surface this plugin uses (services are duck-typed). */
interface ClientContext {
  effect(register: () => (() => void) | void, label?: string): () => void
  get(name: string): unknown
  slots: {
    inject(name: string, register: () => (() => void) | void): void
    register(options: Record<string, unknown>, component: (props: never) => unknown): () => void
  }
  settingsScope: { bind<S>(spec: { namespace: string }): S }
}

/** Required services: slot registry and settings scope. */
export const inject: string[] = ['slots', 'settingsScope']

/**
 * Mount the browser half: the settings card.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  try {
    const binder = (ctx.get('webUiSettings') as { bind: ClientContext['settingsScope']['bind'] } | undefined) ?? ctx.settingsScope
    const scope = binder.bind<HigressSettingsScope>({ namespace: HIGRESS_NS })
    const face = cardFace(scope)
    ctx.slots.inject('settings.plugin.item', () => {
      try {
        const unregister = ctx.slots.register({
          name: 'settings.plugin.item',
          key: HIGRESS_NS,
          inject: () => face,
        }, makeSettingsCard(face) as never)
        return () => {
          unregister()
        }
      } catch {
        return () => {}
      }
    })
  } catch {
    // Without a settings scope the card stays absent.
  }
}
```

`scripts/build-client.mjs`（openmeter 同款，id 换名）：

```js
/**
 * Build the browser half into the client module system's lazy-CJS factory
 * artifact (see plugins/dsh-openmeter/scripts/build-client.mjs for the
 * format contract).
 */

import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const NL = String.fromCharCode(10)
const root = resolve(new URL('.', import.meta.url).pathname, '..')
const outfile = resolve(root, 'lib/client.js')

const result = await build({
  entryPoints: [resolve(root, 'src/client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: 'external',
  outfile: 'client.js',
  legalComments: 'none',
  external: ['react', 'react/jsx-runtime'],
  write: false,
  logLevel: 'info',
})

let body = ''
let map = ''
for (const file of result.outputFiles ?? []) {
  if (file.path.endsWith('.map')) map = file.text
  else body = file.text
}
if (body.length === 0) throw new Error('build-client: no JS output produced')

await mkdir(dirname(outfile), { recursive: true })
await writeFile(
  outfile,
  'window.__ModuleLoader__.load({' + NL
    + '  id: "dsh-higress",' + NL
    + '  factory: (require) => {' + NL
    + '    var module = { exports: {} };' + NL
    + '    var exports = module.exports;' + NL
    + body + NL
    + '    return module.exports;' + NL
    + '  },' + NL
    + '});' + NL
    + (map.length === 0 ? '' : '//# sourceMappingURL=client.js.map' + NL),
  'utf8',
)
if (map.length > 0) {
  await writeFile(outfile + '.map', map, 'utf8')
}
```

`package.json` 修改：

- `scripts.build` → `"tsc -b && tsdown && node scripts/build-client.mjs"`
- `exports` 增加 `"./client": { "default": "./lib/client.js" }`
- `files` 增加 `"scripts"`
- `devDependencies` 增加 `"@types/react": "^18.3.12"`、`"react": "^18.3.1"`、`"esbuild": "^0.25.0"`

`tsconfig.json` 修改：加 `"exclude": ["src/client"]`（client 的 `.tsx` 由 esbuild 编译；tsc 无 jsx 配置，不排除会令 `tsc -b` 失败）。

（`parseModelsText` 的第三个参数 `defaultContextWindow` 在 CardStore.save 中不传——沿用 form.ts 内置的 65_536 默认。）

- [ ] **Step 4: 安装新依赖并验证**

Run（workspace 根）: `pnpm install`，然后 `cd plugins/dsh-higress && pnpm exec vitest run tests/client-form.spec.ts && pnpm run build`
Expected: 4 passed；`lib/client.js` 生成且含 `dsh-higress`

- [ ] **Step 5: Commit**

```bash
git add plugins/dsh-higress pnpm-lock.yaml
git commit -m "dsh-higress: browser settings card (endpoint, credential ref, model catalog)"
```

---

### Task 9: 网关部署模板（services/higress-gateway）

> **修订记录（2026-08-26，审查后）**：本节代码块按审查结论修订过两次——(1) 官方安装器只认 `GATEWAY_HTTP_PORT`/`GATEWAY_HTTPS_PORT`/`CONSOLE_PORT` 直接导出（`DEFAULT_*` 是它的无条件赋值），wrapper 改为加载同目录 `.env`（守卫式：真实环境变量优先，只消费三个端口变量）后导出这三个名字；(2) smoke.mjs 的 fetch + 流消费包进 try/catch，网络类失败统一退出码 2，事件计数移到 JSON.parse 成功之后。下方代码块保留初版原文供对照，**以提交 36258af + 0514a16 + 95ffa99 的实际代码为准**。

**Files:**
- Create: `services/higress-gateway/install.sh`（`chmod +x`）
- Create: `services/higress-gateway/.env.example`
- Create: `services/higress-gateway/smoke.mjs`（`chmod +x`）
- Create: `services/higress-gateway/README.md`

**Interfaces:**
- Produces: 可执行部署入口 `bash services/higress-gateway/install.sh`；冒烟 `node services/higress-gateway/smoke.mjs`（读取同目录 `.env`）。无自动化测试（真实网关是手动步骤）。

- [ ] **Step 1: install.sh**

```bash
#!/usr/bin/env bash
# Wrap the official Higress AI gateway one-click installer so the port plan
# is env-driven and reproducible from this repo. The installer starts the
# gateway (Envoy), the console, and their dependencies as Docker containers.
#
# Env (see .env.example):
#   GATEWAY_HTTP_PORT   default 8080  — the OpenAI-compatible data plane
#   GATEWAY_HTTPS_PORT  default 8443
#   CONSOLE_PORT        default 8001  — the admin console
#   HIGRESS_INSTALL_SCRIPT_URL — override to pin a different installer
set -euo pipefail

GATEWAY_HTTP_PORT="${GATEWAY_HTTP_PORT:-8080}"
GATEWAY_HTTPS_PORT="${GATEWAY_HTTPS_PORT:-8443}"
CONSOLE_PORT="${CONSOLE_PORT:-8001}"
SCRIPT_URL="${HIGRESS_INSTALL_SCRIPT_URL:-https://higress.cn/ai-gateway/install.sh}"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
curl -fsSL "$SCRIPT_URL" -o "$workdir/install.sh"

# The installer reads these as shell variables; exporting them lets our env
# win without editing the downloaded script. If a future installer stops
# honoring them, edit DEFAULT_*_PORT directly in "$workdir/install.sh".
export DEFAULT_GATEWAY_HTTP_PORT="$GATEWAY_HTTP_PORT"
export DEFAULT_GATEWAY_HTTPS_PORT="$GATEWAY_HTTPS_PORT"
export DEFAULT_CONSOLE_PORT="$CONSOLE_PORT"

echo "==> Installing Higress AI gateway (http ${GATEWAY_HTTP_PORT}, https ${GATEWAY_HTTPS_PORT}, console ${CONSOLE_PORT})"
bash "$workdir/install.sh"
```

- [ ] **Step 2: .env.example**

```sh
# Higress AI gateway deployment + DSH integration variables.
# Copy to .env and fill in. NEVER commit the real .env.

# --- gateway ports (install.sh reads these) ---
GATEWAY_HTTP_PORT=8080
GATEWAY_HTTPS_PORT=8443
CONSOLE_PORT=8001

# --- DSH side (plugins/dsh-higress) ---
# OpenAI-compatible endpoint prefix the higress provider route posts to.
HIGRESS_BASE_URL=http://127.0.0.1:8080/v1
# Consumer key issued by the gateway (key-auth); also pasteable via the web
# Models page / credentials service instead of the environment.
HIGRESS_API_KEY=

# --- upstream provider keys (entered in the console, kept here as memo) ---
DEEPSEEK_API_KEY=
DASHSCOPE_API_KEY=
```

- [ ] **Step 3: smoke.mjs**

```js
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

let text = ''
let usage = null
let events = 0
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
    events += 1
    try {
      const parsed = JSON.parse(data)
      text += parsed.choices?.[0]?.delta?.content ?? ''
      if (parsed.usage !== undefined) usage = parsed.usage
    } catch {
      // ignore keep-alive-ish payloads
    }
  }
}

if (events === 0) {
  console.error('smoke: stream produced no data events')
  process.exit(3)
}
console.log(`smoke: ok — model=${model} events=${events} text="${text.trim().slice(0, 40)}"`)
if (usage !== null) console.log(`smoke: usage=${JSON.stringify(usage)}`)
```

- [ ] **Step 4: README.md**

```markdown
# higress-gateway

Higress AI 网关的本地部署与 DSH 接入模板。配套插件：`plugins/dsh-higress`（provider 路由 `higress`）。

## 部署

```sh
cd services/higress-gateway
cp .env.example .env         # 按需改端口；先不填 key 也行
bash install.sh              # 官方一键脚本；交互式录入上游 key 可回车跳过
```

启动后：网关 `http://localhost:${GATEWAY_HTTP_PORT}`，控制台 `http://localhost:${CONSOLE_PORT}`（首次访问设置管理员密码）。

## 控制台 checklist（一次性）

1. **AI 服务提供者**：添加 DeepSeek（填 `DEEPSEEK_API_KEY`）；可选再添加 通义千问（DashScope key）。示例 modelMapping：DeepSeek 路由 `'*': 'deepseek-chat'`。
2. **AI 路由**：确认 `/v1/chat/completions` 按请求 `model` 字段路由到上一步的提供者；需要时配置模型级降级（如 qwen-turbo 兜底）。
3. **消费者**：新建消费者（如 `dsh`），启用 key-auth 认证，生成 key —— 即 DSH 侧的 `HIGRESS_API_KEY`。
4. 把 key 写进 `.env`（或 DSH 的 credentials 服务 / Models 页）。

## 冒烟

```sh
node smoke.mjs                       # 期望输出 smoke: ok — ...
SMOKE_MODEL=qwen-max node smoke.mjs  # 验证第二个上游
```

## 接入 DSH

见 `plugins/dsh-higress/README.md`：settings 命名空间 `llm-higress`，默认端点即本模板的默认端口。

## 已知边界

- Higress ai-proxy 不暴露 `/v1/models`；DSH 侧模型目录在插件 settings 静态声明（卡片每行一个模型 ID）。
- 插件 v1 仅文本请求（图片内容走 `deepseek-official` 直连路由）。
```

- [ ] **Step 5: 验证 + Commit**

Run: `bash -n services/higress-gateway/install.sh && node --check services/higress-gateway/smoke.mjs`
Expected: 无输出（语法通过）

```bash
git add services/higress-gateway
git commit -m "dsh-higress: gateway deployment template (installer wrapper, env, smoke, checklist)"
```

---

### Task 10: 插件 README + 全量校验收尾

**Files:**
- Create: `plugins/dsh-higress/README.md`

**Interfaces:**
- Consumes: 全部前序任务产物。

- [ ] **Step 1: 写 README.md**

```markdown
# dsh-higress

DSH（DeepSeek Harness）的 Higress AI 网关模型路由：把模型调用经网关的 OpenAI 兼容端点（`POST {baseURL}/chat/completions`）转发，由 Higress 负责多模型路由、上游密钥收敛、限流与 token 观测。注册独立 provider 路由 `higress`，与 `deepseek-official` 直连并存、随时切换。

网关侧部署见 `../../services/higress-gateway/`（一键脚本 + 控制台 checklist + 冒烟）。

## 安装到 dsh profile

```sh
# 在 deepseek-harness 检出目录
pnpm dsh plugin --profile web add link:/Users/wuyongjun/trea/dsh-plugin/plugins/dsh-higress
pnpm --filter dsh-higress build   # 或在 monorepo 根 pnpm build
# 重启 dsh web；修改宿主半区代码后同样需重启，浏览器半区刷新页面即可
```

## 配置（settings 命名空间 `llm-higress`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseURL` | `http://127.0.0.1:8080/v1` | 解析顺序：settings > `$HIGRESS_BASE_URL` > 默认；adapter 追加 `/chat/completions` |
| `apiKeyEnv` | `HIGRESS_API_KEY` | credential-ref；经 credentials 服务（web Models 页）或启动环境解析，每请求生效 |
| `models` | `[{ id: deepseek-chat, … }]` | advisory 模型目录；设置卡片每行一个模型 ID，未列出的 ID 不拒绝 |
| `thinking` / `reasoningEffort` | 空 | deepseek 系 thinking 透传默认值 |
| `defaultContextWindow` / `maxTokens` | 65536 / 空 | 目录外模型的上下文容量与默认输出上限 |
| `streamIdleTimeoutMs` | 300000 | 单次流读空闲看门狗 |
| `retryPolicy` | 宿主默认 | 变更后原子热更新路由注册 |

settings.yaml 示例（多上游）：

```yaml
llm-higress:
  baseURL: http://127.0.0.1:8080/v1
  apiKeyEnv: HIGRESS_API_KEY
  models:
    - id: deepseek-chat
      name: DeepSeek Chat (via Higress)
      contextWindow: 65536
    - id: qwen-max
      name: Qwen Max (via Higress)
      contextWindow: 32768
```

## 错误语义

- 无 consumer key → `MISSING_CREDENTIAL`（消息指名引用的环境变量）
- 401/403 → `AUTH`，消息附 key-auth 提示（consumer key 未在网关启用或失效）
- 429/配额 → `RATE_LIMIT` / `QUOTA_EXCEEDED`；400 上下文超限 → `CONTEXT_WINDOW_EXCEEDED`
- SSE 无 `[DONE]` 截断 → `STREAM_CLOSED`；空闲超时 → `TIMEOUT`；调用方中止 → `ABORTED`
- settings 非法快照 → 保持 last-good 并记录错误日志

## 与其他插件的交互

- dsh-openmeter：计量照常（provider 维度为 `higress`）；余额闸门在 `llm/stream` waterfall 生效，先于本 adapter。
- llm-retry：按 `retryPolicy` 重试，无需额外配置。

## v1 边界

- 仅文本请求：image block → `UNSUPPORTED_CONTENT`（走 `deepseek-official`）。
- 不注册模型发现（Higress 无 `/v1/models`）。
- 不声明 reasoning efforts 目录（显式 `reasoningEffort` 仍按请求透传）。

## 开发

```sh
pnpm --filter dsh-higress test
pnpm --filter dsh-higress typecheck
pnpm --filter dsh-higress build
```
```

- [ ] **Step 2: 全量校验**

Run（workspace 根）: `pnpm build && pnpm typecheck && pnpm test`
Expected: 全部通过（含 monorepo 既有插件）

- [ ] **Step 3: 汇报安装选项（不执行安装）**

向用户说明两条后续动作（由用户决定执行时机）：
1. `cd ~/trea/deepseek-harness && pnpm dsh plugin --profile web add link:/Users/wuyongjun/trea/dsh-plugin/plugins/dsh-higress`，重启 `dsh web`。
2. `bash services/higress-gateway/install.sh` + 控制台 checklist + `node smoke.mjs` 真机联调。

- [ ] **Step 4: Commit**

```bash
git add plugins/dsh-higress/README.md
git commit -m "dsh-higress: README (install, config, error semantics, v1 boundaries)"
```

---

## Self-Review 记录

- **Spec 覆盖**：七大节均有任务（§组件结构→T1/T8/T9；§Adapter→T3-T6；§配置→T2；§数据流与错误→T6/T7；§测试→各任务+T10 全量；§部署模板→T9；§已决定细节（env 兜底/默认目录）→T2）。
- **Spec 修订（已完成）**：v1 收窄为仅文本（宿主未导出图片归一化管线），已同步修订 spec §Adapter；计划头部 Global Constraints 与 T3/T6 的 `UNSUPPORTED_CONTENT` 固化同一事实。
- **类型一致性**：`ResolvedHigressOptions`（T2）↔ `HigressAdapterOptions`（T6）↔ apply 访问器（T7）一致；`WireChunk`/`WireUsage`/`WireError`（T3）↔ translate/adapter（T5/T6）一致；`CardFace`/`CardStore`（T8）与 card/index 组件一致；translate 的 usage 语义（`[DONE]` 时发射最后一个载荷）与 T5 测试对齐。
- **已知实现期分支点**（不阻塞，按提示就近选择）：`RetryPolicySchema` 导入可用性（T2）；`ctx.llm` 类型合并（T7 duck-typing 备选）。
