# host-patches — deepseek-harness 本地分支的 patch 副本与应用工具

本目录为 deepseek-harness 宿主仓上维护的本地分支提供**双保险**：分支本身只存在于宿主 checkout 中，一旦丢失（误删分支、重新 clone、worktree 清理），改动可从本仓的 `.patch` 副本一键重放。威胁模型与决策记录见 [ADR-0004](../../plugins/dsh-casdoor-auth/docs/adr/0004-host-guard-hooks-patch.md)：宿主本地 patch 是唯一能全覆盖 HTTP 路由 + `/api` + WS 升级的代码层方案，宿主只定义中性钩子协议，产品逻辑留在插件侧。后续宿主钩子改动（#20、#24）并入同一套工具链管理。

## 状态表

| 项 | 值 |
| --- | --- |
| patch 文件 | `deepseek-harness.dsh-request-guard.patch` |
| 宿主分支 | `dsh-request-guard`（单 commit `feat(webserver): add optional request guard hook`） |
| 分支 tip | `1bd06a979894483b12489d551f3d1ad8581c6351` |
| 基线 commit（upstream master） | `cd5ef8148158c3a752a658978873241fdf8e2bbc` |
| 变更规模 | 5 文件，+329/−38（`packages/host/webserver/` 下 README×3 + src + tests） |
| 导出命令 | `git -C /Users/wuyongjun/trea/deepseek-harness diff cd5ef8148158c3a752a658978873241fdf8e2bbc..1bd06a979894483b12489d551f3d1ad8581c6351` |

patch 文件保持**纯净 git diff 输出**（首行即 `diff --git`，无任何前置注释——统一 diff 中 `#` 行不是合法头，会导致 `git apply` 拒绝）；溯源元数据放在本表与 `apply.sh` 的常量里。

## 重放（apply.sh）

```sh
# 实际应用到指定宿主 checkout（不自动 commit，改动留在工作树由操作者审查提交）
./apply.sh --repo /path/to/deepseek-harness

# dry-run：只探测与校验，不落地任何改动
./apply.sh --repo /path/to/deepseek-harness --check

# 目标路径也可由环境变量提供
DSH_HOST_REPO=/path/to/deepseek-harness ./apply.sh --check
```

- `--repo <path>`：目标仓路径，缺省取 `$DSH_HOST_REPO`；两者皆空报用法错误退出 2。
- 显式 `--repo` 参数优先于 `DSH_HOST_REPO` 环境变量；重复 `--repo` 时后者生效（last-wins）。
- `--check`：幂等探测 + `git apply --check` 预演，成功输出结论退出 0，不修改工作树。
- 幂等语义：先做 `git apply --check --reverse` 探测——补丁已存在则输出 `already applied, skipping` 退出 0；不存在则正向预演，失败（基线不符/冲突）退出 1 并提示基线 commit。
- 实际应用后再次 reverse 探测确认，输出应用文件数（取自 patch 头）；**不自动 commit**。

钩子语义与消费方（dsh-casdoor-auth）见 [ADR-0006](../../plugins/dsh-casdoor-auth/docs/adr/0006-zero-trust-private-port-guard.md)。

## 回退

应用产生的未提交改动，在宿主仓二选一回退：

```sh
# 只撤销 patch 涉及的文件（保留本地其它未提交改动）
git -C /path/to/deepseek-harness checkout -- packages/host/webserver

# 或整体回到干净 upstream（丢弃工作树全部本地改动）
git -C /path/to/deepseek-harness reset --hard origin/master
```

宿主分支 `dsh-request-guard` 本身如需回退，直接删分支即可回到零 patch 状态（副本仍在本仓）。

## 升级循环

宿主 upstream 前进后，按此循环刷新本仓副本：

1. 宿主仓更新分支基线：`git fetch origin && git rebase origin/master`（在 `dsh-request-guard` 分支上；冲突集中在 webserver 分发点，见 ADR-0004）。
2. 跑宿主门禁（`pnpm run test` / `typecheck` 等，以宿主仓 AGENTS.md 为准），确认钩子行为未回归。
3. 用与生成时**完全相同**的 diff 命令重新导出（见状态表；rebase 后 tip 变化则替换新 tip），覆盖本目录 patch 文件。
4. 同步更新本 README 状态表（tip / 基线 / 规模）与 `apply.sh` 中的常量，在本仓提交。

## 自检

```sh
tmp=$(mktemp -d /tmp/host-patch-selftest-XXXX)
git clone --quiet --no-hardlinks --shared /Users/wuyongjun/trea/deepseek-harness "$tmp"
git -C "$tmp" checkout --quiet --detach cd5ef8148158c3a752a658978873241fdf8e2bbc
./apply.sh --repo "$tmp" --check        # → check ok, exit 0
./apply.sh --repo "$tmp"                # → applied
./apply.sh --repo "$tmp" --check        # → already applied, skipping, exit 0
rm -rf "$tmp"
```

`--shared` clone 只读宿主对象库，宿主仓存在其它 worktree 时也安全；全程不对宿主仓本身做任何写操作。
