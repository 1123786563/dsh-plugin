# Issue #25 插件帧过滤判定实现 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dsh-casdoor-auth 为 #24 已落地的两个宿主帧过滤席位（typertGateway `$events` 流 + sessionController 控制流）提供租户归属判定实现，使浏览器实时流只含自己会话的帧、`dsh-admin` 收全量、自己会话基线+实时完整。

**Architecture:** 判定内核 = 「连接建立时物化 own-set（同步）＋ 集合未命中时逐帧同步查归属（正确性优先）」。为满足宿主席位「过滤器必须同步」的硬约束，先给 vendored dsh-multi-tenant 增加**纯新增**的同步归属只读面（`node:sqlite` DatabaseSync / InMemory Map 本就同步）；插件侧一个共享 factory 同时供给两个席位，fail-closed + admin 豁免语义与 #22 的 session-filter 完全一致。

**Tech Stack:** TypeScript (ESM, `.ts` 导入后缀)、vitest、node:sqlite（既有）、cordis 服务注入。无新依赖。

**Spec:** Issue #25 正文（https://github.com/1123786563/dsh-plugin/issues/25）＋ ADR-0005（plugins/dsh-casdoor-auth/docs/adr/0005-tenant-scoped-session-visibility.md）＋ ADR-0004 部署节（宿主钩子契约）。**标题滞后正文一位为已知元数据错位，以正文为准**（PR #45/#46/#47 先例）。

## Scope（范围）

1. vendored `dsh-multi-tenant`（plugins/dsh-multi-tenant/packages/multi-tenant）：store seam 可选同步面 + SQLite/InMemory 双实现 + MultiTenantService 同步透传（`canAccessSessionSync` / `listSessionsByOwnerSync`）。
2. 插件 `plugins/dsh-casdoor-auth/src/frame-filter.ts`：共享判定工厂 + 两个 fail-loud 席位接线（`applyRemoteEventFrameFilter` / `applyControlFrameFilter`）。
3. `index.ts`：guardEnabled 门控下注册两席位；导出新 API；README + ADR-0005 状态更新。
4. WS 三视角 drill 脚本（external 模式，对已运行栈）+ runbook。

## Non-goals（非目标）

- 不改宿主 patch（席位契约已由 #24 定型并合入；本计划只消费席位）。
- 不动 #22 session-filter 既有行为与文件（除 index.ts 新增独立注入块）。
- 不做集合失效/订阅式刷新优化（「性能不足再优化并注明」——逐帧同步查归属已保证正确性）。
- 不改网关（upgrade 代理无路径限制，`/api/remote.mux` 可透传；cookie→identity 铸造已在 #18/#19 覆盖）。
- 不在本计划内执行发布（push/merge/关 Issue 属第 7 步，且本轮无独立终审席位则不发布）。

## 全局约束（Global Constraints）

- **fail-closed**：未知/无主会话、malformed/undefined principal 一律拒绝；永不因判定异常放行（宿主对 filter throw 的语义 = 丢弃该帧并 warn——插件不捕获、让宿主兜底，模块文档注明）。
- **admin 豁免**：`principal.roles ∩ adminRoles ≠ ∅` → 全量放行（与 session-filter/gateway `GATEWAY_ADMIN_ROLES` 同语义；adminRoles 来自插件现有 config）。
- **同步硬约束**：两席位的 filter 与 factory 均为同步签名 `(principal: unknown) => (sessionId: string, frameType: string) => boolean`；任何 await 都是契约违规。
- **席位唯一**：二次注册 throw 是宿主契约；插件只注册一次，disposer 交给 `scoped.effect`。
- **vendored 纯新增**：不修改既有异步方法语义、不 bump 版本（#16 `1645e45` 先例）；同步面为**可选能力**（feature-check），缺失时 service 同步方法 throw 带明确指引的 `MultiTenantError`。
- 代码风格：`.ts` 导入后缀、模块头 `@module` 注释、导出类型用 `export type`（照 guard.ts / session-filter.ts）。
- 测试命令（在 worktree 根）：`pnpm --filter dsh-multi-tenant test`、`pnpm --filter dsh-casdoor-auth test`；门禁：`pnpm -r typecheck && pnpm -r build && pnpm -r test`。
- 分支 `feat/gate-v2-25-plugin-frame-filter`，worktree `.worktrees/frame-filter-25`，SDD workspace `.superpowers/sdd/issue-25-plugin-frame-filter/`（主工作树侧）。

## 宿主席位契约（消费面，勿改）

- `ctx.typertGateway.registerRemoteEventFrameFilter(factory)`：`$events` 流（`/api/remote.mux` WS）打开时在请求主体 continuation 内调用 factory 一次；judgment 覆盖 waterfall 帧（agentId）与带 `sessionReferenceOf` 提取器的 emit 帧；`ready`/`cancel` 协议帧不经判定；filter throw → 丢该帧并 warn。
- `sessionController.registerControlFrameFilter(factory)`：控制流（baseline 会话清单 + jobs/queue 广播帧）每 generation 打开时调用 factory 一次；baseline 对清单逐会话调用 `filter(sessionId, 'baseline')`。
- 两席位的 principal 均为 guard 物化的 `WebRequestPrincipal`（`{tenantId, userId, roles}`），无 guard principal 的载体为 `undefined`。

---

### Task 1: vendored dsh-multi-tenant 同步归属只读面

**Files:**
- Modify: `plugins/dsh-multi-tenant/packages/multi-tenant/src/store.ts`（TenantSessionStore 可选同步成员）
- Modify: `plugins/dsh-multi-tenant/packages/multi-tenant/src/sqlite-store.ts`（SQLiteTenantSessionStore 实现）
- Modify: `plugins/dsh-multi-tenant/packages/multi-tenant/src/service.ts`（同步透传 + 共享判定核）
- Test: `plugins/dsh-multi-tenant/packages/multi-tenant/tests/multi-tenant.test.ts`（先 grep `SQLiteTenantSessionStore` 在 tests/ 中的既有 describe 块并就近扩展；若无 SQLite 专块，在 multi-tenant.test.ts 新增 describe 用 `:memory:` 路径实例化）

**Interfaces:**
- Produces（Task 2/3 依赖，签名精确）:
  - `TenantSessionStore.getSync?(sessionId: string): SessionOwner | undefined`
  - `TenantSessionStore.listByOwnerSync?(tenantId: string, userId: string): string[]`
  - `MultiTenantService.canAccessSessionSync(principal: TenantPrincipal, sessionId: string): boolean`（store 无同步面时 throw `MultiTenantError`）
  - `MultiTenantService.listSessionsByOwnerSync(principal: TenantPrincipal): string[]`（同上）
  - 共享纯函数（service 内部）：`accessDecision(owner: SessionOwner | undefined, principal: TenantPrincipal): AccessDecision`——async `evaluateAccess` 改为经它产出 decision（reason 枚举保持 `UNKNOWN_SESSION` / 跨租户 / 非所有者三值不变，先读现有代码对齐命名）。

- [ ] **Step 1: 写失败测试（service 同步面，InMemory 后端）**

在 `tests/multi-tenant.test.ts` 的 `describe('MultiTenantService', ...)` 内新增：

```ts
describe('synchronous ownership reads', () => {
  it('admits sync exactly when the async path admits', async () => {
    await multiTenant.claimSession('s1', alice)
    expect(multiTenant.canAccessSessionSync(alice, 's1')).toBe(true)
    expect(multiTenant.canAccessSessionSync(bob, 's1')).toBe(false)      // 同租户跨用户
    expect(multiTenant.canAccessSessionSync(eve, 's1')).toBe(false)      // 跨租户
    expect(multiTenant.canAccessSessionSync(alice, 'missing')).toBe(false) // 未知会话 fail-closed
  })

  it('lists the principal’s own sessions ascending', async () => {
    await multiTenant.claimSession('s2', alice)
    await multiTenant.claimSession('s1', alice)
    expect(multiTenant.listSessionsByOwnerSync(alice)).toEqual(['s1', 's2'])
  })

  it('sees claims made after the first sync read (no caching)', async () => {
    expect(multiTenant.canAccessSessionSync(alice, 'late')).toBe(false)
    await multiTenant.claimSession('late', alice)
    expect(multiTenant.canAccessSessionSync(alice, 'late')).toBe(true)
  })

  it('validates arguments identically to the async path', () => {
    expect(() => multiTenant.canAccessSessionSync({ tenantId: 'acme', userId: '' }, 's1')).toThrow(ValidationError)
    expect(() => multiTenant.canAccessSessionSync(alice, 'not a session id!')).toThrow(ValidationError)
    expect(() => multiTenant.listSessionsByOwnerSync({ tenantId: '', userId: 'alice' })).toThrow(ValidationError)
  })
})

describe('synchronous ownership reads on the SQLite store', () => {
  it('mirrors the async contract against :memory: SQLite', async () => {
    const ctx2 = new Context()
    await ctx2.plugin(SQLiteTenantSessionStore, { path: ':memory:' })
    await ctx2.plugin(MultiTenantService)
    const sqliteMultiTenant = ctx2.multiTenant
    await sqliteMultiTenant.claimSession('s1', alice)
    expect(sqliteMultiTenant.canAccessSessionSync(alice, 's1')).toBe(true)
    expect(sqliteMultiTenant.canAccessSessionSync(eve, 's1')).toBe(false)
    expect(sqliteMultiTenant.listSessionsByOwnerSync(alice)).toEqual(['s1'])
    await ctx2.dispose()
  })
})

describe('stores without the sync face', () => {
  it('throws a guiding MultiTenantError from both sync methods', async () => {
    class AsyncOnlyStore extends TenantSessionStore {
      override claim: TenantSessionStore['claim'] = async () => 'created'
      override get: TenantSessionStore['get'] = async () => undefined
      override listByOwner: TenantSessionStore['listByOwner'] = async () => []
    }
    const ctx3 = new Context()
    await ctx3.plugin(AsyncOnlyStore)
    await ctx3.plugin(MultiTenantService)
    expect(() => ctx3.multiTenant.canAccessSessionSync(alice, 's1')).toThrow(MultiTenantError)
    expect(() => ctx3.multiTenant.listSessionsByOwnerSync(alice)).toThrow(MultiTenantError)
    await ctx3.dispose()
  })
})
```

（若文件未导入 `SQLiteTenantSessionStore` / `ValidationError` / `MultiTenantError`，补导入；`ValidationError` 是否导出以现有 import 块为准——service 已用其校验，测试文件已 import 的名单里核对。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-multi-tenant test`
Expected: FAIL —— `canAccessSessionSync is not a function`（TypeError）。

- [ ] **Step 3: 最小实现**

`store.ts`：在 `TenantSessionStore` 抽象类内、`listByOwner` 声明之后追加（连同样例注释说明「可选同步能力，供宿主同步钩子消费」）：

```ts
  /**
   * Optional synchronous ownership reads for host hooks that must judge
   * inside synchronous callbacks (e.g. per-frame stream filters). A backend
   * declares the capability by implementing both members; consumers must
   * feature-check before use. Reads see the latest committed state — no
   * caching is implied.
   */
  getSync?(sessionId: string): SessionOwner | undefined
  listByOwnerSync?(tenantId: string, userId: string): string[]
```

`sqlite-store.ts`：在 `listByOwner` 实现后追加（statement 已在构造器备好）：

```ts
  override getSync(sessionId: string): SessionOwner | undefined {
    return readOwner(this.selectOwner.get(sessionId))
  }

  override listByOwnerSync(tenantId: string, userId: string): string[] {
    return readSessionIds(this.selectOwnerSessionIds.all(tenantId, userId))
  }
```

（若 `readSessionId` 现为单行读取，新增 `readSessionIds(rows: unknown[]): string[]` 小助手，勿复制循环体三次。）

`service.ts`：抽取共享判定核并加同步透传：

```ts
/** Shared owner-match judgment for both the async and sync read paths. */
function accessDecision(owner: SessionOwner | undefined, principal: TenantPrincipal): AccessDecision {
  if (!owner) return { allowed: false, reason: 'UNKNOWN_SESSION' }
  if (owner.tenantId !== principal.tenantId) return { allowed: false, reason: 'CROSS_TENANT' }
  if (owner.userId !== principal.userId) return { allowed: false, reason: 'NOT_OWNER' }
  return { allowed: true, reason: 'ALLOWED' }
}
```

（reason 字面量以现有 `evaluateAccess` 实际返回值为准对齐——先读原实现，保持既有 reason 值不变，仅把逐分支判断替换为对 `accessDecision` 的调用。）service 类内追加：

```ts
  /** Synchronous fail-closed authorization for host hooks that cannot await. */
  canAccessSessionSync(principal: TenantPrincipal, sessionId: string): boolean {
    const store = this.requireSyncStore('canAccessSessionSync')
    validateSessionId(sessionId)
    validateTenantPrincipal(principal)
    return accessDecision(store.getSync!(sessionId), principal).allowed
  }

  /** Synchronous owner session list for host hooks that cannot await. */
  listSessionsByOwnerSync(principal: TenantPrincipal): string[] {
    const store = this.requireSyncStore('listSessionsByOwnerSync')
    validateTenantPrincipal(principal)
    return store.listByOwnerSync!(principal.tenantId, principal.userId)
  }

  private requireSyncStore(caller: string): TenantSessionStore & Required<Pick<TenantSessionStore, 'getSync' | 'listByOwnerSync'>> {
    const store = this.store
    if (typeof store.getSync !== 'function' || typeof store.listByOwnerSync !== 'function') {
      throw new MultiTenantError(
        `${caller}: the active tenant session store provides no synchronous ownership reads`,
      )
    }
    return store as TenantSessionStore & Required<Pick<TenantSessionStore, 'getSync' | 'listByOwnerSync'>>
  }
```

（校验顺序：先验 store 能力再验参数——能力缺失是部署错误应最先暴露；测试断言 ValidationError 的用例走 InMemory 后端，不受影响。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-multi-tenant test`
Expected: PASS（原有全绿 + 新增全绿）。

- [ ] **Step 5: 提交**

```bash
git add plugins/dsh-multi-tenant
git commit -m "feat(multi-tenant): add synchronous ownership reads for host frame-filter hooks"
```

---

### Task 2: 插件 frame-filter 判定工厂 + 双席位 fail-loud 接线

**Files:**
- Create: `plugins/dsh-casdoor-auth/src/frame-filter.ts`
- Test: `plugins/dsh-casdoor-auth/tests/frame-filter.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 service 同步面（经结构化 deps，不直接 import service 类型）；`isWebRequestPrincipal` / `WebRequestPrincipal`（guard.ts）。
- Produces（Task 3 依赖）:

```ts
export interface FrameFilterDeps {
  listSessionsByOwnerSync(principal: { tenantId: string, userId: string }): string[]
  canAccessSessionSync(principal: { tenantId: string, userId: string }, sessionId: string): boolean
}
export type FrameFilterLike = (sessionId: string, frameType: string) => boolean
export type FrameFilterFactoryLike = (principal: unknown) => FrameFilterLike
export interface RemoteEventFrameFilterSeat {
  registerRemoteEventFrameFilter(factory: FrameFilterFactoryLike): () => void
}
export interface ControlFrameFilterSeat {
  registerControlFrameFilter(factory: FrameFilterFactoryLike): () => void
}
export function createFrameFilterFactory(deps: FrameFilterDeps, adminRoles: readonly string[]): FrameFilterFactoryLike
export function applyRemoteEventFrameFilter(typertGateway: unknown, deps: FrameFilterDeps, adminRoles: readonly string[]): () => void
export function applyControlFrameFilter(sessionController: unknown, deps: FrameFilterDeps, adminRoles: readonly string[]): () => void
```

**判定语义（权威）：** factory(principal)：
- `!isWebRequestPrincipal(principal)` → **deny-all**（undefined principal = 无 guard 载体/launch-token 连接，fail-closed，模块文档写明）；
- admin（roles ∩ adminRoles）→ **allow-all**；
- 否则：同步物化 `new Set(deps.listSessionsByOwnerSync(principal))`；filter(sessionId) = `set.has(sessionId) || deps.canAccessSessionSync(principal, sessionId)`（open-time 快照命中走 O(1)，新认领会话走逐帧权威查询——覆盖连接建立后的 MCP claim、跨进程迁移写入）。deps throw 不捕获（宿主契约：丢帧+warn）。

- [ ] **Step 1: 写失败测试**

`tests/frame-filter.spec.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { createFrameFilterFactory, applyRemoteEventFrameFilter, applyControlFrameFilter } from '../src/frame-filter.ts'

interface Owner { tenantId: string, userId: string }
const alice: Owner = { tenantId: 'acme', userId: 'alice' }
const bob: Owner = { tenantId: 'acme', userId: 'bob' }
const eve: Owner = { tenantId: 'globex', userId: 'eve' }

function makeDeps(owners: Map<string, Owner>) {
  const calls = { list: 0, access: 0 }
  return {
    calls,
    deps: {
      listSessionsByOwnerSync(principal: Owner): string[] {
        calls.list += 1
        return [...owners.entries()].filter(([, o]) => o.tenantId === principal.tenantId && o.userId === principal.userId).map(([id]) => id)
      },
      canAccessSessionSync(principal: Owner, sessionId: string): boolean {
        calls.access += 1
        const o = owners.get(sessionId)
        return o !== undefined && o.tenantId === principal.tenantId && o.userId === principal.userId
      },
    },
  }
}

const own = (roles: readonly string[] = []) => ({ ...alice, roles })

describe('createFrameFilterFactory judgments', () => {
  it('denies every frame for a principal-less carrier (fail-closed)', () => {
    const { deps } = makeDeps(new Map())
    const filter = createFrameFilterFactory(deps, ['dsh-admin'])(undefined)
    expect(filter('s1', 'waterfall')).toBe(false)
  })

  it('denies every frame for a malformed principal', () => {
    const { deps } = makeDeps(new Map())
    const filter = createFrameFilterFactory(deps, ['dsh-admin'])({ tenantId: 'acme' })
    expect(filter('s1', 'emit')).toBe(false)
  })

  it('admits everything for an admin regardless of ownership', () => {
    const { deps, calls } = makeDeps(new Map([['s1', bob]]))
    const filter = createFrameFilterFactory(deps, ['dsh-admin'])(own(['dsh-admin']))
    expect(filter('s1', 'waterfall')).toBe(true)
    expect(filter('anything', 'baseline')).toBe(true)
    expect(calls.list).toBe(0) // admin 短路，不物化集合
  })

  it('admits own sessions and denies cross-user / cross-tenant / unknown', () => {
    const { deps } = makeDeps(new Map([['mine', alice], ['bobs', bob], ['eves', eve]]))
    const filter = createFrameFilterFactory(deps, [])(own())
    expect(filter('mine', 'waterfall')).toBe(true)
    expect(filter('bobs', 'jobs')).toBe(false)
    expect(filter('eves', 'emit')).toBe(false)
    expect(filter('ghost', 'baseline')).toBe(false)
  })

  it('materializes the set once per connection and queries ownership only on misses', () => {
    const { deps, calls } = makeDeps(new Map([['mine', alice]]))
    const filter = createFrameFilterFactory(deps, [])(own())
    filter('mine', 'waterfall'); filter('mine', 'jobs')
    expect(calls.list).toBe(1)
    expect(calls.access).toBe(0)   // 命中集合不触发逐帧查询
    filter('claimed-later', 'emit')
    expect(calls.access).toBe(1)   // 未命中才走权威查询
  })

  it('sees a session claimed after the connection opened (per-frame authority)', () => {
    const owners = new Map<string, Owner>([['mine', alice]])
    const { deps } = makeDeps(owners)
    const filter = createFrameFilterFactory(deps, [])(own())
    expect(filter('late', 'waterfall')).toBe(false)
    owners.set('late', alice)
    expect(filter('late', 'waterfall')).toBe(true)
  })

  it('propagates deps throws to the host contract (no silent catch)', () => {
    const { deps } = makeDeps(new Map())
    const filter = createFrameFilterFactory(
      { ...deps, canAccessSessionSync: () => { throw new Error('store closed') } },
      [],
    )(own())
    expect(() => filter('x', 'emit')).toThrow('store closed')
  })
})

describe('seat wiring', () => {
  const { deps } = makeDeps(new Map())
  const registrations: Array<{ factory: unknown }> = []

  const remoteSeat = {
    registerRemoteEventFrameFilter(factory: unknown) { registrations.push({ factory }); return () => 'remote-disposed' },
  }
  const controlSeat = {
    registerControlFrameFilter(factory: unknown) { registrations.push({ factory }); return () => 'control-disposed' },
  }

  it('registers on the remote-event seat and returns its disposer', () => {
    const dispose = applyRemoteEventFrameFilter(remoteSeat, deps, ['dsh-admin'])
    expect(registrations.length).toBe(1)
    expect(dispose()).toBe('remote-disposed')
  })

  it('registers on the control seat and returns its disposer', () => {
    const dispose = applyControlFrameFilter(controlSeat, deps, ['dsh-admin'])
    expect(registrations.length).toBe(2)
    expect(dispose()).toBe('control-disposed')
  })

  it('fails loud when the remote-event seat is missing (stale patch)', () => {
    expect(() => applyRemoteEventFrameFilter({}, deps, [])).toThrow(/registerRemoteEventFrameFilter/)
  })

  it('fails loud when the control seat is missing (stale patch)', () => {
    expect(() => applyControlFrameFilter({}, deps, [])).toThrow(/registerControlFrameFilter/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter dsh-casdoor-auth test`
Expected: FAIL —— 无法解析 `../src/frame-filter.ts`。

- [ ] **Step 3: 实现 frame-filter.ts**

模块结构（照 session-filter.ts 风格）：模块头 `@module` 注释（说明：两席位消费、fail-closed、admin 豁免、open-time 快照+逐帧权威查询、throw 交给宿主丢帧契约）→ `FrameFilterDeps` → `FrameFilterLike` / `FrameFilterFactoryLike` → 两个 Seat 接口（含 registerX 的文档注释，注明「宿主单席位，二次注册 throw」）→ `createFrameFilterFactory`（admin 判定复用与 session-filter 相同的 `roles.some(role => adminRoles.includes(role))` 写法）→ `applyRemoteEventFrameFilter` / `applyControlFrameFilter`（各自 `isXSeat` 运行时 feature-check，缺失时 throw 错误信息包含「apply scripts/host-patches/deepseek-harness.dsh-request-guard.patch (current version)」指引，照 applySessionFilter 的文案形态）。

核心实现（逐字使用）：

```ts
export function createFrameFilterFactory(
  deps: FrameFilterDeps,
  adminRoles: readonly string[],
): FrameFilterFactoryLike {
  return principal => {
    if (!isWebRequestPrincipal(principal)) return () => false
    if (isAdmin(principal, adminRoles)) return () => true
    const own = new Set(deps.listSessionsByOwnerSync(principal))
    return sessionId => own.has(sessionId) || deps.canAccessSessionSync(principal, sessionId)
  }
}
```

（`isAdmin` 与 `errorText` 不从 session-filter.ts 导入则在本模块内私有实现 `isAdmin`；`isWebRequestPrincipal` 从 `./guard.ts` 导入。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter dsh-casdoor-auth test`
Expected: PASS（62 既有 + 新增全绿）。

- [ ] **Step 5: 提交**

```bash
git add plugins/dsh-casdoor-auth/src/frame-filter.ts plugins/dsh-casdoor-auth/tests/frame-filter.spec.ts
git commit -m "feat(casdoor-auth): add tenant-scoped frame filter factory for both host seats"
```

---

### Task 3: index.ts 接线 + 导出 + 文档

**Files:**
- Modify: `plugins/dsh-casdoor-auth/src/index.ts`（新增注入块 + 导出）
- Modify: `plugins/dsh-casdoor-auth/README.md`（帧过滤节）
- Modify: `plugins/dsh-casdoor-auth/docs/adr/0005-tenant-scoped-session-visibility.md`（「事件流：mux 帧过滤」条目状态更新为已实现，注明双席位+同步判定语义）

**Interfaces:**
- Consumes: Task 2 全部导出；`scoped.multiTenant.canAccessSessionSync` / `listSessionsByOwnerSync`（Task 1）；`entry.adminRoles`、`entry.guardEnabled`（config.ts 既有）。
- Produces: 包级导出 `applyRemoteEventFrameFilter`、`applyControlFrameFilter`、`createFrameFilterFactory` 及 Task 2 全部类型。

- [ ] **Step 1: index.ts 新增注入块**（置于现有 sessionFilter 注入块之后，逐字形态）：

```ts
  // Mux frame filtering (ADR-0005, issue #25): with the guard active, claim
  // BOTH host frame-filter seats — the typertGateway $events stream
  // (/api/remote.mux waterfalls and session-referenced emits) and the
  // sessionController control stream (baseline session list, jobs/queue
  // broadcasts). Every judgment reuses the multi-tenant ownership kernel's
  // synchronous reads: an open-time own-session snapshot per connection plus
  // an authoritative per-frame query for sessions claimed later. Admins are
  // exempt; principal-less carriers are denied fail-closed. guardEnabled=false
  // keeps zero seat interaction — without the guard no principal materializes,
  // and a registered filter would drop every frame.
  ctx.inject(['typertGateway', 'sessionController', 'multiTenant'], scoped => {
    if (!entry.guardEnabled) return
    const multiTenant = scoped.multiTenant
    if (typeof multiTenant.canAccessSessionSync !== 'function'
      || typeof multiTenant.listSessionsByOwnerSync !== 'function') {
      throw new Error(
        'casdoor-auth frame filtering is enabled but the active multi-tenant runtime provides no synchronous ownership reads; '
          + 'update the vendored dsh-multi-tenant package to the current version',
      )
    }
    const deps = {
      listSessionsByOwnerSync: (principal: { tenantId: string, userId: string }) =>
        multiTenant.listSessionsByOwnerSync(principal),
      canAccessSessionSync: (principal: { tenantId: string, userId: string }, sessionId: string) =>
        multiTenant.canAccessSessionSync(principal, sessionId),
    }
    const releaseRemote = applyRemoteEventFrameFilter(
      (scoped as unknown as { typertGateway?: unknown }).typertGateway,
      deps,
      entry.adminRoles,
    )
    scoped.effect(() => releaseRemote, 'casdoor-auth: remote-event frame filter')
    const releaseControl = applyControlFrameFilter(
      (scoped as unknown as { sessionController?: unknown }).sessionController,
      deps,
      entry.adminRoles,
    )
    scoped.effect(() => releaseControl, 'casdoor-auth: control frame filter')
  })
```

导入块加 `import { applyControlFrameFilter, applyRemoteEventFrameFilter } from './frame-filter.ts'`；导出区加：

```ts
export { applyControlFrameFilter, applyRemoteEventFrameFilter, createFrameFilterFactory } from './frame-filter.ts'
export type {
  ControlFrameFilterSeat,
  FrameFilterDeps,
  FrameFilterFactoryLike,
  FrameFilterLike,
  RemoteEventFrameFilterSeat,
} from './frame-filter.ts'
```

- [ ] **Step 2: 类型检查 + 全插件测试**

Run: `pnpm --filter dsh-casdoor-auth typecheck && pnpm --filter dsh-casdoor-auth test`
Expected: PASS。（无 index 级 apply() 运行时测试为既有形态——接线正确性由 fail-loud feature-check + typecheck 承担，guard.ts/session-filter.ts 先例同。）

- [ ] **Step 3: 文档更新**

README 在 session visibility 节后新增小节（≈8 行）：双席位、open-time 快照+逐帧权威查询、admin 全量、principal-less 载体 fail-closed、依赖当前宿主 patch 与 vendored 包同步面。ADR-0005 的「事件流：mux 帧过滤（ADR-0004 第 3 钩子）」一行后补实现注记（双席位、同步判定、#25 关闭）。

- [ ] **Step 4: 提交**

```bash
git add plugins/dsh-casdoor-auth/src/index.ts plugins/dsh-casdoor-auth/README.md plugins/dsh-casdoor-auth/docs/adr/0005-tenant-scoped-session-visibility.md
git commit -m "feat(casdoor-auth): wire both host frame-filter seats into plugin activation"
```

---

### Task 4: WS 三视角 drill 脚本 + runbook

**Files:**
- Create: `plugins/dsh-casdoor-auth/scripts/ws-frame-drill.mjs`

**输入与环境（external 模式，栈需已运行）：**
- `DRILL_GATEWAY_URL`（默认 `http://127.0.0.1:3080`）：live 网关。
- casdoor 种子账号（services/casdoor-gateway/docker/init_data.json）：`built-in/alice` pw `alice-Acme1`（org acme）、`built-in/bob` pw `bob-Globex1`（org globex）、`built-in/dsh-admin` pw `dsh-Admin1`（org dsh-ops，role dsh-admin）。
- 栈前提：宿主已打当前 patch（两席位存在）、本插件已启用 guardEnabled、casdoor+gateway+dsh 私口全链路。脚本在无栈时以明确错误退出（不伪报）。

**wire 协议（已从宿主源钉死）：**
- 登录：仿 services/casdoor-gateway/scripts/e2e.mjs —— GET `/login` 拿 authorize 重定向 → POST casdoor `/api/login`（username/password/organization=built-in/application=dsh-gateway 等参数照 e2e.mjs 的 loginQuery 构造）→ 带 code 回 `/casdoor/callback` → 捕获 `dsh_sid` cookie。
- RPC：`POST ${GW}/api/<method>`，body `{type:'client-request', rpcId: crypto.randomUUID(), method, payload}`，响应 `{type:'server-response', rpcId, result:{ok, value}}`。建会话：`session.create` payload `{cwd: <tmpdir>}` → value.sessionId；跑一轮：`session.prompt` payload `{sessionId, mode:'queue', content:[{type:'text', text:'reply with the single word pong'}]}`。
- $events 流：`new WebSocket(wsGW + '/api/remote.mux', {headers:{cookie: dsh_sid}})` → send `{type:'open', streamId, endpoint:'$events', payload:{args:{}}}` → 收 `{type:'item', streamId, value}` 序列；value 形如 `{type:'ready', clientId, host}` / waterfall / `{type:'emit', event, args}`。
- 控制流：`GET ${GW}/api/events.mux`（SSE，带 cookie）逐行解析 data 帧（实现时若 404/形状不符，打印原始前 3 帧并以 FAIL-TO-VERIFY 记录该腿，不中断另两腿断言）。

**断言（每账号收集后再判）：** 深扫每帧 value 中的会话引用（`sessionId` / `agentId` 字段，含 `args[0].sessionId`、baseline `value.sessions[].sessionId`）：
1. alice 流中不含任何 bob sessionId 的帧；2. bob 流中不含任何 alice sessionId 的帧（跨租户+同租户跨用户由 admin 第三视角补齐——本种子只有跨租户对，同租户跨用户视角在脚本注释中注明用 `canAccessSessionSync` 单测覆盖）；3. alice/bob 各自收到自己会话的 `api-session/added` 及至少 1 个后续帧（waterfall/jobs）；4. dsh-admin 流包含 alice 与 bob 双方会话的帧。
5. 栈未过滤判定（防伪阴性与伪阳性区分）：若 1/2 失败且 admin 视角正常 → 输出「STACK-UNFILTERED（席位未注册/宿主未打 patch/插件未启用）」，exit 2；断言 3/4 失败 → exit 1（真实回归）；环境不可达 → exit 3 并打印精确缺失项。

- [ ] **Step 1: 实现脚本**（结构照 e2e.mjs：record/✅❌、waitFor、总览打印、exit code；`import { WebSocket } from 'ws'` 不可用则用 node:22 原生 `WebSocket`——node ≥22.5 已内建且支持 headers 选项的仅 undici 实现，若无 headers 支持改用 `ws` 包（casdoor-gateway 依赖里已有，脚本不进 bundle 不算新依赖；确认 plugins/dsh-casdoor-auth 是否已有 ws 可用，否则以 fetch+SSE 先覆盖控制流腿、WS 腿标注依赖）。
- [ ] **Step 2: 干跑验证**（无栈环境）：`node scripts/ws-frame-drill.mjs` → 期望 exit 3 + 明确「gateway 不可达」输出（证明失败路径诚实，不伪报）。
- [ ] **Step 3: 若本机 live 栈可用（docker compose ps 有 casdoor+gateway 且宿主带 patch），跑真栈并留证据输出到台账；否则在台账记 live-leg PENDING + runbook 步骤（compose 起栈 → patch 宿主 → 启 dsh web with 插件 → 设 DRILL_GATEWAY_URL → 跑脚本）。**
- [ ] **Step 4: 提交**

```bash
git add plugins/dsh-casdoor-auth/scripts/ws-frame-drill.mjs
git commit -m "test(casdoor-auth): add WS three-perspective frame-filter drill script"
```

---

## 测试与验收命令（全计划收口）

1. `pnpm --filter dsh-multi-tenant test` — vendored 包全绿（55 既有 + Task 1 新增）。
2. `pnpm --filter dsh-casdoor-auth test` — 插件全绿（62 既有 + Task 2 新增）。
3. `pnpm -r typecheck && pnpm -r build` — monorepo 门禁 exit 0。
4. `pnpm -r test` — 9 包全绿（≥630 passed 基线）。
5. drill 脚本干跑 exit 3（诚实失败路径）；live 腿按 Task 4 Step 3 的实际可得性留证据或 PENDING 记录。

## Self-Review 记录（写计划时已完成）

- Spec 覆盖：Issue 三条验收（跨主体互不可见＝T2 判定+T4 断言 1/2；admin 全量＝T2 admin 短路+T4 断言 4；自己基线+实时完整＝open-time 快照+逐帧权威查询+T4 断言 3 与控制流 baseline 腿）；「集合物化+新增逐帧查询」逐字落实为 T2 语义；「复用 #22 归属管线」＝FrameFilterDeps 消费同一 ownership kernel 的同步面（T1）。
- 类型一致性：`canAccessSessionSync(principal, sessionId): boolean` / `listSessionsByOwnerSync(principal): string[]` 在 T1/T2/T3 三处签名一致；`FrameFilterFactoryLike` 与宿主两席位 `(principal: unknown) => (sessionId, frameType) => boolean` 结构镜像。
- 冲突预扫：本计划不改 session-filter.ts / 宿主 patch / 网关 → 与并行轨 #21（gateway 文档/演练面）零文件交集；`ctx.inject` 新块与既有块服务名不冲突（typertGateway 为新依赖注入，宿主缺该服务时 cordis inject 等待——guardEnabled=false 部署不受影响；已在 Ruling 记录：注入块在 guardEnabled=false 时仍会等待 typertGateway 可用——与 sessionFilter 块既有行为一致，非新风险）。
