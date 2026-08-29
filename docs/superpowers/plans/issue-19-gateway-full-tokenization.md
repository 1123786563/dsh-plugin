# Issue #19 — 网关全量 token 化（credentialless 白名单移除）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development — implement task-by-task with fresh implementer subagents, per-task spec + quality review, ≤5 fix rounds, final full-branch review.

- **Issue:** https://github.com/1123786563/dsh-plugin/issues/19
- **标题/正文错位说明（#14–#27 已知，一律以正文为准）：** 该 Issue 标题错标为「[门禁v2 07] zero-trust 私口落地：插件守卫接线 + 直连全拒（tracer）」；守卫已由 #18 交付并合入 main。本票正文实为 **网关侧全量 token 化**：移除网关唯一残留的 credentialless 转发特例（`*.webmanifest` 匿名转发、token 为空串），使**一切转发请求**都经登录会话校验并逐请求铸造 `x-dsh-identity`。#18 的 zero-trust 私口守卫已在线，manifest 匿名转发当前会被私口 401（PWA 元数据失效）；本票把该请求改回正常铸造转发，同时兑现「网关无匿名转发路径」。
- **Working repo:** dsh-plugin worktree `/Users/wuyongjun/trea/dsh-plugin/.worktrees/gateway-tokenization-19`，分支 `feat/gate-v2-19-gateway-full-tokenization`，基于 main@`4c97956`（planner 已核：worktree HEAD = main = 4c97956，工作树干净）。
- **References:**
  - ADR-0004（守卫蓝图，其第 11 行已预定本票：「网关侧 `*.webmanifest` 匿名转发随之取消，一切请求带 token」）：`plugins/dsh-casdoor-auth/docs/adr/0004-host-guard-hooks-patch.md`
  - ADR-0006（zero-trust 私口守卫；launch-token 放行裁定）：`plugins/dsh-casdoor-auth/docs/adr/0006-zero-trust-private-port-guard.md`
  - #18 实施计划（演练范式与端口约定）：`docs/superpowers/plans/issue-18-zero-trust-guard.md`
  - #41 终审移交：`services/casdoor-gateway/src/gate.ts:24-26` 与 `plugins/dsh-casdoor-auth/scripts/zero-trust-drill.mjs:675-682` 两处「manifest 按规范不带 cookie」错误前提，归本票修正。

## 意图（一段话）

网关的转发面（`app.all('/*')`）今天对 `*.webmanifest` 保留一条匿名转发捷径：无登录会话也 hijack 直转私口、`x-dsh-identity` 为空串（`server.ts:166-172`）。#18 私口守卫上线后该请求被守卫 401，成为网关唯一「带不齐凭证」的转发路径。本票删除这条特例，让 manifest 与一切静态资产一样走「登录会话校验 → `issuer.mint` 逐请求铸造 → 转发注入」；未登录 manifest 得到与其它 fetch 相同的 401 JSON（浏览器 manifest link 无 `crossorigin` 时 credentials mode 为 same-origin，登录态本就带 cookie——#41 已在 `plugins/dsh-casdoor-auth/README.md:140` 改正过这一规范表述）。验收 = 经网关（登录态）manifest 200 且携带可验签的 `x-dsh-identity`；代码与测试双重确认网关不再存在任何匿名转发路径。

## 现行代码事实（planner 亲查 worktree @4c97956，实施者可直接引用）

1. **credentialless 白名单（本票唯一代码改动面）**：`services/casdoor-gateway/src/gate.ts:28-30` `isCredentiallessAsset(pathname)`（`pathname.endsWith('.webmanifest')`）；其上 `gate.ts:24-26` 注释断言「web-app manifest fetch omits cookies by spec」——**前提错误**（HTML Standard：无 `crossorigin` 的 manifest link credentials mode 为 "same-origin"，同源登录态带 cookie），属 #41 终审移交的 stale 注释。
2. **唯一消费点（匿名转发路径本体）**：`services/casdoor-gateway/src/server.ts:166-172` —— `session === undefined` 时 `if (isCredentiallessAsset(url.pathname)) { reply.hijack(); proxyHttpRequest(req.raw, reply.raw, target, '', undefined, deps.auth); return }`：**空串 token**、`body` 为 undefined、不经 `issuer.mint`。`server.ts:24` import `isCredentiallessAsset`。
3. **对照：正常铸造转发路径**：`server.ts:187` `const token = await issuer.mint(session, identityOptions)` → `server.ts:190` `proxyHttpRequest(..., token, body, deps.auth)`；WS 升级同构（`proxy.ts:146-205` `installUpgradeProxy`，`deps.mint` 铸造后经 `upstreamHeaders` 注入）。`proxy.ts:56` `out[target.identityHeader] = identityToken` 是唯一注入点——空串 token 也会写头，但守卫验签必拒。
4. **白名单测试面**：`services/casdoor-gateway/tests/gate.spec.ts:39-46` `describe('credentialless assets', ...)`（:5 import 成员）——随行为一起删除。`tests/app.spec.ts` **尚无** manifest 用例；其录制上游 stub（`app.spec.ts:49-62`）只对 `/`、`/api/session.list`、`/api/settings.describe` 回 200，其余 404——新增 manifest 用例需给 stub 补 `/manifest.webmanifest` → 200。
5. **文档面**：`services/casdoor-gateway/README.md:71`（请求行为表 `*.webmanifest` 行：「转发（浏览器按规范不带 cookie 拉取 manifest，公开描述符免鉴权）」）与 `:73`（「白名单（不验会话）：… `*.webmanifest`」）。
6. **移交的 drill stale 块**：`plugins/dsh-casdoor-auth/scripts/zero-trust-drill.mjs:675-682` —— 注释重申错误前提，且以 `note()`（只记录不断言）观察「未登录 manifest 经网关匿名转发 → 私口守卫 401（开放问题）」。drill 用隔离端口 38081（私口）/30820（网关），负路径矩阵 `:480` 已含直连 `GET /manifest.webmanifest` → 401 断言（本票后依然成立，不动）。已登录 client（acme/alice）在 `:605` 建立。
7. **不是匿名转发的相邻路径（勿误伤）**：auth-plane 五路径（`gate.ts:11-17` `/healthz` `/.well-known/jwks.json` `/login` `/casdoor/callback` `/logout`）由网关**自答**、不转发，保留；`UpstreamAuth.exchange()`（`services/casdoor-gateway/src/upstream-auth.ts:81-120`，`:92` `GET /?token=`）是网关**自发起**的浏览器认证自举交换（launch token 凭证放行，ADR-0006 裁定），不是转发请求，不属本票。
8. **上游确有该资产**：宿主 web 应用静态面服务 `manifest.webmanifest`（`packages/host/frontend-static/src/index.ts:46` MIME 映射 + `apps/web/index.html` 引用）——drill 演练（真实 dsh）与 e2e（stub 上游）中 manifest 都可 200。
9. **验收命令基面**：网关包 `pnpm test` = `vitest run`（无 docker、离线可跑）；`pnpm typecheck`、`pnpm build`（tsc → `lib/`，drill/e2e 都 spawn `lib/server.js`，跑前必须 build）。e2e：`node scripts/e2e.mjs`（需 docker casdoor@8001；host 模式 spawn 网关于 `E2E_GATEWAY_PORT`（默认 3099），38080 无 dsh 时自动起 stub 上游——**UPSTREAM 硬编码 38080**（`e2e.mjs:37`），与「live 38080 禁触」约束相抵，见 Task 2 的 `E2E_UPSTREAM_URL` 处置）。drill：`node plugins/dsh-casdoor-auth/scripts/zero-trust-drill.mjs --host-worktree … --rt /tmp/zero-trust-g19-…`（全套 rehearsal 搭建见插件 README「演练手册」）。

## 关键设计裁定

1. **移除，不做「空配置」**：issue 给「移除（或收窄为空配置）」两选。选**移除**——恒空的可配置白名单是死配置面（本仓规约：不做投机 tunable；misconfiguration fails loud 的前提是配置有意义）。约束「不留任何匿名转发路径」也只有移除能被代码级证明。见 OQ-1。
2. **未登录 manifest 落入通用 401 臂，不加新特例**：manifest fetch 非导航（Accept 无 text/html），自然走 `wantsHtml === false` → 401 JSON `{error:'unauthenticated'}`。不为它新增任何分支——「无特例」正是本票的语义。
3. **auth-plane 白名单与 credentialless 白名单是两回事**：前者网关自答（保留），后者是免会话**转发**（删除）。README `:73` 把两者混列一张「白名单」清单——改后该行只剩五自答路径，表述同步拆清。
4. **「有效 x-dsh-identity」的证明等级**：单测用录制上游捕获转发头，`jwtVerify(token, createLocalJWKSet(issuer.jwks()))` 全验签（iss/aud/EdDSA，范式即 `tests/identity-token.spec.ts:23-27`）；drill 走真链路（守卫实际验签放行 = 有效性最终证明）；e2e 证状态码。
5. **双重确认「无匿名转发路径残留」**：代码侧——`isCredentiallessAsset` 删除后 `server.ts` 仅剩 `:190` 一个 `proxyHttpRequest` 调用点，token 恒来自 `issuer.mint`；`rg -n 'isCredentiallessAsset|credentialless' services/` 零命中作为任务内核验步。测试侧——未登录 manifest 断言 `upstreamSeen` 零增长（从未到达上游）。

## 范围

`services/casdoor-gateway`（代码 + 单测 + e2e + README）与两处 #41 终审移交修正：

1. 删除 `isCredentiallessAsset` 及其消费分支（gate.ts / server.ts），manifest 并入会话门禁 + 铸造转发。
2. 网关单测：gate.spec 删除 credentialless 块；app.spec 新增 manifest 门禁/铸造矩阵（录制上游 + jwtVerify 验签）。
3. 网关 e2e：manifest 两臂（未登录 401 / 已登录 200）+ 上游端口可参数化（`E2E_UPSTREAM_URL`）以避开 live 38080。
4. drill 移交修正：`:675-682` stale 前提改写 + 开放问题转正（未登录 401 断言 / 已登录 200 断言）。
5. README 对齐：网关 README 请求行为表与白名单行；插件 README「已知边界」manifest 条（OQ-2）。

## 非目标

- 不动 live 3080/38080（网关公口与 dsh 私口的常驻实例）：不部署、不重启、不打流量；一切测试用临时/演练端口（38081/30820/3099 或 `E2E_UPSTREAM_URL` 指定口）。
- 不动宿主仓 `/Users/wuyongjun/trea/deepseek-harness`（只读参考；drill rehearsal worktree 按插件 README 既有流程另建，用后即删）。
- 不改前端/SPA（manifest link 由宿主 web 应用自带，credentials mode same-origin 已满足；无 frontend 改动）。
- 不做 #21 重启自愈演练、live 3080 运维编排、compose/Dockerfile 变更（白名单无配置面，容器无需动）。
- 不改 `UpstreamAuth` 的 `/?token=` 交换（ADR-0006 记录的升级路径——网关自举凭证，非转发；另轨裁定）。
- 不动插件守卫/验签行为、auth-plane 五路径、WS 升级路径（已恒铸造）。
- 不 push 任何分支。

## 任务拆分（3 任务，每任务独立实现 + 独立审查 + 单条 commit；Task 1 → {Task 2, Task 3}）

### Task 1 — 移除 credentialless 白名单 + 单测矩阵（TDD 核心）

**Files:**
- Modify: `services/casdoor-gateway/src/gate.ts`（删除 `:23-30`：`isCredentiallessAsset` 函数及其错误前提注释）
- Modify: `services/casdoor-gateway/src/server.ts`（`:24` import 去掉 `isCredentiallessAsset`；删除 `:166-172` 匿名转发分支，含 `:167` 注释）
- Modify: `services/casdoor-gateway/tests/gate.spec.ts`（删 `:5` import 成员与 `:39-46` describe 块——过时行为随其测试一起退役）
- Modify: `services/casdoor-gateway/tests/app.spec.ts`（stub 上游 `:54` 的 200 路径清单补 `'/manifest.webmanifest'`；新增两用例，见矩阵）
- Modify: `services/casdoor-gateway/README.md`（`:71` 表行改为与普通资产一致：未登录 401（fetch）/302（导航）、已登录 转发+注入；`:73` 白名单行删 `*.webmanifest` 并拆明「网关自答，不转发」语义）

**TDD 步骤（RED 先行）：**
1. 先写 app.spec.ts 两用例（对当前代码必红）：
   - **未登录 manifest 走通用门禁、绝不触达上游**：记录 `upstreamSeen.length`，`fetch(gatewayOrigin + '/manifest.webmanifest')`（默认 fetch 头，无 text/html）→ 断言 401 + `{error:'unauthenticated'}` + `upstreamSeen` 零增长；再以 `accept: text/html` 导航式请求 → 302 `/login?returnTo=%2Fmanifest.webmanifest`。**RED 现状**：当前匿名转发命中 stub 的 404（status 404 ≠ 401/302）。
   - **已登录 manifest 铸造转发且 token 全验签**：`makeSession([])` + cookie → `GET /manifest.webmanifest` → 200；`upstreamSeen.at(-1)` 断言 `url === '/manifest.webmanifest'`、`headers[config.identityHeader]` 非空串，并 `jwtVerify(token, createLocalJWKSet(issuer.jwks()), { algorithms: ['EdDSA'], issuer: config.identityIssuer, audience: config.identityAudience })` 通过、payload `tenant='acme'` `user='u1'`（范式照抄 `tests/identity-token.spec.ts:23-27`）。（此臂改动前后皆绿——它是验收锁，防回归。）
2. 聚焦 `pnpm vitest run tests/app.spec.ts` 确认第一用例 RED（404 实测 vs 401 期望）。
3. 删 gate.ts `:23-30`、server.ts 分支与 import；gate.spec.ts 删块。
4. GREEN：`pnpm vitest run` 全量绿（含未动的 oidc/sessions/config/identity-token 套件）。
5. 核验步（双重确认之代码侧）：`rg -n 'isCredentiallessAsset|credentialless' services/` 零命中；`rg -n 'proxyHttpRequest' services/casdoor-gateway/src` 仅剩 server.ts 单一调用点（minted）与 proxy.ts 定义。
6. `pnpm typecheck && pnpm build`；README 两处对齐；单 commit。

**Commit:** `feat(casdoor-gateway): route webmanifest through the session gate with minted identity`

### Task 2 — e2e manifest 回归臂 + 上游端口参数化

**Files:**
- Modify: `services/casdoor-gateway/scripts/e2e.mjs`
  - `:37` `const UPSTREAM = process.env.E2E_UPSTREAM_URL ?? 'http://127.0.0.1:38080'`（默认不变，零行为差异；演练可用临时口，兑现「live 38080 禁触」）
  - 步骤 2（`unauth /api 401` 之后）加臂：未登录 `GET /manifest.webmanifest` → 401 + `{error:'unauthenticated'}`（`record()` 断言；**RED 现状**：stub 上游对一切路径回 200，匿名转发得 200）
  - 步骤 3（已登录导航 200 之后）加臂：已登录（cookie）`GET /manifest.webmanifest` → 200
  - 头部注释 Prerequisites 段与 README `:125`「覆盖」行同步两臂
- Modify: `services/casdoor-gateway/README.md`（e2e 节补 `E2E_UPSTREAM_URL` 一句）

**步骤：** 改脚本 → `node --check scripts/e2e.mjs` → 起 docker casdoor（`docker compose up -d casdoor postgres`，仓根）→ `E2E_UPSTREAM_URL=http://127.0.0.1:38091 node scripts/e2e.mjs`（stub 自动占 38091，物理隔离 live 口）全绿 exit 0。RED 观察可选（切回 Task 1 前代码跑一次臂得 200）；强制 RED 由 Task 1 单测承担（同类行为）。

**Commit:** `test(casdoor-gateway): assert manifest gating in e2e and parameterize its upstream port`

### Task 3 — drill 移交修正：manifest 开放问题转正（#41 终审移交项）

**Files:**
- Modify: `plugins/dsh-casdoor-auth/scripts/zero-trust-drill.mjs`（重写 `:675-682` 块）
  - 注释改对前提：manifest link 无 `crossorigin` 时 credentials mode 为 same-origin，登录态带 cookie；网关（#19 后）对一切转发请求铸造注入，无匿名特例
  - 未登录臂转正为 `record()`：新 `makeClient()`（无 cookie）`GET ${GATEWAY}/manifest.webmanifest` → **网关自身 401 JSON**（`{error:'unauthenticated'}`，非守卫文案）——断言网关门禁，而非守卫兜底
  - 已登录臂新增 `record()`：用 `:605` 已登录 `client` 请求同路径 → 200（真实 dsh 静态面服务 manifest，守卫验签放行 = 有效 x-dsh-identity 的端到端证明）
- Modify: `plugins/dsh-casdoor-auth/README.md:140`（「已知边界」manifest 条改写：匿名转发特例已由 #19 取消；未登录 → 网关 401，PWA 元数据登录前不可用、UI 不受影响；已登录 → 正常铸造转发 200；删「属 #19 正文领地（开放问题）」尾注。OQ-2 待裁，默认改）

**步骤：** 改两文件 → `node --check plugins/dsh-casdoor-auth/scripts/zero-trust-drill.mjs` → 具备 rehearsal 环境时按插件 README「演练手册」全程跑 drill（宿主临时 worktree cd5ef814 + apply.sh + build + link + `--rt /tmp/zero-trust-g19-XXXX`），确认新两臂 ✅ 且 `ALL PASS`、宿主零残留、38081/30820 释放；环境不可得时记录 NEEDS_CONTEXT 式说明留验收补跑（OQ-4）。drill 同时端到端复验 Task 1（真守卫下登录态 manifest 200）。

**Commit:** `test(casdoor-auth): settle drill manifest arms after gateway full tokenization`

## 测试与验收命令（Issue 验收格对账）

| Issue 验收格 | 覆盖 |
| --- | --- |
| 经网关的 webmanifest 请求 200 且携带有效 x-dsh-identity | Task 1 单测（录制上游捕获 + `jwtVerify` 全验签）+ Task 2 e2e 已登录 200 + Task 3 drill（真守卫验签放行） |
| 网关不再存在匿名转发路径（代码 + 测试双重确认） | Task 1 代码核验步（rg 零命中、单一 minted 调用点）+ 未登录 manifest `upstreamSeen` 零增长断言 + gate.spec 特例块退役 |
| e2e 全绿，UI 资源加载无回退 | Task 2 `node scripts/e2e.mjs` exit 0（manifest 两臂入列）+ Task 3 drill 正向路径（index/JS 资产/RPC/WS 既有臂不动全绿） |

```
# 日常门禁（Task 1/2 后每步必绿；无 docker、离线可跑）
cd /Users/wuyongjun/trea/dsh-plugin/.worktrees/gateway-tokenization-19/services/casdoor-gateway
pnpm vitest run
pnpm typecheck && pnpm build

# e2e（需仓根 docker casdoor@8001；临时口隔离 live 38080）
E2E_UPSTREAM_URL=http://127.0.0.1:38091 node scripts/e2e.mjs

# drill（Task 3；需 rehearsal 环境，搭建见插件 README「演练手册」）
node plugins/dsh-casdoor-auth/scripts/zero-trust-drill.mjs \
  --host-worktree <patched host checkout> --rt /tmp/zero-trust-g19-XXXX

# 残留核验（双重确认之静态侧）
rg -n 'isCredentiallessAsset|credentialless' services/   # 期望零命中
```

## 全局约束

1. **不留任何匿名转发路径**：删除后网关转发面唯一入口 `server.ts` `app.all('/*')` 恒经 `issuer.mint`；不为任何路径新增免会话转发（含「空配置」形态，见裁定 1）。
2. **越界即停**：不动宿主仓、其它 worktree（含 `port-num-41`）、插件行为代码；插件侧仅 `zero-trust-drill.mjs` 移交块与（OQ-2 裁定后）README 单条。发现确需扩面 → 开放问题上报，不静默扩。
3. **live 端点禁触**：3080/38080 常驻实例不部署不重启不打流量；e2e 经 `E2E_UPSTREAM_URL` 走临时口，drill 恒用 38081/30820 并预检占用。
4. **commit 纪律**：每任务单 commit（消息见各任务），先构建后跑脚本类验收（drill/e2e spawn `lib/server.js`）；不 push、不开 PR。
5. **过时行为随测试退役**：gate.spec credentialless 块与实现同 commit 删除；测试描述行为变化（401/302 替代匿名 200/404），PR 说明引用 #18→#19 的顺序依赖（守卫先就位，本票收口）。
6. **文档同步**：代码与 README 同任务同 commit；表述用已改正的规范前提（same-origin credentials），禁止回流「omits cookies by spec」措辞。

## 开放问题（OQ，controller 裁定）

- **OQ-1 移除 vs 空配置**：默认**移除**（issue 两可；恒空配置是死面）。若 controller 要保留逃生门，改为 `GATEWAY_CREDENTIALLESS_PATHS`（默认空）+ config.spec 用例——不建议。
- **OQ-2 插件 README.md:140 是否本轨改**：brief 越界清单只豁免 gate.ts 与 zero-trust-drill.mjs 两处移交；但该条自身标注「属 #19 正文领地（开放问题）」，落地后不改即留 stale 文档。默认：随 Task 3 改写该单条。
- **OQ-3 e2e 上游端口参数化（`E2E_UPSTREAM_URL`）**：超出 issue 字面（测试基建小增），默认做——否则 e2e 无法既跑 stub 又不触 live 38080，与全局约束 3 冲突。
- **OQ-4 drill 全程复跑的可得性**：Task 3 完整验收需 rehearsal 宿主 worktree + docker casdoor + 全量 build（重）。默认：实现会话能搭则搭并跑 `ALL PASS`；不可得则以 `node --check` + 块级评审交付，drill 复跑列入验收阶段由 controller 排期（同 #18/#41 先例）。
