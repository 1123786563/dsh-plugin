# Issue #11 跨租户验收与文档收口 Implementation Plan（2026-08-29 重验修订版）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用租户 A/B 与运营者三类身份完成租户账单自助服务的端到端验收证据（集成 fixture 自动化为主 + 浏览器手动验收留档），并把文档（术语、API 行为、角色矩阵、迁移/回滚、验证命令）与已实现行为对齐收口。

**Architecture:** 在 `plugins/dsh-openmeter` 内新增确定性集成 fixture（vitest，驱动**构建产物 lib/** 的计费管线与 HTTP 面本地模块：WAL→Forwarder→meter→balance→gate→operator store，A/B/operator 三身份夹具），OpenMeter fork API（127.0.0.1:8888）可达时纳入真链路、不可达时该子集显式 skip 并在验收记录中如实注明；新增 documentation-contract 测试把文档术语/命令锁进 CI；README/CONTEXT 按当前实现收口并附验收记录文档。

**Tech Stack:** Vitest（既有）、Node ESM 脚本（smoke.mjs 先例）、lib 构建产物模块（smoke.mjs 同源）、Markdown。

**Spec:** `docs/superpowers/specs/2026-08-26-tenant-billing-self-service-design.md`（权威 spec）

**Issue:** https://github.com/1123786563/dsh-plugin/issues/11

**重验说明（对照 2026-08-26 既有计划的修订）:** 既有计划两任务结构保留，但按现状修订：①`tests/tenant-billing.integration.spec.ts` 至今未创建（确认）；②`scripts/smoke.mjs` 已存在且驱动 lib 产物——修改点收窄为「暴露可复用夹具/身份常量」而非重写；③README 已含 operator/* 迁移面与 410 语义（L23-56）、CONTEXT.md 已有 19 条术语——文档任务从「补齐缺失」改为「对照实现逐项核实+补差距」；④package.json 无 `lint` 脚本（仅 test/typecheck/build）——AC 的 lint 项如实记录「脚本不存在」；⑤openmeter 容器（compose，源码构建镜像）当前未运行——集成 fixture 必须支持依赖缺席的诚实降级。

## Global Constraints

- 租户 A/B 数据在 API 与夹具层面互不可见；运营者访问显式角色门控（isOperator 策略面，README L23 语义）。
- 不可用服务呈现诚实降级态；测试不得把健康检查当作完整验收。
- 不引入新计费模式或支付渠道（Issue Out of scope）。
- 不修改计费**实现**代码：文档与实现不一致时以实现为准修文档；发现实现缺陷→记录并在收尾报告中列出（不擅自修，留给新 Issue）。
- 集成 fixture 确定性：可重复运行两遍结果一致（种子幂等、临时目录清理）。
- 门禁命令实测基线：`pnpm --dir plugins/dsh-openmeter test`、`typecheck`、`build` 均存在；lint 脚本不存在→验收记录如实注明。

## 范围（Scope）

- `plugins/dsh-openmeter/tests/tenant-billing.integration.spec.ts`（新建）
- `plugins/dsh-openmeter/tests/documentation-contract.spec.ts`（新建）
- `plugins/dsh-openmeter/scripts/smoke.mjs`（最小修改：仅当夹具需要复用其常量/助手时）
- `plugins/dsh-openmeter/README.md`、`plugins/dsh-openmeter/CONTEXT.md`（对照核实+补差距）
- `docs/superpowers/plans/2026-08-26-tenant-billing-self-service-acceptance.md`（验收记录：证据索引+手动验收步骤+未运行门禁原因）

## 非目标（Non-goals）

- 不新增/修改计费业务逻辑、API 行为或 UI 组件。
- 不做门禁 v2 面（casdoor/网关）的验收（那是 #21/#25 正文范围）。
- 不起 live 3080 栈做浏览器自动化（待用户批准项不扩大化；浏览器验收以「手动步骤+留档格式」交付）。

---

### Task 1: 跨租户集成 fixture（TDD）

**Files:**
- Create: `plugins/dsh-openmeter/tests/tenant-billing.integration.spec.ts`
- Modify: `plugins/dsh-openmeter/scripts/smoke.mjs`（仅当需抽取复用助手）

**Interfaces:**
- Consumes: `lib/index.js` 构建产物的 `MeteringWal、OpenMeterClient、OperatorStore、PriceEstimator、BalanceGate、Forwarder、MeteringPipeline、buildWalRecord`（smoke.mjs L18 同源 import 形态）；`lib/client.js` 面（若 me/* 租户 API 在 client 导出——实现者以 `ls plugins/dsh-openmeter/lib` + package.json exports 实证后选用）。
- Produces: 三身份夹具工厂 `makeTenantFixture(subjectPrefix)` / `makeOperatorFixture()`（测试文件内导出供 Task 2 文档测试引用验收事实行）；确定性双跑通过的证据。

- [ ] **Step 1: 先跑基线** `pnpm --dir plugins/dsh-openmeter build && pnpm --dir plugins/dsh-openmeter test` 确认现状全绿（记录基线数字进报告）。
- [ ] **Step 2: 写失败测试**（文件骨架+全部用例，跑出 FAIL/not-importable）：
  - A/B 互不可见：A 计量→A 概览/用量/明细仅含 A 的 subject 数据；B 查询同 API 不见 A 的任何值（subject id、金额、事件计数）；反向对称。
  - 预算与超支预警：A 设预算→A 侧可见/可编辑；B 侧对 A 预算零可见；A 用量越线触发预警标志。
  - 运营者边界：operator 面（operator/customers、grants、block、bindings）operator 可操作；非 operator 身份被拒（isOperator=false 路径）；旧路径 410 断言（route-migrated 契约，README L34）。
  - 越权拒绝：A 以 B 的 subject 查询→拒绝/空（以实现契约为准断言）。
  - 服务暂不可用：endpoint 不可达夹具（invalid port）→ 诚实降级态（错误语义按 CONTEXT「错误语义」术语），绝不伪装成功。
  - OpenMeter 真链路子集：8888 可达才跑（`describe.skipIf`）——事件转发→meter 查询→余额扣减→阻断一条链。
- [ ] **Step 3: 实现夹具**：mkdtemp 临时 WAL/store；每用例独立 subject 前缀；`afterAll` 清理；种子幂等（重复 seed 不翻倍——用例内跑两遍断言）。
- [ ] **Step 4: 跑通 + 双跑确定性**：连续两次 `pnpm --dir plugins/dsh-openmeter test -- tests/tenant-billing.integration.spec.ts` 输出一致。
- [ ] **Step 5: Commit** `test: add cross-tenant billing acceptance fixture`

### Task 2: 文档收口 + 质量门禁记录

**Files:**
- Modify: `plugins/dsh-openmeter/README.md`
- Modify: `plugins/dsh-openmeter/CONTEXT.md`
- Create: `docs/superpowers/plans/2026-08-26-tenant-billing-self-service-acceptance.md`
- Test: `plugins/dsh-openmeter/tests/documentation-contract.spec.ts`

**Interfaces:**
- Consumes: Task 1 的验收事实（AC 逐条证据行）。
- Produces: 验收记录文档（AC 映射表 + 手动浏览器验收步骤清单 + 留档格式 + 门禁结果记录）；documentation-contract 测试（防文档漂移）。

- [ ] **Step 1: 写失败 contract 测试**：断言 README 含——me/* 租户自助 API 面全表（路径+方法+body 契约要点）、operator 面表、410 迁移语义、角色矩阵（租户成员/运营者/stock 回环三列 × 可用面）、迁移/回滚说明标题、验证命令段（test/typecheck/build 逐字）；CONTEXT.md 含术语——Tenant/Subject 映射、Token/CNY 报价币种、错误语义/降级态、operator 策略解析。跑出 FAIL（当前缺项即差距清单）。
- [ ] **Step 2: 对照实现逐项核实补齐** README/CONTEXT（以 src/ 与 lib 导出面为唯一事实源；与 Task 1 断言的契约一致）。
- [ ] **Step 3: contract 测试转绿**；全量 `pnpm --dir plugins/dsh-openmeter test` + `typecheck` + `build` 全绿（lint 脚本不存在→记录）。
- [ ] **Step 4: 写验收记录文档**：AC 逐条→证据（测试名/命令输出摘要/双跑一致性）；手动浏览器验收步骤（登录→概览→预警→明细下钻→预算编辑→越权尝试→停服降级观察，每步预期+留档格式）；未运行门禁清单及原因（lint 不存在；8888 未起时的真链路子集 skip 原因——若 Task 1 运行时点已起则记录实际结果）。
- [ ] **Step 5: Commit** `docs: close tenant billing acceptance and runbook`

## 测试与验收命令总表（对照 Issue AC）

| AC | 证据 | 命令 |
| --- | --- | --- |
| A/B 额度/用量/预算/页面数据互不可见 | Task 1 用例组 1-2 | `pnpm --dir plugins/dsh-openmeter test -- tests/tenant-billing.integration.spec.ts` |
| 运营者授权边界内可管理 | Task 1 用例组 3 | 同上 |
| 覆盖登录/概览/预警/下钻/预算编辑/越权拒绝/暂不可用反馈 | Task 1 用例组 1-5 + 验收记录文档手动步骤节 | 同上 + 验收记录文档 |
| 术语/API 行为/角色矩阵/迁移回滚与实现一致 | contract 测试 + README/CONTEXT | `pnpm --dir plugins/dsh-openmeter test -- tests/documentation-contract.spec.ts` |
| 记录 lint/typecheck/test/集成验收；未运行门禁说明原因 | 验收记录文档门禁节 | `pnpm --dir plugins/dsh-openmeter test && pnpm --dir plugins/dsh-openmeter typecheck && pnpm --dir plugins/dsh-openmeter build` |

## 已知风险

- me/* 面的确切导出形态未在控制器侧逐文件实证——Task 1 Step 2 要求实现者以 lib 实际导出为准选择调用面（差异记入报告）。
- OpenMeter 容器（源码构建镜像）若构建耗时过长或失败，真链路子集保持 skip 并如实记录——不影响其余 AC 的本地证据。
- 浏览器手动验收在无人值守轮只能交付「步骤+格式」，执行留待用户或后续轮（等待事项记台账）。
