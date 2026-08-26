# dsh-higress 设计文档

日期：2026-08-26
状态：设计已获用户确认（方案 A：适配器插件），待实现

## 背景与目标

DSH（DeepSeek Harness）的模型调用目前由内置 `deepseek-official` 路由直连上游。本插件新增一条独立的 `higress` provider 路由：模型调用经 Higress AI 网关的 OpenAI 兼容端点（`POST {baseURL}/chat/completions`）转发，由 Higress 负责：

- 多模型路由与 modelMapping（DeepSeek、Qwen 等 100+ 模型统一协议）
- 上游 API key 收敛（客户端只见 Higress consumer key，key-auth 鉴权）
- 限流 / token 配额 / AI 监控面板

`deepseek-official` 直连路由保持不变，两路并存，可在 Models 页随时切换对比。

用户环境尚无 Higress 实例，因此交付物同时包含网关部署模板（`services/higress-gateway/`）。

### 不做的事（范围排除）

- DSH web 入口反向代理（casdoor-gateway 的领地，另一方向）
- 网关侧计费/配额管理（DSH 侧已有 dsh-openmeter 计量 + 余额闸门，照常工作）
- Higress console API 自动化配置（v1 用手工 checklist；后续可演进）
- `/v1/models` 模型发现（Higress ai-proxy 不暴露该接口；模型清单在 settings 静态声明）

## 选型记录（为什么是适配器插件）

| 方案 | 结论 |
| --- | --- |
| A. 独立 `higress` provider 适配器（本设计） | 走宿主标准扩展点（`registerAdapter` + `registerConfigurableProviders` + settings），双路由并存，重试/能力协商/openmeter 全兼容 |
| B. 改写 `llm-deepseek.baseURL` 指向网关 | 等价于手工改一行 settings，无插件价值，provider 维度失真，放弃 |
| C. `llm/stream` waterfall 短路自打网关 | 绕过 adapter 体系、打断其他 waterfall 插件链，宿主文档视为下策，放弃 |
| （参考）`llm-pi-ai` 自定义 profile | 宿主已有的通用 OpenAI 兼容路由能覆盖传输层，但对 `reasoning_content`→thinking 的 DeepSeek 系语义 fidelity 不可控，且无法沉淀 Higress 专属默认值/文档/部署模板，故仍自写精简 adapter |

## 架构

### 组件结构

```
plugins/dsh-higress/
  package.json        # dsh.bundle + dsh.client（web 平台），peer 依赖 cordis
  cordis.patch.yml    # 入 bundle 列表
  tsdown.config.ts    # 宿主半区构建；client 走 scripts/build-client.mjs（esbuild）
  src/
    config.ts         # schemastery schema + resolveConfig（last-good 模式）
    adapter.ts        # HigressAdapter extends LlmAdapter
    index.ts          # apply()：装配 + 注册 + settings
    types.ts
  src/client/         # 浏览器半区：设置卡片（settings.plugin.item slot，key=ns）
  tests/              # vitest 单测
  README.md

services/higress-gateway/
  install.sh          # 官方一键脚本的包装（端口/密钥走环境变量）
  .env.example        # 端口 + 上游 provider API keys + DSH 侧 HIGRESS_API_KEY
  README.md           # console 配置 checklist
  smoke.mjs           # 端到端冒烟（POST /v1/chat/completions）
```

### 宿主接缝（全部为公开 API）

- `inject: ['llm']`；`ctx.llm.registerAdapter(['higress'], adapter)` —— provider 路由名 `higress`，返回 handle 上有 `replace()`（retryPolicy 热更新用）
- `ctx.llm.registerConfigurableProviders([{ provider: 'higress', displayName: 'Higress', settingsNs: 'llm-higress', settingsPath: [] }])` —— Models 页目录条目
- `installSettingsSection(ctx, 'llm-higress', Config, entry, { setSource, onChange })` —— settings 卡片后端
- 凭据：`ctx.get('credentials')?.resolve(ref)`，无服务时 launch env 兜底（`llm-deepseek/src/index.ts:411-432` 同款）
- 参考实现：`deepseek-harness/packages/llm/llm-deepseek/src/index.ts:386-467`（装配模式）、`adapter.ts`（SSE/序列化参照）

### Adapter 设计（核心）

`HigressAdapter extends LlmAdapter`（契约见 `deepseek-harness/packages/llm/llm/src/index.ts:191-260`），**精简实现，不整体 fork DeepSeekAdapter**：

- `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`（唯一必需方法）
  - 序列化：messages（**仅文本，v1**：宿主未导出图片归一化管线，含 image block 的请求抛 `UNSUPPORTED_CONTENT` 并指引改走 `deepseek-official`）、tools、`stream: true`、thinking/reasoning 相关字段按宿主 `GenerateOptions` 语义映射为 OpenAI 请求体
  - `POST ${baseURL}/chat/completions`，`Authorization: Bearer <consumer key>`，尊重 `options.signal`
  - SSE 解析：`data:` 行 → JSON；文本增量 → text chunk；**`reasoning_content` 增量 → thinking chunk**（deepseek 系模型经网关仍返回该字段——自写 adapter 的主要理由）；tool_calls 增量聚合；`usage` 块透传（openmeter 消费，取最后一个 usage 载荷）；`[DONE]` 终止
- `listModels(provider)` / `resolveModel(provider, model)`：从 settings `models` 目录返回（advisory，未列出的 id 不拒绝）
- `providerInfo`：显示名 "Higress"
- 明确不实现：files API（Higress 不透传）、图片输入（v1 仅文本，理由见上）、匿名 user-id 头、token 用量查询端点

### 配置（settings 命名空间 `llm-higress`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseURL` | `http://127.0.0.1:8080/v1` | 网关 OpenAI 兼容端点前缀；adapter 追加 `/chat/completions` |
| `apiKeyEnv` | `HIGRESS_API_KEY` | credential-ref；Higress consumer key |
| `models` | `[{ id: 'deepseek-chat', name: 'DeepSeek Chat (via Higress)', contextWindow: 65536 }]` | 静态模型目录；README 提供 qwen 等示例 |
| `retryPolicy` | 宿主默认 | 变更时 `registration.replace(['higress'])` 原子热更新 |

每请求经 accessor 解析（settings 热改即时生效）；非法快照回退 last-good 并 `ctx.logger.error` 一次——照 `llm-deepseek` 惯例。环境变量兜底：`HIGRESS_BASE_URL`（bootstrap-only，同 `DEEPSEEK_BASE_URL` 语义）。

### 数据流与错误处理

```
agent → ctx.llm.stream(provider='higress')
      → llm/stream waterfall（openmeter 余额闸门照常生效）
      → HigressAdapter.stream
      → Higress ai-proxy（modelMapping 路由到上游）
      → SSE 回流 → StreamChunk（text / thinking / tool / usage）
```

错误映射：

- 无 consumer key → `LlmError('MISSING_CREDENTIAL')`，文案指引用户经 credentials 服务 / Models 页 / launch env 写入 `HIGRESS_API_KEY`
- 401/403 → `LlmError`，明确提示“consumer key 未在网关侧启用 key-auth 或已失效”
- 其他非 2xx → `LlmError` 附状态码与网关响应体摘要（截断）
- SSE 中途断流 / 网络错误 → 向流消费者抛错，由宿主 `llm-retry` 接管
- settings 非法 → last-good，不中断服务

### 部署模板（services/higress-gateway）

- `install.sh`：包装官方 `curl -sS https://higress.cn/ai-gateway/install.sh | bash`；支持 `GATEWAY_HTTP_PORT`（默认 8080）/ `GATEWAY_HTTPS_PORT`（8443）/ `CONSOLE_PORT`（8001）透传
- README checklist：
  1. `bash install.sh`（交互式录入上游 key，可跳过）
  2. console `http://localhost:8001` → AI 服务提供者：配 DeepSeek + Qwen（示例 `modelMapping`：`'*': 'deepseek-chat'` / qwen 路由）
  3. AI 路由管理：按 model 分流 + 可选降级（qwen-turbo 兜底）
  4. 消费者管理：建 `dsh` consumer，启用 key-auth，生成 key → 填入 DSH 侧 `HIGRESS_API_KEY`
  5. 插件卡片填 baseURL（默认即可），Models 页选 higress 路由模型
- `smoke.mjs`：读取 `.env`，POST 一条最小 chat 请求，校验 SSE 首块到达

### 测试

vitest 单测（mock fetch / 注入 SSE 分片）：

- config：resolve 优先级（settings > env > 默认）、非法值 last-good
- 序列化：messages/tools/thinking 的请求体形状
- SSE 解析：文本增量、reasoning_content→thinking、tool_calls 聚合、usage、`[DONE]`、CRLF/分片边界
- 错误映射：401/403/5xx/网络中断
- manifest：`dsh.bundle`/`dsh.client` 声明完整性（照 casdoor 的 manifest.spec 模式）

`pnpm test / typecheck / build` monorepo 全量绿；真实链路验证走 `smoke.mjs`（手动步骤，README 记录）。

## 已决定的实现细节

- `HIGRESS_BASE_URL` 环境变量兜底：v1 提供（与 `DEEPSEEK_BASE_URL` 同语义，bootstrap-only；解析优先级 settings > env > 默认）
- 默认 models 目录：仅 `deepseek-chat` 一条（qwen 等在 README/settings 示例中扩展），避免默认清单与用户网关侧实际路由不符带来的误导
