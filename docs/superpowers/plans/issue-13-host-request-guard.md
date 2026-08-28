# Issue #13 — 宿主通用请求守卫扩展点（dsh-request-guard）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development — implement task-by-task with fresh implementer subagents, per-task spec + quality review, ≤5 fix rounds, final full-branch review.

- **Issue:** https://github.com/1123786563/dsh-plugin/issues/13
- **Working repo:** `deepseek-harness` checkout at `/Users/wuyongjun/trea/deepseek-harness`，隔离 worktree `.worktrees/dsh-request-guard`，分支 `dsh-request-guard`，基于 **origin/master @ cd5ef81481**（dsh-0.1.2-alpha.1；Issue 撰写时的 rc.2 快照已过期，按「基于 upstream master」取当前 master，事实已在 master 上复核仍成立）。
- **References:** ADR-0004（dsh-plugin `plugins/dsh-casdoor-auth/docs/adr/0004-host-guard-hooks-patch.md`，钩子①的宿主底座）；dsh-plugin `plugins/dsh-casdoor-auth/CONTEXT.md` 术语「请求守卫/请求主体」。

## 范围

在 `packages/host/webserver` 增加一个**通用、中性**（无 casdoor/租户产品词汇，可提 upstream）的请求守卫扩展点：

1. 守卫注册协议：`registerGuard(guard)` 服务方法（单席位，二次注册抛错，风格对齐 `registerFallback`）；守卫回调 `(req, kind) => decision`，`kind: 'http' | 'upgrade'`；决策为判别联合 `{ allow: true, principal?: unknown } | { allow: false, status?: number, body?: string }`（否决默认 401 + `Unauthorized` 文案）。
2. 两处接线，均在**分发前**：HTTP 在 `handle()` 顶部（路由匹配与 fallback 之前）；upgrade 在 `'upgrade'` 监听器内路由查表之前。否决时 HTTP 写状态码+文案，upgrade 直接 `socket.destroy()`。
3. 放行时把守卫返回的 principal 存入以请求对象为键的 WeakMap，暴露 `principalOf(req)` 读取器，供后续 `/api` 处理链（#20 语义层钩子）取用；http 与 upgrade 两个 kind 的处理器都经同一个 `req` 可读。
4. 守卫抛错/拒绝 → fail-closed：记 warn 日志后按否决处理（HTTP 401 默认文案 / destroy）。
5. **未配置守卫时行为与 upstream 完全一致**：零行为差异（Config schema 不变，默认路径不经过任何守卫代码的可观察行为）。

## 非目标

- 不做任何 casdoor/租户/JWT 语义（#15/#18/#20 的职责）。
- 不改 `/api` 处理链本身、不改其他 host 包、不改 web 前端。
- 不做多守卫合成（单席位；多守卫是未来 upstream 话题）。
- 不把分支推到上游（本地分支维护；导出 patch 是 #18 的职责）。

## 任务拆分（单任务、单 commit）

### Task 1 — webserver 守卫扩展点（本 Issue 全部工作）

**Files:**
- Modify: `packages/host/webserver/src/index.ts`（新增类型 + `registerGuard` + `principalOf` + 两处接线）
- Test: `packages/host/webserver/tests/webserver.spec.ts`（沿用现有 REAL-composition 测试范式扩展）

TDD 步骤：
1. 先写失败测试：三态电池 —— (a) 未配置守卫：现有断言不受影响；(b) 放行：principal 经 `principalOf(req)` 在注册路由处理器内可读；kind 判别（http/upgrade 各自正确）；(c) 否决：HTTP 401+自定义文案，且否决先于路由（未注册路径也 401 而非 404）；upgrade 握手被拒（socket destroy，无 101）；(d) 边界：守卫抛错 fail-closed、重复注册抛错、disposer 释放席位后可重注册。
2. 聚焦运行确认 RED。
3. 实现扩展点（判别联合 + WeakMap + 两处分发前接线 + fail-closed）。
4. 聚焦测试 GREEN + 类型检查 +（如可用）构建门禁。
5. 在 `dsh-request-guard` 分支以**单 commit** 提交（信息：`feat(webserver): add optional request guard hook`），保持与 upstream diff 最小（仅上述两文件）。

## 测试与验收命令

- 聚焦：`pnpm vitest run packages/host/webserver`（worktree 根执行；宿主 vitest 配置自动拾取）。
- 类型检查：`node ./node_modules/typescript/bin/tsc -b tsconfig.host.json`（或仓库等价 typecheck 脚本）。
- 既有全绿基线：webserver 包既有测试在未配置守卫时全部保持绿（“宿主现有测试全绿”在受影响模块层面的落地；更广范围按最终审查裁定如实记录）。
- 验收（Issue 原文）：未配置守卫行为不变；配置后 HTTP 与 WS 升级均可否决（401 自定义响应体生效）；principal 在 /api 处理链可读（以注册于 /api/* 路径的测试路由验证）；改动通用无产品词汇、单 commit 位于 dsh-request-guard。

## 全局约束

- 中性形态：标识符与文案只用 guard/principal/kind/veto 词汇，禁止 tenant/casdoor/role 等产品词。
- 默认关闭 = 零行为变化；不许引入可观察的默认路径开销（除一次 Map 查找级别的分支）。
- 与 upstream diff 最小：只动 webserver 两文件，不重排既有代码，不改公共既有签名。
- SDD 纪律：RED 先行、逐任务 spec+质量审查、台账记录；implementer 不得自行派生 subagent。
