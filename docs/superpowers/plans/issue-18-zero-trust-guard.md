# Issue #18 — zero-trust 私口落地（dsh-casdoor-auth 守卫接线）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development — implement task-by-task with fresh implementer subagents, per-task spec + quality review, ≤5 fix rounds, final full-branch review.

- **Issue:** https://github.com/1123786563/dsh-plugin/issues/18
- **标题/正文错位说明（#14–#27 已知，一律以正文为准）：** 该 Issue 标题错标为「[门禁v2 06] 宿主 patch 工具链：patch 副本 + 幂等应用脚本」；patch 工具链已由 #17 交付（`scripts/host-patches/`）。本票正文实为 **zero-trust 私口落地——「直连绕过门禁」tracer 事故的最终修复**：`dsh-casdoor-auth` 把 #14 的验签能力接进 #13 的宿主守卫钩子，私口上一切未携带有效 `x-dsh-identity` 的请求一律 401。
- **Working repo:** dsh-plugin worktree `/Users/wuyongjun/trea/dsh-plugin/.worktrees/gate-v2-18`，分支 `feat/gate-v2-18-zero-trust-guard`，基于 main@`4d2f04e`。宿主仓 `/Users/wuyongjun/trea/deepseek-harness` 只读参考 + 一次性 rehearsal worktree（零残留）。
- **References:**
  - ADR-0004（宿主守卫钩子蓝图）：`plugins/dsh-casdoor-auth/docs/adr/0004-host-guard-hooks-patch.md`
  - #13 守卫钩子 API（对接面，以 patch 文件为准）：`scripts/host-patches/deepseek-harness.dsh-request-guard.patch`（`registerGuard` 单席位 / `RequestGuardDecision` 判别联合 / `principalOf` / fail-closed）
  - #14 验签能力：`plugins/dsh-casdoor-auth/src/identity.ts`（钉公钥优先、`PinMisconfigurationError` 大声失败）
  - 网关铸造格式（对齐基准）：`services/casdoor-gateway/src/identity-token.ts`（claims tenant/user/name/roles，iss=`dsh-casdoor-gateway`，aud=`dsh-casdoor-auth`，TTL 默认 60s，EdDSA/Ed25519）与 `src/config.ts` 的 `identity*` 字段
  - #17 验证过的 rehearsal 范式：`.superpowers/sdd/gate-v2-17/task-2-report.md`（宿主 detached worktree + apply.sh + `pnpm install --frozen-lockfile` + 门禁 + 零残留清理）
  - e2e 范式：`services/casdoor-gateway/scripts/e2e.mjs`（真实 casdoor@8001 密码登录取 code + 网关 30820 + stub upstream）

## 0. 关键设计裁定：浏览器 cookie 交换（launch token）的放行（必读）

**技术事实（读码确认，非推测）：**

1. dsh ≥ 0.1.2-alpha（本轨基线 `cd5ef81481` = dsh-0.1.2-alpha.1）启用 stock 浏览器认证：`dsh-client-connection` 在 `/api` 路由（`rpc-host.ts` `requestRejection`：fence 403 → `browserAuth.isAuthenticated` 401 `'unauthorized'`）与 index 请求上强制自有签名 cookie。
2. 该 cookie 由网关侧 `UpstreamAuth.exchange()`（`services/casdoor-gateway/src/upstream-auth.ts:81-120`）以 `GET /?token=<launch-token>` 直连 upstream 换取——**该请求不携带 `x-dsh-identity`**（headers 只有 host/accept）。
3. 因此「字面意义无例外」的守卫会 401 掉这次交换 → 网关永远换不到 cookie → 经网关的 `/api`/index 全部在 connection 层 401 → **Issue 验收格 3（经 3080 登录后 UI/API/WS 全部正常）在 dsh ≥ 0.1.2-alpha 上必然失败**。

**裁定（本计划采纳）：守卫放行两类凭证，其余一律 401——凭证语义，非路径白名单：**

1. `x-dsh-identity` 有效（#14 验签，钉公钥优先）→ 放行并物化 principal `{tenantId, userId, roles}`；
2. 请求查询参数 `token` 等于**当前进程 launch token**（插件已从 `connection.authenticatedUrl` 取得并发布给网关的同一个值；常量时间比较）→ 裸放行（不附 principal）——这是 stock 浏览器认证自举凭证，只服务于 `/?token=` 交换与 303 set-cookie。
3. 其余一切（缺/伪/过期 token、任意方法/路径/静态资源/WS 升级）→ 401 + 固定文案。

**威胁模型对账（为何这不是开洞）：** launch token 以 0600 写在网关 data dir（`webserver-token.json`），与网关 Ed25519 私钥同一暴露等级；CONTEXT.md「已知边界」明文接受「私钥文件同用户可读是接受的极限」。能读到它的进程本就能读 dsh 自身 credentials store 直接铸 cookie。tracer 类攻击者直连私口**不带**该 token，照旧 401——Issue 验收格 1/2 的矩阵全部照常通过。zero-trust 的实质（一切请求必须携带某一有效凭证，无路径豁免）保持不变；ADR-0004 Q6=a 反对的是**路径白名单**，不是凭证准入。

**升级路径（记录进 ADR-0006，不属本轨）：** 若 #15 轨改网关让 `UpstreamAuth` 交换请求自带网关铸造的 `x-dsh-identity`，第 2 类放行即可删除，回到单一凭证形态。此依赖已作为开放问题上报（见 planner-report）。

## 范围

`dsh-casdoor-auth` 插件内实现 zero-trust 私口守卫，并经 bundle patch 注入配置：

1. **守卫实现（`src/guard.ts` 新文件）**：工厂产出宿主 `RequestGuard` 兼容回调——
   - `service.identityFromRequest(req)` 有效 → `{ allow: true, principal: { tenantId, userId, roles } }`（principal 恰三字段，与 CONTEXT.md「请求主体」定义一致；`displayName` 不进请求主体）；
   - `PinMisconfigurationError` 等**向上抛**（不吞）：宿主 `decide()` catch → warn 日志 + 默认否决（#13 已测的 fail-closed 路径）；
   - launch token 查询参数匹配（§0 第 2 类，sha256 摘要 + `timingSafeEqual`）→ 裸放行；
   - 其余 → `{ allow: false, status: 401, body: '请走 http://127.0.0.1:3080' }`（固定常量，plain text，运维可读；upgrade 载体由宿主 destroy socket，无 101）。
2. **接线（`src/index.ts`）**：`guardEnabled` 为真时在 `ctx.inject(['webServer'])` 内注册守卫席位（`scoped.effect` 返回 disposer）；宿主 webserver 无 `registerGuard`（未打 patch 的核）→ **激活时大声抛错**并点名 `scripts/host-patches/deepseek-harness.dsh-request-guard.patch`（错配绝不静默降级）；`guardEnabled` 为假（默认）→ 不触碰席位，零行为差异。launch token 采集沿用既有 `ctx.inject(['connection'])` 块（重构为无论是否取到都记录到共享 holder，守卫闭包决策时读取，容忍 boot 顺序）。
3. **配置（`src/config.ts`）**：新增 `guardEnabled: boolean`（默认 `false`，逃生门：关 = 门禁前形态）。
4. **patch 注入（`cordis.patch.yml`）**：casdoor-auth 行新增 `guardEnabled: !!js process.env.DSH_CASDOOR_GUARD ...`（`1`/`true` 开，其余关）与 `gatewayDataDir: !!js process.env.DSH_CASDOOR_GATEWAY_DATA_DIR ?? '~/.dsh-casdoor-gateway'`（rehearsal 隔离与部署灵活性；默认不变）。
5. **文档**：ADR-0006（承载 #13 移交的 Agent Note 义务，见「#13 移交必办项」节）、README（已知边界「本机进程可直连 38080 绕过网关」一条**作废改写**、配置表、端口约定、演练手册）、`scripts/host-patches/README.md` 一行指针附注。
6. **rehearsal 演练（Task 3）**：宿主仓临时 worktree 上起隔离 dsh web 第二实例（私口 38081）+ 真实 casdoor@8001 + 网关 30820，跑直连负路径矩阵、经网关正向路径、fail-closed 与逃生门演练；宿主仓零残留。

## 非目标

- 不改宿主 patch 文件本身（`scripts/host-patches/deepseek-harness.dsh-request-guard.patch` 保持中性词汇零改动；宿主侧 `RequestGuard`/`RequestGuardDecision` 旧名不动，见 m1 说明）。
- 不改 `services/casdoor-gateway/**`（#15 轨领地；含 webmanifest 匿名转发特例的去留——开放问题上报）。
- 不做钩子②③（ApiProxy 会话过滤 #20/#22、mux 帧过滤 #24/#25）——本轨只做钩子①的消费方。
- 不执行 live web profile 更新与 dsh 实例重启（正文第 3 步列为等待用户批准的外发项，见「测试与验收命令」末节）。
- 不动 principal 的下游消费（`principalOf` 的读取者属 #20/#24）；不为 `?token=` 放行加独立开关（它是正向链路的必要组成，随 `guardEnabled` 走）。
- 不 push 任何分支。

## 任务拆分（3 任务，每任务一个 implementer、独立审查、单条 commit）

### Task 1 — 守卫实现 + 接线 + 单测（TDD 核心）

**Files:**
- Create: `plugins/dsh-casdoor-auth/src/guard.ts`（`GUARD_HINT` 常量、`WebRequestGuard`/`WebRequestGuardDecision`/`WebRequestGuardSeat` 插件本地最小类型面、`createCasdoorRequestGuard(service, launchToken)`、`applyGuard(webServer, entry, service, launchToken)` 纯函数）
- Modify: `plugins/dsh-casdoor-auth/src/index.ts`（launch token holder 重构 + guardEnabled 接线）
- Modify: `plugins/dsh-casdoor-auth/src/config.ts`（`guardEnabled` 字段 + Schema + DEFAULT_CONFIG + resolveConfig）
- Create: `plugins/dsh-casdoor-auth/tests/guard.spec.ts`
- Modify: `plugins/dsh-casdoor-auth/tests/config.spec.ts`（guardEnabled 默认假）
- Modify: `plugins/dsh-casdoor-auth/README.md`（职责新增守卫条目；「已知边界」中「本机进程可直连 38080 绕过网关」改为已由守卫关闭，指向 ADR-0006）

**命名（m1 对齐）：** 本轨新引入的守卫相关导出一律 `Web*` 前缀（`WebRequestGuard`、`WebRequestGuardDecision`、`WebRequestGuardSeat`），对齐宿主 `WebRoute`/`WebUpgradeRoute` 词汇；模块内产品语义层可用 `tenantId` 等域词。

**TDD 步骤：**
1. 先写失败测试 `tests/guard.spec.ts`（复用 `identity.spec.ts` 的 Ed25519 铸造范式：本测试文件自铸密钥对 + `staticJwks`/钉 PEM 构造 `CasdoorAuthService`）：
   - 有效 token（http 与 upgrade 两个 kind）→ `{allow:true, principal:{tenantId,userId,roles}}`，`toEqual` 恰三键（钉死无 `displayName`）；
   - 缺头/空串/数组头/垃圾 JWT/错 key 伪造/过期/错 iss/错 aud → `{allow:false, status:401, body:'请走 http://127.0.0.1:3080'}`；
   - 钉物料畸形（`PinMisconfigurationError`）→ `rejects.toThrow`（向上抛，宿主 fail-closed 兜底——ADR 引 #13 测试为外层证据）；
   - `?token=` 等于当前 launch token → 裸放行（无 principal）；错误 token/长度异形 → 401；同时携带有效 `x-dsh-identity` 与 `?token=` → principal 优先物化；
   - launchToken 为 undefined（旧核无 token）→ `?token=` 请求 401；
   - `applyGuard`：`guardEnabled:false` → 返回 undefined 且席位对象 `registerGuard` 零调用（逃生门零行为差异）；`true` + 席位在 → 注册恰一次、disposer 生效；`true` + 席位缺（未打 patch 的核）→ throw 且报错文案含 patch 文件路径。
2. 聚焦 `pnpm vitest run tests/guard.spec.ts tests/config.spec.ts` 确认 RED。
3. 实现 `guard.ts` + `config.ts` + `index.ts` 接线。
4. GREEN + `pnpm typecheck` + `pnpm build`。
5. 单 commit。

**验收命令：**
```
cd /Users/wuyongjun/trea/dsh-plugin/.worktrees/gate-v2-18/plugins/dsh-casdoor-auth
pnpm vitest run            # 全部既有 + 新增测试绿
pnpm typecheck
pnpm build
```

**Commit:** `feat(casdoor-auth): enforce zero-trust private-port guard via host guard seat`

### Task 2 — patch 层 env 注入 + ADR-0006（#13 移交 Agent Note）+ 文档对齐

**Files:**
- Modify: `plugins/dsh-casdoor-auth/cordis.patch.yml`（casdoor-auth 行加 `guardEnabled` 与 `gatewayDataDir` 两行 env 注入，沿用既有 `!!js process.env.*` 先例并加注释）
- Modify: `plugins/dsh-casdoor-auth/tests/manifest.spec.ts`（断言新 env 行存在）
- Create: `plugins/dsh-casdoor-auth/docs/adr/0006-zero-trust-private-port-guard.md`
- Modify: `scripts/host-patches/README.md`（「重放」节末加一行指针：钩子语义与消费方见 ADR-0006——满足 #13「patch 应用侧需 Agent Note 说明宿主钩子语义」的最小落点）
- Modify: `plugins/dsh-casdoor-auth/README.md`（配置表加 `guardEnabled`（env `DSH_CASDOOR_GUARD`）与 `gatewayDataDir`（env `DSH_CASDOOR_GATEWAY_DATA_DIR`）；端口约定补 38081 演练用法；「已知边界」补 webmanifest 经网关匿名 401 的说明）

**ADR-0006 必含（承载 #13 移交两项硬性必办）：**
1. **宿主钩子语义**（Agent Note 本体）：`registerGuard` 单席位（二次注册 throw）、守卫先于一切路由（HTTP `handle()` 顶部 / upgrade 查表前）、决策判别联合与 veto 默认 401 `'Unauthorized'`、守卫抛错/reject = warn + 默认否决（fail-closed）、`principalOf` 以请求对象为键的 WeakMap、upgrade 否决 destroy socket 无 101、未配置守卫 = 宿主行为与 upstream 完全一致；
2. **patch 溯源与升级循环**：分支 `dsh-request-guard`（tip `1bd06a979…`，基线 `cd5ef814…`）、副本与 `apply.sh` 幂等语义、宿主升级 = fetch+rebase+重导出（引用 scripts/host-patches/README 状态表）；
3. **本轨设计裁定**：§0 的 launch-token 交换放行（含威胁模型对账与 #15 升级路径）、固定 401 文案、逃生门语义、principal 三字段对齐；
4. **m1 定名记录**：#18 起新命名走 `Web*` 前缀；宿主 patch 内旧名 `RequestGuard`/`RequestGuardDecision` 因 #13 W1 链内钉死保持不动，重命名留待 upstream PR 一并裁定（避免二次 API 改名）。

**TDD 步骤：** manifest.spec.ts 先加断言（RED）→ 改 cordis.patch.yml（GREEN）→ ADR/README 文档 → 单 commit。

**验收命令：**
```
cd /Users/wuyongjun/trea/dsh-plugin/.worktrees/gate-v2-18/plugins/dsh-casdoor-auth
pnpm vitest run
pnpm typecheck && pnpm build
```

**Commit:** `feat(casdoor-auth): inject guard env via bundle patch and record ADR-0006`

### Task 3 — rehearsal e2e：直连负路径矩阵 + 经网关正向 + fail-closed + 逃生门

**Files:**
- Create: `plugins/dsh-casdoor-auth/scripts/zero-trust-drill.mjs`（node ≥22 直跑，无新依赖；范式对齐 `services/casdoor-gateway/scripts/e2e.mjs`：✅/❌ 记录 + 退出码）
- Modify: `plugins/dsh-casdoor-auth/README.md`（「演练手册」节：前置 docker casdoor、宿主 rehearsal worktree 搭建/清理全命令、drill 用法）

**drill 脚本职责（全部对隔离实例，进程自起自清）：**
- 前置校验：casdoor@8001 可达（不可达则打印 compose 命令退出非零）；参数/环境给出 rehearsal worktree 路径。
- 起网关：`node services/casdoor-gateway/lib/server.js`，env `GATEWAY_PORT=30820`、`GATEWAY_PUBLIC_URL=http://127.0.0.1:30820`、`DSH_UPSTREAM_URL=http://127.0.0.1:38081`、`GATEWAY_DATA_DIR=$RT/gw-data`、`GATEWAY_IDENTITY_TTL_SEC=5`（压缩 fail-closed 演练等待）、casdoor 凭据默认同 e2e.mjs（`dsh-gateway`/`change-me-64-hex`）→ 等 `/healthz`。
- 起 dsh 第二实例：在 rehearsal worktree 内 `pnpm dsh web`，env `DSH_HOME=$RT/dsh-home`（profile 全隔离）、`DSH_CASDOOR_DSH_PORT=38081`、`DSH_CASDOOR_GUARD=1`、`DSH_CASDOOR_IDENTITY_PUBLIC_KEY=$(cat $RT/gw-data/identity_ed25519.pub.pem)`（钉公钥优先路径）、`DSH_CASDOOR_GATEWAY_JWKS_URL=http://127.0.0.1:30820/.well-known/jwks.json`、`DSH_CASDOOR_GATEWAY_DATA_DIR=$RT/gw-data`、禁开浏览器（`--no-open` 或等价 flag，实现时以 `pnpm dsh web --help` 为准）→ 等 38081 应答（401 即存活）。
- **负路径矩阵（直连 38081，全部断言 401 + body 逐字 `请走 http://127.0.0.1:3080` + `content-type: text/plain`）：** `GET /`、`GET /manifest.webmanifest`、`GET /favicon.svg`、任一 `GET /assets/*.js`、`GET /plugins/<id>/client.js`、`POST /api/session.list`、`HEAD /`、`OPTIONS /api/session.list`、`PUT /anything`、`DELETE /api/session.export`、`GET /export/...`（session.export GET 旁路代表路径）、未注册路径 `GET /no/such/route`；**WS 直连**（node:net 原始 socket `GET /api/events.mux` + Upgrade 头，无 token 与伪 token 两臂）→ 无 `101` 且连接被拆；**自铸攻击 token**（读 `$RT/gw-data/identity_ed25519.pem` 私钥）：伪造（错 key）、过期（exp -10s）、错 iss、错 aud → 401。
- **正向路径（经 30820）：** `casdoorLoginAndGetCode` 范式登录 `acme/alice`（`alice-Acme1`）→ `GET /` 200（真实 index，含 tapIndex watcher 注入痕迹）→ 任一 JS 资产 200 → `POST /api/session.list` 非 401/403 → WS 升级（带 `dsh_sid` cookie + 标准 websocket 头）得 `101`；记录项（不断言失败）：`GET /manifest.webmanifest` 经网关匿名转发 → 私口守卫 401（预期行为，见开放问题）。
- **fail-closed 演练：** 自铸短 TTL（5s）合法 token T0 → 直连 `GET /?token` 场景外任一路径带 T0 → 放行可观察（非守卫 401 文案）；SIGTERM 网关 → 等 6s（过 TTL）→ T0 重放 → 401；直连矩阵复跑仍全 401；30820 连接拒绝。重启网关 → 正向路径恢复（登录态 cookie 仍在 SQLite，网关重启不掉线）。
- **逃生门演练：** SIGTERM dsh 实例 → 以同 env 但去掉 `DSH_CASDOOR_GUARD` 重启 → 直连 `GET /` 不再是守卫 401（回到门禁前形态：index 交换/303 或 connection 行为）；恢复 `DSH_CASDOOR_GUARD=1` 重启 → 401 回归。
- 清理：杀网关/dsh 子进程、`rm -rf $RT`（dsh-home/gw-data 全在其中）。

**rehearsal 环境搭建（宿主仓，#17 范式，实现者执行、报告留证）：**
```
# 0. 前置：casdoor（dsh-plugin 根 compose）
cd /Users/wuyongjun/trea/dsh-plugin && docker compose up -d casdoor postgres

# 1. 宿主 rehearsal worktree（只读基线 + patch，不 commit）
git -C /Users/wuyongjun/trea/deepseek-harness worktree add --detach \
  .worktrees/patch-rehearsal-g18 cd5ef8148158c3a752a658978873241fdf8e2bbc
bash /Users/wuyongjun/trea/dsh-plugin/.worktrees/gate-v2-18/scripts/host-patches/apply.sh \
  --repo /Users/wuyongjun/trea/deepseek-harness/.worktrees/patch-rehearsal-g18
cd /Users/wuyongjun/trea/deepseek-harness/.worktrees/patch-rehearsal-g18
pnpm install --frozen-lockfile
pnpm run build:web          # 前端 dist（web-runtime 回退席位所需）

# 2. 插件与 multi-tenant 构建后 link 进隔离 profile
cd /Users/wuyongjun/trea/dsh-plugin/.worktrees/gate-v2-18 && pnpm install
pnpm --filter dsh-casdoor-auth build
pnpm --filter dsh-multi-tenant... build   # 或 cd plugins/dsh-multi-tenant/packages/multi-tenant && pnpm build
RT=$(mktemp -d /tmp/zero-trust-g18-XXXX)
DSH_HOME=$RT/dsh-home pnpm -C /Users/wuyongjun/trea/deepseek-harness/.worktrees/patch-rehearsal-g18 dsh \
  plugin --profile web add link:/Users/wuyongjun/trea/dsh-plugin/.worktrees/gate-v2-18/plugins/dsh-casdoor-auth
DSH_HOME=$RT/dsh-home pnpm -C /Users/wuyongjun/trea/deepseek-harness/.worktrees/patch-rehearsal-g18 dsh \
  plugin --profile web add link:/Users/wuyongjun/trea/dsh-plugin/.worktrees/gate-v2-18/plugins/dsh-multi-tenant/packages/multi-tenant

# 3. drill（脚本自起网关+dsh、自清理）
node plugins/dsh-casdoor-auth/scripts/zero-trust-drill.mjs \
  --host-worktree /Users/wuyongjun/trea/deepseek-harness/.worktrees/patch-rehearsal-g18 \
  --rt $RT
```

**rehearsal 清理（零残留核验）：**
```
rm -rf $RT
git -C /Users/wuyongjun/trea/deepseek-harness/.worktrees/patch-rehearsal-g18 status --porcelain  # 仅 patch 5 文件 M 或已还原
git -C /Users/wuyongjun/trea/deepseek-harness/.worktrees/patch-rehearsal-g18 checkout -- .
git -C /Users/wuyongjun/trea/deepseek-harness worktree remove --force .worktrees/patch-rehearsal-g18
git -C /Users/wuyongjun/trea/deepseek-harness worktree list   # 回到演练前状态
```

**验收命令（Task 3 汇总）：** drill 输出 `ALL PASS` 且 exit 0；宿主 `worktree list` 与演练前一致；`lsof -nP -iTCP:38081 -iTCP:30820 -sTCP:LISTEN` 为空；live 3080 进程 PID 未变。

**Commit:** `test(casdoor-auth): add zero-trust rehearsal drill (negative matrix, fail-closed, escape hatch)`

## 测试与验收命令（Issue 验收格对账）

| Issue 验收格 | 覆盖 |
| --- | --- |
| curl 直连 38080 任意路径/方法 → 401（含提示文案） | Task 1 单测（决策函数）+ Task 3 负路径矩阵（真服务器，38081） |
| 直连 WS 升级被拒；伪造/过期 x-dsh-identity → 401 | Task 1 单测 + Task 3 原始 socket 无 101 + 自铸伪/过期 token 臂 |
| 经 3080 登录后 UI/API/WS 全部正常（含静态资源） | Task 3 正向路径（30820 演练口：登录→index 200→资产 200→/api 非 401→WS 101） |
| 停网关 → 私口全 401（fail-closed）；恢复后自动可用 | Task 3 fail-closed 相（SIGTERM 网关 + TTL 过期重放 401 + 重启恢复） |
| 守卫开关关闭时回到门禁前形态 | Task 1 单测（席位零注册）+ Task 3 逃生门相（重启无 DSH_CASDOOR_GUARD） |
| （#13 移交）Agent Note + m1 定名 | Task 2 ADR-0006 + `Web*` 前缀命名 |

日常门禁：`cd plugins/dsh-casdoor-auth && pnpm vitest run && pnpm typecheck && pnpm build`（vitest 套件保持无 docker、无密钥、可离线复跑；drill 是独立的真链路脚本，不进 `pnpm test`）。

**等待用户批准的外发项（本轮不执行）：** live web profile 更新（`~/.dsh/profiles/web` 安装/刷新 `link:` 插件、配 `DSH_CASDOOR_GUARD=1` 等 env）+ dsh web 实例重启 + 网关/casdoor 常驻编排。live 实例（PID 93312/93329，监听 3080）是本自动化会话自身运行时，**严禁本轮触碰**；且当前 live web profile 并未安装 casdoor-auth（无网关在跑），真正上线是一套完整编排（装插件→起网关→占 3080→dsh 挪 38080），须用户在场批准后另行走查。

## 全局约束

1. **词汇分层**：守卫是插件内产品语义层——`tenantId`/`userId`/`roles`/casdoor 等域词可用；宿主 patch 文件与宿主仓任何改动保持中性词汇零改动（本轨宿主仓只读 + 一次性 worktree，不 commit 不 push）。
2. **principal 精确对齐**：`{tenantId, userId, roles}` 三字段恰与网关 `identity-token.ts` 铸造 claims（`tenant`/`user`/`roles`）一一对应（经 `IdentityVerifier` 的 CasdoorIdentity 映射）；`displayName` 不进请求主体（CONTEXT.md 定义）；单测 `toEqual` 钉死键集。
3. **iss/aud 来源**：插件 config `issuer`/`audience`（默认 `dsh-casdoor-gateway`/`dsh-casdoor-auth`），与网关 `DEFAULT_IDENTITY_ISSUER`/`DEFAULT_IDENTITY_AUDIENCE` 默认值一致；两处 env（`GATEWAY_IDENTITY_ISSUER`/`GATEWAY_IDENTITY_AUDIENCE` vs 插件 config）如被分别改写须保持相等——ADR-0006 记录该耦合，drill 用默认值验证真实对齐。
4. **默认零行为差异**：`guardEnabled=false`（默认）时插件行为与门禁前逐字节一致——既有测试全绿零改动；宿主未配置守卫时行为不变（#13 已验收，引用不重测）。
5. **fail-closed 语义**：守卫开 = 无有效凭证一律 401；验签异常向上抛由宿主否决；钉物料畸形大声失败绝不静默降级（#14 语义保持）。
6. **401 文案固定**：`请走 http://127.0.0.1:3080`，plain text（宿主 veto 写 `text/plain; charset=utf-8`），不做成配置。
7. **演练端口隔离**：私口 38081（`DSH_CASDOOR_DSH_PORT`）、网关 30820、casdoor 8001、`DSH_HOME` 临时目录——一切与 live 3080/`~/.dsh` 物理隔离；live 实例不动。
8. **不 push**：分支 `feat/gate-v2-18-zero-trust-guard` 本地提交，不 push 不开 PR。
9. **与 #15 零文件重叠**：只改 `plugins/dsh-casdoor-auth/**` 与 `scripts/host-patches/README.md`（一行附注）+ 本计划文档；不碰 `services/casdoor-gateway/**`；发现网关侧确需改动 → 开放问题上报。
10. **宿主仓零残留**：rehearsal worktree 用后即删；宿主仓对象库只经 `--shared` 式只读引用（`worktree add` 本身不改基线分支）。
11. **SDD 纪律**：RED 先行、逐任务 spec+质量审查、台账记录；implementer 不得自行派生 subagent。

## #13 移交必办项落实（对照 `.superpowers/sdd/host-guard-13/final-review.md` §6/§7）

| 移交项 | 本计划落点 |
| --- | --- |
| Agent Note 必补（§6「Agent Note（README 之外）」：#18 提 PR 前必须补，说明宿主钩子语义；brief 指明先查确切所指——已查：quality-review I1 + final-review §6 第 5 行，指 patch 交付物随真 PR 需补的钩子语义决策记录，落点即 patch 应用侧文档） | Task 2 ADR-0006 §1（钩子语义）+ §2（patch 溯源/升级循环）+ `scripts/host-patches/README.md` 一行指针 |
| m1 定名（#18 起对齐宿主 `Web*` 前缀；#13 旧名因 W1 钉死不动） | Task 1 命名规范（`WebRequestGuard` 等）+ ADR-0006 §4 记录：宿主侧重命名留待 upstream PR 一并裁定 |
| patch 工具链本体 | 已由 #17 交付，本轨直接消费（apply.sh + patch 副本） |

## 风险与开放问题（详见 planner-report）

1. **launch-token 交换放行**（§0）——本计划最重要的裁定，需 captain 复核；替代方案（网关侧带身份交换）属 #15。
2. **webmanifest 经网关 401**：网关匿名转发特例（`isCredentiallessAsset`）+ 守卫 = manifest 永远 401（PWA 元数据失效，UI 不受影响）；取消该特例属 `services/casdoor-gateway`（#15）——开放问题上报。
3. drill 依赖 docker casdoor 与 8001/30820/38081 端口空闲；casdoor 首启种子数据需存在（init_data.json 已含 `dsh-gateway`/`change-me-64-hex` 与 alice/dsh-admin 账号）。
4. `pnpm dsh web` 在 rehearsal worktree 从源起（tsx），需 `build:web` 产物；若 boot 报缺 `DEEPSEEK_API_KEY`（不预期——webserver 启动不调模型），从主检出 `.env` 复制该变量即可。
