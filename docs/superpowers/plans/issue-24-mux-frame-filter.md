# Issue #24 — 宿主 mux 帧过滤钩子（ADR-0004 钩子③）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development — implement task-by-task with fresh implementer subagents, per-task spec + quality review, ≤5 fix rounds, final full-branch review.

**Goal:** 宿主 WS 下行事件泵获得**每连接帧过滤**钩子：连接（流代）建立时以 #20 管线的请求主体构造 `(principal) => frameFilter(sessionId, frameType) => boolean`；三类判定点——订阅基线、实时事件广播、新增会话帧——入队前先过外部过滤器。未配置 = 与 upstream 逐字节一致。

**Architecture:** 两个中性单席位钩子落在帧真正入队的两个包：gateway 为 `$events` 转发事件流（emit 广播 / waterfall 首放与补投）按 `RemoteEventClient` 持有的每连接过滤器判定；session-controller 为 `session/control` 流（baseline 全量会话循环 / queue/jobs/projection 广播）按每流过滤器判定。会话引用类帧（`api-session/*` 通知、agent-scoped waterfall）经判定；非会话状态帧放行；`ready`/`cancel` 协议帧不判定。会话引用提取表由事件发射方（session-controller）声明、经 api-remotes 装配传入 gateway 注册项，宿主零产品词汇。

**Tech Stack:** TypeScript (strict, ESM)、vendored Cordis Services、vitest（host specs）、git patch 工具链（`scripts/host-patches/`）。

---

## 0. 元数据与红线（必读）

- **Issue:** https://github.com/1123786563/dsh-plugin/issues/24（**以正文为准**：宿主 mux/events 帧过滤钩子；标题滞后正文一位，#14–#27 已知元数据错位，#16/#17/#18/#20 先例均以正文为准）。
- **本仓 worktree（dsh-plugin）:** `/Users/wuyongjun/trea/dsh-plugin/.worktrees/mux-frame-filter-24`，分支 `feat/gate-v2-24-mux-frame-filter`，基于 main `4c97956`。承载：本计划、patch 重导出、工具链常量、ADR-0006 §2 同步。本仓工作树内**只动** `docs/superpowers/plans/`、`scripts/host-patches/`、`plugins/dsh-casdoor-auth/docs/adr/0006-*.md`。
- **宿主仓 worktree（deepseek-harness）:** `/Users/wuyongjun/trea/deepseek-harness/.worktrees/dsh-request-guard`，分支 `dsh-request-guard`，当前 tip `d56a51edb79c7cd55ae6bc6183662c7a37030a32`（4 commits：#13 守卫 + #20 主体载体/实证/会话过滤钩子）。承载：全部钩子实现代码与宿主测试。基线 upstream master = `cd5ef8148158c3a752a658978873241fdf8e2bbc`。
- **红线（全程生效）：**
  - **不 push 两仓任何分支**；宿主分支 `dsh-request-guard` 永不 push，patch 是唯一交付载体。
  - 不动宿主仓主 checkout（detached）与 `origin/master`；一切宿主改动只在 `.worktrees/dsh-request-guard` 提交，clean conventional commits（无 fixup 噪音）。
  - 不动 live 3080 / 38080；测试一律 `127.0.0.1:0` 临时端口（现有 fixture 已如此）。
  - 不改 #13/#20 patch 既有行为（本计划是叠加，不重写 guard / principalOf / RemoteStreamScope / registerSessionFilter 语义）。
  - patch 导出 = commit-range diff（`cd5ef814..新 tip`），**仅源文件**；`pnpm-lock.yaml` 不得进入 patch（导出后断言），两仓任何 lockfile 漂移先 revert 再导出。
  - principal 一律取自 #20 管线（升级时 `principalOf(req)` + `RemoteStreamScope` 每消息重入），**不新增** principal 管道。

## 1. 已核实的宿主事实（planner 亲查 @ d56a51edb7，实施者可直接引用）

### 1.1 命名对账：「events.mux / events.host」→ 实际泵面

宿主只有**一个** WS 升级路由：`/api/remote.mux`（`packages/api/gateway/src/stream-protocol.ts:6`，ADR-0001 所写 `/api/events.mux`、`/api/events.host` 双路由在当前基线**不存在**，系探索前词汇）。issue 正文所指的下行泵实际是两条逻辑帧流，各自同时跑在 WS mux 载体与进程内 host 载体上（gateway README:48「Browsers use Remote mux, while in-process compositions use `connection.rpc.open`」）：

- **泵 A — `$events` 转发 Host 事件流**（gateway 内部逻辑流，端点常量 `'$events'`，`stream-protocol.ts:9`）：api-remotes 把宿主 Cordis 事件（allowlist：`API_REMOTE_FORWARDED_EVENTS`，`packages/api/remotes/src/remote-events.ts:16-31`，含 `api-session/added|removed|status|error|activity` 五个会话引用事件 + `approval/request`、`user-questions/request` 两个 agent-scoped waterfall + 其余宿主/workspace 状态事件）转发进唯一 source，gateway 为每个 Client 流代维护 `RemoteEventQueue` 下发。
- **泵 B — `session/control` 实时控制流**（stream Remote 方法，`packages/api/session-controller/src/index.ts:445-448` → `src/control.ts`）：连接（流代）即 yield 全量会话 baseline，随后广播 queue/jobs/projection 帧，**每帧都带 sessionId**。

另有的下行流不在本票泄漏面：`session/follow`（单会话流，#20 已在首帧前准入，`index.ts:435-438`）；workspace `follow`（见 OQ2）。

### 1.2 三个判定点的精确位置（未配置现状 = 无收件人过滤）

**泵 A（gateway，`packages/api/gateway/src/index.ts`）：**

1. **订阅基线**（连接即全量补投）: `:432` — `openRemoteEvents`（`:395-439`）为新 Client 建队后，`for (const pending of this.pendingRemoteEvents.values()) this.deliverRemoteEvent(pending, client)`：把**所有** pending waterfall 无差别补投给新连接。
2. **实时事件广播**: `:458-466` — `broadcastRemoteEvent` 把每条 emit 帧 `for (const client of this.remoteEventClients.values()) client.queue.push(wire)` 推给**所有** Client。
3. **新增事件补投**: `:526` — `startRemoteEvent`（`:468-530`）把新 pending waterfall `for (const client of ...) this.deliverRemoteEvent(pending, client)` 投给**所有** Client；`:532-536` `deliverRemoteEvent` 同时把 client 记入 `pending.deliveries`（决定其能否经 `$events/result` 应答、是否收到 `:587-591` 的 cancel 帧）。

**泵 B（session-controller，`packages/api/session-controller/src/control.ts`）：**

1. **订阅基线**（连接即全量订阅的循环）: `:54-65` `control()` 首帧 yield `baseline()`（`:67-81`）——`this.ctx.sessions.list()` 遍历**全部**会话，逐会话产出 queues/jobs/projections 三张 Record（`:83-99` projectionBaseline 同样全量）。
2. **实时广播**: `:131-133` `broadcast(frame)` 把 queue（`:101-110`）/jobs（`:112-124`）/projection（`:25-35`）帧推给**所有** `this.streams`，无收件人判定。
3. **新增会话补订阅**: `:39-42` `ctx.on('session/created')` 把新会话的 jobs 帧广播给所有流（经 `broadcast` → 同一无过滤路径）。

会话引用事件的**发射源**（供提取表对账，`packages/api/session-controller/src/index.ts`）：`api-session/added` args=[SessionSummary]（`:140-142`，`summaryFor` 产 `SessionSummary{sessionId,...}`，`src/list.ts:120`）；`api-session/removed` args=[sessionId]（`:143-145`）；`api-session/status` args=[agent.id]（`:146-148`）；`api-session/error` args=[id, chain]（`:149-151`）；`api-session/activity` args=[id, time]（`:152-164`）。agent id ≡ session id（`:147` 直接以 `agent.id` 作会话 id 发射）。

### 1.3 principal 在连接建立时的可用性（#20 管线，复用不新增）

- 升级收口：gateway 注册 mux 升级路由（`index.ts:216-239`），handler 内 `const principal = webCtx.webServer.principalOf(req)`（`:228`）→ `mux.handleUpgrade(req, socket, head, principal === undefined ? undefined : run => runWithRequestPrincipal(principal, run))`（`:229-231`）。
- 每消息重入：`RemoteStreamMuxServer.handleUpgrade` 的可选 `RemoteStreamScope` seam（`stream-server.ts:28`、`:56-69`）；`RemoteStreamMuxConnection.run` 在每条消息上 `this.scope(() => this.receive(rawText(data)))`（`stream-server.ts:123`）。
- 因此 `$events` 的 open（`receive → pump → openWireStream:384-393 → openRemoteEvents`）与 `session/control` 的流方法体（`openWireStream → stream() → Reflect.apply`）都运行在连接的 principal continuation 内，`currentRequestPrincipal()`（`packages/host/webserver/src/request-principal.ts:27`）可读。**端到端已证**：`packages/api/gateway/tests/request-principal.host.spec.ts:132-144`（stream 方法经真实 WS mux 读到 principal）；`webserver/src/index.ts` HTTP wrap `:299` / upgrade wrap `:417`。
- 广播路径（`broadcastRemoteEvent`、`control.broadcast`）运行在宿主事件源上下文，**不在**任何连接的 ALS 内——所以每连接过滤器必须在流代建立时构建并存在队列/流对象上（本设计如此）。
- 进程内载体（`connection.rpc.open` / `wireStream`，无 HTTP 请求）principal 为 undefined：工厂收到 undefined，策略归注册方（见 §2.3）。

### 1.4 依赖面与测试基建（均已就位，无需新依赖）

- gateway、session-controller 均已 peer+dev 依赖 `@deepseek-ai/dsh-host-webserver`（#20 已加）；remotes 已依赖 gateway + session-controller（`remotes/package.json:64-65`）。本计划**零 package.json / tsconfig 变更**。
- `session-controller/src/remote-events.ts` 同时在 host/client 两个 tsconfig face（client face 只 reference gateway 的 **client** face）——新增导出必须零宿主专属 import（本设计用局部结构类型）。
- 既有测试基建：gateway `$events` 真实 WS 测试与 `openEventClient`/`sendEventResult`/`deliveredInvocation` 助手（`gateway-stream.host.spec.ts:1064-1135`）；control 直测 fixture（`control-jobs.host.spec.ts`/`control-queue.host.spec.ts` 直接 `new SessionControlController(ctx)` + `control.control(signal)` 迭代器）；remotes 结构探针（`remote-events.host.spec.ts`，`ctx.reflect.provide('typertGateway', probe)`，加可选第三参不破坏探针）。
- **基线绿（planner 已实测）**：`pnpm vitest run packages/api/gateway packages/api/session-controller packages/api/remotes packages/host/webserver` → 45 files / 715 tests 全过，exit 0（tip `d56a51edb7`，工作树干净）。这是「未配置 = 现有测试全绿」的起点证据。

## 2. 钩子协议与关键设计裁定（终审复核点）

### 2.1 协议形状（issue 钉死：`(principal) => frameFilter(sessionId, frameType) => boolean`，未配置 = 不过滤）

```ts
// gateway — packages/api/gateway/src/types.ts（仅类型）
/** 提取一条转发通知引用的 Session；无引用（状态帧）返回 undefined。 */
export type RemoteEventSessionReference = (args: readonly unknown[]) => string | undefined

/** 单条会话引用帧的每连接判定。 */
export type RemoteEventFrameFilter = (sessionId: string, frameType: string) => boolean

/** 由流代建立时的请求主体构造该连接的帧过滤器。 */
export type RemoteEventFrameFilterFactory = (principal: unknown) => RemoteEventFrameFilter

/** registerRemoteEvents 的可选注册事实。 */
export interface RemoteEventRegistrationOptions {
  /** 事件名 → Session 引用提取；无提取器的事件（状态帧）不经判定直接放行。 */
  readonly sessionReferenceOf?: Readonly<Record<string, RemoteEventSessionReference>>
}

// session-controller — packages/api/session-controller/src/types.ts（仅类型）
export type SessionControlFrameType = SessionControlFrame['type'] // 'baseline' | 'queue' | 'jobs' | 'projection'
export type SessionControlFrameFilter = (sessionId: SessionId, frameType: SessionControlFrameType) => boolean
export type SessionControlFrameFilterFactory = (principal: unknown) => SessionControlFrameFilter
```

- **单席位 ×2**（对齐 #13 `registerGuard`、#20 `registerSessionFilter` 先例）：gateway `registerRemoteEventFrameFilter(factory)`（二次注册 throw、disposer 释放）；session-controller `registerControlFrameFilter(factory)`（委托 `SessionControlController.registerFrameFilter`，直测 fixture 可用，镜像 `SessionAccessPolicy` 形态）。
- **判定只针对会话引用帧；状态帧放行**（issue 原文语义）：
  - waterfall 帧：恒为会话引用——sessionId = `frame.agentId`（Branded string，agent id ≡ session id，§1.2）；frameType = 事件名。deny 时不入队也**不入 `pending.deliveries`**（该连接永远无法应答不可见会话的 approval/user-questions，也不会收到其 cancel 帧——`receiveRemoteEventResult:538-557` 对不在 deliveries 的 client 是幂等 no-op，天然一致）。
  - emit 帧：事件名在 `sessionReferenceOf` 表中且提取出 sessionId → 判定；无提取器或提取 undefined → 放行（发射方为同进程可信宿主事件，提取 undefined 只能是未注册状态帧）。
  - `ready`（`:434`）与 `cancel`（`:587-591`）协议帧：不判定（cancel 只会到达已在 deliveries 的 client）。
  - control 帧：全部带 sessionId——baseline 按会话逐个判定（`'baseline'`），queue/jobs/projection 按帧判定（帧 type 作 frameType）。
- **过滤器为同步 boolean**（issue 钉死 `=> bool`）：baseline 构建与广播入队都是同步 push 路径，异步会迫使队列语义改动。与 #20 的可异步 listFilter/accessCheck 不同，本钩子协议明确同步，JSDoc 写明。
- **过滤器 throw = 丢帧 + `logger.warn`**（对齐 #20 fail-closed + 容错先例）：绝不放行未知错误，也绝不因一个连接的过滤器拆掉广播循环或流。

### 2.2 会话引用提取表：发射方声明、装配方传递、gateway 执行（采纳）

- 知识归属：`api-session/*` 的参数形状属 session-controller（发射方）；gateway 是通用设施，不得硬编码这些事件名（违反包所有权）。
- 落地：session-controller `src/remote-events.ts`（双 face 文件）新增导出 `SESSION_CONTROLLER_SESSION_REFERENCES`（局部结构类型 `(args) => string | undefined`，零跨 face import）：`api-session/added → args[0].sessionId`（summary），其余四个 `→ args[0]`（string）。api-remotes 装配时作为 `registerRemoteEvents` 第三参传入。api-remotes 是 `registerRemoteEvents` 唯一生产调用方（`remotes/src/index.ts:39`），签名加可选参为纯叠加。
- 被否方案：gateway 内硬编码 `api-session/*` 前缀（包所有权违规）；过滤器直接收原始帧由插件分类（偏离 issue 钉死的 `(sessionId, frameType)` 协议，且把宿主事件词汇泄给插件）。

### 2.3 principal 缺席 = 工厂收到 undefined，策略归注册方（采纳）

- 宿主只保证：**未注册工厂 = 逐字节 upstream 行为；注册后每个会话引用帧入队前必经该连接过滤器**。工厂收到的 principal 原样透传（WS mux 连接 = guard principal；进程内载体 = undefined）。
- 理由：ADR-0004 哲学是宿主零产品词汇；fail-closed（对 undefined principal 返回 deny-all）是 dsh-casdoor-auth 插件工厂（#22 消费轨）的策略选择。宿主侧硬拒绝无 principal 的 `$events` open 会拆掉进程内合法组合（worker-host/webworker-runtime 经 `wireStream` 消费，无 HTTP 请求）。
- 部署事实兜底：真实部署里浏览器一律经网关 + #13 守卫（#18 zero-trust 拒匿名），WS 连接必有 principal。

### 2.4 两个泵都接线（采纳；「events.mux/events.host」= 同一钩子协议覆盖两条载体路径）

issue 的三判定点分布在两个包（§1.2）；只接一个泵即留下另一条全文泄露路径（control baseline 直接带全部会话的 queue/jobs/projection 内容）。两席位同协议同语义，插件（#22）用同一可见性谓词注册两者。过滤器构建点在流代 open（`openRemoteEvents` / `control()` 首段），对 WS mux 与进程内两种载体一致生效——这正是「events.mux / events.host」两种载体形态的同构覆盖。

### 2.5 commit 结构（宿主 3 + 本仓 1）

宿主：①`feat(gateway): add optional per-connection forwarded-event frame filter`；②`feat(session-controller): filter control frames and declare session references`；③`feat(api-remotes): declare session references for forwarded events`。每步提交后受影响包 vitest + root host face tsc 全绿（增量可验证；②的提取表导出在③被消费，②内自有单测消费不致 knip 未用告警）。本仓：Task 4 的 `chore(host-patches): …` 重导出 commit。

## 范围

宿主（`dsh-request-guard` 分支，3 commits）：

1. gateway：`src/types.ts` 过滤器/提取器类型 + `TypertGateway.registerRemoteEvents` 可选 options；`src/index.ts` 席位 + `RemoteEventClient.frameFilter` + 三判定点接线；`tests/event-frame-filter.host.spec.ts` 测试矩阵；README×3。
2. session-controller：`src/types.ts` 过滤器类型；`src/control.ts` 席位 + 每流过滤器 + baseline/broadcast 接线；`src/index.ts` 委托；`src/remote-events.ts` 提取表；`tests/control-filter.host.spec.ts`；README×3。
3. api-remotes：`src/index.ts`（或 `src/remote-events.ts` 旁）把提取表传入 `registerRemoteEvents` 第三参；探针测试断言；README×3。

本仓（1 commit）：patch 重导出（覆盖至新 tip）+ README 状态表 + `apply.sh` 常量 + ADR-0006 §2 同步 + 三态自检 + byte-identical 证明。

## 非目标

- 不做 WS 三视角实况验收（#25 领地：两租户并发连网关断言互不可见）；不做插件侧过滤器实现（#22：listByOwner/assertSessionAccess/claim 与本票过滤器工厂都在插件轨）。
- 不动 #13/#20 既有行为（叠加式）；不新增 principal 管道；不改 `RemoteStreamScope`/`runWithRequestPrincipal` 语义。
- 不接线 workspace `follow`（OQ2：sessionIds 分组披露，另行裁定）；不给 `session/follow` 加逐帧复判（#20 已在首帧前准入，单会话流、所有权不可变，OQ4）。
- 不改 wire 协议（帧类型、`$events` 端点、mux 消息格式零变化）；不改 client contract / 两个 SDK。
- 不 push 任何分支；不动 live 3080/38080；不动宿主主 checkout 与 `origin/master`。

---

## Task 1（宿主）— gateway `$events` 每连接帧过滤器（席位 + 三判定点 + 测试矩阵）

**Objective:** `TypertGatewayService` 落地 §2.1/§2.2 的 gateway 侧协议与接线；未配置时现有 gateway 测试全绿零改动，配置后 issue AC 的泵 A 三判定点全部生效。

**Files:**
- Modify: `packages/api/gateway/src/types.ts`（`RemoteEventSessionReference` / `RemoteEventFrameFilter` / `RemoteEventFrameFilterFactory` / `RemoteEventRegistrationOptions`；`TypertGateway.registerRemoteEvents` 加可选第三参 `options`，JSDoc 同步）
- Modify: `packages/api/gateway/src/index.ts`（席位字段与 `registerRemoteEventFrameFilter` 方法；`registerRemoteEvents` 存 `this.sessionReferenceOf`；`RemoteEventClient`（`:97-101`）加 `readonly frameFilter: RemoteEventFrameFilter | undefined`；`openRemoteEvents` 在 `:415` registration 检查后构建 `const frameFilter = this.eventFrameFilter?.(currentRequestPrincipal())` 并放进 `:426-430` 的 client 对象；`deliverRemoteEvent`（`:532`）首行判定；`broadcastRemoteEvent`（`:458-466`）emit 提取 + 逐 client 判定；私有 `admits(client, sessionId, frameType)` 带 throw 容错 + warn；import `currentRequestPrincipal`）
- Modify: `packages/api/gateway/README.md` + `README.zh.md` + `README.i18n.yaml`
- Create: `packages/api/gateway/tests/event-frame-filter.host.spec.ts`

**Step 1: 写失败测试**（新 spec；复用 `gateway-stream.host.spec.ts` 的 `openEventClient`/`sendEventResult`/`deliveredInvocation`/`browserCookie` 助手与 fake source 形态，及 `request-principal.host.spec.ts` 的真 WebServer + `registerGuard` boot 形态）

矩阵（每条一个 it）：

1. **席位**：第二次 `registerRemoteEventFrameFilter` throw `/already registered/`；disposer 释放后行为回到现状（HMR 语义）。
2. **principal 可达性（突变验证义务）**：真 WebServer + `registerGuard` 带 principal + 真 WS mux open `$events`：工厂收到该 principal 对象（`toEqual` 断言）。随后临时注释 `openRemoteEvents` 的工厂调用重跑必须变红（收到 undefined），恢复后 GREEN——防恒真。
3. **emit 判定**：注册带 `sessionReferenceOf` 的 source；过滤器只放行 `sess-a`：发 `api-session/added`(summary of invisible `sess-b`) → 该 client 无此帧；发 `sess-a` 的 added → 帧到达且 `args` 深相等（**自帧完整性**）；发无提取器的状态事件（如 `settings/document-updated`）→ 到达（**状态帧放行**）。
4. **订阅基线（`:432`）**：连接前制造 invisible 会话的 pending waterfall（照 `gateway-stream.host.spec.ts` 既有的 waterfall fixture）→ 新连接不收到该 invocation（`deliveredInvocation` undefined），向其 POST 该 eventId 的 result 为幂等 no-op（不断言错误）；visible 会话的 pending → 收到。
5. **实时补投（`:526`）**：连接后新起 invisible 会话的 waterfall → 不投递；visible → 投递且可正常 `sendEventResult` 结算。
6. **fail-closed**：过滤器 throw → 帧被丢 + `vi.spyOn(ctx.logger, 'warn')` 命中；流与广播循环不毁（后续 visible 帧仍达）。

（无 principal 的进程内路径：工厂收到 undefined 的断言并入矩阵 3——用 `wireStream.open('$events', …)` 或不注册 guard 的 WS open。）

**Step 2: 跑 RED**

```sh
cd /Users/wuyongjun/trea/deepseek-harness/.worktrees/dsh-request-guard
pnpm vitest run packages/api/gateway -t 'frame filter'
```

预期：FAIL（`registerRemoteEventFrameFilter` 不存在、`RemoteEventRegistrationOptions` 类型缺失，编译/导入错误）。

**Step 3: 实现**（§2.1/§2.2 骨架；`admits` 对 waterfall 用 `pending.frame.agentId`、对 emit 用提取结果；`deliverRemoteEvent` 在 deny 时直接 return——不入 `pending.deliveries`、不入队）

**Step 4: GREEN + 全量**

```sh
pnpm vitest run packages/api/gateway   # 新 spec 全 PASS + 既有 94+33+22+… 全 PASS（未配置零行为差异的硬证据）
```

**Step 5: README×3**：gateway README 事件源段落补「per-connection frame filter seat」：协议、单席位/二次 throw/disposer、会话引用分类（waterfall 恒判、emit 查表、ready/cancel 不判）、throw=丢帧+warn、未配置零差异。

**Step 6: 门禁 + commit**

```sh
pnpm vitest run packages/api/gateway packages/api/session-controller
node ./node_modules/typescript/bin/tsc -b tsconfig.host.json   # 预期: 无输出, exit 0
pnpm run verify-export-jsdoc && pnpm run verify-translation-pairing
git add packages/api/gateway
git commit -m "feat(gateway): add optional per-connection forwarded-event frame filter"
```

## Task 2（宿主）— session-controller control 帧过滤 + 会话引用提取表

**Objective:** `session/control` 流的三判定点接线（§1.2 泵 B）；导出 `api-session/*` 提取表供 Task 3。

**Files:**
- Modify: `packages/api/session-controller/src/types.ts`（`SessionControlFrameType` / `SessionControlFrameFilter` / `SessionControlFrameFilterFactory`，仅类型）
- Modify: `packages/api/session-controller/src/control.ts`（`streams` 集合元素改 `{queue, filter}`；`registerFrameFilter` 单席位；`control()` 首段 `const filter = this.frameFilterFactory?.(currentRequestPrincipal())`；`baseline(filter)` 先按 `filter(sessionId, 'baseline')` 过滤会话列表再建三张 Record；`broadcast` 逐流判定；判定 throw → 丢帧 + warn；import `currentRequestPrincipal`）
- Modify: `packages/api/session-controller/src/index.ts`（public `registerControlFrameFilter(factory)` 委托 `this.controlState.registerFrameFilter`，JSDoc 完整）
- Modify: `packages/api/session-controller/src/remote-events.ts`（`SESSION_CONTROLLER_SESSION_REFERENCES` 常量：`added → args[0].sessionId`、`removed|status|error|activity → args[0]`；局部结构类型，双 face 可编译，零新 import）
- Create: `packages/api/session-controller/tests/control-filter.host.spec.ts`
- Modify: `README.md` + `README.zh.md` + `README.i18n.yaml`

**Step 1: 写失败测试**（新 spec；fixture 照 `control-jobs.host.spec.ts` 的 `harness()` 直测 `SessionControlController`；principal 用 `runWithRequestPrincipal`（webserver 依赖 #20 已备））

矩阵：

1. **席位**：二次注册 throw；disposer 恢复现状。
2. **订阅基线**：两会话，过滤器只放行其一 → 首帧 baseline 的 queues/jobs/projections 三张 Record **只含** visible 会话键；visible 会话条目完整（**自帧完整性**，深相等）。
3. **实时广播**：invisible 会话的 queue（`agent/inbox/spliced` 路径，照 control-queue 既有 fixture）/jobs/projection 帧不入流；visible 的帧到达且逐字节不变。
4. **新增会话**：`session/created` 后 invisible 新会话的 jobs 帧不入流；visible 新会话的到达。
5. **principal 透传**：`runWithRequestPrincipal({userId:'u1'}, …)` 内 open → 工厂收到该对象；无 wrap → undefined（宿主中立，§2.3）。
6. **fail-closed**：过滤器 throw → 帧丢弃 + warn；流存活。
7. **提取表**：`SESSION_CONTROLLER_SESSION_REFERENCES['api-session/added']([{sessionId:'s1',…}]) === 's1'`；其余四事件 `([ 's2' ]) === 's2'`；越界/异形 args → undefined。

**Step 2: 跑 RED**：`pnpm vitest run packages/api/session-controller -t 'frame filter'` → FAIL（`registerControlFrameFilter`/`SESSION_CONTROLLER_SESSION_REFERENCES` 不存在）。

**Step 3: 实现**（§2.1 骨架；baseline 过滤在会话列表层一次完成，三张 Record 自然同集）

**Step 4: GREEN + 全量**：`pnpm vitest run packages/api/session-controller`（新 spec 全 PASS + 既有含 control-jobs/control-queue 全 PASS）。

**Step 5: README×3**：「The control frame filter seat」小节：协议、baseline/broadcast/new-session 三判定点、帧 type 词表（baseline/queue/jobs/projection）、throw=丢帧+warn、未配置零差异、提取表用途与归属。

**Step 6: 门禁 + commit**

```sh
pnpm vitest run packages/api/session-controller packages/api/gateway
node ./node_modules/typescript/bin/tsc -b tsconfig.host.json && node ./node_modules/typescript/bin/tsc -b tsconfig.client.json
pnpm run verify-export-jsdoc && pnpm run verify-translation-pairing
git add packages/api/session-controller
git commit -m "feat(session-controller): filter control frames and declare session references"
```

## Task 3（宿主）— api-remotes 声明会话引用（装配收口）

**Objective:** 生产装配把提取表交给 gateway，泵 A 的 `api-session/*` 判定在生产组合里真实生效。

**Files:**
- Modify: `packages/api/remotes/src/remote-events.ts`（import `SESSION_CONTROLLER_SESSION_REFERENCES` 并随 `API_REMOTE_FORWARDED_EVENTS` 一并再导出，或在 `index.ts` 直接 import——择一，保持与既有 `SESSION_CONTROLLER_REMOTE_EVENTS` import 同风格）
- Modify: `packages/api/remotes/src/index.ts:39`（`registerRemoteEvents(remoteEventSource(ctx), { home: homedir() }, { sessionReferenceOf: SESSION_CONTROLLER_SESSION_REFERENCES })`）
- Modify: `packages/api/remotes/tests/remote-events.host.spec.ts`（探针 `GatewayProbe` 捕获第三参：断言含 `api-session/added` 提取器且对 summary 提取正确；既有 6 个 it 保持不动全绿）
- Modify: `README.md` + `README.zh.md` + `README.i18n.yaml`

**Step 1: RED** — 探针新增断言 FAIL（第三参 undefined）。
**Step 2: 实现**（一行装配 + 再导出）。
**Step 3: GREEN + 门禁 + commit**

```sh
pnpm vitest run packages/api/remotes packages/api/gateway packages/api/session-controller
node ./node_modules/typescript/bin/tsc -b tsconfig.host.json
pnpm run verify-export-jsdoc && pnpm run verify-translation-pairing
git add packages/api/remotes
git commit -m "feat(api-remotes): declare session references for forwarded events"
```

## Task 4（本仓）— patch 重导出 + 工具链常量 + ADR-0006 §2 同步 + 三态自检

**Objective:** 宿主三 commit 落定后刷新 `.patch` 副本到新 tip，同步溯源元数据与 ADR（#17 工具链契约）。

**前置:** Task 1–3 已提交；记录宿主新 tip：

```sh
git -C /Users/wuyongjun/trea/deepseek-harness/.worktrees/dsh-request-guard log --oneline cd5ef8148158c3a752a658978873241fdf8e2bbc..HEAD
# 预期 7 行：既有 4 + Task1/2/3 三个新 commit；git status 两仓均干净（lockfile 漂移先 revert）
```

**Step 1: 重导出（纯净 git diff，首行 `diff --git`，仅源文件）**

```sh
cd /Users/wuyongjun/trea/dsh-plugin/.worktrees/mux-frame-filter-24
HOST=/Users/wuyongjun/trea/deepseek-harness/.worktrees/dsh-request-guard
NEW_TIP=$(git -C "$HOST" rev-parse HEAD)
git -C "$HOST" diff cd5ef8148158c3a752a658978873241fdf8e2bbc.."$NEW_TIP" \
  > scripts/host-patches/deepseek-harness.dsh-request-guard.patch
head -1 scripts/host-patches/deepseek-harness.dsh-request-guard.patch          # 首行必须是 diff --git
! grep -q '^diff --git a/pnpm-lock.yaml' scripts/host-patches/deepseek-harness.dsh-request-guard.patch   # 无 lockfile（exit 1 为通过）
```

**Step 2: byte-identical 证明**

```sh
git -C "$HOST" diff cd5ef8148158c3a752a658978873241fdf8e2bbc.."$NEW_TIP" | cmp - scripts/host-patches/deepseek-harness.dsh-request-guard.patch
# 预期: 无输出 exit 0（提交副本与同命令重生成逐字节一致）
```

**Step 3: 同步 `scripts/host-patches/README.md` 状态表** — 宿主分支行改 7 commits（逐条 message）；tip 换新全 sha；规模 `git -C "$HOST" diff --stat cd5ef814..<tip> | tail -1` 实测；导出命令行换新 tip；基线行不变。

**Step 4: 同步 `apply.sh` 常量** — `BRANCH_TIP_COMMIT` 换新全 sha（`BASELINE_COMMIT` 不变）。

**Step 5: ADR-0006 §2 同步**（`plugins/dsh-casdoor-auth/docs/adr/0006-zero-trust-private-port-guard.md`）— §2 首段改 7 commits + 新 tip/规模；补 #24 段：两席位协议（`registerRemoteEventFrameFilter` / `registerControlFrameFilter`）、会话引用分类（waterfall=agentId 恒判、emit 查 `SESSION_CONTROLLER_SESSION_REFERENCES` 表、ready/cancel 不判）、principal 缺席 = 工厂收 undefined 策略归注册方（§2.3）、OQ2/OQ4 已裁定的记录（workspace follow 不在 scope；follow 无逐帧复判）。

**Step 6: 三态自检（clone 验证 check → applied → already-applied）**

```sh
cd /Users/wuyongjun/trea/dsh-plugin/.worktrees/mux-frame-filter-24/scripts/host-patches
tmp=$(mktemp -d /tmp/host-patch-selftest-XXXX)
git clone --quiet --no-hardlinks --shared /Users/wuyongjun/trea/deepseek-harness "$tmp"
git -C "$tmp" checkout --quiet --detach cd5ef8148158c3a752a658978873241fdf8e2bbc
./apply.sh --repo "$tmp" --check   # → check ok, exit 0
./apply.sh --repo "$tmp"           # → applied（输出应用文件数）
./apply.sh --repo "$tmp" --check   # → already applied, skipping, exit 0
rm -rf "$tmp"
```

（`--shared` clone 只读宿主对象库，全程不写宿主仓。）

**Step 7: commit（恰 1 个，仅上述文件）**

```sh
git add scripts/host-patches/deepseek-harness.dsh-request-guard.patch \
        scripts/host-patches/README.md \
        scripts/host-patches/apply.sh \
        plugins/dsh-casdoor-auth/docs/adr/0006-zero-trust-private-port-guard.md
git commit -m "chore(host-patches): re-export dsh-request-guard patch with mux frame filter hooks"
```

---

## 测试与验收命令汇总（最终门禁）

```sh
# 宿主 worktree（受影响包全量 + 双 face 类型 + JSDoc/翻译配对）
cd /Users/wuyongjun/trea/deepseek-harness/.worktrees/dsh-request-guard
pnpm vitest run packages/api/gateway packages/api/session-controller packages/api/remotes packages/host/webserver
node ./node_modules/typescript/bin/tsc -b tsconfig.host.json
node ./node_modules/typescript/bin/tsc -b tsconfig.client.json
pnpm run verify-export-jsdoc && pnpm run verify-translation-pairing
# 本仓 worktree
cd /Users/wuyongjun/trea/dsh-plugin/.worktrees/mux-frame-filter-24
git status --short   # 预期: 仅 Task 4 文件已提交，工作树干净
```

## 终审验收对照（Issue AC ↔ 证据）

| AC | 证据 |
| --- | --- |
| 未配置：宿主现有测试全绿 | 基线 715 tests 实测绿（§1.4）+ Task 1/2 Step 4 既有 spec 零改动全绿 |
| 配置后：订阅基线/实时事件/新增会话帧均经判定，不可见会话帧不入该连接队列 | 泵 B：Task 2 矩阵 2/3/4（baseline 循环、broadcast、session/created）；泵 A：Task 1 矩阵 3/4/5（emit 广播、pending 首放 :432、补投 :526） |
| events.host 会话引用帧按可见性过滤、状态帧放行 | Task 1 矩阵 3（查表判定 + 无提取器状态事件放行）+ Task 3（生产装配 `api-session/*` 提取表）+ waterfall 恒判（agentId）矩阵 4/5 |
| 过滤不破坏自己会话帧完整性 | Task 1 矩阵 3/5、Task 2 矩阵 2/3 的深相等断言 |
| patch 并入工具链管理 | Task 4：三态自检 + byte-identical `cmp` + 状态表/apply.sh/ADR-0006 §2 |

## OQ（未决问题 + 推荐默认）

1. **「events.mux / events.host」双路由名与宿主单路由现实不符**（§1.1：宿主只有 `/api/remote.mux`；两个名字对应两条逻辑帧流 × 两种载体）。推荐默认：按 §1.1/§2.4 的映射执行（两席位覆盖两泵双载体），ADR-0006 §2 记录命名对账；若终审认为还需第三个面，补 OQ 再议。
2. **workspace `follow` baseline 披露 sessionIds/workspace 分组**（`workspace-controller/src/feed.ts`，issue 未点名）。推荐默认：#24 不接线；作为已知残余面记入 ADR-0006 §2；后续如插件需要，用同席位模式给 `WorkspaceFeed` 补一枚钩子。
3. **principal 缺席时宿主是否硬拒**（进程内载体无 HTTP 请求）。推荐默认：宿主中立（工厂收 undefined，策略归插件，§2.3）；硬拒会拆 worker-host/webworker-runtime 的进程内消费。
4. **`session/follow` 是否逐帧复判**（#20 只在首帧前准入）。推荐默认：不加——单会话流、会话所有权不可变、逐帧复判无 AC 支撑；若未来引入可见性撤销再议。
5. **帧过滤器是否允许异步**（#20 的 listFilter/accessCheck 可 async）。推荐默认：同步 only（issue 钉死 `=> bool`；baseline/广播是同步 push 路径）；JSDoc 写明，插件侧可见性谓词须同步可判（SQLite 预载/内存缓存归 #22 轨）。
