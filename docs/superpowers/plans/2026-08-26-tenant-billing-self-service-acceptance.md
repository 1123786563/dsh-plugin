# 租户账单自助服务验收记录（Issue #11）

日期：2026-08-30 ｜ 分支：`feat/tenant-billing-11-acceptance` ｜ 范围：`plugins/dsh-openmeter`
计划：`docs/superpowers/plans/issue-11-billing-acceptance.md` ｜ spec：`docs/superpowers/specs/2026-08-26-tenant-billing-self-service-design.md`

本记录汇总 Issue #11 的自动化验收证据（Task 1 集成 fixture，commit `2d2c184` + `c7dc536`）与文档收口证据（Task 2，documentation-contract 测试），并给出浏览器手动验收的步骤与留档格式。事实源：`t1-report.md`（T1 验收事实）与本轮 T2 实测输出。

## 1. AC 逐条映射

| AC | 证据（测试名 / 命令输出摘要） | 命令 |
| --- | --- | --- |
| A/B 额度、用量、预算、页面数据互不可见 | 集成 fixture describe `A/B tenant mutual invisibility (offline ledger + local aggregates)` 4 例：`A meters usage and sees only own rows in /me/usage; B sees zero rows…`、`symmetric: B meters usage…`、`/me/summary local aggregates are subject-scoped even while OpenMeter is down`、`seeding is idempotent…`；describe `tenant budget: visibility, edit rights, over-line warning` 4 例中 `B has zero visibility of A budget: B side stays unconfigured with no A figures`。全组通过。 | `pnpm --dir plugins/dsh-openmeter test -- tests/tenant-billing.integration.spec.ts` |
| 运营者授权边界内可管理 | describe `operator surface boundary` 5 例：operator 读写带 audit actor、租户成员在一切 operator 路由被拒（先于任何 store 变更）、无验签身份一律 401、旧路径全方法全调用者 410 `route-migrated`、authz 通过后上游不可达诚实 502。全组通过。 | 同上 |
| 覆盖登录/概览/预警/下钻/预算编辑/越权拒绝/暂不可用反馈 | 自动化：T1 用例组 1–5（含 `cross-tenant subject attempts are rejected` 3 例——`subject=B` 查询 400 `subject-not-allowed`、`tenantId` 参数同样拒绝、非回环来源 403；`unreachable OpenMeter degrades honestly (invalid-port fixture)` 4 例——summary `unavailable` 保留本地聚合不伪造余额、不泄露 endpoint/错误文本、operator 面降级 502、gate 故障放行）。浏览器面：本文 §3 手动步骤（步骤 1–7 一一对应）。 | 同上 + §3 |
| 术语/API 行为/角色矩阵/迁移回滚与实现一致 | documentation-contract 测试 10 例（README 6 + CONTEXT 4）通过；README 以 `src/routes.ts` `route('…')` 注册面（13 条路径）为唯一事实源做集合相等断言，含 me/* 面全表、operator 迁移表、410 语义、角色矩阵（租户成员/运营者/stock 回环三列）、回滚说明、验证命令逐字段。 | `pnpm --dir plugins/dsh-openmeter test -- tests/documentation-contract.spec.ts` |
| 记录 lint/typecheck/test/集成验收；未运行门禁说明原因 | 本文 §4 门禁节（lint 脚本不存在如实注明；8888 真链路子集的 skip 原因如实注明）。 | `pnpm --dir plugins/dsh-openmeter test && pnpm --dir plugins/dsh-openmeter typecheck && pnpm --dir plugins/dsh-openmeter build` |

### 集成 fixture 双跑一致性（确定性）

`pnpm --dir plugins/dsh-openmeter exec vitest run tests/tenant-billing.integration.spec.ts` 连续两次：
`Test Files 1 passed (1), Tests 21 passed | 1 skipped (22)`（588ms / 561ms），两次输出逐字一致（T1 报告 Fix Round 1 亲测；用例总数 22 = 21 自动 + 1 自愈 skip，见 §4）。

## 2. 8888 真链路实测记录（如实）

验收时点 `127.0.0.1:8888` 可达，但直接探针证实其为**部分本地 shim 而非 OpenMeter fork**：

- `ingest`（事件摄入）与 `customers` 答 2xx（customer id 形如 `…-LOCAL-SHIM-CUSTOMER`）；
- `GET /api/v1/meters` 恒为空表 `{"data":[]}`，`dsh_llm_tokens` meter 查询恒 `{}` ⇒ meter 物化腿不可验证。

因此 live describe（`OpenMeter real chain at 127.0.0.1:8888 (forwards → meter → balance → block)`）的实际结果：

| 用例 | 结果 | 说明 |
| --- | --- | --- |
| 用例 2 `a manual block stops one tenant at the gate while the other proceeds` | **真跑通过**（含真实 ingest 腿：seed → forwarder.drain → WAL 清空） | 覆盖 customers/entitlements/grants/gate/block 与 WAL→forwarder→ingest 排空；无 meter 行断言 |
| 用例 1（全链路含 meter 物化、ready 态汇总） | **自愈式跳过**（`it.skipIf(!METER_SINK_LIVE)`） | 收集期探针 `GET /api/v1/meters` 非空即判 live；shim 空表 ⇒ skip 如预期触发。真 fork 起服务后无需改码自动恢复运行 |

**不得记为「全部真链路通过」**：meter 行物化与 ready 态汇总仍待真 fork 环境验证（见 §5 等待事项）。

## 3. 浏览器手动验收步骤（交付步骤+留档格式；执行留待用户）

前置：live 3080 Web 栈 + Casdoor 身份服务 + OpenMeter fork（8888）；三个身份：租户 A 成员（普通）、租户 A 管理者（`owner`）、租户 B 成员。导航模型：租户侧固定三项「概览 / 用量明细 / 预算」，运营者另见「收银台 / 运营者设置」（`src/client/navigation.ts`）。

| # | 步骤 | 预期 |
| --- | --- | --- |
| 1 | 登录：租户 A 成员经 Casdoor 登录，进入设置内「计费」一级页面 | 出现概览/用量明细/预算三项入口，无收银台；未映射租户看到未开通（403 `tenant-unmapped`）提示，绝不回退到其他租户或全局数据 |
| 2 | 概览：打开概览卡 | Token 余额与 7 天用量/CNY 估算并列呈现（Token 不换算成 CNY）；余额未知时缺席而非 0；`runwayDays < 7` 呈现低余额预警 |
| 3 | 预警：制造 A 用量越线（或调低预算），回到概览/预算卡 | 预算卡 ready 态且 `projectedOverageCny > 0` 呈现超支预警；进度条超支封顶满格不显示 120%；无预算（unconfigured）不出现比例 |
| 4 | 明细下钻：概览 → 用量明细 | 持久账本分页/时间/模型筛选；行含 token 维度与估算金额（未定价行如实标注）；URL 手工加 `?subject=<B的subject>` 或 `?tenantId=B` → 400 `subject-not-allowed`，页面不呈现 B 任何数据 |
| 5 | 预算编辑：A 管理者编辑月度预算保存；换普通成员打开预算卡 | 管理者可编辑、保存后预测即时刷新（响应含 `canManageBudget: true`）；普通成员编辑控件不可用/只读（PUT 403 `forbidden`） |
| 6 | 越权尝试：A 会话直接请求 `/api/openmeter/operator/customers`（POST）与旧路径 `/api/openmeter/customers` | operator 面 403 `forbidden`（先于任何 store 变更）；旧路径一切方法 410 `{ok:false,error:"route-migrated",to:"/api/openmeter/operator/customers"}` |
| 7 | 停服降级观察：停掉 OpenMeter（或断开 endpoint）后刷新计费页，再恢复 | 概览转 `unavailable` 降级态：本地 7 天聚合仍在、无余额/访问标志/runway、无 endpoint 或错误文本；用量/预算面呈现暂不可用（503 `ledger-unavailable`/`budget-unavailable`），不伪造数字；恢复后自动回到 ready |

留档格式（每步一条，附于本表之后）：

```markdown
| 字段 | 值 |
| --- | --- |
| 步骤 | <#>. <名称> |
| 执行人 / 时间 |  |
| 身份 | tenantId / userId / 角色（成员/管理者/运营者） |
| 操作 | URL 与动作（或截图中的操作序列） |
| 预期 | 照上表对应行 |
| 实际 |  |
| 证据 | 截图路径 / HAR / network 响应摘录 |
| 结论 | pass / fail（fail 附缺陷 issue 号） |
```

## 4. 门禁结果与未运行门禁清单

| 门禁 | 结果 | 备注 |
| --- | --- | --- |
| `pnpm --dir plugins/dsh-openmeter test` | ✅ `Test Files 20 passed (20), Tests 315 passed | 1 skipped (316)`（2026-08-30，T2 收口后；T1 时点为 305+1=306，差值 = 新增 contract 10 例） | `pretest` 自动先 `build`，干净树可跑（`rm -rf lib` 后复现，见 T1 报告 I1） |
| `pnpm --dir plugins/dsh-openmeter typecheck` | ✅ `tsc -b --pretty false` 零输出，exit 0 |  |
| `pnpm --dir plugins/dsh-openmeter build` | ✅ exit 0（`lib/index.js` 112.77 kB、`client.js` 66.5 kB） |  |
| `pnpm --dir plugins/dsh-openmeter lint` | ⛔ 未运行 | `package.json` 无 `lint` 脚本（仅 test/typecheck/build）——脚本不存在，如实注明 |
| 集成 fixture 双跑确定性 | ✅ 两次输出逐字一致（§1） |  |
| documentation-contract | ✅ 10 passed（RED 7 失败 → GREEN，见 T2 报告） |  |
| 8888 真链路子集 | ⚠️ 部分执行 | shim 非真 fork：用例 2 真跑通过、用例 1 自愈 skip（§2）；不记「全部真链路通过」 |
| 浏览器手动验收（§3） | ⛔ 未执行 | 无人值守轮只交付步骤+留档格式，执行留待用户（§5） |

## 5. 等待事项

1. **浏览器手动验收**：按 §3 执行并留档（用户操作；每步一条留档记录）。
2. **真 OpenMeter fork 环境**：起 compose 栈（README「部署」节）后重跑集成 fixture——`METER_SINK_LIVE` 探针见 meters 非空即自动恢复用例 1（meter 物化全链路），无需改码。
3. **8888 环境事实待裁定**（T1 记录）：当前 8888 为部分本地 shim（ingest/customers 2xx、meters 空表），与「OpenMeter fork」预期不符——环境问题而非代码缺陷，留待运营者裁定该端口归属。
4. **实现缺陷记录**：Task 1/2 均未发现计费实现缺陷（Global Constraint「只记录不修」；无新增缺陷条目）。
