# Issue #20 — 宿主 ApiProxy 会话访问过滤钩子（ADR-0004 钩子②）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development — implement task-by-task with fresh implementer subagents, per-task spec + quality review, ≤5 fix rounds, final full-branch review.

**Goal:** 在 deepseek-harness 宿主语义层（session-controller 域方法）加入产品无关的三个可选钩子 `listFilter` / `accessCheck` / `onSessionCreated`，未配置时逐字节行为不变，并让请求主体（#13 守卫附加的 principal）可从 WebServer 入口流到域方法层。

**Architecture:** 请求主体经 `AsyncLocalStorage` 载体传播：webserver 在 guard 决策后把 continuation 包进请求作用域（HTTP 与 WS 升级同一收口），导出 `currentRequestPrincipal()` 读取器；session-controller 新增单席位 `registerSessionFilter(hooks)` 与可复用准入原语 `assertSessionAccess(sessionId)`，在 `session` 命名空间的列表出口、带 sessionId 方法入口、create/fork 成功后三点接线。deny 一律以稳定失败码 `forbidden`（HTTP 403 语义）经既有 typert 错误通道返回。

**Tech Stack:** TypeScript (strict, ESM)、vendored Cordis Services、node:async_hooks、vitest（host specs）、git patch 工具链（`scripts/host-patches/`）。

---

## 0. 元数据与红线（必读）

- **Issue:** https://github.com/1123786563/dsh-plugin/issues/20（**以正文为准**：「宿主语义层的通用钩子：listFilter/accessCheck/onSessionCreated」；标题滞后正文一位，系 #14–#27 已知元数据错位，#16/#17/#18 先例均以正文为准）。
- **本仓 worktree（dsh-plugin）:** `/Users/wuyongjun/trea/dsh-plugin/.worktrees/apiproxy-hooks-20`，分支 `feat/gate-v2-20-apiproxy-session-hooks`，基于 main `303413a`。承载：本计划、patch 重导出、工具链常量、ADR-0006 §2 同步。本仓工作树内**只动** `docs/superpowers/plans/`、`scripts/host-patches/`、`plugins/dsh-casdoor-auth/docs/adr/0006-*.md`；不动 `plugins/dsh-casdoor-auth` 其它文件（#41 并行轨道领地）。
- **宿主仓 worktree（deepseek-harness）:** `/Users/wuyongjun/trea/deepseek-harness/.worktrees/dsh-request-guard`，分支 `dsh-request-guard`，当前 tip `1bd06a9798`（单 commit：webserver 守卫钩子，即 #13 落地）。承载：全部钩子实现代码与宿主测试。基线 upstream master = `cd5ef8148158c3a752a658978873241fdf8e2bbc`。
- **红线（全程生效）：**
  - 不 push 两仓任何分支。
  - 不动宿主仓主 checkout（detached `b150a551b8`）与 `origin/master`；一切宿主改动只在 `.worktrees/dsh-request-guard` 提交。
  - 不动 live 3080（PID 93329）；不占用 38081 / 30820（并行轨道 #41 drill 专用）；不进 `/Users/wuyongjun/trea/dsh-plugin/.worktrees/port-num-41`。
  - 不改 #13 守卫 patch 既有行为（webserver 变更是叠加，不重写 `decide()`/`principalOf()`/席位语义）。
  - 不 spawn subagent 由本计划的 implementer 自行决定以外的方式扩张领地（按 subagent-driven-development 执行即可）。

## 1. 已核实的宿主事实（planner 亲查，实施者可直接引用）

链路（HTTP `/api`）：

1. `packages/host/webserver/src/index.ts:271-294` — WebServer `handle()`：guard 决策（`decide()`）→ `principals.set(req, decision.principal)`（`:278`，仅 principal 非 undefined 时）→ 路由匹配 → `route.handler(req, res)`。守卫席位 `registerGuard`（`:236-242`，单席位、二次注册 throw）、`principalOf(req)`（`:250-252`，`WeakMap<IncomingMessage, unknown>`）。
2. `packages/host/webserver/src/index.ts:381-412` — `admitUpgrade()`：upgrade 的 guard 决策 → `principals.set`（`:388`）→ upgrade 路由表分发 `route.handler(req, socket, head)`（`:404`）。
3. `packages/client/connection/src/index.ts:113-127` — `apply()` 注册 `/api` prefix 路由：`requestRejection`（信任栅栏 403 + 浏览器认证 401）→ `bridge(req, res, fetchHandler, …)`。
4. `packages/client/connection/src/rpc-host.ts:116-132` — `createSharedFetchHandler('/api')`：先查 exact fetch-route（`registerFetchRoute`，`:134-150`，**生产零调用方**，测试可用），否则走唯一拦截器槽位。
5. `packages/api/gateway/src/index.ts:202-208` — gateway 构造器占用 `/api` 拦截器槽位（`connection.rpc.intercept`）→ `dispatchRpc` → `invoke` → `prepareInvocation` → `Reflect.apply` 到域方法。`resolveReceiverContext`（`:771-817`）解析的是**会话域上下文**，非请求域——请求主体不经参数传入域方法，这正是需要 ALS 载体的原因。
6. WS 载体：`packages/api/gateway/src/index.ts:209-233` 注册 `REMOTE_STREAM_MUX_PATH = '/api/remote.mux'`（`stream-protocol.ts:6`）的 upgrade 路由；`stream-server.ts:44-55` `handleUpgrade` 在路由 handler 内**同步**调用，ws 的 socket 监听在该同步调用栈内注册——升级 handler 若运行在请求作用域 continuation 内，后续 `'data'`/`'message'` 回调继承同一 ALS store（Task 2 实证）。
7. `session` 命名空间方法面（`packages/api/session-controller/src/index.ts`，行号为当前 tip 实测）：`list`(:208)/`search`(:219)/`create`(:229)/`selectModel`(:239)/`modelCatalog`(:248)/`canOpenWorkspacePath`(:257)/`openWorkspacePath`(:269)/`rename`(:304)/`fork`(:314)/`prompt`(:325)/`attachment`(:336)/`updateQueue`(:346)/`cancel`(:356)/`page`(:367)/`follow`(:378, stream)/`control`(:388, stream)。history 委托 `src/history.ts`，list/search 委托 `src/list.ts`，create/fork/prompt 等委托 `src/commands.ts`。
8. 带 sessionId 的请求类型（`src/types.ts`）：`selectModel`/`rename`/`fork`/`prompt`/`attachment`/`updateQueue`/`cancel` 直带 `sessionId`；`page`/`follow` 带 `address`（`kind:'session'→sessionId`、`kind:'subagent'→childSessionId`，`history.ts:233-235` 已有私有 `addressId`）。`list`/`search` 无 sessionId（出口过滤路径）；`create` 无 sessionId（创建回调路径）；`modelCatalog`/`canOpenWorkspacePath`/`openWorkspacePath`/`control` 无会话地址（不接线）。
9. **失败码通道事实（亲查 dispatchRpc 错误路径）**：`gateway/src/index.ts:594-604` `invokeRpc` catch → `rpcFailure`（`:997-1018`，`TypertRemoteFailure` 原样保留 `error.failure`）→ `rpc-host.ts:270-277` `fullResponse` → `Response.json(body)`——**HTTP 状态恒 200，deny 语义只能以 `ConnectionRpcFailure.code` 携带**；`RemoteFailure.code` 是开放 string（`typert/protocol/src/types.ts:43-49`）。WS mux 流上同一 code 经 `wireStream.failure`（`gateway/src/index.ts:181-184`）映射为 `{type:'error', streamId, error}` 帧。字面 HTTP 403 只存在于分发前的信任栅栏（`rpc-host.ts:166` / `connection/src/index.ts:121`）。
10. **R1（已裁定，planner 复核成立）**：基线 `cd5ef814` 全仓 grep 无 `session.export` 端点（`session` 命名空间无 export 方法；`registerFetchRoute` 生产零调用方）。ADR-0005 中「session.export GET 直达旁路」在当前基线**不存在**。
11. 宿主测试基建：webserver 用真实 Loader 组合（`tests/webserver.spec.ts:33-60` `loadComposition`）；gateway 全链路集成用 fake webServer + `applyConnection` + 真实 fetch（`tests/gateway.host.spec.ts:1171-1265`），ws mux 单调用 `stream-server.host.spec.ts`；session-controller 直测用 `tests/test-remote.ts`（`createSessionTestController` / `createSessionTestRemote`（RemoteResult 语义包装）/ `installSessionReadTestServices`）。基线四包 vitest 全绿（planner 已抽测 webserver：7 passed）。
12. 依赖面：session-controller 现**不依赖** `@deepseek-ai/dsh-host-webserver`（peer/dev 均无）；gateway 以 dev 依赖 + type-only import 使用之；client/connection 以 peer+dev 使用之。workspace constraints 不限制 api→host 组间依赖（仅实验包隔离与 workspace 协议检查）。

## 2. 关键设计裁定（含理由，终审复核点）

### 2.1 请求主体载体：webserver 收口的 AsyncLocalStorage（采纳）+ 明确 fallback

- **载体**：`packages/host/webserver/src/request-principal.ts` 新模块，内含一个模块级 `AsyncLocalStorage<{principal}>`，导出 `runWithRequestPrincipal(principal, run)` 与 `currentRequestPrincipal()`。
- **进入点（单一收口，两个）**：`handle()` 在 guard 决策并 `principals.set` 后，把「路由匹配 → handler → fallback」整个 continuation 包进 `runWithRequestPrincipal(decision.principal, dispatch)`；`admitUpgrade()` 同样包 `route.handler(req, socket, head)` 的调用。principal 为 undefined 时不进入 ALS（零开销，逐字节行为不变）。
- **读取点**：session-controller `src/access.ts` import `currentRequestPrincipal`（来自 `@deepseek-ai/dsh-host-webserver`，新增 peer+dev 依赖与 tsconfig.host.json reference；client face 不含该 import，不受影响）。
- **为什么收口在 webserver**：principal 的物化点（`principals.set`）就在 webserver；HTTP 路由与 WS 升级是仅有的两个进入宿主的口子；下游（connection bridge → gateway dispatch → 域方法）全程是同一 async continuation 链与同步注册的 socket 监听，ALS 语义覆盖。
- **强制实证（Task 2 的存在理由）**：ALS 跨 cordis fiber/await 链、跨 ws socket 数据事件回调的传播**必须端到端测过才算数**，且测试必须做突变验证（去掉 wrap 后必须变红），防恒真测试。
- **fallback（若实证失败，计划内偏差）**：在 `packages/client/connection/src/index.ts` 的 `/api` 路由 handler 与 `packages/api/gateway/src/index.ts` 的 mux upgrade handler（:216-226）两处显式进入 `runWithRequestPrincipal(webServer.principalOf(req), …)`（两处均可注入 webServer / 持有 req）。采用 fallback 属于对既定架构的偏差：实施者必须在任务报告记录失败证据（哪条链路 ALS 断了、什么现象），并在 ADR-0006 §2 补记偏差与理由；不得静默降级成只覆盖单一路径。

### 2.2 「deny → 403」的实际形态：稳定失败码 `forbidden`（写实，非臆造）

事实见 §1.9：`/api` POST 载体对一切业务失败回 HTTP 200 + `result.ok:false` envelope。因此本票的「403」落地为：deny 的方法抛 `TypertRemoteFailure({ code: 'forbidden', message, details:{sessionId} })`——HTTP/WS 载体原样透传该 code，客户端按 403 语义消费。**不得**为了字面 403 改动 `fullResponse`/envelope 契约（会波及全部客户端与 SDK，超出本票）。`RpcErrorDetailsMap`（`rpc.ts`）暂不新增 `forbidden` 键：本票消费方（#22）在宿主侧；client typed-error 映射留待需要时随消费 PR 补（记入 plan 的已知边界）。

### 2.3 钩子协议与席位：单席位、三可选回调

```ts
export interface SessionFilterHooks {
  readonly listFilter?: SessionListFilter      // (principal, items) => items（可 async）
  readonly accessCheck?: SessionAccessCheck    // (principal, sessionId) => allow（可 async）
  readonly onSessionCreated?: SessionCreatedNotifier // (principal, sessionId) => void（可 async）
}
```

- **单席位 vs 三席位**：单席位（`registerSessionFilter(hooks)`，二次注册 throw、disposer 释放）。理由：三个回调是同一关注点（会话访问策略），消费方是同一个插件（#22 的 listByOwner / assertSessionAccess / auto-claim 三位一体）；拆三席位则插件要协调三个单例的半配置态组合，状态空间无收益（YAGNI）。对齐 #13 `registerGuard` 单席位先例（ADR-0006 §1）。
- **逐回调可选，缺席=该方法零行为差异**：只配 listFilter 时 UNARY 方法不做准入；只配 accessCheck 时列表不过滤。这是「全部可选，缺省=现状零行为差异」在组合配置下的精确化。
- **principal 类型为 `unknown` 透传**：宿主不理解其形状（#22 传 `{tenantId,userId,roles}`），满足「宿主零产品词汇」。
- **listFilter 泛型签名**：`<Item extends {sessionId}> (principal, items) => items`——list 传 `SessionSummary[]`、search 传 `SessionSearchItem[]`，泛型保型，实现方按 `sessionId` 过滤即可（#22 listByOwner 只需 sessionId）。
- **search 的 `hasMore` 不随过滤重算**：过滤在响应出口，`hasMore` 描述 provider 分页（过滤前），文档写明。

### 2.4 fail-closed 语义（对齐守卫先例）

钩子已注册（对应回调在场）时：

- **无主体**（`currentRequestPrincipal()` undefined）：listFilter 在场 → list/search 抛 forbidden；accessCheck 在场 → 全部接线方法抛 forbidden；onSessionCreated 在场 → create/fork 在**执行前**抛 forbidden（先检查后创建，绝不产生不可归属会话再报错）。
- **钩子 throw / reject**：按 deny 处理（forbidden）+ `logger.warn`，绝不放行（对齐 `decide()` fail-closed 先例）。
- **onSessionCreated 回调失败**：create/fork 已成功，回调 throw 只 warn 不改写响应；回调被 await（保证 #23 的 claim 先于响应落库，避免创建者紧随其后的 accessCheck 被自家未落库 claim 拒掉）。
- **席位未注册 / 回调缺席**：逐字节现状（现有宿主测试全绿即证明）。

### 2.5 R1 落地：export 旁路 = 结构性覆盖

- 事实：基线无 `session.export` 端点（§1.10）。计划**不得虚构**该端点。
- 结构性覆盖的落地：准入判定收敛为**一个可复用原语** `SessionController.assertSessionAccess(sessionId)`（public service 方法，读 ALS principal + 席位判定，一切接线点与未来任意 GET 直达路由共用），并以代表性测试证明：席位配置后，直接调用该原语（模拟旁路路径消费）得到与域方法一致的 forbidden 判定。#18 zero-trust 守卫已兜底匿名直连；未来出现真 GET 直达路由时接线是一行调用。
- ADR-0006 §2 同步时补一句：ADR-0005 所述 export 旁路在基线不存在，本票以原语复用形态覆盖（留待终审核）。

### 2.6 范围裁定：`skills` / `fileReferences` 命名空间不接线

`src/skill-catalog.ts`（`skills` 命名空间，请求带 sessionId）与 `src/file-references.ts`（`fileReferences` 命名空间，经 lookup 解析 Agent）同为会话寻址面，但：Issue 正文与 AC 均只点名 `session` 命名空间方法；接线它们需把策略对象注入两个独立 TypertRemoteService 的构造（patch 面扩大）；且 fileReferences 经 context lookup 解析接收者，准入点位置不同构。裁定本票不接线，写入 session-controller README「Known Limitations and Deferred Work」：消费方（#22/#24）如需覆盖，用同一 `assertSessionAccess` 原语在这两个命名空间补一行接线即可。

### 2.7 commit 结构（宿主 3 + 本仓 1）

宿主：①`feat(webserver): propagate guard principal into request continuations`；②`test(gateway): prove request principal reaches remote methods end to end`；③`feat(session-controller): add optional session access filter hooks`。每步提交后四包 vitest + tsc host face 全绿（增量可验证）。本仓：Task 4 的 `chore(host-patches): …` 重导出 commit。

## 范围

宿主（`dsh-request-guard` 分支，3 commits）：

1. webserver：`request-principal.ts` 新模块 + `handle()`/`admitUpgrade()` 收口 + 单测 + README×3。
2. gateway：`tests/request-principal.host.spec.ts` 端到端实证（HTTP + WS mux 两路径，含突变验证）。
3. session-controller：`src/types.ts` 钩子类型 + `src/access.ts` 策略/席位/原语 + `src/index.ts` 12 个方法接线 + `src/history.ts` 导出 `addressId` + `tests/access.host.spec.ts` 测试矩阵 + README×3 + package.json（peer+dev 加 webserver）+ tsconfig.host.json reference。

本仓（1 commit）：`scripts/host-patches/deepseek-harness.dsh-request-guard.patch` 重导出（覆盖至新 tip）+ README 状态表 + `apply.sh` 常量 + ADR-0006 §2 多 commit 表述同步 + 自检流程跑通。

## 非目标

- 不做 mux 帧过滤（ADR-0004 钩子③，#24/#25 领地）；不做消费方实现（#22：listByOwner/assertSessionAccess/claim 都在插件侧）。
- 不改 `/api` envelope / HTTP 状态码契约，不动 `RpcErrorDetailsMap`（见 §2.2）。
- 不动 webserver 既有 guard/principalOf/席位语义（叠加式变更）；不改 `skills`/`fileReferences` 命名空间（§2.6）。
- 不改 client contract / 两个 SDK（无 wire 签名变化、无 SessionEventMap 变化）。
- 不 push 任何分支；不动 live 3080 与 38081/30820。

---

## Task 1（宿主）— webserver 请求主体载体（ALS 模块 + 双收口 + 单测 + README）

**Objective:** guard 附加的 principal 以请求作用域随 continuation 传播，并导出 `currentRequestPrincipal()` 读取器；无 guard principal 时逐字节不变。

**Files:**
- Create: `packages/host/webserver/src/request-principal.ts`
- Modify: `packages/host/webserver/src/index.ts:271-294`（handle 收口）、`:381-412`（admitUpgrade 收口）、导出行
- Modify: `packages/host/webserver/tests/webserver.spec.ts`（新增一个 it）
- Modify: `packages/host/webserver/README.md` + `README.zh.md` + `README.i18n.yaml`（三件套同步）

**Step 1: 写失败测试**（webserver.spec.ts，guard 测试之后新增；沿用 `loadComposition` / `registerGuard` / `registerUpgrade` 既有范式）

```ts
it('propagates the guard principal to request-scoped continuations on both carriers', { timeout: 60_000 }, async () => {
  const loaded = await loadComposition()
  const server = loaded.webServer
  const port = server.port
  const seen: unknown[] = []

  server.register({
    kind: 'exact',
    path: '/api/echo-scoped',
    handler: async (req, res) => {
      // A deliberate async hop: the reader must survive await boundaries.
      await new Promise(resolve => { setImmediate(resolve) })
      seen.push(['http', currentRequestPrincipal(), server.principalOf(req)])
      res.writeHead(200).end()
    },
  })
  server.registerUpgrade({
    path: '/upgrade-scoped',
    handler: (req, socket) => {
      seen.push(['upgrade', currentRequestPrincipal(), server.principalOf(req)])
      socket.destroy()
    },
  })

  const release = server.registerGuard(() => ({ allow: true, principal: { subject: 'scoped-alice' } }))
  await fetch(`http://127.0.0.1:${String(port)}/api/echo-scoped`)
  await tornUpgrade('/upgrade-scoped') // 复用本文件既有的 raw upgrade 助手

  expect(seen).toEqual([
    ['http', { subject: 'scoped-alice' }, { subject: 'scoped-alice' }],
    ['upgrade', { subject: 'scoped-alice' }, { subject: 'scoped-alice' }],
  ])

  // No principal attached: the reader reports undefined on the same path.
  release()
  await fetch(`http://127.0.0.1:${String(port)}/api/echo-scoped`)
  expect(seen.at(-1)).toEqual(['http', undefined, undefined])
})
```

（import 行加 `currentRequestPrincipal`；`tornUpgrade` 为本文件既有助手，若签名不同按现状复用。）

**Step 2: 跑 RED**

```sh
cd /Users/wuyongjun/trea/deepseek-harness/.worktrees/dsh-request-guard
pnpm vitest run packages/host/webserver
```
预期：FAIL——`currentRequestPrincipal` 未导出（编译/导入错误）。

**Step 3: 实现**

`src/request-principal.ts`（完整新文件）：

```ts
/** Request-scoped propagation of the guard-supplied principal. */

import { AsyncLocalStorage } from 'node:async_hooks'

const requestPrincipal = new AsyncLocalStorage<{ readonly principal: unknown }>()

/**
 * Run one request continuation with a principal readable through
 * {@link currentRequestPrincipal}; entering is owned by the webserver's
 * dispatch funnels after the guard allowed with a principal.
 * @param principal - guard-supplied identity for this request.
 * @param run - continuation owning the request's dispatch.
 * @returns the continuation's result.
 */
export function runWithRequestPrincipal<T>(principal: unknown, run: () => T): T {
  return requestPrincipal.run({ principal }, run)
}

/**
 * The principal the guard attached to the current request continuation:
 * undefined off a request, or when the guard allowed without a principal.
 * @returns the guard-supplied principal, or undefined.
 */
export function currentRequestPrincipal(): unknown {
  return requestPrincipal.getStore()?.principal
}
```

`src/index.ts` 三处修改（叠加，不重写守卫语义）：

(a) 导出（既有 `export { renderIndexInjections }` 区块旁）：

```ts
export { currentRequestPrincipal, runWithRequestPrincipal } from './request-principal.ts'
```

(b) `handle()` 内 `this.principals.set(req, decision.principal)` 之后，把「rawPath → match → route/fallback」抽成局部 `dispatch`，尾部替换为：

```ts
const dispatch = async (): Promise<void> => {
  /* v8 ignore next -- `?? '/'` arm: node:http always sets url on server
  requests; the field is only optional on the client-side IncomingMessage type */
  const rawPath = new URL(req.url ?? '/', 'http://x').pathname
  const route = this.match(rawPath)
  if (route !== undefined) {
    await route.handler(req, res)
    return
  }
  const fallback = this.fallback
  if (fallback === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  await fallback(req, res)
}
if (decision.principal === undefined) await dispatch()
else await runWithRequestPrincipal(decision.principal, dispatch)
```

(c) `admitUpgrade()` 内 `this.upgradedSockets.add(socket)` 后的 handler 调用块替换为（保留原同步 throw 防护与 warn 语义）：

```ts
this.upgradedSockets.add(socket)
try {
  const invoke = (): void => {
    Promise.resolve(route.handler(req, socket, head)).catch((error: unknown) => {
      this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      socket.destroy()
    })
  }
  if (decision.principal === undefined) invoke()
  else runWithRequestPrincipal(decision.principal, invoke)
} catch (error) {
  this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
  socket.destroy()
}
```

**Step 4: 跑 GREEN + 突变验证**

```sh
pnpm vitest run packages/host/webserver
```
预期：PASS（8 个测试）。随后做一次突变验证：临时把 (b) 的尾两行改成无条件 `await dispatch()`，重跑必须 FAIL（`['http', {subject…}]` 变 `['http', undefined,…]`），恢复后再 GREEN——证明测试对 wrap 敏感、非恒真。

**Step 5: README×3 同步**

`README.md` 在「The guard seat」节末补一段（`README.zh.md` / `README.i18n.yaml` 三件套同步）：

> A guard allow with a principal also propagates it into the request continuation: handlers, and any code they await (including the `/api` RPC dispatch down to domain methods), read it through `currentRequestPrincipal()`; `runWithRequestPrincipal()` enters the scope explicitly for tests and alternative carriers. Without a guard principal the reader returns `undefined` and behavior is unchanged.

**Step 6: 门禁 + commit**

```sh
pnpm vitest run packages/host/webserver
node ./node_modules/typescript/bin/tsc -b tsconfig.host.json   # 预期: 无输出, exit 0
pnpm run verify-translation-pairing                            # 预期: all consistent
git add packages/host/webserver
git commit -m "feat(webserver): propagate guard principal into request continuations"
```

## Task 2（宿主）— ALS 端到端实证（gateway 集成测试，HTTP + WS mux）

**Objective:** 用真实 WebServer + 真实 client-connection bridge + 真实 gateway dispatch 证明 principal 可达「域方法层」，覆盖 HTTP POST 与 WS mux 两路径；这是 §2.1 的强制实证。

**Files:**
- Create: `packages/api/gateway/tests/request-principal.host.spec.ts`

**Step 1: 写测试**（完整新文件；复用 `gateway.host.spec.ts` 的 `browserCookie`、`provideBrowserCredentials` 范式与 `stream-server.host.spec.ts` 的 open frame 形状）

```ts
/** End-to-end proof that the guard principal reaches Remote domain methods on both carriers. */

import { once } from 'node:events'
import { Context, Service } from '@deepseek-ai/cordis'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { currentRequestPrincipal } from '@deepseek-ai/dsh-host-webserver'
import { bindTypertRemote, Remote } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import WebSocket from 'ws'
import { describe, expect, it } from 'vitest'
import { provideBrowserCredentials } from './browser-credentials.ts'

class PrincipalEchoService extends Service {
  readonly typertRemote = bindTypertRemote(this, 'principalEcho')

  constructor(ctx: Context) {
    super(ctx, 'principalEcho')
  }

  @Remote
  read(): unknown {
    return { principal: currentRequestPrincipal() }
  }

  @Remote({ mode: 'stream' })
  async *frames(): AsyncIterable<unknown> {
    yield { principal: currentRequestPrincipal() }
  }
}

async function boot(): Promise<{ ctx: Context; port: number; cookie: string; dispose: () => Promise<void> }> {
  const ctx = new Context()
  provideBrowserCredentials(ctx)
  const serverFiber = ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await serverFiber
  const server = ctx.webServer
  const connectionFiber = ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  await connectionFiber
  await ctx.plugin(TypertRegistry)
  const gatewayFiber = ctx.plugin(TypertGatewayService)
  await gatewayFiber
  const echoFiber = ctx.plugin(PrincipalEchoService)
  await echoFiber
  const origin = `http://127.0.0.1:${String(server.port)}`
  const cookie = browserCookie(ctx.connection, origin) // 复用 gateway.host.spec.ts 的同名助手
  return {
    ctx,
    port: server.port,
    cookie,
    dispose: async () => {
      await echoFiber.dispose()
      await gatewayFiber.dispose()
      await connectionFiber.dispose()
      await serverFiber.dispose()
    },
  }
}

describe('request principal propagation', () => {
  it('reaches a unary Remote method through the real /api HTTP chain', async () => {
    const { ctx, port, cookie, dispose } = await boot()
    const release = ctx.webServer.registerGuard(() => ({ allow: true, principal: { userId: 'e2e-http' } }))
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/api/principalEcho/read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          type: 'client-request', rpcId: 'rpc-principal', method: 'principalEcho/read',
          payload: { args: {} },
        }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        type: 'server-response', rpcId: 'rpc-principal',
        result: { ok: true, value: { principal: { userId: 'e2e-http' } } },
      })
    } finally {
      release()
      await dispose()
    }
  })

  it('reaches a stream Remote method through the real WebSocket mux', async () => {
    const { ctx, port, cookie, dispose } = await boot()
    const release = ctx.webServer.registerGuard((_req, kind) =>
      kind === 'upgrade' ? { allow: true, principal: { userId: 'e2e-ws' } } : { allow: true })
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/api/remote.mux`, { headers: { cookie } })
      await once(socket, 'open')
      socket.send(JSON.stringify({
        type: 'open', streamId: 's1', endpoint: 'principalEcho/frames', payload: { args: {} },
      }))
      const [frame] = await once(socket, 'message')
      expect(JSON.parse(String(frame))).toEqual({
        type: 'item', streamId: 's1', value: { principal: { userId: 'e2e-ws' } } ,
      })
      socket.close()
      await once(socket, 'close')
    } finally {
      release()
      await dispose()
    }
  })

  it('reports undefined without a guard principal on both carriers', async () => {
    // 同 boot，不注册 guard：unary 响应 value.principal === undefined（envelope ok:true）。
    // 覆盖「无守卫 = 读取器 undefined」的负路径，防 ALS 泄漏。
  })
})
```

（实施时把 `browserCookie` 助手与第三条负路径补全；`once(socket,'message')` 的帧断言按 `stream-server.host.spec.ts` 的实际帧形状核对 `{type:'item',…}`。）

**Step 2: 跑测试**

```sh
pnpm vitest run packages/api/gateway -t 'request principal'
```
预期：3 passed。**若 WS 路径 FAIL（principal undefined）且 HTTP 路径 PASS**： ALS 未跨 ws socket 数据事件回调——启用 §2.1 fallback（gateway mux upgrade handler 内 `runWithRequestPrincipal(webServer.principalOf(req), () => mux.handleUpgrade(...))`；HTTP 若同样失败再加 connection `/api` 路由 handler 进入点），fallback 改动并入本 commit，并在任务报告记录证据与偏差说明。

**Step 3: 突变验证（实证义务，不可跳过）**

临时注释 Task 1 (b)/(c) 的 `runWithRequestPrincipal` 包裹（直调 dispatch/invoke），重跑本 spec 必须 FAIL；恢复后 GREEN。此步骤的结论（"ALS 传播假设在两条载体上经真实链路证实"）写入任务报告。

**Step 4: 门禁 + commit**

```sh
pnpm vitest run packages/api/gateway packages/client/connection packages/host/webserver
node ./node_modules/typescript/bin/tsc -b tsconfig.host.json
git add packages/api/gateway/tests/request-principal.host.spec.ts
git commit -m "test(gateway): prove request principal reaches remote methods end to end"
```

## Task 3（宿主）— 三钩子协议 + 席位 + 三个接线点 + 测试矩阵

**Objective:** session-controller 落地 §2.3/§2.4 的协议与接线；未配置时现有测试全绿（零行为差异），配置后满足 Issue 全部验收语义。

**Files:**
- Modify: `packages/api/session-controller/src/types.ts`（钩子类型，仅类型）
- Create: `packages/api/session-controller/src/access.ts`
- Modify: `packages/api/session-controller/src/index.ts`（席位 + 原语 + 12 个方法接线 + import）
- Modify: `packages/api/session-controller/src/history.ts:233`（`addressId` 改导出）
- Modify: `packages/api/session-controller/package.json`（peerDependencies + devDependencies 加 `@deepseek-ai/dsh-host-webserver: workspace:^`）
- Modify: `packages/api/session-controller/tsconfig.host.json`（references 加 `{ "path": "../../host/webserver" }`，files 加 `src/access.ts`）
- Create: `packages/api/session-controller/tests/access.host.spec.ts`
- Modify: `packages/api/session-controller/README.md` + `README.zh.md` + `README.i18n.yaml`

**Step 1: 写失败测试** `tests/access.host.spec.ts`（矩阵；`runWithRequestPrincipal` 自 `@deepseek-ai/dsh-host-webserver` import——需先加依赖，见 Step 3，此处先写测试按预期 RED 为「模块/导出不存在」）

测试骨架（完整形状；fixture 细节标注复用来源）：

```ts
import { Context } from '@deepseek-ai/cordis'
import { runWithRequestPrincipal } from '@deepseek-ai/dsh-host-webserver'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { createSessionTestController, createSessionTestRemote, installSessionReadTestServices } from './test-remote.ts'

const principal = { userId: 'u1' }
const withPrincipal = <T>(run: () => Promise<T>): Promise<T> =>
  runWithRequestPrincipal(principal, run)

// 矩阵用例（每条一个 it）：
// 1. 席位：第二次 registerSessionFilter throw /guard already|filter hooks already registered/；
//    disposer 释放后行为回到现状（HMR 语义，registry contributions prove disposal）。
// 2. 未注册钩子：list/create/page 与现状一致（既有套件已证，这里只断言 registerSessionFilter 存在且可释放）。
// 3. listFilter：list（两行 summary 过滤剩一行）+ search（items 过滤、hasMore 不变）；
//    无主体 → forbidden；filter throw → forbidden 且 logger.warn 被调用（vi.spyOn(ctx.logger,'warn')）；
//    席位在但 listFilter 缺席 → list 原样。
// 4. accessCheck：page（address kind 'session' 与 'subagent' 各一）/prompt/cancel/rename/selectModel
//    denied → RemoteResult ok:false error.code 'forbidden'；allowed → 正常值；
//    无主体 → forbidden；check throw → forbidden + warn；席位在但 accessCheck 缺席 → 现状。
// 5. follow：denied 时首个 next() reject（forbidden），无 snapshot 帧泄漏；
//    allowed 时首帧 snapshot 正常（沿用 transport.host.spec.ts 的迭代器范式）。
// 6. onSessionCreated：create 成功 → 回调收到 (principal 对象引用相等, value.sessionId)；
//    fork 成功 → 回调收到子 id（fixture 沿用 commands-create-fork.host.spec.ts:149 completedSession）；
//    无主体 → create 在 commands.create 之前拒绝（sessionQuery/store 断言零副作用）；
//    回调 throw → create 仍 ok:true + warn。
// 7. R1 结构性覆盖：席位配置后直接调用 controller.assertSessionAccess(id)
//    （模拟未来 GET 旁路消费同一原语）→ 与域方法同判（forbidden / 放行）。
```

**Step 2: 跑 RED**

```sh
pnpm vitest run packages/api/session-controller -t 'session filter'
```
预期：FAIL（`registerSessionFilter`/`assertSessionAccess` 不存在、`runWithRequestPrincipal` 导入失败）。

**Step 3: 实现**

(a) `src/types.ts` 追加（类型 only；client face 也含 types.ts，纯类型无宿主依赖）：

```ts
/** Structural floor for list-filter items: every list and search item names its Session. */
export interface SessionListItem {
  readonly sessionId: SessionId
}

/**
 * Rewrite one list or search response outlet; the generic preserves the
 * caller's item type, so list summaries and search hits stay distinct.
 * @param principal - guard-supplied request identity, opaque to the host.
 * @param items - complete unfiltered response items.
 * @returns the filtered items (a promise is awaited).
 */
export type SessionListFilter = <Item extends SessionListItem>(
  principal: unknown,
  items: readonly Item[],
) => readonly Item[] | Promise<readonly Item[]>

/**
 * Admission judgment for one addressed Session.
 * @param principal - guard-supplied request identity, opaque to the host.
 * @param sessionId - addressed durable Session identity.
 * @returns true to allow; a promise is awaited.
 */
export type SessionAccessCheck = (
  principal: unknown,
  sessionId: SessionId,
) => boolean | Promise<boolean>

/**
 * Notification after one successful create or fork; awaited before the
 * response settles, and its rejection never fails the settled response.
 * @param principal - guard-supplied request identity, opaque to the host.
 * @param sessionId - newly created (or forked) Session identity.
 */
export type SessionCreatedNotifier = (
  principal: unknown,
  sessionId: SessionId,
) => void | Promise<void>

/** Optional session access hooks; each absent callback leaves that seam unchanged. */
export interface SessionFilterHooks {
  readonly listFilter?: SessionListFilter
  readonly accessCheck?: SessionAccessCheck
  readonly onSessionCreated?: SessionCreatedNotifier
}
```

(b) `src/access.ts`（完整新文件）：

```ts
/** Session admission and list filtering driven by one optional external hook set. */

import type { Context } from '@deepseek-ai/cordis'
import { currentRequestPrincipal } from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionFilterHooks, SessionListItem } from './types.ts'

/** Single seat of session access hooks consulted by the Session Remote methods. */
export class SessionAccessPolicy {
  private hooks: SessionFilterHooks | undefined

  /**
   * @param ctx - owning Session Controller context; used for contained hook-failure warnings.
   */
  constructor(private readonly ctx: Context) {}

  /**
   * Claim the single session-hook seat: two access policies cannot compose,
   * so a second registration throws. Release with the returned disposer.
   * @param hooks - optional list, admission, and creation callbacks.
   * @returns the disposer releasing the seat.
   */
  register(hooks: SessionFilterHooks): () => void {
    if (this.hooks !== undefined) {
      throw new Error('session-controller: session filter hooks already registered')
    }
    this.hooks = hooks
    return () => { this.hooks = undefined }
  }

  /**
   * The reusable admission judgment for one Session, shared by every
   * sessionId-bearing Remote method and any future direct route: allow when
   * no accessCheck hook is registered; deny fail-closed when the hook is
   * registered but the request carries no principal, the hook denies, or the
   * hook throws (a throwing hook is logged and counted as a denial).
   * @param sessionId - addressed durable Session identity.
   * @throws TypertRemoteFailure code `forbidden` (HTTP 403 semantics) on denial.
   */
  async assertSessionAccess(sessionId: SessionId): Promise<void> {
    const check = this.hooks?.accessCheck
    if (check === undefined) return
    const principal = currentRequestPrincipal()
    if (principal === undefined) throw forbidden(`access to session "${sessionId}" was denied`, { sessionId })
    try {
      if (!await check(principal, sessionId)) {
        throw forbidden(`access to session "${sessionId}" was denied`, { sessionId })
      }
    } catch (error) {
      if (error instanceof TypertRemoteFailure) throw error
      this.ctx.logger.warn(
        `session-controller: accessCheck for "${sessionId}" threw and was treated as a denial: ${String(error)}`,
      )
      throw forbidden(`access to session "${sessionId}" was denied`, { sessionId })
    }
  }

  /**
   * Apply the registered list filter to one list or search response outlet;
   * absent filter returns the items unchanged, a principal-less request or a
   * throwing filter denies the whole call fail-closed.
   * @param items - complete response items.
   * @returns the filtered items.
   * @throws TypertRemoteFailure code `forbidden` on denial.
   */
  async applyListFilter<Item extends SessionListItem>(items: readonly Item[]): Promise<readonly Item[]> {
    const filter = this.hooks?.listFilter
    if (filter === undefined) return items
    const principal = currentRequestPrincipal()
    if (principal === undefined) throw forbidden('session list access was denied', {})
    try {
      return await filter(principal, items)
    } catch (error) {
      this.ctx.logger.warn(
        `session-controller: listFilter threw and was treated as a denial: ${String(error)}`,
      )
      throw forbidden('session list access was denied', {})
    }
  }

  /**
   * Require a principal before any creation side effect whenever creation is
   * observed: an anonymous create would mint a Session no observer can claim.
   * @throws TypertRemoteFailure code `forbidden` when the observer is registered and no principal is present.
   */
  assertCreationAdmission(): void {
    if (this.hooks?.onSessionCreated === undefined) return
    if (currentRequestPrincipal() === undefined) {
      throw forbidden('session creation was denied', {})
    }
  }

  /**
   * Notify the creation observer after one successful create or fork; the
   * callback is awaited (its claims settle before the response) and its
   * rejection is logged, never failing the settled response.
   * @param sessionId - newly created (or forked) Session identity.
   */
  async sessionCreated(sessionId: SessionId): Promise<void> {
    const notify = this.hooks?.onSessionCreated
    if (notify === undefined) return
    const principal = currentRequestPrincipal()
    if (principal === undefined) {
      // Only reachable without a matching assertCreationAdmission call.
      this.ctx.logger.warn(`session-controller: created "${sessionId}" without a request principal; observer skipped`)
      return
    }
    try {
      await notify(principal, sessionId)
    } catch (error) {
      this.ctx.logger.warn(
        `session-controller: onSessionCreated for "${sessionId}" failed: ${String(error)}`,
      )
    }
  }

  /**
   * Admit one stream before its first frame: the judgment runs on first pull,
   * so a denial rejects the stream before any snapshot frame is produced.
   * @param sessionId - addressed durable Session identity.
   * @param source - the unstarted stream.
   * @returns the admitted stream.
   */
  async *admittedStream<Frame>(sessionId: SessionId, source: AsyncIterable<Frame>): AsyncIterable<Frame> {
    await this.assertSessionAccess(sessionId)
    yield* source
  }
}

function forbidden(message: string, details: object): TypertRemoteFailure {
  return new TypertRemoteFailure({ code: 'forbidden', message, details })
}
```

(c) `src/history.ts:233` — `function addressId(` 改 `export function addressId(`（JSDoc 补一行「@returns the Session identity the address names.」）。

(d) `src/index.ts`：import `SessionFilterHooks`（types）、`SessionAccessPolicy`（access）、`addressId`（history）；字段 `private readonly access: SessionAccessPolicy`；构造器 `this.listState = …` 之后 `this.access = new SessionAccessPolicy(ctx)`；public 面加：

```ts
/**
 * Claim the single session-hook seat: optional list, admission, and creation
 * callbacks consulted by the Session Remote methods. A second registration
 * throws because two access policies cannot compose.
 * @param hooks - listFilter, accessCheck, and onSessionCreated callbacks.
 * @returns the disposer releasing the seat.
 */
registerSessionFilter(hooks: SessionFilterHooks): () => void {
  return this.access.register(hooks)
}

/**
 * The reusable admission judgment behind every sessionId-bearing Remote
 * method: any future direct route addressing a Session consumes the same
 * verdict (fail-closed `forbidden`).
 * @param sessionId - addressed durable Session identity.
 * @throws TypertRemoteFailure code `forbidden` on denial.
 */
assertSessionAccess(sessionId: SessionId): Promise<void> {
  return this.access.assertSessionAccess(sessionId)
}
```

方法接线（每个方法的既有 JSDoc 保留，正文首行加准入/过滤/回调）：

```ts
@Remote('list')
async list(_request: SessionListRequest, signal: AbortSignal): Promise<SessionListValue> {
  return { items: await this.access.applyListFilter(await this.listState.list(signal)) }
}

@Remote('search')
async search(request: SessionSearchRequest, signal: AbortSignal): Promise<SessionSearchValue> {
  const value = await this.listState.search(request.query, signal)
  // hasMore describes the provider page, not the filtered view.
  return { ...value, items: await this.access.applyListFilter(value.items) }
}

@Remote('create')
async create(request: SessionCreateRequest): Promise<SessionCreateValue> {
  this.access.assertCreationAdmission()
  const value = await this.commands.create(request)
  await this.access.sessionCreated(value.sessionId)
  return value
}

// selectModel / rename / prompt / attachment / updateQueue / cancel —— 方法体首行：
await this.access.assertSessionAccess(request.sessionId)
// （prompt 保持其后的 signal.throwIfAborted()；其余照旧委托 commands）

@Remote('page')
async page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
  await this.access.assertSessionAccess(addressId(request.address))
  return this.history.page(request, signal)
}

@Remote('fork')
async fork(request: SessionForkRequest): Promise<SessionForkValue> {
  await this.access.assertSessionAccess(request.sessionId)
  this.access.assertCreationAdmission()
  const value = await this.commands.fork(request)
  await this.access.sessionCreated(value.sessionId)
  return value
}

@Remote({ mode: 'stream' })
follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
  return this.access.admittedStream(addressId(request.address), this.history.follow(request, signal))
}
```

(e) `package.json`：`peerDependencies` 与 `devDependencies` 各加 `"@deepseek-ai/dsh-host-webserver": "workspace:^"`；`tsconfig.host.json`：`files` 加 `"src/access.ts"`，`references` 加 `{ "path": "../../host/webserver" }`（client face 不动）。

**Step 4: GREEN + 全量矩阵**

```sh
pnpm vitest run packages/api/session-controller
```
预期：新 spec 全 PASS + **既有全部 spec 仍 PASS**（未配置=零行为差异的硬证据）。

**Step 5: README×3 同步**

`README.md` 在「Use this package」后加「The session filter seat」小节（三件套同步）：三回调协议、单席位/二次注册 throw/disposer、fail-closed（无主体/throw=deny+warn）、`forbidden` 失败码即 403 语义、search 的 hasMore 语义、`assertSessionAccess` 可复用原语；「Known Limitations and Deferred Work」加两条：`skills`/`fileReferences` 命名空间未接线（§2.6 理由）、`RpcErrorDetailsMap` 无 `forbidden` 键（client typed 映射随消费 PR 补）。

**Step 6: 门禁 + commit（四包全量 + tsc + pairing）**

```sh
pnpm vitest run packages/api/session-controller packages/api/gateway packages/client/connection packages/host/webserver
node ./node_modules/typescript/bin/tsc -b tsconfig.host.json   # 预期: 无输出, exit 0
pnpm run verify-translation-pairing                            # 预期: all consistent
git add packages/api/session-controller
git commit -m "feat(session-controller): add optional session access filter hooks"
```

## Task 4（本仓）— patch 重导出 + 工具链常量 + ADR-0006 §2 同步 + 自检

**Objective:** 宿主分支三 commit 落定后，把 `.patch` 副本刷新到新 tip，并同步工具链溯源元数据与 ADR（#17 工具链契约）。

**前置:** Task 1–3 已提交；记录宿主新 tip：

```sh
git -C /Users/wuyongjun/trea/deepseek-harness/.worktrees/dsh-request-guard log --oneline cd5ef8148158c3a752a658978873241fdf8e2bbc..HEAD
# 预期 4 行：1bd06a9 守卫 + Task1/2/3 三个新 commit
```

**Step 1: 重导出 patch（纯净 git diff，首行 diff --git）**

```sh
cd /Users/wuyongjun/trea/dsh-plugin/.worktrees/apiproxy-hooks-20
NEW_TIP=$(git -C /Users/wuyongjun/trea/deepseek-harness rev-parse dsh-request-guard)
git -C /Users/wuyongjun/trea/deepseek-harness diff cd5ef8148158c3a752a658978873241fdf8e2bbc.."$NEW_TIP" \
  > scripts/host-patches/deepseek-harness.dsh-request-guard.patch
head -1 scripts/host-patches/deepseek-harness.dsh-request-guard.patch   # 预期: diff --git a/packages/host/webserver/README.i18n.yaml ...
```

**Step 2: 同步 `scripts/host-patches/README.md` 状态表**

- 宿主分支行：`dsh-request-guard`（4 commits：webserver 守卫 + 请求主体载体 + 载体实证 + 会话过滤钩子）——「单 commit」表述更新为多 commit 列表（每条一行 message）。
- 分支 tip：新 tip 全 sha；变更规模：`git -C … diff --stat cd5ef814..<tip> | tail -1` 实测替换；导出命令行替换新 tip。
- 「自检」节基线 checkout 命令不变（基线仍是 `cd5ef814`）。

**Step 3: 同步 `scripts/host-patches/apply.sh` 常量**

`BRANCH_TIP_COMMIT` 替换为新 tip 全 sha（`BASELINE_COMMIT` 不变）。

**Step 4: ADR-0006 §2 同步**（`plugins/dsh-casdoor-auth/docs/adr/0006-zero-trust-private-port-guard.md`）

- §2 第一段改为多 commit 表述（4 commits + tip/规模），保持「单 commit」→「4 commits」的表述更新，其余升级循环语义不变。
- §2 末补一句（R1 记录）：ADR-0005 所述 `session.export` GET 旁路在基线 `cd5ef814` 不存在；#20 以可复用准入原语 `SessionController.assertSessionAccess` 的结构性覆盖落地（同判定供未来直达路由消费），不虚构端点。

**Step 5: 自检（README「自检」节流程，clone 验证 apply/already-applied）**

```sh
cd /Users/wuyongjun/trea/dsh-plugin/.worktrees/apiproxy-hooks-20/scripts/host-patches
tmp=$(mktemp -d /tmp/host-patch-selftest-XXXX)
git clone --quiet --no-hardlinks --shared /Users/wuyongjun/trea/deepseek-harness "$tmp"
git -C "$tmp" checkout --quiet --detach cd5ef8148158c3a752a658978873241fdf8e2bbc
./apply.sh --repo "$tmp" --check   # 预期: check ok, exit 0
./apply.sh --repo "$tmp"           # 预期: applied（输出应用文件数）
./apply.sh --repo "$tmp" --check   # 预期: already applied, skipping, exit 0
rm -rf "$tmp"
```

（`--shared` clone 只读宿主对象库，全程不对宿主仓做任何写操作；不触碰主 checkout。）

**Step 6: commit（恰 1 个，仅上述文件）**

```sh
git add scripts/host-patches/deepseek-harness.dsh-request-guard.patch \
        scripts/host-patches/README.md \
        scripts/host-patches/apply.sh \
        plugins/dsh-casdoor-auth/docs/adr/0006-zero-trust-private-port-guard.md
git commit -m "chore(host-patches): re-export dsh-request-guard patch with session filter hooks"
```

---

## 测试与验收命令汇总（最终门禁）

```sh
# 宿主 worktree（受影响包全量 + 类型 + 文档配对）
cd /Users/wuyongjun/trea/deepseek-harness/.worktrees/dsh-request-guard
pnpm vitest run packages/api/session-controller packages/api/gateway packages/client/connection packages/host/webserver
node ./node_modules/typescript/bin/tsc -b tsconfig.host.json
pnpm run verify-translation-pairing
# 本仓 worktree
cd /Users/wuyongjun/trea/dsh-plugin/.worktrees/apiproxy-hooks-20
git status --short   # 预期: 仅 Task 4 文件已提交，工作树干净
```

## 终审验收对照（Issue AC ↔ 证据）

| AC | 证据 |
| --- | --- |
| 未配置钩子宿主现有测试全绿 | Task 3 Step 4「既有全部 spec 仍 PASS」+ Task 1/2 未动既有断言 |
| 列表响应可被外部改写 | Task 3 矩阵 3（list/search 过滤 + hasMore 语义） |
| sessionId 方法可被外部 403 | Task 3 矩阵 4/5（九方法 forbidden + follow 流首帧拒绝）+ §2.2 失败码通道事实 |
| session.export GET 旁路同样受控 | R1 结构性覆盖（§2.5）：矩阵 7 直接消费 `assertSessionAccess` 原语 + ADR-0006 §2 记录 |
| onSessionCreated 携带主体与 sessionId | Task 3 矩阵 6（create/fork、引用相等断言、无主体 fail-closed、回调失败不毁响应） |
| 钩子通用形态并入工具链 | 宿主代码零产品词汇（principal 透传 unknown）；Task 4 重导出 + 状态表 + apply.sh + ADR-0006 §2 + 自检 |
