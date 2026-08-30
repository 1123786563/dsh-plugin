# 存量会话迁移演练 Runbook（issue #26）

> **前置（fresh clone 必读）**：gateway 测试与迁移工具依赖 multi-tenant 嵌套 workspace 的安装态。root `pnpm-workspace` 的 `plugins/*` glob 不覆盖自带 lockfile 的嵌套 workspace，fresh clone 后先跑：
>
> ```bash
> pnpm --dir plugins/dsh-multi-tenant install --frozen-lockfile
> ```

## 工具

除特别注明外，本文所有命令均在 **dsh-plugin 仓库根**执行（`--dir` 与脚本路径均为仓库根相对）；仅步骤②的宿主命令在 `<deepseek-harness>` checkout 下执行。

```bash
pnpm --dir services/casdoor-gateway build          # 脚本 import lib/ 编译产物，先 build
node services/casdoor-gateway/scripts/migrate-legacy-sessions.mjs [options]
```

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `--db <path>` | `<cwd>/.dsh-multi-tenant/session-ownership.sqlite` | 归属库；相对路径按当前目录解析；演练时必须显式传（见步骤②） |
| `--tenant <t>` / `--user <u>` | `dsh-ops` / `dsh-admin` | claim 目标 principal（ADR-0005 Q12=a），同时也是网关登录身份 |
| `--gateway <url>` | `http://127.0.0.1:3080` | 网关基址 |
| `--password <s>` | env `MIGRATION_PASSWORD` | 登录密码，禁止硬编码 |
| `--dry-run` | 关 | 只读预览：输出将迁移清单，零写入（不写库、不写任何状态文件） |

退出码：`0` 成功（含无可迁移）、`1` 参数错误、`2` 运行错误。stdout 第一行是完整 JSON 报告，随后是人类可读摘要（计数 + 迁移清单前 10 条 + target principal + db 路径）。

## 本地演练步骤

① **起 IdP 栈**（仓库根）：

```bash
docker compose up -d casdoor postgres    # casdoor @ 127.0.0.1:8001
```

② **起带 patch 宿主与网关**。带 patch 宿主 = 装了 `dsh-multi-tenant` 插件的 deepseek-harness（bundle patch 把 webserver 挪到 `127.0.0.1:38080`）：

```bash
# 终端 A，cwd = <deepseek-harness> checkout 根（宿主 cwd 即归属 DB 所在，--db 路径据此取）
cd <deepseek-harness> && DSH_MULTI_TENANT_STARTER=1 dsh web

# 终端 B，cwd = dsh-plugin 仓库根（本文其余命令同此基准）
pnpm --dir services/casdoor-gateway dev    # 网关 @ 127.0.0.1:3080
```

**`--db` 实际路径取法**：归属库默认落在**宿主进程 cwd** 下——`<宿主cwd>/.dsh-multi-tenant/session-ownership.sqlite`（或宿主启动时的 `DSH_MULTI_TENANT_SQLITE_PATH`）。演练时把这个绝对路径显式传给 `--db`，不要依赖 CLI 的 cwd 默认值。

③ **造有主会话**：经网关 UI（`http://127.0.0.1:3080` 登录后新建会话）或 RPC（cookie 登录后 `POST /api/session.create`），以 `acme/alice` 与 `globex/bob` 各建 ≥2 个会话。multi-tenant 的 `onSessionCreated` 钩子会立即把新会话 claim 给创建者——这些就是「有主」行。

④ **制造无主夹具**：直接 SQL 删两行 `session_owners`（模拟门禁启用前的存量）。句柄带 `timeout: 5000`——演练期宿主在跑、可能持瞬时写锁，与 CLI 真跑的 `busy_timeout=5000` 对齐（node:sqlite 默认 timeout 0，遇锁即报 `database is locked`）：

```bash
node -e "const{DatabaseSync}=require('node:sqlite');\
const db=new DatabaseSync('<宿主cwd>/.dsh-multi-tenant/session-ownership.sqlite',{timeout:5000});\
console.log(db.prepare(\"DELETE FROM session_owners WHERE session_id IN (?,?)\").run('<sid-1>','<sid-2>'));db.close()"
```

只读验证（删后剩余行）：

```bash
node -e "const{DatabaseSync}=require('node:sqlite');\
const db=new DatabaseSync('<宿主cwd>/.dsh-multi-tenant/session-ownership.sqlite',{readOnly:true});\
console.log(db.prepare('SELECT session_id,tenant_id,user_id FROM session_owners ORDER BY session_id').all());db.close()"
```

⑤ **dry-run 断言清单**：

```bash
MIGRATION_PASSWORD='dsh-Admin1' node services/casdoor-gateway/scripts/migrate-legacy-sessions.mjs --dry-run \
  --db <宿主cwd>/.dsh-multi-tenant/session-ownership.sqlite --gateway http://127.0.0.1:3080
```

断言：`counts.claim` = 删除的行数；`claimed` 数组精确列出 `<sid-1>`/`<sid-2>`；再用步骤④的只读命令确认表内容不变。

⑥ **真跑**（去掉 `--dry-run`，其余同上）：断言 `outcome claimed=N failed=0`。

⑦ **可见性断言**：以 `acme/alice`（与 `globex/bob`）登录网关查 `POST /api/session.list`——被迁移的 `<sid-1>`/`<sid-2>` 不得出现在其 `items`；以 `dsh-ops/dsh-admin` 登录查询——全部会话可见。

⑧ **幂等重跑**：再执行一次步骤⑥的命令。断言：`plan` 行不变（claim=N 仍为计划值），`outcome claimed=0 skipped-owned=N`，且步骤④的只读查询输出与⑥结束后一致（无新写入）。

⑨ **清理与留档**：演练库是宿主 cwd 下的真实文件——演练后删除 `<宿主cwd>/.dsh-multi-tenant/session-ownership.sqlite`（或整目录），停网关/宿主/`docker compose stop casdoor postgres`；把数量、清单摘要与命令输出摘录追加到下面「演练记录」。

## 演练记录

### 2026-08-30 CLI 冒烟（不起全栈；宿主模式网关 + stub 上游 + 临时夹具）

环境：casdoor@8001（docker）真实登录链路；网关 `lib/server.js` 宿主模式 @3199（临时数据目录）；上游为按宿主 fetch-carrier 帧形状作答的 stub（`/api/session.list` 固定返回 4 会话）；归属库为临时 SQLite：预置 `owned-acme`（acme/alice）与 `ops-claimed`（dsh-ops/dsh-admin）两行，`legacy-1`/`legacy-2` 仅存在于清单（无主）。

`--dry-run` 输出（stdout 摘录）：

```
{"tool":"migrate-legacy-sessions","dryRun":true,"db":"…/session-ownership.sqlite","gateway":"http://127.0.0.1:3199","target":{"tenantId":"dsh-ops","userId":"dsh-admin"},"sessions":4,"counts":{"claim":2,"skipOwned":2,"skipUnknown":0,"claimed":2,"skippedOwned":0,"failed":0},"claimed":["legacy-1","legacy-2"],…}
legacy session migration — dry-run (nothing written)
  target principal : dsh-ops/dsh-admin
  sessions listed  : 4
  plan             : claim=2 skip-owned=2 skip-unknown=0
  outcome          : would claim=2 skipped-owned=0 failed=0
  would-claim list (first 2):
    - legacy-1
    - legacy-2
```

断言结果：dry-run 退出码 0；参数错误（缺密码）退出码 1；`--db` 指向不存在文件退出码 2；夹具库文件字节前后不变。真实 casdoor 登录→网关回调→cookie→经代理 `session.list` 解析全链路走通（stub 帧按 `{"type":"server-response","rpcId":…,"result":{"ok":true,"value":{"items":[{sessionId,…}]}}}` 作答，解析零容错失败即退出 2）。

### 全栈演练（步骤①-⑨）

待执行——带 patch 宿主（deepseek-harness + multi-tenant 插件）未在本次席位起盘。执行后在此追加：各计数、迁移清单、⑦/⑧ 断言输出摘录。
