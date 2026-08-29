# 0006 — zero-trust 私口守卫：宿主钩子语义、准入裁定与定名

**状态：已接受（2026-08-29 守卫已落地，本 ADR 为落地补记）**

ADR-0004 三件套中第 1 钩子（请求守卫）的插件侧消费记录：守卫实现见 `src/guard.ts`（`createCasdoorRequestGuard` / `applyGuard`），经 bundle patch 的 `guardEnabled` 开关装配（默认关）。本 ADR 四节：§1 宿主钩子语义（Agent Note 本体）、§2 patch 溯源与升级循环（含 #20 多 commit 溯源、准入记录 R1、WS 载体偏差与 abort/close 边界、#24 帧过滤席位记录）、§3 本轨设计裁定、§4 m1 定名记录。

## §1 宿主钩子语义（Agent Note）

唯一事实源：[`scripts/host-patches/deepseek-harness.dsh-request-guard.patch`](../../../../scripts/host-patches/deepseek-harness.dsh-request-guard.patch)（以下逐条对应 patch 落地代码，宿主 `packages/host/webserver/src/index.ts`）。

- **单席位**：`registerGuard(guard)` 认领唯一守卫席位，返回释放席位的 disposer；第二次注册直接 throw（`webserver: guard already registered`）——两个守卫无法组合。释放后席位可重新认领。
- **先于一切路由**：HTTP 请求在 `handle()` 顶部（路由匹配与回退之前）咨询守卫；upgrade 请求在查 upgrade 路由表之前咨询。守卫否决时，未注册路径得到的是否决（401）而非未匹配（404）。
- **决策判别联合**：`RequestGuardDecision = { allow: true; principal?: unknown } | { allow: false; status?: number; body?: string }`。HTTP 否决以 `status ?? 401` + `body ?? 'Unauthorized'` 应答（content-type `text/plain; charset=utf-8`），status 与 body 各自独立覆盖；upgrade 否决不发 101 直接 destroy socket。veto 字段按类型信任：非法 status（< 100）或非 string body 仍构成否决——请求落到既有 400 兜底或连接被拆。
- **fail-closed**：守卫 throw 或 reject → `logger.warn` 记录 + 按默认字段否决（HTTP 401 `'Unauthorized'`、upgrade 拆连接）——守卫失败绝不放行。
- **principal 传递**：allow 可附加 principal，宿主存入以请求对象为键的 `WeakMap<IncomingMessage, unknown>`；handler 经 `principalOf(req)` 读取，未跑守卫 / allow 未带 principal / 否决时读 undefined（请求结束即随 WeakMap 回收）。
- **决策窗口竞态**：守卫决策 pending 期间被拆的 upgrade socket 不进 upgraded set——其 close 事件已发，等它会挂死 teardown。
- **未配置守卫 = 宿主行为与 upstream 完全一致**：席位空时每个请求 `{ allow: true }`，无可观察差异；本 patch 对不打开 `guardEnabled` 的部署是零影响的。

## §2 patch 溯源与升级循环（含 #20 多 commit 溯源、准入记录 R1、WS 载体偏差与 abort/close 边界、#24 帧过滤席位记录）

宿主分支 `dsh-request-guard`（8 commits：webserver 守卫 + 请求主体载体 + 载体实证 + 会话过滤钩子 + mux 帧过滤钩子③及会话引用表装配）：tip `9cf768e3021030af274754e39bcca1d0f05d0fce`，基线（upstream master）`cd5ef8148158c3a752a658978873241fdf8e2bbc`，规模 33 文件 +2602/−97（`packages/api/gateway` + `packages/api/session-controller` + `packages/api/remotes` + `packages/host/webserver`，逐 commit 列表见状态表）。本仓副本 `scripts/host-patches/deepseek-harness.dsh-request-guard.patch` 保持纯净 git diff，溯源元数据在状态表与 `apply.sh` 常量里。

`apply.sh` 幂等语义：`--check` 先做 `git apply --check --reverse` 探测——已应用输出 `already applied, skipping` 退出 0；未应用则正向预演，基线不符/冲突退出 1 并提示基线 commit；实际应用后再次 reverse 探测确认、输出应用文件数，不自动 commit。宿主升级 = 宿主仓 `git fetch origin && git rebase origin/master` + 跑宿主门禁确认钩子行为未回归 + 以与生成时完全相同的 diff 命令重导出覆盖副本，同步状态表与 `apply.sh` 常量。完整循环与当前状态见 [`scripts/host-patches/README.md`](../../../../scripts/host-patches/README.md) 状态表。

#20 准入记录（R1）：ADR-0005 所述 `session.export` GET 旁路在基线 `cd5ef8148158c3a752a658978873241fdf8e2bbc` 不存在，不虚构端点；#20 以可复用准入原语 `SessionController.assertSessionAccess` 的结构性覆盖落地，同一判定供未来直达路由消费。

WS 载体偏差（计划 §2.1 计划内 fallback 实证）：原设「wrap handleUpgrade」传播 principal 被实证驳斥——ws 升级后 message 监听在 socket 原生读上下文触发，wrap 在任何帧到达前已退出。变体实现：`RemoteStreamMuxServer.handleUpgrade` 新增可选 `RemoteStreamScope` seam（恒等默认，既有调用方不变）+ gateway mux 每消息 `runWithRequestPrincipal` 重入。HTTP 载体仍走 webserver 收口（`aeb1a1e`），WS 载体经此 seam，双载体均经真实链路测试 + 突变验证（`29b9b97`）。

边界声明：WS mux 流的 abort/close 路径不在 #20 准入作用域内——准入只管首帧前 admit，流建立后的中止与关闭语义由既有 mux 生命周期承担。

#24 mux 帧过滤钩子（ADR-0004 钩子③）落地记录：issue 所称「events.mux / events.host」双路由在宿主基线不存在——宿主只有 `/api/remote.mux` 一个 WS 升级路由，两个名字实为两条逻辑帧流（`$events` 转发事件流、`session/control` 控制流）各跑在 WS mux 与进程内两种载体上，由以下两枚同协议席位同构覆盖：

- **两席位协议**：gateway `registerRemoteEventFrameFilter(factory)`（单席位，二次注册 throw，disposer 释放）在 `$events` 流代建立时构建 `(principal) => (sessionId, frameType) => boolean` 同步过滤器；session-controller `registerControlFrameFilter(factory)` 同形覆盖 `session/control` 流（baseline 逐会话以 `'baseline'` 判定，queue/jobs/projection 以帧 type 判定）。未认领席位 = 宿主行为与 upstream 逐字节一致。
- **会话引用分类**：waterfall 帧（approval/user-questions）恒为会话引用，以 `frame.agentId` 判定（agent id ≡ session id），deny 时不入队也不记入该流代的 deliveries——该连接永远无法应答不可见会话的 invocation，也收不到其 cancel 帧（result 应答为幂等 no-op）；emit 帧查 `sessionReferenceOf` 表——表由发射方 session-controller 以 `SESSION_CONTROLLER_SESSION_REFERENCES` 声明（`api-session/added` 取 summary 的 sessionId，其余四事件取 args[0]，异形参数返回 undefined）、api-remotes 装配时经 `registerRemoteEvents` 第三参传入，gateway 不硬编码任何事件名；无提取器或提取 undefined 的状态帧不经判定放行。`ready`/`cancel` 协议帧不经判定。
- **principal 缺席 = 工厂收 undefined**（计划 §2.3 裁定）：WS mux 连接传入 guard principal，进程内载体（无 HTTP 请求）传入 undefined；是否 fail-closed 归注册方策略——宿主硬拒会拆掉进程内合法组合（worker-host 等经 `wireStream` 消费）。
- **过滤器 throw = 丢该帧该连接 + `logger.warn`**：不因单连接过滤器中断广播循环或拆流。
- **已裁定 OQ**：workspace `follow` 不在 #24 作用域（sessionIds/workspace 分组披露作为已知残余面记录，插件如需再补同形席位）；`session/follow` 不加逐帧复判（#20 已在首帧前准入，单会话流所有权不可变）。
- **Documentation**：这些钩子的宿主仓级文档（Agent Note）刻意由本 ADR（插件仓）承载——patch 工具链交付设计的既定分工，宿主分支只承载代码、包内 README 与测试。

## §3 本轨设计裁定

- **launch-token 交换放行**：`?token=` 等于当前进程 launch token 时，经 sha256 摘要的常量时间比较后**裸放行**（不带 principal）——这是 stock 浏览器认证的自举凭证（网关 UpstreamAuth.exchange 以 `GET /?token=` 直连私口换 cookie，不带 `x-dsh-identity`；无差别 401 会打死经网关的全链路）。威胁模型对账：launch token 以 0600 存网关 data dir，与网关私钥同暴露等级；能读它的进程本就能读 dsh credentials store，不构成新增暴露面。这是**凭证准入**而非路径白名单——ADR-0004 Q6=a 反对的是路径白名单。升级路径：若 #15 轨改网关让 UpstreamAuth 交换自带 `x-dsh-identity`，该放行可删除。
- **401 固定文案**：`请走 http://127.0.0.1:3080`，plain text，不做配置——文案是操作员可读的入口指引；配置面只保留逃生门一个开关。
- **逃生门**：`guardEnabled=false`（默认）＝门禁前形态零行为差异——`applyGuard` 直接返回 undefined，不与守卫席位发生任何交互；开启时若宿主无守卫席位则激活大声失败（提示应用 host patch）。
- **principal 三字段**：恰 `{tenantId, userId, roles}`，对齐 [CONTEXT.md](../../CONTEXT.md)「请求主体」（multi-tenant Principal 的超集，多出 roles 供特权豁免判定）；displayName 不进请求主体。

## §4 m1 定名记录

宿主 patch 内类型名 `RequestGuard` / `RequestGuardDecision` 因 #13 W1 链内钉死保持不动。#18 起新命名走 `Web*` 前缀（`WebRequestGuard` / `WebRequestGuardDecision` / `WebRequestGuardSeat`），对齐宿主既有 `WebRoute` / `WebUpgradeRoute` 词汇。宿主侧重命名留待 upstream PR 一并裁定，避免二次 API 改名。
