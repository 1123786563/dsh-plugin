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

- 无 consumer key → `MISSING_CREDENTIAL`（消息指名引用的环境变量）；key 已提供但为空白/含非法字符 → `INVALID_CREDENTIAL`
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
