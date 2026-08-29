# Issue #22 — 插件会话过滤器（listFilter + accessCheck + admin 豁免）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dsh-casdoor-auth 为宿主 sessionController 的 sessionFilter 钩子座（#20 落地）提供实现：listFilter 用 multi-tenant 的 `listSessionsByOwner` 过滤、accessCheck 用 `canAccessSession` 准入、roles 含 admin 角色（默认 `dsh-admin`）全量豁免——前端零改动。

**Architecture:** 新模块 `src/session-filter.ts` 产出宿主形状的 hooks（principal 为 `unknown`，由插件侧窄化为守卫物化的 `WebRequestPrincipal`，畸形即 fail-closed）；`src/index.ts` 在 `guardEnabled` 时经 `ctx.inject(['sessionController','multiTenant'])` 注册到单座并托管释放。未配置（guard 关闭）零接触钩子座。

**Tech Stack:** TypeScript (cordis plugin)、vitest、dsh-multi-tenant（link 依赖，真实 `MultiTenantService` + `InMemoryTenantSessionStore` 作测试后端）。

**Spec:** Issue #22（https://github.com/1123786563/dsh-plugin/issues/22）正文 + ADR-0005（会话可见性：列表/准入过滤、未知无主 fail-closed、dsh-admin 豁免）+ CONTEXT.md「会话可见性/特权角色」。

**⚠️ 标题滞后正文一位是本仓库已知元数据错位：本 Issue 的权威内容以其正文为准（插件会话过滤器），与其标题（"网关重启自愈演练"）无关。**

## Global Constraints

- 宿主契约（宿主侧已由 #20 patch 固定，插件侧以结构化最小面镜像，不得引入宿主包类型依赖）：
  - `registerSessionFilter(hooks): () => void` 单座，二次注册宿主抛错。
  - `listFilter?: <Item extends { sessionId }>(principal: unknown, items: readonly Item[]) => readonly Item[] | Promise<readonly Item[]>`
  - `accessCheck?: (principal: unknown, sessionId: string) => boolean | Promise<boolean>`
  - 宿主语义：钩子已注册且请求无 principal → 整单 403 fail-closed；钩子抛错按拒绝处理。`onSessionCreated` 属 Issue #23 领地，本票**不注册**。
- 豁免判定：principal.roles 与 adminRoles（默认 `['dsh-admin']`，镜像网关 `GATEWAY_ADMIN_ROLES`）有交集 → 列表不过滤、准入恒真（含无主会话）。
- 非豁免主体：可见 = 自己 claim 的会话（`listSessionsByOwner`）；未知/无主/跨租户/同租户跨用户一律 false（fail-closed，不得泄露存在性）。
- **前端零改动**：过滤只做子集筛选，保持条目对象引用与顺序，不重塑响应。
- 注册仅当 `guardEnabled`（守卫关闭时不存在 principal，注册会把所有会话 API 打成 403）；宿主无 `registerSessionFilter` 座 = 补丁过期 → 抛错 fail-loud（沿 `applyGuard` 先例）。
- TDD：每任务先写失败测试再实现；commit 信息用 conventional 前缀；不动 `services/casdoor-gateway`（#19/#21 领地）、不动宿主仓（#24 领地）。

---

### Task 1: 会话可见性 hooks 核心（createSessionFilterHooks + principal 窄化）

**Files:**
- Modify: `plugins/dsh-casdoor-auth/src/guard.ts`（新增并导出 `isWebRequestPrincipal` 运行时窄化，紧邻其类型定义）
- Create: `plugins/dsh-casdoor-auth/src/session-filter.ts`
- Test: `plugins/dsh-casdoor-auth/tests/session-filter.spec.ts`

**Interfaces:**
- Consumes: `WebRequestPrincipal`（guard.ts 已有）；`dsh-multi-tenant` 的 `MultiTenantService.listSessionsByOwner(principal): Promise<string[]>` 与 `canAccessSession(principal, sessionId): Promise<boolean>`（#16 落地，未知会话 false）。
- Produces（Task 2 与宿主对接依赖）:
  - `type SessionListFilterLike = <Item extends { readonly sessionId: string }>(principal: unknown, items: readonly Item[]) => readonly Item[] | Promise<readonly Item[]>`
  - `type SessionAccessCheckLike = (principal: unknown, sessionId: string) => boolean | Promise<boolean>`
  - `interface SessionFilterHooksLike { readonly listFilter?: SessionListFilterLike; readonly accessCheck?: SessionAccessCheckLike }`
  - `interface SessionFilterDeps { readonly listSessionsByOwner(p: {tenantId,userId}): Promise<string[]>; readonly canAccessSession(p, sessionId): Promise<boolean> }`（结构化最小面）
  - `createSessionFilterHooks(deps: SessionFilterDeps, adminRoles: readonly string[]): SessionFilterHooksLike`
  - `isWebRequestPrincipal(principal: unknown): principal is WebRequestPrincipal`

- [ ] **Step 1: 写失败测试** `tests/session-filter.spec.ts`：真实 `MultiTenantService`（`new Context()` + `ctx.plugin(InMemoryTenantSessionStore)` + `ctx.plugin(MultiTenantService)`，照 multi-tenant 自有测试范式）。fixture：acme/alice（sa1,sa2）、globex/bob（sb1,sb2）、acme/carol（sc1）、`s-unclaimed`（永不 claim = 无主存量）、admin principal（dsh-ops/dsh-ops-admin，roles:['dsh-admin']）。矩阵：
  - listFilter：alice 于 [sa1,sb1,sa2,sb2,sc1] 得 [sa1,sa2]（同时覆盖跨租户+同租户跨用户；断言保持引用与顺序）；admin 得原数组 `toBe(items)`；畸形 principal（缺 roles/roles 非数组/userId 空串/字符串主体）→ `[]`；无自己会话的有效主体 → `[]`；空 items → `[]`。
  - accessCheck：alice→sa1 true；→sb1 false（跨租户）；→sc1 false（同租户跨用户）；→'forged-unknown' false；→'s-unclaimed' false；admin→sb1 true、→'s-unclaimed' true（无主对豁免可见）；畸形 principal→false。
  - adminRoles 为自定义 ['ops-god'] 时 roles:['ops-god'] 豁免、roles:['dsh-admin'] 不豁免。
- [ ] **Step 2: 跑测试确认失败**：`cd plugins/dsh-casdoor-auth && pnpm vitest run tests/session-filter.spec.ts` → FAIL（模块不存在）。
- [ ] **Step 3: 实现** `src/guard.ts` 加 `isWebRequestPrincipal`（tenantId/userId 非空 string、roles 为 string[] 且元素皆 string）；`src/session-filter.ts` 实现 `createSessionFilterHooks`：listFilter = 畸形→`[]`；admin→原样返回；否则 `new Set(await listSessionsByOwner)` 过滤。accessCheck = 畸形→false；admin→true；否则 `canAccessSession`。
- [ ] **Step 4: 跑测试确认通过**：同 Step 2 → PASS 全绿。
- [ ] **Step 5: 门禁 + commit**：`pnpm typecheck && pnpm test && pnpm build` 全绿后 `git commit -m "feat(casdoor-auth): tenant-scoped session visibility hooks (listFilter + accessCheck + admin exemption)"`。

### Task 2: 配置、接线与文档（adminRoles + applySessionFilter + index 注册 + README）

**Files:**
- Modify: `plugins/dsh-casdoor-auth/src/config.ts`（`adminRoles: readonly string[]`，默认 `['dsh-admin']`，schemastery `Schema.array(String)`）
- Modify: `plugins/dsh-casdoor-auth/src/session-filter.ts`（新增 `SessionFilterSeat` 最小面 + `applySessionFilter(sessionController: unknown, deps, adminRoles): () => void`，座缺失抛错指路补丁文件）
- Modify: `plugins/dsh-casdoor-auth/src/index.ts`（`ctx.inject(['sessionController','multiTenant'])` 内 `guardEnabled` 时注册 + effect 托管释放；导出新符号）
- Modify: `plugins/dsh-casdoor-auth/tests/config.spec.ts`（默认 adminRoles 断言）
- Modify: `plugins/dsh-casdoor-auth/tests/session-filter.spec.ts`（applySessionFilter：假座注册/释放/递 hooks 行为；无座抛错）
- Modify: `plugins/dsh-casdoor-auth/README.md`（adminRoles 配置行 + 会话可见性行为与补丁要求）

**Interfaces:**
- Consumes: Task 1 的 `createSessionFilterHooks`/`SessionFilterHooksLike`；`entry.adminRoles`；`scoped.multiTenant`（真实服务）与 `scoped.sessionController`（unknown，经 `applySessionFilter` 特性检查）。
- Produces: `applySessionFilter`、`SessionFilterSeat`、`SessionFilterHooksLike` 从包入口导出。

- [ ] **Step 1: 写失败测试**：config 默认 `adminRoles` 为 `['dsh-admin']`；`applySessionFilter` 对 `{ registerSessionFilter: vi.fn(...) }` 假座注册并返回释放器、释放器转发宿主 disposer、递入的 hooks 与 `createSessionFilterHooks` 同源（listFilter 实际过滤）；对无 `registerSessionFilter` 的对象抛错且错误信息含补丁路径 `scripts/host-patches/deepseek-harness.dsh-request-guard.patch`。
- [ ] **Step 2: 确认失败** → FAIL。
- [ ] **Step 3: 实现** config/adminRoles + applySessionFilter + index.ts inject 注册块（guardEnabled=false 早退，零座接触）+ 导出 + README 段落。
- [ ] **Step 4: 确认通过**：`pnpm vitest run tests/session-filter.spec.ts tests/config.spec.ts` → PASS；`pnpm typecheck && pnpm test && pnpm build` 全绿。
- [ ] **Step 5: commit** `git commit -m "feat(casdoor-auth): wire session visibility hooks into host sessionController seat"`。

### Task 3: 全量门禁与验收对照

**Files:** 无新改动（只跑门禁 + 勾选计划/台账）。

- [ ] **Step 1**: `cd plugins/dsh-casdoor-auth && pnpm typecheck && pnpm build && pnpm test`。
- [ ] **Step 2**: 仓库级 `pnpm -r typecheck && pnpm -r build && pnpm -r test`（沿前轮先例，记录各包计数；与 main 基线对比无回归）。
- [ ] **Step 3**: 对照 Issue #22 验收清单逐项在台账记录证据（列表隔离两类、403 准入 fail-closed、admin 全量、前端零改动=引用保序断言 + 库存 UI 渲染验证归 #21/#26 演练票的说明）。

## 非目标（显式）
- `onSessionCreated` 自动认领 → #23；mux 帧过滤 → #24/#26；存量迁移 → #27；网关面任何改动 → #19/#21。
- 不做真实浏览器三视角 e2e（需 live 网关栈，归 #26 验收）；以单测矩阵对三视角语义做忠实覆盖并留档说明。

## 测试与验收命令
- 聚焦：`cd plugins/dsh-casdoor-auth && pnpm vitest run tests/session-filter.spec.ts`
- 包门禁：`cd plugins/dsh-casdoor-auth && pnpm typecheck && pnpm build && pnpm test`
- 仓库门禁：`pnpm -r typecheck && pnpm -r build && pnpm -r test`
