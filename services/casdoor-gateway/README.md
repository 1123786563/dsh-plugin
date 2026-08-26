# dsh-casdoor-gateway — Casdoor 认证网关

挡在 DeepSeek Harness（DSH）之前的独立 Node 服务：**所有**到达 dsh 的 HTTP 与 WebSocket 流量先过这里——OIDC 登录（授权码 + PKCE）、服务端登录会话（HttpOnly cookie + SQLite）、特权 `/api` 方法角色门禁、逐请求铸造 DshIdentityToken，然后转发给 loopback 私口上的 dsh webserver。配套 dsh 侧插件 [plugins/dsh-casdoor-auth](../../plugins/dsh-casdoor-auth)。

## 快速开始（开发拓扑）

```bash
# 1. casdoor（官方镜像；固定版本用 CASDOOR_IMAGE=casbin/casdoor:vX.Y.Z）
docker compose up -d casdoor              # 仓库根目录（统一 compose，见根 README）；首启读取 init_data.json 种子；宿主端口 8001

# 2. 网关
cp .env.example .env                        # 填 CASDOOR_CLIENT_SECRET（与 init_data.json 一致）
pnpm install && pnpm dev                    # 监听 127.0.0.1:3080

# 3. dsh（bundle patch 会把 webserver 挪到 127.0.0.1:38080，见插件 README）
cd <deepseek-harness> && pnpm dsh web
```

打开 `http://127.0.0.1:3080` → 302 到 casdoor → 登录后回到 DSH。

## 端口与拓扑

| 组件 | 地址 | 说明 |
| --- | --- | --- |
| 网关（公口） | `127.0.0.1:3080` | 唯一入口；生产置 `GATEWAY_HOST=0.0.0.0` 并置于 TLS 之后 |
| dsh webserver（私口） | `127.0.0.1:38080` | 由 dsh-casdoor-auth 的 bundle patch 设置；永不直接暴露 |
| casdoor | `127.0.0.1:8001` | compose 映射到容器内 8000（宿主 8000 常被占用，本机即有别的服务监听）；只绑定 loopback |

## 请求行为

| 表面 | 未登录 | 已登录 |
| --- | --- | --- |
| 浏览器导航（Accept 含 text/html） | 302 → `/login` → casdoor authorize | 转发（注入 `x-dsh-identity`） |
| `/api/*`（fetch/XHR） | 401 JSON | 转发；SPA 内置 watcher 把过期 401 变为跳转 |
| WebSocket 升级（`/api/events.*`） | 401 拒绝升级 | 双向 pipe 转发 |
| 特权方法（15 个，见下） | 401 | 非特权角色 403；特权角色转发 |
| `*.webmanifest` | 转发（浏览器按规范不带 cookie 拉取 manifest，公开描述符免鉴权） | 转发 |

白名单（不验会话）：`/healthz`、`/.well-known/jwks.json`、`/login`、`/casdoor/callback`、`/logout`、`*.webmanifest`。

## 多组织（租户）登录入口

casdoor 共享应用的授权页**不提供组织选择**；组织通过共享应用 clientId 后缀绑定。网关暴露：

```
/login               → 应用默认组织（built-in）
/login?org=acme      → 绑定 casdoor 组织 acme（clientId 变为 dsh-gateway-org-acme）
/login?org=globex    → 绑定 globex
```

SaaS 场景给每个租户分发带 `org` 参数的入口 URL（或由你的租户识别层 302 过来）。

转发时改写 `Host`/`Origin` 为私口 authority（满足 dsh 的 DNS-rebinding fence），剥离登录 cookie，附 DshIdentityToken。

## 配置（环境变量）

全部变量、默认值与说明见 [.env.example](./.env.example)。要点：

- `CASDOOR_CLIENT_ID` / `CASDOOR_CLIENT_SECRET`：必填，对应 casdoor 应用 `dsh-gateway`；
- `CASDOOR_ORGANIZATION_CLAIM` / `CASDOOR_ROLES_CLAIM`：租户与角色 claim 名（默认 `organization` / `roles`，缺失时回退 userinfo）；
- `GATEWAY_ADMIN_ROLES`：特权方法放行角色（默认 `dsh-admin`）；
- `GATEWAY_PRIVILEGED_METHODS`：镜像自宿主 PRIVILEGED 清单（`src/config.ts` 的 `DEFAULT_PRIVILEGED_METHODS`），宿主升级时需人工同步；
- `GATEWAY_IDP_LOGOUT=false`：登出只清本侧会话，不动 casdoor 会话；
- 数据目录（默认 `~/.dsh-casdoor-gateway/`）：`sessions.sqlite` + Ed25519 签名密钥对（`identity_ed25519*.pem`，删除即轮换——旧令牌 60s 内自然过期）。

## casdoor 初始化（docker/init_data.json）

首启空库时种子：组织 `acme`、`globex`、`dsh-ops`（平台管理员）；用户 `acme/alice`、`globex/bob`、`dsh-ops/dsh-admin`；应用 `dsh-gateway`（owner=admin、`isShared` 跨组织共享——这是"单应用多组织"的关键，redirect URI `http://127.0.0.1:3080/casdoor/callback`，JWT/RS256）。重新种子需 `docker compose down -v`。改 `clientSecret` 时同步 `init_data.json` 与网关 env。多组织登录用 `组织/用户名` 形式。

> **角色挂法（casdoor 姿势）**：用户角色必须挂在 **role 侧的 `users` 数组**（`"users": ["dsh-ops/dsh-admin"]`）才会进 JWT——写在用户 JSON 的 `roles` 字段里不会生效（运行时不读）。另外两个实测要点：共享应用的 ID token `aud` 是 `<clientId>-org-<组织>`（网关已按此校验）；`iss` 无尾斜杠（网关已归一化）。

## e2e

```bash
node scripts/e2e.mjs    # 需 docker casdoor 在跑；38080 无 dsh 时自动起 stub 上游
```

九步覆盖：未登录 302/401 → API 登录取码（casdoor `/api/login?oauth参数`，无需浏览器）→ 回调建会话 → 代理命中上游 → 特权 403 → 登出 → admin 放行。

> init_data 的字段以 casdoor 实际版本为准做过一次校对；若某版本行为不符，在 casdoor UI 中核对应用配置即可（种子只影响首启）。

## 内存注意（ADR-0003）

fastify 的请求体处理是**先完整缓冲**再进 handler——网关每个并发请求最多驻留一份请求体副本，`bodyLimit` 因此设为 320 MiB（覆盖 dsh 的 300 MiB 附件信封）。高并发大附件场景请评估内存预算，或等待 v2 的 raw-server 流式转发演进。

## 开发

```bash
pnpm dev         # tsx 直跑 src/server.ts
pnpm build       # tsc → lib/
pnpm test        # vitest：会话/令牌/门禁矩阵/代理集成（含 WS 升级、keep-alive 帧回归）
node scripts/e2e.mjs   # 手动 e2e：需 docker casdoor 在跑（见脚本头部说明）
```
