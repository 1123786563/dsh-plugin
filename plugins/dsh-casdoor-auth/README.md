# dsh-casdoor-auth — DSH 的 Casdoor 登录门禁插件

把 [casdoor](https://github.com/casdoor/casdoor) 登录接到 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）：**所有到达 dsh 的请求必经 casdoor 认证，未登录跳转登录页，满足 SaaS 多租户**。

本插件是两件套的 dsh 侧一半，与独立网关服务 [services/casdoor-gateway](../../services/casdoor-gateway) 配套使用：

```
浏览器 ──► casdoor-gateway :3080 ──转发──► dsh webserver 127.0.0.1:38080（私口）
              │  OIDC 授权码+PKCE → casdoor :8001
              │  登录会话(HttpOnly cookie + SQLite) / 特权方法角色门禁
              └─ 每请求铸造 DshIdentityToken(Ed25519 JWT) → 本插件验签 → ctx.casdoorAuth
                                                    → 装配 dsh-multi-tenant（Agent 层租户隔离）
```

## 职责

- **`ctx.casdoorAuth`**：验证网关转发的 DshIdentityToken（JWKS 验签、iss/aud/算法校验），物化 `{tenantId, userId, displayName, roles}`；
- **zero-trust 私口守卫**（`guardEnabled`，默认关）：认领宿主 webserver 唯一守卫席位（`registerGuard`），私口上一切 HTTP/WS 升级请求必须携带有效凭证（DshIdentityToken 或 launch-token 自举凭证），否则一律 401 固定文案——无路径白名单，裁定见 [ADR-0006](./docs/adr/0006-zero-trust-private-port-guard.md)；
- **401 登出监视器**：通过 `webServer.tapIndex` 注入极小脚本进 SPA shell——登录会话中途过期时，首个同源 401 自动跳 `/login`（无 client 半区依赖，覆盖一切插件的 fetch）；
- **dsh-multi-tenant 装配**：以已验证身份为其 `identity` 接缝供 TenantPrincipal，挂载 `/_dsh-multi-tenant` Web 桥（identity / agents/create / agents/resume），MCP 服务器与 Principal 凭据从插件配置读取（v1：静态，见配置）。

## 安装（与网关配套）

```bash
# 1. 起 casdoor（首启种子数据：orgs acme/globex、用户、dsh-gateway 应用）
cd services/casdoor-gateway/docker && docker compose up -d

# 2. 起网关（.env 参考 ../.env.example，clientSecret 与 init_data.json 一致）
cd services/casdoor-gateway && pnpm dev

# 3. 安装插件与 multi-tenant 到 dsh web profile
cd <deepseek-harness 检出>
pnpm dsh plugin --profile web add link:/Users/wuyongjun/trea/dsh-plugin/plugins/dsh-casdoor-auth
pnpm dsh plugin --profile web add link:/Users/wuyongjun/trea/dsh-plugin/plugins/dsh-multi-tenant/packages/multi-tenant
pnpm dsh web        # webserver 已被 bundle patch 挪到 127.0.0.1:38080

# 4. 浏览器访问 http://127.0.0.1:3080/login?org=acme（多组织入口：/login?org=<casdoor组织名>；不带 org 走应用默认组织）
```

种子账号：`acme/alice`（密码 `alice-Acme1`）、`globex/bob`（`bob-Globex1`）、`dsh-ops/dsh-admin`（`dsh-Admin1`，特权角色 `dsh-admin`）。

## 配置

设置卡（Settings → Plugins → casdoor-auth）或 profile 补丁均可覆盖；环境变量默认值由 bundle patch 注入：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `gatewayJwksUrl` | `http://127.0.0.1:3080/.well-known/jwks.json` | 网关 JWKS（公钥公开） |
| `identityPublicKey` | `''`（env `DSH_CASDOOR_IDENTITY_PUBLIC_KEY`） | 钉住的网关 Ed25519 公钥（PEM SPKI 或 JSON JWK 字符串）；非空时本地验签、不拉 JWKS（网关离线也可验），空则回退 JWKS。畸形物料在激活时大声失败，绝不静默降级 |
| `identityHeader` | `x-dsh-identity` | DshIdentityToken 携带头 |
| `issuer` / `audience` | `dsh-casdoor-gateway` / `dsh-casdoor-auth` | 令牌校验目标 |
| `basePath` | `/_dsh-multi-tenant` | Web 桥挂载路径 |
| `mcpServers` / `mcpServersByTenant` | `[]` / `{}` | 租户 MCP 服务器（stdio/streamable-http），per-tenant 覆盖全局 |
| `credentials` | `{}` | Principal 静态凭据（name→secret），MCP 凭据绑定解析用 |
| `gatewayDataDir` | `~/.dsh-casdoor-gateway`（env `DSH_CASDOOR_GATEWAY_DATA_DIR`） | 网关数据目录：插件把本进程 webserver launch token 以 0600 写入其中（`webserver-token.json`），网关 UpstreamAuth 读取它铸造 dsh 浏览器认证 cookie |
| `guardEnabled` | `false`（env `DSH_CASDOOR_GUARD`，`1`/`true` 开、其余关） | zero-trust 私口守卫开关（逃生门：默认关＝门禁前行为零差异）；开则认领宿主唯一守卫席位，无有效 DshIdentityToken / launch token 的一切 HTTP/WS 请求 401 固定文案，宿主需已应用 dsh-request-guard patch（缺失则激活大声失败），语义与裁定见 [ADR-0006](./docs/adr/0006-zero-trust-private-port-guard.md) |

端口约定：网关公口 `3080`、dsh 私口 `38080`（`DSH_CASDOOR_DSH_PORT` 可改，需同步网关 `DSH_UPSTREAM_URL` 与插件 `DSH_CASDOOR_GATEWAY_JWKS_URL`）、casdoor `8001`；演练（rehearsal drill）另以 `DSH_CASDOOR_DSH_PORT=38081` 起隔离私口的第二实例，不占用正式 `38080`。

## 已知边界

- **stock Web UI 无租户隔离**（上游 [issue #41](https://github.com/GuoMonth/dsh-multi-tenant/issues/41)）：登录后是共享工作区；租户隔离发生在 Agent 层（会话归属 claim-once + Principal 绑定）。
- 本机进程直连 `38080` 绕过网关的旁路已由 zero-trust 私口守卫关闭（开启 `guardEnabled` 后，无有效凭证的直连一律 401；逃生门与裁定见 [ADR-0006](./docs/adr/0006-zero-trust-private-port-guard.md)）。
- `manifest.webmanifest` 经网关匿名转发会被守卫 401：PWA 安装元数据失效，UI 不受影响（浏览器按规范拉取 manifest 不带 cookie，即使登录态亦然）；取消网关侧匿名转发特例属 #19 正文领地（开放问题）。
- 特权方法（settings/credentials/agentPreset 等 15 个）在网关层要求 casdoor 角色 `dsh-admin`。

## 文档

- 领域术语表：[CONTEXT.md](./CONTEXT.md)
- 架构决策：[docs/adr/0001](./docs/adr/0001-standalone-gateway-form.md)（独立网关形态）、[0002](./docs/adr/0002-gateway-signed-identity-jwt.md)（JWT 身份传递与特权门禁）、[0003](./docs/adr/0003-fastify-openid-client-stack.md)（网关技术栈与请求体缓冲）、[0006](./docs/adr/0006-zero-trust-private-port-guard.md)（zero-trust 私口守卫：钩子语义、准入裁定与定名）

## 开发

```bash
pnpm build      # tsc -b && tsdown（jose 打包进产物；cordis/schemastery/dsh-multi-tenant 外部化）
pnpm test       # vitest：身份验签矩阵 / 配置与 MCP 映射 / watcher 注入 / 清单
pnpm typecheck
```
