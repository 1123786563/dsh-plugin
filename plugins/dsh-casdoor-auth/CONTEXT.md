# CONTEXT — dsh-casdoor-auth（DSH ↔ Casdoor 登录门禁插件）

本文件是 dsh-casdoor-auth 插件的领域术语表（glossary），只记术语与业务规则，不记实现细节。

## 术语

### 登录会话 (Login Session)
浏览器 HttpOnly cookie（`dsh_sid`）指向的、网关侧 SQLite 持久化的一条已认证记录。生命周期由绝对 TTL 决定；网关重启不掉线。与下面两个"会话"严格区分。

### DSH Agent 会话 (Agent Session)
dsh 宿主中一次对话/代理运行的会话实体。在租户体系里，它的归属由**会话归属**决定；stock Web UI 直接创建的会话自动认领给当前请求主体（#23，见"已知边界"）。

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

### 请求主体 (Request Principal)
请求作用域的 {tenantId, userId, roles}，由**请求守卫**从 DshIdentityToken 物化并附加到请求上下文。是 multi-tenant Principal 的超集（多出 roles，供特权豁免判定）。

### 请求守卫 (Request Guard)
dsh 私口 webserver 层的每请求（含 WS 升级）认证关卡：验 `x-dsh-identity`，无有效 token 一律拒绝——zero-trust，无路径白名单，静态资源也不例外。宿主只提供通用钩子，校验实现由本插件提供；未配置钩子时宿主行为不变（upstream 兼容）。网关不在 = 私口不可用（fail-closed）。

### 特权方法 (Privileged Method)
宿主钉死 loopback 的 15 个 `/api` RPC 方法（settings/credentials/agentPreset/host 桌面操作等）。经由网关转发等效放行，故网关镜像该清单并要求 casdoor 管理员角色（默认 `dsh-admin`）才放行，其余已登录用户 403。

### 特权角色 (Admin Role)
casdoor 中持有特权方法放行权的角色名集合（默认 `dsh-admin`，env 可配）。持有者同时豁免**会话可见性**过滤（可见、可开、可订阅全部会话）。

### 会话可见性 (Session Visibility)
已认证主体能列出、打开、订阅的 Agent 会话范围 = 自己的（按**会话归属**判定）；特权角色豁免时为全量。未知或无主会话对非豁免主体一律拒绝（fail-closed）。stock UI 新建/复制的会话自动认领给当前请求主体。

### mux 帧过滤 (Mux Frame Filter)
events.mux / events.host 下行流按连接的请求主体过滤：只推送其会话可见性范围内的帧——订阅基线、实时事件、新增会话帧一律先判定归属再入队。

### JIT 开通 (Just-In-Time Provisioning)
新用户首次登录即自动获得其租户的 Agent 会话认领资格，无需管理员预建。会话归属的 claim-once 语义天然幂等支持。

## 业务规则

- 未登录：浏览器导航 302 跳登录；`/api` 401 JSON；WebSocket 升级 401 拒绝。
- 白名单路径（不验会话）：`/healthz`、`/.well-known/jwks.json`、`/login`、`/casdoor/callback`、`/logout`。
- 登出：清 cookie + 删登录会话 + 302 casdoor RP-initiated logout（可用 `GATEWAY_IDP_LOGOUT=false` 关闭）。
- returnTo 只接受站内相对路径，其余一律回 `/`（防开放重定向）。
- **zero-trust 私口**：dsh 私口上的一切请求（含静态资源与 WS 升级）必须携带有效 `x-dsh-identity`；本机进程直连私口同样被拒。网关宕机则私口整体不可用。

## 已知边界

- stock UI 会话可见性过滤依赖宿主本地 patch 钩子（见 ADR-0005）；上游原生 request-scoped Principal 落地后 patch 应移除。
- 持有与用户同权限的恶意进程（可读网关私钥、注入进程）不在防御范围——私钥文件同用户可读是接受的极限。
- 登录会话存储为网关单机 SQLite；多副本 HA 与集中式会话留 v2。
