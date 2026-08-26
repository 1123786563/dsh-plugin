# CONTEXT — dsh-casdoor-auth（DSH ↔ Casdoor 登录门禁插件）

本文件是 dsh-casdoor-auth 插件的领域术语表（glossary），只记术语与业务规则，不记实现细节。

## 术语

### 登录会话 (Login Session)
浏览器 HttpOnly cookie（`dsh_sid`）指向的、网关侧 SQLite 持久化的一条已认证记录。生命周期由绝对 TTL 决定；网关重启不掉线。与下面两个"会话"严格区分。

### DSH Agent 会话 (Agent Session)
dsh 宿主中一次对话/代理运行的会话实体。在租户体系里，它的归属由**会话归属**决定；stock Web UI 直接创建的会话当前不参与租户归属（见"已知边界"）。

### 会话归属 (Session Ownership)
`dsh-multi-tenant` 的 SQLite `session_owners` 表：Agent 会话 ID → {tenantId, userId}，claim-once 不可变。首次认领即锁定；他人 resume 同一会话返回 403。

### 网关 (Gateway)
独立 Node 服务 `dsh-casdoor-gateway`，持有公口，是唯一入口：OIDC 登录、登录会话校验、特权方法角色门禁、HTTP/WebSocket 转发到 loopback 私口上的 dsh webserver。dsh 永远只监听 `127.0.0.1`。

### DshIdentityToken
网关每请求铸造的短期 Ed25519 JWT（claims：tenant/user/name/roles，iss=`dsh-casdoor-gateway`，aud=`dsh-casdoor-auth`，TTL 默认 60 秒），经 `x-dsh-identity` 头转发，dsh 侧插件用网关公开 JWKS 验签后物化身份。刻意**不叫 "ID token"**——那是 casdoor OIDC id_token 的既有术语。

### Tenant（租户）
计费/隔离的顶级单位，映射 casdoor 的 **Organization**（org 名即 tenantId）。单 Application 多组织：用户以 `组织/用户名` 或邮箱登录同一应用，token 的 org claim 定租户。

### Principal（主体）
{tenantId, userId} 二元组，`dsh-multi-tenant` 的最小身份单元。userId 取 casdoor 的 `sub`。

### 特权方法 (Privileged Method)
宿主钉死 loopback 的 15 个 `/api` RPC 方法（settings/credentials/agentPreset/host 桌面操作等）。经由网关转发等效放行，故网关镜像该清单并要求 casdoor 管理员角色（默认 `dsh-admin`）才放行，其余已登录用户 403。

### 特权角色 (Admin Role)
casdoor 中持有特权方法放行权的角色名集合（默认 `dsh-admin`，env 可配）。

### JIT 开通 (Just-In-Time Provisioning)
新用户首次登录即自动获得其租户的 Agent 会话认领资格，无需管理员预建。会话归属的 claim-once 语义天然幂等支持。

## 业务规则

- 未登录：浏览器导航 302 跳登录；`/api` 401 JSON；WebSocket 升级 401 拒绝。
- 白名单路径（不验会话）：`/healthz`、`/.well-known/jwks.json`、`/login`、`/casdoor/callback`、`/logout`。
- 登出：清 cookie + 删登录会话 + 302 casdoor RP-initiated logout（可用 `GATEWAY_IDP_LOGOUT=false` 关闭）。
- returnTo 只接受站内相对路径，其余一律回 `/`（防开放重定向）。

## 已知边界

- stock DSH Web UI 无租户隔离（上游 issue #41）：网关决定"谁能进"，租户隔离只发生在 Agent 层（dsh-multi-tenant 的会话归属与 Principal 绑定）。
- 本机进程可直连私口（如 38080）绕过网关——loopback 内信任，接受并记录。
- 登录会话存储为网关单机 SQLite；多副本 HA 与集中式会话留 v2。
