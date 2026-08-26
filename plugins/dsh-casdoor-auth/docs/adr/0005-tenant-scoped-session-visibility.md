# 0005 — stock Web UI 租户隔离（上游 #41 的本地解法）

**状态：已接受（2026-08-26 设计共识，阶段二实施）**

上游 issue #41 的缺口：stock RPC 分发不物化请求作用域的产品 Principal，因此已登录的租户 A 经网关也能全量列出会话、打开/续跑任意冷会话（`session.prompt` 冷恢复）、并在 events.mux 上实时收到**所有租户所有会话**的事件全文（连接即全量，纯下行协议，客户端无法表达订阅范围）。

本决策：借 ADR-0004 的宿主钩子，把**会话可见性**判定下沉到宿主语义层，前端零改动（过滤后的响应照常渲染）：

- 归属数据源：vendored `dsh-multi-tenant` 新增 `listByOwner(tenantId, userId)`（SQLite `WHERE tenant_id=? AND user_id=?`，纯新增方法，可提上游）——**打破 v1 "vendored 零改动"原则的最小侵入**（Q10=a）。
- 列表：`session.list`/`session.search` 响应按请求主体过滤。
- 准入：带 sessionId 的方法（history/prompt/fork/export/cancel 等）逐个 `assertSessionAccess`；未知/无主会话 fail-closed。
- 新会话归属：宿主会话钩子提供"会话创建"回调，stock UI `session.create`/`fork` 产生的会话自动 claim 给当前请求主体（否则隔离后用户自己新建的会话自己不可见）。
- 事件流：mux 帧过滤（ADR-0004 第 3 钩子）。
- 特权豁免：请求主体 roles 含 `dsh-admin` 豁免全部过滤（运维排障视角，Q11=a）。
- 存量会话：一次性迁移脚本把既有无主会话全部 claim 给 `dsh-ops/dsh-admin`（Q12=a）。

## Considered Options

- **网关响应改写 + 归属查询端点**——被否：覆盖不了 WS 帧过滤；网关从流式管道变有状态语义网关。
- **前端注入隐藏**（tapIndex 脚本过滤 UI 展示）——被否：装饰性隔离，payload 已全量送达浏览器，curl 可绕过；DIRECTION.md 明言不可作为安全边界。
- **等上游原生 request-scoped Principal**——被否：时间不可控；本地钩子形态与上游可能的实现不冲突，落地后移除 patch 即可。

## Consequences

- 隔离正确性依赖"一切会话都有归属"：claim 回调遗漏的创建路径会产生不可见会话（fail-closed 下无人可见、admin 可见）。
- `dsh-admin` 成为跨租户全权角色（可见 + 可开 + 可收全量事件），与特权方法门禁共用同一角色语义。
- vendored multi-tenant 与上游的 diff 需跟随其版本升级维护。
- 验收必须覆盖旁路：`session.export`（GET 直达，不经 `/api` POST 分发）在守卫 + 钩子下的行为。
