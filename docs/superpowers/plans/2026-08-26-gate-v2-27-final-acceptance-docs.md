> 对应 issue：[#27](https://github.com/1123786563/dsh-plugin/issues/27)（状态跟踪以 issue 为准，本文件是计划的仓库内源稿）

## What to build

全部能力就位后的**总演练与收口**：一次通过阶段一+二的合并验收清单；README/CONTEXT 已知边界与运行态对齐（移除"直连可绕过"、"#41 未隔离"两条已解决边界）；逃生开关与回滚路径文档化并演练。

## 实施计划

1. 合并验收清单执行（证据留 issue comment）：
   - 直连矩阵：38080 任意路径/方法/WS 升级全 401；缺/伪/过期 token 401
   - 重启自愈：整机重启后 3080 自动可用、私口全 401、登录会话存活
   - 租户隔离三视角：列表/打开/导出/冷恢复/WS 帧五面 × alice/bob/admin
   - 旁路：session.export GET 直达被拒
   - fail-closed：停网关 → 私口死
   - 逃生门：守卫开关关闭 → 回门禁前形态；恢复
2. 文档收口：casdoor-auth README 已知边界更新、网关 README 部署章节核对、CONTEXT.md 与运行态复核（术语/业务规则逐条对照）。
3. 回滚路径文档：关守卫开关 / patch 退回 upstream（工具链 reverse）两级。

## Acceptance criteria

- [ ] 合并验收清单全项通过并留证据
- [ ] 文档已知边界与运行态一致（已解决条目移除/改写）
- [ ] 逃生门与回滚演练通过

## Blocked by

- #21 — 重启自愈演练
- #25 — WS 帧过滤验收
- #26 — 存量迁移

## 文档

- [ADR-0004](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0004-host-guard-hooks-patch.md)
- [ADR-0005](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0005-tenant-scoped-session-visibility.md)
- [CONTEXT.md](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/CONTEXT.md)
