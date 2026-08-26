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
