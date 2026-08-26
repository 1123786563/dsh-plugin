> 对应 issue：[#25](https://github.com/1123786563/dsh-plugin/issues/25)（状态跟踪以 issue 为准，本文件是计划的仓库内源稿）

## What to build

**tracer——上游 #41 的 WS 面修复。** 租户 A 的浏览器实时流里**收不到任何其他主体（跨租户、同租户跨用户）会话的事件帧**；`dsh-admin` 收全量；自己会话的订阅基线与实时事件完整无丢帧（stock UI 实时性不回退）。

实现：`dsh-casdoor-auth` 为 #24 的帧过滤钩子提供判定实现，复用 #22 的归属管线（listByOwner 集合 + assertSessionAccess + admin 豁免）。

## 实施计划

1. 插件实现 per-connection 过滤器：以连接主体的可见会话集合判定（集合在连接建立时物化，新增会话逐帧查询归属——正确性优先，性能不足再优化并注明）。
2. WS 验收脚本：两账号（acme/alice、globex/bob）并发经网关连 events.mux，各自创建会话并跑一个 turn，断言：各自流中无对方 sessionId 的任何帧、自己帧齐全；dsh-admin 流包含全部。
3. stock UI 手动回归：自己会话的实时输出、新增会话侧边栏刷新正常（events.host 过滤语义下 UI 功能不回退）。

## Acceptance criteria

- [ ] 跨租户、同租户跨用户互收不到对方会话的任何帧
- [ ] admin 收全量
- [ ] 自己会话的基线+实时事件完整（UI 无丢帧/不刷新回退）

## Blocked by

- #22 — 归属判定管线
- #24 — mux 帧过滤钩子

## 文档

- [ADR-0005 WS 泄露面与验收](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0005-tenant-scoped-session-visibility.md)
