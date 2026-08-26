> 对应 issue：[#17](https://github.com/1123786563/dsh-plugin/issues/17)（状态跟踪以 issue 为准，本文件是计划的仓库内源稿）

## What to build

dsh-plugin 仓库可以**一键导出/重放宿主本地分支的改动**：`scripts/host-patches/` 存放 deepseek-harness `dsh-request-guard` 分支的 `.patch` 副本与应用脚本，宿主 fork 从此有双保险（分支丢了可从本仓重放），升级流程有明确文档（fetch + rebase + 重新导出）。后续所有宿主钩子改动（#20、#24）都并入这套工具链管理。

## 实施计划

1. 约定目录 `scripts/host-patches/`：`deepseek-harness.dsh-request-guard.patch`（由分支对 upstream master 导出）+ `README.md`（升级循环文档：在宿主仓 fetch/rebase 分支 → 重导出 patch → 本仓提交）。
2. 应用脚本（bash 或 node）：幂等（检测已应用则跳过，例如按 patch 前缀探测）、支持 `--check` dry-run、支持 `--repo` 参数指定宿主 checkout 路径。
3. 演练：在一个干净的 upstream worktree 上重放成功，且宿主测试可跑通。
4. 脚本本身加最小自检模式（`--check` 即用）。

## Acceptance criteria

- [ ] patch 副本可在干净 upstream 上幂等应用（二次运行跳过不报错）
- [ ] 应用后宿主测试全绿（含 #13 的钩子测试）
- [ ] README 写清升级循环与回退（git checkout 回 upstream）路径

## Blocked by

- #13 — 宿主请求守卫钩子（先有分支与首个 commit，工具链才有内容管理）

## 文档

- [ADR-0004 patch 维护决策](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0004-host-guard-hooks-patch.md)
