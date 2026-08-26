> 对应 issue：[#16](https://github.com/1123786563/dsh-plugin/issues/16)（状态跟踪以 issue 为准，本文件是计划的仓库内源稿）

## What to build

vendored `dsh-multi-tenant` 的会话归属库获得**按 owner 列会话**的查询能力：store 与 service 层新增 `listByOwner(tenantId, userId)`，返回该 (tenant, user) 拥有的全部会话 ID。纯新增方法——既有 `claim`/`get` 契约与 claim-once 语义零改动（这是 v1 "vendored 零改动"原则的唯一豁免，见 ADR-0005，改法刻意保持可提上游）。

背景：当前 store 只有按单个 session_id 的 INSERT/SELECT（`session_owners` 表：session_id PK, tenant_id, user_id, STRICT），**没有任何按 owner 的列表查询**——这正是租户过滤列表（#22）的必需数据源。

## 实施计划

1. sqlite-store 新增按 (tenant_id, user_id) 的 SELECT（沿用既有 WAL/STRICT 习惯）。
2. store 抽象层与 service 薄封装同步新增方法；类型导出；结果顺序语义明确（按 session_id 稳定排序即可）。
3. 单测：多租户多用户混合数据下的过滤正确性、空结果、与既有 claim 的兼容（claim 后立即可列出）。
4. vendored 包既有测试全绿（零行为变化）。

## Acceptance criteria

- [ ] `listByOwner` 只返回该 (tenantId, userId) 的会话，与 claim-once 产物兼容
- [ ] 既有 API 契约与全部既有测试不受影响
- [ ] 单测通过

## Blocked by

None — can start immediately.

## 文档

- [ADR-0005 租户隔离与 listByOwner 决策](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0005-tenant-scoped-session-visibility.md)
