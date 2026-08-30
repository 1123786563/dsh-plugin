# Issue #26 存量会话迁移脚本 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个幂等、可 dry-run 的迁移工具：把门禁启用前创建的无主存量 Agent 会话批量 claim 给 `dsh-ops/dsh-admin`，使普通租户列表不可见、管理员可见可接管。

**Architecture:** 独立 Node CLI 脚本落在 `services/casdoor-gateway/scripts/migrate-legacy-sessions.mjs`（沿 e2e.mjs 纯 node 直跑风格）。三步数据面：①全量会话清单 = admin 经网关 `POST /api/session.list`（cookie 登录，#22 admin 豁免）；②归属查询 = 只读直连 `session_owners` SQLite（`node:sqlite` 只读打开）；③claim 写入 = 与 `dsh-multi-tenant` sqlite-store `claim()` 完全同语义的事务写入（先查后插 + 唯一约束兜底，claim-once），语义一致性由单测用**真实** `SQLiteTenantSessionStore`（跨包相对 import 种夹具）守护。纯逻辑抽为可测模块放 `services/casdoor-gateway/src/migration/`，vitest 覆盖；脚本壳只做 IO 编排。

**Tech Stack:** Node.js ≥22（node:sqlite 内建）、vitest、既有网关 cookie-jar 登录模式（参照 scripts/e2e.mjs）。

**Spec:** GitHub Issue #26 正文（标题/正文错位——正文为权威）+ [ADR-0005 存量迁移决策（Q12=a）](../../plugins/dsh-casdoor-auth/docs/adr/0005-tenant-scoped-session-visibility.md)

**Issue:** https://github.com/1123786563/dsh-plugin/issues/26

## Global Constraints

- 最小暴露面：不新增任何 HTTP/RPC 端点（multi-tenant web 面保持仅 create/resume）。
- claim-once 语义不可绕过、不可改变：写入仅当会话无主时生效；已有归属（任何主体，含已迁移给 dsh-ops/dsh-admin）一律跳过、非错误。
- dry-run 零副作用：不写 `session_owners`、不写任何状态文件；测试必须断言 DB 字节不变。
- 迁移目标 principal 默认 `--tenant dsh-ops --user dsh-admin`（ADR-0005 Q12=a），可参数覆盖。
- 幂等可重跑：第二次运行输出「无主=0、已归属跳过=N」，不产生任何新写入。
- 归属 DB 路径必须显式：`--db <path>`（默认 `<cwd>/.dsh-multi-tenant/session-ownership.sqlite`；宿主进程 cwd 决定真实路径，演练时必须显式传）。
- 不回归：`services/casdoor-gateway` 既有测试全绿（pnpm --dir services/casdoor-gateway test）；typecheck 全绿。

## 范围（Scope）

- 新增迁移脚本 + 纯逻辑模块 + 单测（混合归属夹具正确性、幂等、dry-run 无副作用、与真实 store 的 claim 语义一致性）。
- 新增本地演练 runbook（沿 e2e.mjs 手动 drill 先例）：起本地栈 → 制造无主会话夹具 → dry-run → 真跑 → 幂等重跑 → 断言 → 清理，结果留档。
- README 增补脚本用法一节。

## 非目标（Non-goals）

- 不做 WS 帧过滤（那是 #25 正文的范围）。
- 不修改 claim-once 归属语义或 session_owners schema。
- 不新增网关/multi-tenant API 面。
- 不迁移已有主会话、不改动 casdoor 种子。

---

### Task 1: 迁移纯逻辑模块（TDD）

**Files:**
- Create: `services/casdoor-gateway/src/migration/plan-migration.ts`
- Test: `services/casdoor-gateway/tests/migration-plan.spec.ts`

**Interfaces:**
- Consumes: 无（纯函数模块）。
- Produces（Task 2 脚本壳依赖，签名固定）:
  - `interface OwnerRow { readonly sessionId: string; readonly tenantId: string; readonly userId: string }`
  - `interface MigrationPlanItem { readonly sessionId: string; readonly action: 'claim' | 'skip-owned' | 'skip-unknown' }`
  - `interface MigrationPlan { readonly items: readonly MigrationPlanItem[]; readonly counts: { claim: number; skipOwned: number; skipUnknown: number }; readonly target: { readonly tenantId: string; readonly userId: string } }`
  - `function planMigration(allSessionIds: readonly string[], owners: readonly OwnerRow[], target: { tenantId: string; userId: string }): MigrationPlan`
    —— `allSessionIds` 来自网关 session.list（admin 全量）；`owners` 来自 DB 只读查询；输出逐会话动作与计数。无主→`claim`；有主→`skip-owned`；清单中不存在于 session_owners 且…注意：无主会话在 session_owners 中**没有行**，因此 DB 行只覆盖有主会话；`skip-unknown` 保留给「DB 有行但清单没有该会话」的反向孤儿（报告用，不写）。

- [ ] **Step 1: 写失败测试**：混合夹具——无主 2 个（清单有、DB 无行）、有主 2 个（其一已被 dsh-ops/dsh-admin 认领=重跑幂等形态）、DB 孤儿行 1 个（清单没有）。断言：plan.counts = { claim: 2, skipOwned: 2, skipUnknown: 1 }；claim 项的 sessionId 精确匹配；target 原样透传。
- [ ] **Step 2: 跑测确认失败**：`pnpm --dir services/casdoor-gateway test -- tests/migration-plan.spec.ts`（Expected: FAIL 模块不存在）。
- [ ] **Step 3: 最小实现** planMigration（纯函数，无 IO）。
- [ ] **Step 4: 跑测通过**；随后全量 `pnpm --dir services/casdoor-gateway test` 确认零回归。
- [ ] **Step 5: Commit** `feat(gateway): add legacy session migration planner`

### Task 2: claim 写入 + dry-run 编排模块（TDD，真实 store 守护语义）

**Files:**
- Create: `services/casdoor-gateway/src/migration/apply-migration.ts`
- Test: `services/casdoor-gateway/tests/migration-apply.spec.ts`

**Interfaces:**
- Consumes: Task 1 的 `MigrationPlan`/`OwnerRow`；`node:sqlite` DatabaseSync。
- Produces（Task 3 脚本壳依赖）:
  - `interface ApplyResult { readonly claimed: readonly string[]; readonly skippedOwned: readonly string[]; readonly failed: readonly { sessionId: string; reason: string }[] }`
  - `function applyMigration(db: DatabaseSync, plan: MigrationPlan, opts: { dryRun: boolean }): ApplyResult`
    —— dryRun=true 时**只读**（逐 claim 项复查仍无主后计入将迁移清单，零写入）；dryRun=false 时对每个 claim 项执行与 `SQLiteTenantSessionStore.claim()` 同语义的事务：`BEGIN IMMEDIATE` → SELECT 无主校验 → INSERT → `COMMIT`，唯一约束冲突（并发已有主）视为 skip-owned 计入 skippedOwned。db 句柄由调用方开（read-only 或 rw 模式由本函数按 dryRun 决定要求）。

- [ ] **Step 1: 写失败测试**：夹具用**真实** store 种数据——`import { SQLiteTenantSessionStore } from '../../../plugins/dsh-multi-tenant/packages/multi-tenant/src/sqlite-store.ts'`（vitest 跨包相对 import；若该导出名不符，以实际导出为准修正 import，不得改 multi-tenant 包）。用例：a) dry-run 后 DB 字节不变（读文件 buffer 前后对比）且 ApplyResult.claimed 列出全部待迁移；b) 真跑后用 store 的 `listByOwner('dsh-ops','dsh-admin')` 断言全部 claim 成功；c) 二次 apply 同一 plan → claimed=[]、skippedOwned 含全部；d) 预置并发冲突行后 apply → 冲突项进 skippedOwned 而非 failed；e) store 已有数据经 `claimSession` 后 listByOwner 可见（语义一致性基线）。
- [ ] **Step 2: 跑测确认失败**（Expected: FAIL apply-migration 不存在）。
- [ ] **Step 3: 实现 applyMigration**（事务 SQL 与 sqlite-store.claim 的 SQL 语义逐字对齐——先读该文件 L141-L159 作参照）。
- [ ] **Step 4: 跑测通过** + 全量 `pnpm --dir services/casdoor-gateway test` 零回归 + `pnpm --dir services/casdoor-gateway typecheck`。
- [ ] **Step 5: Commit** `feat(gateway): add idempotent claim writer with dry-run`

### Task 3: CLI 脚本壳 + 本地演练 runbook + README

**Files:**
- Create: `services/casdoor-gateway/scripts/migrate-legacy-sessions.mjs`
- Create: `services/casdoor-gateway/scripts/MIGRATION-RUNBOOK.md`
- Modify: `services/casdoor-gateway/README.md`（新增「存量会话迁移」一节）
- Test: `services/casdoor-gateway/tests/migration-cli.spec.ts`（argv 解析纯逻辑：--db/--tenant/--user/--dry-run/--gateway/--help 默认值与错误）

**Interfaces:**
- Consumes: Task 1 `planMigration`、Task 2 `applyMigration`（经 tsx 编译壳或 lib 产物——脚本用 `#!/usr/bin/env node` + import 编译产物不可用时退 `tsx` shebang，以仓库可直跑形态为准并在 runbook 写明启动命令）；cookie-jar 登录序列参照 `scripts/e2e.mjs`（`POST ${GATEWAY}/api/login` 挑战 → casdoor 登录 → 回调 → cookie → `POST ${GATEWAY}/api/session.list`）。
- Produces: 可执行 CLI；退出码 0=成功（含「无可迁移」）、1=参数错误、2=运行错误；stdout 汇总报告（JSON 行 + 人类可读摘要：各计数 + 迁移清单前 N 条 + target principal + db 路径）。

- [ ] **Step 1: 写失败测试**（argv 解析：默认值、必填校验、--dry-run 开关、--help 文本含 usage）。
- [ ] **Step 2: 跑测确认失败 → 实现 → 跑测通过。**
- [ ] **Step 3: 实现脚本壳**：登录（admin `dsh-ops/dsh-admin` 凭据经 `--password`/env `MIGRATION_PASSWORD` 传入，禁止硬编码）→ session.list 全量清单（分页/响应形状以 e2e.mjs L252/L295 先例与实际响应为准，解析失败则报错退出）→ 只读打开 `--db`（`node:sqlite` readOnly）读 OwnerRow 全表 → planMigration → applyMigration（dryRun 按 flag）→ 输出报告。
- [ ] **Step 4: 手动冒烟**（不起全栈）：临时 SQLite 夹具 + `--dry-run` 跑通零副作用路径（runbook Step 记录输出）。
- [ ] **Step 5: 写 runbook**：本地演练步骤——①`docker compose up -d`（casdoor+postgres；如需 openmeter 另说明）②起带 patch 宿主（参照 e2e.mjs 头部注释的宿主启动形态；宿主 cwd 即 DB 所在，写明 `--db` 实际路径取法）③以 acme/alice 与 globex/bob 各建若干会话（经网关 UI/RPC）④直接 SQL 手工删两行 session_owners 制造「无主」夹具（runbook 给出只读验证命令）⑤dry-run 断言清单 ⑥真跑 ⑦断言：alice/bob 列表不含被迁移会话、admin session.list 可见全部 ⑧幂等重跑断言无变化 ⑨清理与留档：结果摘要追加到 runbook 末节「演练记录」。
- [ ] **Step 6: 全量门禁** `pnpm --dir services/casdoor-gateway test && pnpm --dir services/casdoor-gateway typecheck && pnpm --dir services/casdoor-gateway build`。
- [ ] **Step 7: Commit** `feat(gateway): legacy session migration CLI with runbook`

## 测试与验收命令总表（对照 Issue AC）

| AC | 证据 | 命令/产物 |
| --- | --- | --- |
| dry-run 输出待迁移清单与数量，无副作用 | migration-apply.spec 用例 a（DB 字节不变断言）+ CLI 冒烟 | `pnpm --dir services/casdoor-gateway test -- tests/migration-apply.spec.ts` |
| 迁移后普通租户列表不含存量会话、admin 可见全部 | runbook 演练 ⑦（本地栈断言步骤）+ 单测 b/c（归属正确性） | `services/casdoor-gateway/scripts/MIGRATION-RUNBOOK.md` 演练记录节 |
| 重跑无变化（幂等） | migration-apply.spec 用例 c + runbook 演练 ⑧ | 同上 |
| live 执行结果留档 | runbook「演练记录」节（数量、清单摘要、命令输出摘录） | 同上 |

## 已知风险

- session.list 响应形状未在控制器侧实证（e2e.mjs 仅断言状态码）——Task 3 Step 3 要求实现者先在本地栈实取一帧再写解析（runbook 演练前置）。
- 宿主 cwd 与 DB 路径对应关系依赖部署形态——runbook 显式 `--db` 化，风险收敛到 runbook 准确性。
- 若演练栈（带 patch 宿主）无法在无人值守轮起盘，AC 第 2/4 条降级为「单测+冒烟证据 + runbook 待执行清单」，在台账记录等待事项。
