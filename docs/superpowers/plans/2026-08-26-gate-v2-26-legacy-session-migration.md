> 对应 issue：[#26](https://github.com/1123786563/dsh-plugin/issues/26)（状态跟踪以 issue 为准，本文件是计划的仓库内源稿）

## What to build

一个幂等迁移工具：把门禁启用前创建的**无主存量会话**批量归属（claim）给 `dsh-ops/dsh-admin`——普通租户列表不可见，管理员可见可接管。可重跑、可 dry-run。

运行形态：脚本以 admin 身份经网关登录（仓库已有 API 脚本化登录模式）→ 列全量会话（admin 豁免后可见，依赖 #22）→ 对每个会话查归属 → 无主者 claim → 输出迁移清单。

## 实施计划

1. 脚本落在 `services/casdoor-gateway/scripts/`（或仓库约定的脚本区）：admin 登录、全量列表、归属查询（经插件/桥暴露的查询能力，若无则复用 session_owners 只读视图——以最小暴露面为准）、claim、汇总报告。
2. 支持 `--dry-run`（只输出清单）与重复运行幂等（已归属跳过）。
3. 测试：混合归属夹具下的正确性、幂等性、dry-run 无副作用。
4. 在 live 环境执行并记录结果（数量、清单摘要）。

## Acceptance criteria

- [ ] dry-run 输出待迁移清单与数量，无副作用
- [ ] 迁移后普通租户列表不含存量会话、admin 可见全部
- [ ] 重跑无变化（幂等）
- [ ] live 执行结果留档

## Blocked by

- #22 — admin 全量列表（过滤豁免就位后脚本才可见存量）

## 文档

- [ADR-0005 存量迁移决策](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0005-tenant-scoped-session-visibility.md)
