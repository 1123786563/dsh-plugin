> 对应 issue：[#22](https://github.com/1123786563/dsh-plugin/issues/22)（状态跟踪以 issue 为准，本文件是计划的仓库内源稿）

## What to build

**tracer——上游 #41 的 RPC 面修复。** 租户 A 登录 stock Web UI：会话列表**只见自己的**；对他人会话的 history/prompt（含冷恢复续跑）/export 一律 403；伪造 sessionId fail-closed 拒绝；`dsh-admin` 角色全量豁免（列表全量、可开任意）。**前端零改动**——过滤后的响应照常渲染。

实现：`dsh-casdoor-auth` 为 #20 的三个钩子提供实现——listFilter 用 #16 的 `listByOwner`；accessCheck 用既有 `assertSessionAccess`（UNKNOWN_SESSION / USER_MISMATCH fail-closed）；豁免判定读请求主体 roles 含 `dsh-admin`。

## 实施计划

1. 插件侧实现三个回调并注册进宿主钩子；身份来源为守卫物化的请求主体（#18）。
2. 单测矩阵：跨租户、同租户跨用户、admin 豁免、未知 sessionId（伪造）、无主存量会话（迁移前 fail-closed）。
3. e2e/手动验收三视角：acme/alice、globex/bob、dsh-ops/dsh-admin——列表、打开、导出、冷恢复续跑（prompt 他人会话）逐项断言。
4. 确认 stock UI 前端在过滤后列表正常渲染、新建入口可用（新建自动归属在 #23；本票验收时新建会话可能暂不可见——以既有 `/_dsh-multi-tenant` 入口创建验证归属判定）。

## Acceptance criteria

- [ ] A 列表无 B 的会话（跨租户与同租户跨用户两种情形都验证）
- [ ] A 对 B 会话 history/prompt/export → 403；伪造 sessionId → 403（fail-closed）
- [ ] admin 列表全量、可打开任意会话
- [ ] 前端零改动、过滤后 UI 正常渲染

## Blocked by

- #16 — listByOwner 数据源
- #18 — 请求主体物化（守卫）
- #20 — ApiProxy 会话访问过滤钩子

## 文档

- [ADR-0005 隔离语义与豁免决策](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0005-tenant-scoped-session-visibility.md)
- [CONTEXT.md 术语：会话可见性](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/CONTEXT.md)
