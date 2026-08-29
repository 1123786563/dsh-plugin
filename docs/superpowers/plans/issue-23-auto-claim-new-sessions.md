# Issue #23 — 新建/fork 会话自动认领（onSessionCreated 自动 claim）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 隔离开启（`guardEnabled`）后，stock Web UI 经 `session.create` / `session.fork` 新建或派生的会话自动认领给当前请求主体：插件在 #22 已占据的 sessionFilter 单座上补齐 `onSessionCreated` 回调，以请求主体调 `multiTenant.claimSession`（claim-once 幂等、并发安全；冲突 fail-closed + 告警日志），使创建者对新会话立即可见可用。

**Architecture:** 不新增模块、不改 multi-tenant、不改宿主 patch。`src/session-filter.ts` 的 `createSessionFilterHooks` 增产 `onSessionCreated`：窄化 principal（复用 `isWebRequestPrincipal`）→ `deps.claimSession(principal, sessionId)` → 一切 claim 失败在回调内捕获并经 `deps.warn` 告警、**永不 rethrow**（宿主只作外层兜底）；fail-closed 由 #22 的 listFilter/accessCheck 结构性落地（归属未变 → 创建者不可见，admin 可见）。`src/index.ts` 既有 `ctx.inject(['sessionController','multiTenant'])` 块内 deps 增补 `claimSession` 与 `warn`（接 `scoped.logger('casdoor-auth')`），随既有单座一次性注册三个回调。

**Tech Stack:** TypeScript (cordis plugin)、vitest、dsh-multi-tenant（link 依赖，真实 `MultiTenantService` + `InMemoryTenantSessionStore` 作测试后端，沿 #22 测试范式）。

**Spec:** Issue #23（https://github.com/1123786563/dsh-plugin/issues/23）正文 + ADR-0005「新会话归属」决策节 + CONTEXT.md「会话归属 / 会话可见性 / JIT 开通」+ #22 落地的 `src/session-filter.ts` / `src/index.ts`。

**⚠️ 标题滞后正文是本仓库已知元数据错位：本 Issue 的权威内容以其正文为准（新建/fork 会话自动认领），与其标题（"插件会话过滤器"——那是 #22 的内容）无关。**

---

## 设计裁决（已对照宿主源码核实，实施时不得偏离）

以下事实全部引自主仓 `scripts/host-patches/deepseek-harness.dsh-request-guard.patch` 所导出的宿主分支 `dsh-request-guard` @`9cf768e`（工作树 `/Users/wuyongjun/trea/deepseek-harness/.worktrees/dsh-request-guard`，只读参考）。

### D1 回调如何获得当前请求主体 —— 宿主签名直接携带，插件零额外机制

- 宿主 `packages/api/session-controller/src/types.ts` L205-208：`SessionCreatedNotifier = (principal: unknown, sessionId: SessionId) => void | Promise<void>`，`principal` 即「guard-supplied request identity, opaque to the host」；L210-215 `SessionFilterHooks` 含 `onSessionCreated?`。
- 宿主 `packages/api/session-controller/src/access.ts` L100-116 `sessionCreated()`：`const principal = currentRequestPrincipal()` 后 `await notify(principal, sessionId)`。`currentRequestPrincipal` 来自 `packages/host/webserver/src/request-principal.ts`（AsyncLocalStorage，守卫 allow 时附带、webserver dispatch funnel 写入）。
- **结论**：主体由宿主作为回调第一参传入，与 listFilter/accessCheck 同源。插件侧唯一要做的仍是 `isWebRequestPrincipal` 运行时窄化（#22 已落地，guard.ts L74-80）。不需要插件侧请求作用域上下文，不需要碰宿主签名，**宿主 patch 面零改动**（钩子面已随 #20 落地并入 patch，见 patch 内 `SessionCreatedNotifier`/`assertCreationAdmission` 各 hunk）。

### D2 claim 冲突 = fail-closed + 告警日志 的具体落地

- **ClaimResult 语义**（multi-tenant 已有，零改动）：`service.ts` L33-47 `claimSession` 把 store 的 `'created' | 'idempotent'` 视为成功、`'conflict'` 抛 `SessionOwnershipConflictError`；原子性由 store 保证（SQLite：`sqlite-store.ts` L141-153 单条 `INSERT … ON CONFLICT(session_id) DO NOTHING` + 读回不可变赢家；InMemory：`store.ts` L61-71 单 JS turn 内无 await 完成 get+set）。
- **回调行为**：插件 `onSessionCreated` 内 `try { await deps.claimSession(...) } catch { deps.warn(含 sessionId/tenantId/userId/错误) }`——**捕获一切、永不 rethrow**。理由：宿主 access.ts L109-115 对回调 rejection 只 warn 不失败响应（外层兜底），插件内捕获才能打出带主体上下文的可运维告警；rethrow 只会换来第二条丢上下文的宿主日志。
- **fail-closed 的落地形态**：claim 未成功 ⇒ 归属表无变化 ⇒ #22 的 listFilter 把该会话从创建者列表剔除、accessCheck 拒绝打开（未知/他人会话 false）——创建者「创建了但看不见」，admin（豁免）仍可见。这即 fail-closed：不授予任何可见性、不改既有归属、无部分状态。三类失败路径同一处理：① `SessionOwnershipConflictError`（sessionId 已有他人归属，如客户端猜测他人 sessionId 的 `session.create` 幂等采纳）；② 其余 store/校验错误（如存储离线 → 无主会话，非 admin 不可见，符合 ADR-0005 Consequences「claim 遗漏产生 admin 可见会话」）；③ principal 窄化失败（理论上不可达——守卫是唯一 attacher；沿 #22 先例仍 fail-closed：不 claim + warn）。
- **admin 不豁免 claim**：onSessionCreated 对一切有效主体（含 admin 角色）照常 claim——归属是簿记不是可见性过滤；保持 ADR-0005「一切会话都有归属」。豁免仍只在 listFilter/accessCheck 生效（#22 语义不变）。

### D3 fork 路径覆盖 —— 宿主两个触发点已全覆盖派生 sessionId，无缺口

- 宿主 `packages/api/session-controller/src/index.ts` 仅两个铸造会话的 Remote：`create`（L276-282：`assertCreationAdmission()` → `commands.create` → `await sessionCreated(value.sessionId)`）与 `fork`（L370-377：源会话 `assertSessionAccess` → `assertCreationAdmission()` → `commands.fork` → `await sessionCreated(value.sessionId)`，此 `value.sessionId` 是 **fork 派生的新子会话 id**，JSDoc L367「the new Session identity」）。
- 宿主侧先例：`tests/access.host.spec.ts` L425 起 `describe('session filter onSessionCreated')`——L441「notifies fork with the child Session identity」、L457「rejects an anonymous create before any creation side effect」、L473「keeps create successful when the observer throws, and warns」。
- **结论**：fork 派生 sessionId 已触发回调，无缺口 ⇒ **不需要宿主 patch 改动，也就不需要 scripts/host-patches 管线联动任务**。其余 `@Remote`（list/search/prompt/page/…L250-460 全量枚举）不铸造新会话；subagent 子会话在 agent 运行内产生、不经 session-controller Remote，不在本票认领范围（见非目标）。

### D4 与 `/_dsh-multi-tenant/agents/create` 入口的一致性 —— 双入口殊途同归，互不触碰

- 该入口走 `mountMcpSaaSWebBridge`（multi-tenant `web.ts` L268 路由）→ `mcp.ts` L578 **先** `ownership.claimSession(sessionId, principal.identity)` **再** `agents.create`（持久预留语义），全程不经 session-controller Remote，`assertCreationAdmission` 对其无效 ⇒ 本票不改变其任何行为。
- 一致性定义 = 两条入口对同一 ownership kernel 收敛出同一归属终态：同主体同 sessionId（先经 bridge 预 claim，stock UI 再幂等采纳）→ `'idempotent'` 无错误；不同主体 → 冲突方 fail-closed 不可见。时序差异（bridge 先 claim 后建、stock 先建后 claim）是宿主契约固有，不属回归面。
- 回归证据 = 插件单测（下述）+ multi-tenant 包套件全绿（基线 61 tests）。

### D5 并发创建不冲突 —— claim-once 原子性由 store 层拥有，插件测试证组合不出错

- 单写者原子性是 store 契约（D2 引文）；multi-tenant 自有并发先例 `testing.ts` L95（`Promise.allSettled` 双 claim 同 id）。插件测试证明**组合层**语义：同主体 N 个并发不同 sessionId 的 onSessionCreated 全部落定且列表全可见；同 id 同主体并发双 claim 均成功解析（created+idempotent）；同 id 异主体并发恰一胜者、败者 warn 不抛。跨进程 SQLite 串行化是 kernel 契约、由 multi-tenant 套件背书，不在插件侧重复证明。

### D6 行为面新增：匿名 create/fork 由宿主前置拒绝（需写入文档）

注册 `onSessionCreated` 即激活宿主 `assertCreationAdmission`（access.ts L87-92）：观察者在场且请求无 principal → create/fork 在**任何副作用前** 403。覆盖面含仅持 launch token 的请求（guard 对其 allow 但不带 principal，guard.ts L103-107）——零信任下不可归因的创建本就该拒。`guardEnabled=false` 时不注册三钩子、创建行为不变。此为**预期新行为**，Task 2 落 README + CONTEXT.md。

---

## Global Constraints

- **宿主 patch 面零改动**：D1/D3 已裁决钩子面完备；不新增 scripts/host-patches 任务、不动宿主仓（那是 #24 管线票领地）。若实施中发现钩子面缺口，停下来以 PLANNER_BLOCKED 同等格式上报，不得自行改宿主。
- **claim-once 不可变**：只调 `claimSession`，绝无 unclaim/release/改归属（store 无此 API，v0 契约刻意如此，`store.ts` L4-7）。
- **fail-closed**：一切 claim 失败在回调内吞掉 + warn，绝不 rethrow、绝不部分认领；可见性裁决完全复用 #22 钩子，不在 onSessionCreated 里做任何可见性判断。
- **不回归 #22 管线**：既有 62 tests（casdoor-auth）+ 61 tests（multi-tenant）全绿是底线；`createSessionFilterHooks(deps, adminRoles)` 既有签名与返回的两个回调语义不变，只**增产** `onSessionCreated`。
- 结构化最小面纪律：不引入宿主包类型依赖（`SessionFilterHooksLike` 等结构镜像 + 运行时特性检查）；新导出符号过 `verify-export-jsdoc` 风格（JSDoc @param/@returns）。
- 注册仍仅当 `guardEnabled`（index.ts L161-173 既有块内扩展，`guardEnabled=false` 零座接触不变）；宿主无 `registerSessionFilter` 座 = 补丁过期 → 沿 `applySessionFilter` 既有 fail-loud。
- TDD：每任务先写失败测试再实现；commit 用 conventional 前缀；不动 `services/casdoor-gateway`、不动 `plugins/dsh-multi-tenant`。
- 存量无主会话迁移是 #26/#27 领地，本票不做。

---

### Task 1: onSessionCreated 自动认领核心（createSessionFilterHooks 增产）

**Files:**
- Modify: `plugins/dsh-casdoor-auth/src/session-filter.ts`（`SessionFilterDeps` 增 `claimSession`/`warn`；`SessionFilterHooksLike` 增 `SessionCreatedNotifierLike`；`createSessionFilterHooks` 产出 `onSessionCreated`；改写模块头注释与 L42-43 的「deliberately absent」过时注释）
- Test: `plugins/dsh-casdoor-auth/tests/session-filter.spec.ts`

**Interfaces:**
- Produces:
  - `type SessionCreatedNotifierLike = (principal: unknown, sessionId: string) => void | Promise<void>`（宿主 `SessionCreatedNotifier` 结构镜像）
  - `interface SessionFilterDeps` 增：`claimSession(principal: { tenantId: string, userId: string }, sessionId: string): Promise<void>`（MultiTenantService.claimSession 的主体前置形参化）、`warn(message: string): void`（claim 失败的可运维告警通道）
  - `SessionFilterHooksLike` 增 `readonly onSessionCreated?: SessionCreatedNotifierLike`（类型可选；工厂**恒**产出——注册即激活宿主 creation admission，D6）
  - `createSessionFilterHooks(deps, adminRoles)` 返回值增 `onSessionCreated`（D2 语义：窄化失败/claim 一切异常 → `deps.warn` 含 sessionId 与主体上下文 → 正常返回）
- Consumes: `isWebRequestPrincipal`（guard.ts）、真实 `MultiTenantService`（link 依赖）。

**TDD Steps:**
- [ ] **Step 1 写失败测试**（`tests/session-filter.spec.ts` 新增 describe `onSessionCreated`，沿文件内既有真实服务范式 `new Context()` + `InMemoryTenantSessionStore` + `MultiTenantService`，warn 用 `vi.fn()` 注入 deps）：
  - create 契约：`await onSessionCreated(alice, 's-new')` 落定后 `getSessionOwner('s-new')` = acme/alice，且**同回合** `listFilter(alice, [{sessionId:'s-new'},…])` 含之（AC1「立即可见」的契约级证明——宿主 access.ts L100-110 await 回调后才返回响应）。
  - fork 契约：`onSessionCreated(alice, 'fork-child-1')` 派生 id 照常 claim（宿主 index.ts L375 语义的插件侧镜像）。
  - 幂等（AC3 一致性）：预先 `multiTenant.claimSession('s-bridge', alice)`（模拟 `/_dsh-multi-tenant/agents/create` 先 claim），再 `onSessionCreated(alice, 's-bridge')` → 正常落定不抛、归属不变；`onSessionCreated(bob, 's-bridge')` → 不抛、warn 被调（消息含 sessionId 与 bob 主体）、归属仍 alice、`canAccessSession(bob,'s-bridge')` false（fail-closed 闭环）。
  - admin 照常 claim：`onSessionCreated(admin, 's-admin')` → 归属 dsh-ops/dsh-admin（无豁免分支）。
  - 畸形 principal：`onSessionCreated(非三字段主体, 's-x')` → 不 claim、warn 被调、不抛。
  - store 故障：deps.claimSession 注入 reject（非冲突错误）→ 回调正常解析、warn 被调（永不 rethrow——断言用 `resolves` 而非 `rejects`）。
  - 并发（AC4）：`Promise.all` 8 个并发不同 id（alice）全落定且 `listSessionsByOwner(alice)` 全含；同 id 同主体并发双调均 resolves；同 id 异主体并发（alice vs bob，`Promise.allSettled`）均 resolves 且恰一归属 + 败者 warn。
- [ ] **Step 2 确认失败**：`pnpm --dir plugins/dsh-casdoor-auth exec vitest run tests/session-filter.spec.ts` → FAIL（hooks 无 onSessionCreated / deps 无新成员）。
- [ ] **Step 3 实现** `src/session-filter.ts`：按 Interfaces 与 D2 实现；模块头注释补「creation auto-claim」一句；删除 L40-44 过时的「deliberately absent」注释块（改为陈述本回调已提供）。
- [ ] **Step 4 确认通过**：同 Step 2 → PASS；`pnpm --dir plugins/dsh-casdoor-auth test` 全绿（62+新增）。
- [ ] **Step 5 门禁 + commit**：`pnpm --dir plugins/dsh-casdoor-auth typecheck && pnpm --dir plugins/dsh-casdoor-auth build` 全绿后 `git commit -m "feat(casdoor-auth): auto-claim stock-UI created/forked sessions to the request principal"`。

### Task 2: 接线、导出与文档（index deps 增补 + README/CONTEXT）

**Files:**
- Modify: `plugins/dsh-casdoor-auth/src/index.ts`（L161-173 既有 inject 块 deps 增 `claimSession: (principal, sessionId) => multiTenant.claimSession(sessionId, principal)` 与 `warn: message => scoped.logger('casdoor-auth').warn(message)`；L108-115 导出增 `SessionCreatedNotifierLike`；块注释补自动认领一句）
- Modify: `plugins/dsh-casdoor-auth/tests/session-filter.spec.ts`（`applySessionFilter` describe 增用例）
- Modify: `plugins/dsh-casdoor-auth/README.md`（「职责」增自动认领与 D6 匿名创建 403 行为；「已知边界」核对无过时表述）
- Modify: `plugins/dsh-casdoor-auth/CONTEXT.md`（L11「stock Web UI 直接创建的会话当前不参与租户归属」改为「自动认领给当前请求主体（#23）」；其余术语行已与目标态一致，仅核对）

**TDD Steps:**
- [ ] **Step 1 写失败测试**：`applySessionFilter` 对假座 `{ registerSessionFilter: vi.fn(...) }` 注册的 hooks 断言 `typeof hooks.onSessionCreated === 'function'`；捕获 hooks 后经**真实** MultiTenantService 走一遍 `onSessionCreated(alice,'s-wired')` → 归属落定 + listFilter 可见（证接线 deps 真的通到 kernel）；既有用例（双钩子注册/释放/fail-loud）保持不变且通过。
- [ ] **Step 2 确认失败** → FAIL（hooks 无 onSessionCreated）。
- [ ] **Step 3 实现** index.ts 接线 + 导出 + README/CONTEXT 文档更新（D6 行为必须写明：`guardEnabled` 下无主体 create/fork 一律 403，含仅 launch token 请求）。
- [ ] **Step 4 确认通过**：`pnpm --dir plugins/dsh-casdoor-auth test` → PASS。
- [ ] **Step 5 commit** `git commit -m "feat(casdoor-auth): wire creation auto-claim into the sessionFilter seat and document the anonymous-create veto"`。

### Task 3: 全量门禁与验收对照（无新改动）

- [ ] **Step 1 包门禁**：`pnpm --dir plugins/dsh-casdoor-auth typecheck && pnpm --dir plugins/dsh-casdoor-auth build && pnpm --dir plugins/dsh-casdoor-auth test`（基线 62 全数保留 + 新增全绿）。
- [ ] **Step 2 相邻回归**：`pnpm --dir plugins/dsh-multi-tenant/packages/multi-tenant test`（基线 61 全绿，证 AC3 不回归）；仓库级 `pnpm -r typecheck && pnpm -r build && pnpm -r test`（沿 #22 先例，与 main 基线对比无回归）。
- [ ] **Step 3 验收台账**：对照下方「测试与验收命令总表」逐 AC 记录证据；手动项 A 按步骤执行并留档（截图/录屏或演练记录），归入 #26 总验收票前置材料。

---

## 非目标（显式）

- `onSessionCreated` 的 mux 帧过滤联动、WS 帧过滤验收 → #24/#25；存量无主会话迁移 → #26/#27；网关面改动 → #19/#21 领地。
- subagent 派生子会话的自动认领：不经 session-controller Remote（D3 枚举），归 agent 运行内部路径，ADR-0005 已记为「claim 遗漏 → admin 可见」的已知边界；若 #24/#25 验收暴露需要，另开票。
- 不做真实浏览器三视角 e2e（需 live 网关栈，归 #26 验收票）；本票以单测矩阵对语义做忠实覆盖并留档说明。
- 不改 multi-tenant、不改宿主 patch、不加新配置项（claim 对有效主体无条件，无 tunable；`adminRoles`/`guardEnabled` 复用既有配置语义）。

## 测试与验收命令总表

| Issue AC | 自动化证据 | 命令（均已实测可运行） |
| --- | --- | --- |
| 1. stock UI 新建会话后创建者立即可见可用 | Task 1 用例「create 契约」：回调落定即归属 + 同回合 listFilter 可见（宿主 await 回调先于响应落定，access.ts L100-110）；Task 2 接线用例证 deps 通 kernel。**UI 端到端属手动项 A**（下方步骤） | `pnpm --dir plugins/dsh-casdoor-auth exec vitest run tests/session-filter.spec.ts` |
| 2. fork 派生会话同样自动归属 | Task 1 用例「fork 契约」+ 宿主侧先例佐证（access.host.spec.ts L441 fork 子 id 触发；index.ts L370-377） | 同上 |
| 3. 经 /_dsh-multi-tenant 入口创建会话的行为不回退 | Task 1 用例「幂等（AC3 一致性）」双入口同 kernel 同终态 + multi-tenant 套件全绿（基线 61） | `pnpm --dir plugins/dsh-multi-tenant/packages/multi-tenant test` |
| 4. 并发创建无冲突错误 | Task 1 用例「并发」三态（异 id 全落定 / 同 id 同主体幂等 / 同 id 异主体恰一胜者败者 warn）；store 层原子性由 multi-tenant 套件背书 | 同 AC1 命令 |
| 门禁（全局约束） | typecheck / build / 全量 | `pnpm --dir plugins/dsh-casdoor-auth typecheck && pnpm --dir plugins/dsh-casdoor-auth build && pnpm --dir plugins/dsh-casdoor-auth test`；仓库级 `pnpm -r typecheck && pnpm -r build && pnpm -r test` |

## 手动验收项（无法由本票单测覆盖，按步骤执行留档）

**A. 新建会话立即可见（AC1/AC2 端到端）**——依赖 README「演练手册」的 live 栈（casdoor + gateway + patch 过的 dsh web + 本插件，`guardEnabled` 默认开）：
1. 浏览器以 acme/alice 登录 `http://127.0.0.1:3080/login?org=acme`。
2. stock UI 新建会话 → 侧栏**立即**出现该会话；发一条消息得到正常回复（可见 + 可用）。
3. 对该会话执行 fork（复制）→ 新会话立即出现且可打开对话。
4. 换 globex/bob 登录：列表只见 bob 自己的会话（不见 alice 新建/fork 的）。
5. 观察点（可选负例）：无 `x-dsh-identity` 的裸请求（如仅 launch token 直连私口）create/fork → 403 `session creation was denied`（D6）。

（三视角完整演练与录屏归 #26 总验收票；本项通过即视为 AC1/AC2 的 UI 面证据。）
