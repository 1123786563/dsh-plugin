# dsh-casdoor-gateway — Casdoor 认证网关

挡在 DeepSeek Harness（DSH）之前的独立 Node 服务：**所有**到达 dsh 的 HTTP 与 WebSocket 流量先过这里——OIDC 登录（授权码 + PKCE）、服务端登录会话（HttpOnly cookie + SQLite）、特权 `/api` 方法角色门禁、逐请求铸造 DshIdentityToken，然后转发给 loopback 私口上的 dsh webserver。配套 dsh 侧插件 [plugins/dsh-casdoor-auth](../../plugins/dsh-casdoor-auth)。

## 部署（compose 正式形态）

网关是根 compose 的 `casdoor-gateway` 服务（见根 `docker-compose.yml`）：

```bash
cp .env.example .env                        # 填 CASDOOR_CLIENT_SECRET（与 init_data.json 一致；gitignored）
docker compose up -d casdoor-gateway        # 仓库根；自动带起 casdoor + postgres
```

- **凭据**经 `env_file: ./services/casdoor-gateway/.env` 透传——该文件 gitignored 且被 `.dockerignore` 排除，绝不进 git/镜像层；监听面由服务 `environment` 覆盖为容器内 `0.0.0.0:3080`，宿主侧映射默认 `127.0.0.1:3080:3080`（正式形态）。
- **端口参数化**：宿主 3080 被占用时（本机已有 live 实例即是）成对覆盖 `GATEWAY_HOST_PORT` 与 `GATEWAY_PUBLIC_URL`（redirect URI 必须与映射端口一致；种子授权 3080 与 3099 两个端口）：

  ```bash
  GATEWAY_HOST_PORT=3099 GATEWAY_PUBLIC_URL=http://127.0.0.1:3099 docker compose up -d casdoor-gateway
  curl -sSI http://127.0.0.1:3099/login | grep -i '^location'   # 期望以 http://127.0.0.1:8001/login/oauth/authorize 开头
  ```

- **upstream**：容器经 `DSH_UPSTREAM_URL=http://host.docker.internal:38080` 回连宿主私口上的 dsh webserver（dsh 本体不容器化）。`host.docker.internal` 由 Docker Desktop 自带；Linux 原生 Docker 需为本服务补 `extra_hosts: ["host.docker.internal:host-gateway"]`（compose 默认不带，Linux 部署时自行追加）。
- **持久化**：会话 SQLite 与 Ed25519 签名密钥对存 `casdoor-gateway-data` 卷（容器内 `/data`）——容器重建/重启不换钥，`/.well-known/jwks.json` 的 `kid` 前后一致，登录会话不丢。
- **issuer 内外分离**：浏览器可见的 authorize/redirect/logout 与 ID-token `iss` 校验一律走外部 `CASDOOR_ISSUER`（宿主位 `http://127.0.0.1:8001`）；网关自身发起的 discovery/token 兑换/JWKS 拉取走 `CASDOOR_INTERNAL_ISSUER=http://casdoor:8000`（compose 网络服务名，IdP 流量不出网）。casdoor 的 discovery 文档由 `docker/app.ini` 的 `origin` 钉死在外部形式，网关在使用点把 `token_endpoint`/`jwks_uri` 的 origin 替换为内部基址。**尾斜杠坑**：所有 issuer 比较先过 `new URL(x).href` 归一化（casdoor 的 `iss` 无尾斜杠、`URL.href` 有）——两侧配置错值会被启动时 fail-loud 的 iss 断言拦下。内部发现基址的启动日志证据：

  ```bash
  docker logs dsh-casdoor-gateway 2>&1 | grep -o 'discovery via [^)]*'
  ```

停止（数据卷保留，绝不 `down -v` 除非明确要清种子）：

```bash
docker compose stop casdoor-gateway
```

## 开发模式（pnpm dev）

不经容器直跑源码——改代码快速重启的场景；对外部署一律用上面的 compose 形态。

```bash
# 1. casdoor（官方镜像；固定版本用 CASDOOR_IMAGE=casbin/casdoor:vX.Y.Z）
docker compose up -d casdoor              # 仓库根目录（统一 compose，见根 README）；首启读取 init_data.json 种子；宿主端口 8001

# 2. 网关（源码直跑）
cp .env.example .env                        # 填 CASDOOR_CLIENT_SECRET（与 init_data.json 一致）
pnpm install && pnpm dev                    # 监听 127.0.0.1:3080

# 3. dsh（bundle patch 会把 webserver 挪到 127.0.0.1:38080，见插件 README）
cd <deepseek-harness> && pnpm dsh web
```

打开 `http://127.0.0.1:3080` → 302 到 casdoor → 登录后回到 DSH。

## 端口与拓扑

| 组件 | 地址 | 说明 |
| --- | --- | --- |
| 网关（公口） | `127.0.0.1:3080`（compose 映射；`GATEWAY_HOST_PORT` 可改） | 唯一入口；生产置 `GATEWAY_HOST=0.0.0.0` 并置于 TLS 之后 |
| dsh webserver（私口） | `127.0.0.1:38080` | 由 dsh-casdoor-auth 的 bundle patch 设置；永不直接暴露；容器网关经 `host.docker.internal` 回连宿主 |
| casdoor（外部位） | `127.0.0.1:8001` | compose 映射到容器内 8000（宿主 8000 常被占用，本机即有别的服务监听）；只绑定 loopback；浏览器与 `iss` 校验都用它 |
| casdoor（内部基址） | `http://casdoor:8000`（仅容器内网关） | 网关自身 discovery/token/JWKS 走它（`CASDOOR_INTERNAL_ISSUER`）；宿主直跑时留空即可 |

## 请求行为

| 表面 | 未登录 | 已登录 |
| --- | --- | --- |
| 浏览器导航（Accept 含 text/html） | 302 → `/login` → casdoor authorize | 转发（注入 `x-dsh-identity`） |
| `/api/*`（fetch/XHR） | 401 JSON | 转发；SPA 内置 watcher 把过期 401 变为跳转 |
| WebSocket 升级（`/api/events.*`） | 401 拒绝升级 | 双向 pipe 转发 |
| 特权方法（15 个，见下） | 401 | 非特权角色 403；特权角色转发 |
| `*.webmanifest`（与一切静态资产同） | 401（fetch）/ 302 → `/login`（导航） | 转发（注入 `x-dsh-identity`） |

网关自答路径（不验会话，也绝不转发）：`/healthz`、`/.well-known/jwks.json`、`/login`、`/casdoor/callback`、`/logout`；其余一切请求（含 `*.webmanifest`）必过会话门禁，转发时逐请求铸造身份令牌。

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

首启空库时种子：组织 `acme`、`globex`、`dsh-ops`（平台管理员）；用户 `acme/alice`、`globex/bob`、`dsh-ops/dsh-admin`；应用 `dsh-gateway`（owner=admin、`isShared` 跨组织共享——这是"单应用多组织"的关键，redirect URI `http://127.0.0.1:3080/casdoor/callback` 与 `http://127.0.0.1:3099/casdoor/callback`，JWT/RS256）。重新种子需 `docker compose down -v`。改 `clientSecret` 时同步 `init_data.json` 与网关 env。多组织登录用 `组织/用户名` 形式。

> **角色挂法（casdoor 姿势）**：用户角色必须挂在 **role 侧的 `users` 数组**（`"users": ["dsh-ops/dsh-admin"]`）才会进 JWT——写在用户 JSON 的 `roles` 字段里不会生效（运行时不读）。另外两个实测要点：共享应用的 ID token `aud` 是 `<clientId>-org-<组织>`（网关已按此校验）；`iss` 无尾斜杠（网关已归一化）。

## e2e

两种模式（casdoor 都来自根 compose，`127.0.0.1:8001`；38080 无 dsh 时自动起 stub 上游）：

```bash
# 宿主模式：脚本自行 spawn lib/server.js（先 pnpm build）；默认 3099——种子授权的
# redirect 端口（3080/3099），E2E_GATEWAY_PORT 可覆盖
node scripts/e2e.mjs

# 外部模式：全链路打已运行的网关（不 spawn、不 kill、不动数据目录），
# 配 E2E_RESTART_CMD 时追加重启持久性两断言（同 cookie 仍可用 + JWKS kid 不变）
E2E_GATEWAY_URL=http://127.0.0.1:3099 \
E2E_RESTART_CMD='docker compose --project-directory <仓库根> restart casdoor-gateway' \
CASDOOR_CLIENT_SECRET=change-me-64-hex \
  node services/casdoor-gateway/scripts/e2e.mjs
```

`E2E_GATEWAY_URL` 与 `E2E_GATEWAY_PORT` 同设时 URL 优先生效、PORT 被忽略——PORT 仅作用于宿主 spawn 模式。`E2E_UPSTREAM_URL` 覆盖上游地址（默认 `http://127.0.0.1:38080`，stub 上游同样改绑该端口）——设成一个空闲临时端口（如 38091）即可让 e2e 完全不碰 live 私口 38080。

覆盖：未登录 302/401 → API 登录取码（casdoor `/api/login?oauth参数`，无需浏览器）→ 回调建会话 → 代理命中上游 → manifest 门禁（未登录 401 JSON / 已登录转发 200）→ WS 升级（未登录 401 / 已登录 101）→ 特权 403 → 重启持久性（仅外部模式）→ 登出 → admin 放行。

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
