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
| `controlPage` | `true` | 是否在 `basePath` 提供网桥控制页（身份/准入状态页） |
| `mcpServers` / `mcpServersByTenant` | `[]` / `{}` | 租户 MCP 服务器（stdio/streamable-http），per-tenant 覆盖全局 |
| `credentials` | `{}` | Principal 静态凭据（name→secret），MCP 凭据绑定解析用 |
| `gatewayDataDir` | `~/.dsh-casdoor-gateway`（env `DSH_CASDOOR_GATEWAY_DATA_DIR`） | 网关数据目录：插件把本进程 webserver launch token 以 0600 写入其中（`webserver-token.json`），网关 UpstreamAuth 读取它铸造 dsh 浏览器认证 cookie |
| `guardEnabled` | `false`（env `DSH_CASDOOR_GUARD`，`1`/`true` 开、其余关） | zero-trust 私口守卫开关（逃生门：默认关＝门禁前行为零差异）；开则认领宿主唯一守卫席位，无有效 DshIdentityToken / launch token 的一切 HTTP/WS 请求 401 固定文案，宿主需已应用 dsh-request-guard patch（缺失则激活大声失败），语义与裁定见 [ADR-0006](./docs/adr/0006-zero-trust-private-port-guard.md) |
| `adminRoles` | `['dsh-admin']` | 会话可见性豁免角色名列表：请求主体 roles 与之有交集则列表不过滤、任意会话（含无主存量）可开；与网关 `GATEWAY_ADMIN_ROLES` 保持同步，语义见 [ADR-0005](./docs/adr/0005-tenant-scoped-session-visibility.md) |

`guardEnabled` 开启时，插件同时认领宿主 sessionController 的唯一 sessionFilter 座位并装上**会话可见性过滤**（ADR-0005）：会话列表/搜索只保留当前请求主体自己认领的会话，一切带 sessionId 的方法（history/prompt/fork/export/cancel 等）先过归属准入，未知/无主/跨租户/同租户跨用户一律 403 fail-closed，`adminRoles` 命中者全量豁免——前端零改动。宿主核心若只有守卫座而无 sessionFilter 座（旧版 patch），过滤静默不生效：请重新应用当前版 `scripts/host-patches/deepseek-harness.dsh-request-guard.patch`。

端口约定：网关公口 `3080`、dsh 私口 `38080`（`DSH_CASDOOR_DSH_PORT` 可改，值经 `Number()` 强转：空串视同未设回落 `38080`，非数值得 `NaN` 由 webserver schema 大声拒绝；改口需同步网关 `DSH_UPSTREAM_URL` 与插件 `DSH_CASDOOR_GATEWAY_JWKS_URL`）、casdoor `8001`；演练（rehearsal drill）另起隔离私口 `38081` 的第二实例，不占用正式 `38080`（全流程见[演练手册](#演练手册zero-trust-私口守卫-rehearsal-drill)）。

## 演练手册（zero-trust 私口守卫 rehearsal drill）

[`scripts/zero-trust-drill.mjs`](./scripts/zero-trust-drill.mjs) 对**隔离实例**复演守卫全行为：直连负路径矩阵（12 条 HTTP 路径/方法全 401 固定文案、WS 直连无 101 被拆、自铸攻击 token 四臂）、经网关正向五步（真实 casdoor 登录 / index / JS 资产 / RPC / WS 101）与 manifest 门禁双臂（未登录 → 网关自身 401 JSON、已登录 → 铸造转发 200）、fail-closed（短 TTL token 随网关死亡失效、矩阵复跑、重启后会话不掉线）、逃生门三步。脚本自起网关与 dsh 子进程、用后自清；全程只碰 `38081`/`30820`/`8001`，不触碰宿主 3080 live 实例与 `38080` 正式私口。

### 前置

```bash
# 本 worktree 内构建网关（drill 以 node 直跑 services/casdoor-gateway/lib/server.js，只读复用）
pnpm --filter dsh-casdoor-gateway build

# 主仓起 casdoor（幂等；种子数据：acme/alice 等）
cd /Users/wuyongjun/trea/dsh-plugin && docker compose up -d casdoor postgres
```

### 搭建宿主 rehearsal worktree（只读基线 + patch，不 commit）

宿主核心需带守卫席位（ADR-0004 的 dsh-request-guard patch）。以变量代路径：`HOST_REPO`＝宿主 deepseek-harness 检出，`PLUGIN_WT`＝本 worktree：

```bash
HOST_REPO=/Users/wuyongjun/trea/deepseek-harness
PLUGIN_WT=/Users/wuyongjun/trea/dsh-plugin/.worktrees/port-num-41

# 1. detached 基线 worktree + 应用守卫 patch（5 文件改动，留在工作区不 commit）
git -C "$HOST_REPO" worktree add --detach .worktrees/patch-rehearsal-g18 cd5ef8148158c3a752a658978873241fdf8e2bbc
bash "$PLUGIN_WT/scripts/host-patches/apply.sh" --repo "$HOST_REPO/.worktrees/patch-rehearsal-g18"
cd "$HOST_REPO/.worktrees/patch-rehearsal-g18"
pnpm install --frozen-lockfile
pnpm run build        # 全量构建：web profile 启动需要全部 client bundle（仅 build:web 会在 boot 报 MissingClientBundleError）

# 2. 构建插件并 link 进隔离 profile（DSH_HOME 在 $RT 内；与正式 ~/.dsh 完全隔离）
cd "$PLUGIN_WT" && pnpm install
pnpm --filter dsh-casdoor-auth build
# dsh-multi-tenant 是嵌套 pnpm workspace，其包对根过滤器不可见，须在其内安装并构建
pnpm -C plugins/dsh-multi-tenant install
pnpm -C plugins/dsh-multi-tenant build
RT=$(mktemp -d /tmp/zero-trust-g18-XXXX)
DSH_HOME=$RT/dsh-home pnpm -C "$HOST_REPO/.worktrees/patch-rehearsal-g18" dsh \
  plugin --profile web add link:$PLUGIN_WT/plugins/dsh-casdoor-auth
DSH_HOME=$RT/dsh-home pnpm -C "$HOST_REPO/.worktrees/patch-rehearsal-g18" dsh \
  plugin --profile web add link:$PLUGIN_WT/plugins/dsh-multi-tenant/packages/multi-tenant
```

### 运行 drill

```bash
cd "$PLUGIN_WT"
node plugins/dsh-casdoor-auth/scripts/zero-trust-drill.mjs \
  --host-worktree "$HOST_REPO/.worktrees/patch-rehearsal-g18" \
  --rt "$RT"
```

- `--rt` **必须**与上面 link 插件时的 `$RT` 同一目录（隔离 web profile 落在 `$RT/dsh-home`，脚本不重建它）。
- drill 自起网关（`GATEWAY_IDENTITY_TTL_SEC=5` 压缩 fail-closed 等待）与 dsh 第二实例（`pnpm dsh web --no-open`，`DSH_CASDOOR_GUARD=1` + 钉公钥），结束自动杀尽子进程并 `rm -rf $RT`。
- 私口 38081 经 `DSH_CASDOOR_DSH_PORT` 环境通道注入（`cordis.patch.yml` 已作 `Number()` 强转，env 字符串端口不再被 webserver schema 拒绝）；drill 不写 profile 用户 patch 层，隔离与清理契约不变。
- 退出码 0 且末行 `ALL PASS`＝全部通过；任一步骤失败输出逐项 `❌` 并退出非零。manifest 门禁为双臂断言：未登录 → 网关自身 401 JSON（不再匿名转发），已登录 → 铸造转发 200（见「已知边界」）。

### 清理（宿主零残留核验）

drill 已自清子进程与 `$RT`；宿主侧还剩 rehearsal worktree 本体：

```bash
rm -rf "$RT"   # 幂等，drill 正常结束时已不存在
git -C "$HOST_REPO/.worktrees/patch-rehearsal-g18" status --porcelain   # patch 的 5 个文件 M，另有运行期写入的 ?? .dsh-multi-tenant/（隔离实例经 cwd 落在宿主 worktree，非 $RT；worktree remove --force 已覆盖其清除）
git -C "$HOST_REPO/.worktrees/patch-rehearsal-g18" checkout -- .
git -C "$HOST_REPO" worktree remove --force .worktrees/patch-rehearsal-g18
git -C "$HOST_REPO" worktree list   # 回到演练前状态（main + dsh-request-guard 两项）
```

中断恢复：SIGINT/SIGTERM 下 drill 自装处理器（逆序杀子进程组、删 `$RT`、exit 130/143），正常中断即零残留；唯 SIGKILL 等不可捕获信号会留下孤儿网关（30820）与 dsh（38081）并泄漏 `$RT`——重跑时 drill 会对两端口预检并大声报「上次中断残留」。此时按下述恢复：

```bash
lsof -nP -iTCP:38081 -iTCP:30820 -sTCP:LISTEN   # 应为空；有孤儿则对所列 PID 逐一 kill -TERM（pnpm 外壳若残留，pgrep -fl 'dsh web' 找到后同样清除）
rm -rf "$RT"   # 泄漏时才存在；重跑前按「搭建」step 2 重新 link
```

## 已知边界

- **stock Web UI 无租户隔离**（上游 [issue #41](https://github.com/GuoMonth/dsh-multi-tenant/issues/41)）：登录后是共享工作区；租户隔离发生在 Agent 层（会话归属 claim-once + Principal 绑定）。
- 本机进程直连 `38080` 绕过网关的旁路已由 zero-trust 私口守卫关闭（开启 `guardEnabled` 后，无有效凭证的直连一律 401；逃生门与裁定见 [ADR-0006](./docs/adr/0006-zero-trust-private-port-guard.md)）。
- `manifest.webmanifest` 与其他静态资产同权，网关匿名转发特例已随 #19 移除：未登录 → 网关自身 401 JSON（登录前 PWA 安装元数据不可得，UI 不受影响）；已登录 → 正常铸造转发 200。按 HTML Standard [Link type "manifest"](https://html.spec.whatwg.org/multipage/links.html#link-type-manifest)，无 `crossorigin` 属性的 manifest link credentials mode 为 "same-origin"（同源登录态会带 cookie），登录后臂即浏览器的真实路径。
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
