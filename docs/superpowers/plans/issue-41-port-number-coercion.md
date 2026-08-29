# Issue #41 port number coercion 实施计划（DSH_CASDOOR_DSH_PORT Number() 强转）

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 让 `dsh-casdoor-auth` bundle patch 的私口 env 通道（`DSH_CASDOOR_DSH_PORT`）产出数值端口（`Number()` 强转），drill 恢复走该通道，全链路门禁与 51 步演练全绿。

**Architecture:** 缺陷在 `cordis.patch.yml` 一行 `!!js` 表达式：env 设值时产出字符串端口被宿主 webserver schema（`z.natural().max(65535)`）拒绝。修法为三元强转（空串视同未设），golden 断言钉住整串表达式防回退；drill 删除 profile 用户 patch 层绕行、恢复 env 注入 38081，以「drill 全绿」闭环证明修复；顺带带走 Issue 列明的三个可选文档/加固项（T2-m2、T2-m3、T3-m7）。

**Tech Stack:** cordis bundle patch（`!!js` 求值）+ schemastery schema；vitest golden-string 清单测试；Node ESM `.mjs` 演练脚本（raw-socket 探针）；pnpm workspace。

---

- **Issue:** https://github.com/1123786563/dsh-plugin/issues/41
- **Worktree:** `/Users/wuyongjun/trea/dsh-plugin/.worktrees/port-num-41`，分支 `fix/casdoor-port-41`，基于 main@`303413a`。
- **裁决口径（验收判据）：** 本票修的是 env 通道端口**类型**；Task 2 把 drill 恢复到 env 通道后完整复跑全绿（51 步、exit 0、零残留），即证明修复闭环。51 步计数不变。

## 背景与根因（读码证实，行号为当前工作树实测）

1. `plugins/dsh-casdoor-auth/cordis.patch.yml:19` 现为 `port: !!js process.env.DSH_CASDOOR_DSH_PORT ?? 38080`。env 一旦设值，`!!js` 求值产出**字符串**端口（实测 `DSH_CASDOOR_DSH_PORT=38081` → `"38081"` string），宿主 webserver schema（`z.natural().max(65535)`）拒绝 → dsh boot 失败（schemastery 报 expected number）。未设 env 时 `?? 38080` 为数字，故日常门禁不触发。缺陷行早于 #18 分支存在（pre-existing）。
2. 绕行现状：`scripts/zero-trust-drill.mjs` 因上述缺陷不敢用 env 通道，改写 profile 用户 patch 层（`startDsh` 内 `writeFileSync`，:459-472）注入数值端口，并 `delete env.DSH_CASDOOR_DSH_PORT`（:480）；头注 :30-36 记录了原因。
3. 文档暂注：`README.md:58` 端口约定句里「（该环境通道现产出字符串端口，drill 改走 profile patch 数值端口…）」；`README.md:111` 演练手册行同理。
4. 顺带项落点（Issue「相关顺手项」明文可选，随本票文档 pass 带走）：
   - T2-m2：`README.md:137` webmanifest「按规范不带 cookie」句补 W3C Web Application Manifest §fetching-a-manifest（credentials mode `"omit"`）引文；仓内先例 `services/casdoor-gateway/src/gate.ts:24-26`。注意：brief 写「README:64 附近」，实际该句在 :137（「已知边界」节）——以内容定位为准。
   - T3-m7：drill WS 非 101 臂加固——HTTP 臂全过时追加要求 `ended==='close' && bytes===0`（防死端口恒绿：死端口 `ended='error'`、firstLine 为空，现行断言照样绿）。
   - T2-m1（布尔 env on 值集合集中约定文档）：Issue 明言「非本票必改」→ 非目标。

## 修复后的 port 求值边界（推荐变体，计划采用）

`!!js process.env.DSH_CASDOOR_DSH_PORT ? Number(process.env.DSH_CASDOOR_DSH_PORT) : 38080`

| env 值 | 求值 | 结果 |
| --- | --- | --- |
| `'38081'` | truthy → `Number('38081')` | `38081`（数值）✓ schema 收 |
| 未设 / `''` | falsy → 字面量 | `38080`（避开 `Number('')===0` 随机端口）✓ |
| `'abc'` | truthy → `Number('abc')` | `NaN` → schema 大声拒绝 ✓（misconfiguration fails loud） |

## 范围

1. **Task 1（fix 本体）**：`cordis.patch.yml:19` 改三元 `Number()` 强转（其余行逐字保留）；`tests/manifest.spec.ts` golden 断言更新 + 新增防回退断言；`README.md:58` 暂注改写为正常表述；顺带 T2-m2（README:137 引文）、T2-m3（配置表补 `controlPage` 行，默认 `true`，`src/config.ts:69`）。
2. **Task 2（drill 恢复 env 通道 + 手册同步 + T3-m7）**：`scripts/zero-trust-drill.mjs` `startDsh` 改 env 注入 `DSH_CASDOOR_DSH_PORT=38081`、删 profile 用户 patch 写入与相关头注；WS 非 101 臂加固；`README.md:111` 手册行改写；构建宿主 rehearsal worktree 完整复跑 drill（ALL PASS 51 步、exit 0、零残留）+ 插件门禁复跑。
3. 每任务恰一条 commit（信息见各任务末步）。

## 非目标

- **T2-m1**（布尔 env on 值集合集中约定文档）——Issue 明言非本票必改，避免范围蔓延。
- 不改 `services/casdoor-gateway/**`、不改 `scripts/host-patches/**`（#20 并行轨道领地）；webmanifest 匿名转发特例去留属 #19 正文领地（开放问题，drill 中仍为记录不计失败项）。
- 不动宿主仓持久状态（rehearsal worktree 为一次性、零残留）；不动 live 3080 / 正式 38080；不更新 live web profile、不重启任何正式实例。
- 不 push；不改本仓（dsh-plugin）其它文件；不派生 subagent（由调度方按 subagent-driven-development 派 implementer）。

## 任务拆分（2 实施任务，每任务一条 commit）

### Task 1 — 端口强转本体 + golden 断言 + 文档 pass（TDD）

**Objective:** env 通道产出数值端口；golden 断言钉死整串强转表达式；README 暂注归位并带走 T2-m2/T2-m3。

**Files:**
- Modify: `plugins/dsh-casdoor-auth/tests/manifest.spec.ts:32-37`（`describe('cordis.patch.yml')` 首测试更新 + 新增一测试）
- Modify: `plugins/dsh-casdoor-auth/cordis.patch.yml:19`（仅此一行）
- Modify: `plugins/dsh-casdoor-auth/README.md:58`（暂注改写）、`:52-53` 之间（配置表插 `controlPage` 行）、`:137`（W3C 引文）

**Step 1: 写失败测试（先改 spec）**

`tests/manifest.spec.ts` 的 `describe('cordis.patch.yml')` 块开头（`it('moves the webserver onto the loopback private port'` 之前）加 golden 常量，更新该测试第三条断言，并紧随其后新增防回退测试。改后的块首应为：

```ts
describe('cordis.patch.yml', () => {
  // Golden string pins the whole ternary: env values are strings, so the old
  // `?? 38080` seam handed the webserver schema (z.natural().max(65535)) a
  // string port and dsh boot failed; '' must take the default branch because
  // Number('') === 0 would request a random port.
  const portSeam = 'port: !!js process.env.DSH_CASDOOR_DSH_PORT ? Number(process.env.DSH_CASDOOR_DSH_PORT) : 38080'

  it('moves the webserver onto the loopback private port', () => {
    expect(patch).toContain('- id: webserver')
    expect(patch).toContain('host: 127.0.0.1')
    expect(patch).toContain(portSeam)
  })

  it('coerces DSH_CASDOOR_DSH_PORT to a number (golden, regression-pinned)', () => {
    expect(patch).toContain(portSeam)
    expect(patch).not.toContain('process.env.DSH_CASDOOR_DSH_PORT ?? 38080')
  })
```

（其后 `it('inserts the plugin row ...` 等既有测试不动。）

**Step 2: 跑聚焦测试确认 RED**

```bash
cd plugins/dsh-casdoor-auth && pnpm vitest run tests/manifest.spec.ts
```

预期 FAIL：恰 2 个测试失败——`moves the webserver onto the loopback private port`（旧 yml 无三元整串）与新增 `coerces ... (golden, regression-pinned)`（整串缺失且旧 `?? 38080` 串仍在）；其余 6 个通过（`Tests  2 failed | 6 passed`）。若失败数不同，先停下核对再继续。

**Step 3: 最小实现（改 yml 一行）**

`cordis.patch.yml:19` 由：

```yaml
    port: !!js process.env.DSH_CASDOOR_DSH_PORT ?? 38080
```

改为：

```yaml
    port: !!js process.env.DSH_CASDOOR_DSH_PORT ? Number(process.env.DSH_CASDOOR_DSH_PORT) : 38080
```

其余 36 行逐字保留（含 :13-15 头注与 :21 起 insert 块）。

**Step 4: 跑聚焦测试确认 GREEN**

```bash
cd plugins/dsh-casdoor-auth && pnpm vitest run tests/manifest.spec.ts
```

预期 PASS：`Test Files  1 passed (1)`、`Tests  8 passed (8)`。

**Step 5: README 三处文档 pass**

1. `README.md:58` 整行替换为（删暂注、保留锚点链接与反引号）：

```markdown
端口约定：网关公口 `3080`、dsh 私口 `38080`（`DSH_CASDOOR_DSH_PORT` 可改，值经 `Number()` 强转：空串视同未设回落 `38080`，非数值得 `NaN` 由 webserver schema 大声拒绝；改口需同步网关 `DSH_UPSTREAM_URL` 与插件 `DSH_CASDOOR_GATEWAY_JWKS_URL`）、casdoor `8001`；演练（rehearsal drill）另起隔离私口 `38081` 的第二实例，不占用正式 `38080`（全流程见[演练手册](#演练手册zero-trust-私口守卫-rehearsal-drill)）。
```

2. `README.md:52`（`basePath` 行）与 `:53`（`mcpServers` 行）之间插一行（T2-m3；默认值实证 `src/config.ts:69` `controlPage: true`）：

```markdown
| `controlPage` | `true` | 是否在 `basePath` 提供网桥控制页（身份/准入状态页） |
```

3. `README.md:137` 整行替换为（T2-m2；补 W3C 规范引文，措辞对齐 `services/casdoor-gateway/src/gate.ts:24-26` 先例）：

```markdown
- `manifest.webmanifest` 经网关匿名转发会被守卫 401：PWA 安装元数据失效，UI 不受影响（浏览器拉取 manifest 不带 cookie——W3C [Web Application Manifest](https://www.w3.org/TR/appmanifest/#fetching-a-manifest) 规定 manifest 请求以 credentials mode "omit" 发出，登录态亦然）；取消网关侧匿名转发特例属 #19 正文领地（开放问题）。
```

**Step 6: 插件门禁三项全绿**

```bash
cd plugins/dsh-casdoor-auth && pnpm vitest run && pnpm typecheck && pnpm build
```

预期：vitest 全部通过（本包 5 个 spec 文件）、`tsc -b --pretty false` 零输出退出 0、`tsc -b && tsdown` 产出 `lib/` 退出 0。禁止把聚焦测试表述为全部通过。

**Step 7: Commit**

```bash
cd /Users/wuyongjun/trea/dsh-plugin/.worktrees/port-num-41
git add plugins/dsh-casdoor-auth/cordis.patch.yml plugins/dsh-casdoor-auth/tests/manifest.spec.ts plugins/dsh-casdoor-auth/README.md
git status   # 仅上述 3 文件入暂存
git commit -m "fix(casdoor-auth): coerce DSH_CASDOOR_DSH_PORT to number in bundle patch"
```

### Task 2 — drill 恢复 env 通道 + 手册同步 + WS 臂加固 + 完整复跑

**Objective:** drill 不再写 profile 用户 patch，私口 38081 经 `DSH_CASDOOR_DSH_PORT` 注入；WS 非 101 臂在 HTTP 矩阵全过时追加零字节拆连要求；宿主 rehearsal worktree 上完整复跑 ALL PASS（51 步）且零残留。

**Files:**
- Modify: `plugins/dsh-casdoor-auth/scripts/zero-trust-drill.mjs:56`（import）、`:30-36`（头注）、`:457-484`（`startDsh`）、`:493-546`（负路径矩阵 HTTP 循环 + WS 臂）
- Modify: `plugins/dsh-casdoor-auth/README.md:111`（手册行）

**Step 1: `startDsh` 恢复 env 通道，删 profile patch 写入**

`zero-trust-drill.mjs:457-484` 整函数替换为：

```js
/** Spawn the isolated second dsh instance in the rehearsal worktree. */
function startDsh (rt, hostWorktree, publicKeyPem, withGuard) {
  // Private port through the plugin's env seam: cordis.patch.yml coerces
  // DSH_CASDOOR_DSH_PORT with Number(), so the webserver schema accepts it.
  const env = {
    ...process.env,
    DSH_HOME: join(rt, 'dsh-home'),
    DSH_CASDOOR_DSH_PORT: String(PRIVATE_PORT),
    DSH_CASDOOR_GATEWAY_JWKS_URL: `${GATEWAY}/.well-known/jwks.json`,
    DSH_CASDOOR_GATEWAY_DATA_DIR: join(rt, 'gw-data'),
    DSH_CASDOOR_IDENTITY_PUBLIC_KEY: publicKeyPem,
  }
  if (withGuard) env.DSH_CASDOOR_GUARD = '1'
  else delete env.DSH_CASDOOR_GUARD
  return spawnChild('dsh', 'pnpm', ['dsh', 'web', '--no-open'], { cwd: hostWorktree, env })
}
```

（显式设值覆盖继承的 env，取代原 `delete env.DSH_CASDOOR_DSH_PORT`。）

同步删掉现已无用的 import：`zero-trust-drill.mjs:56` 由

```js
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
```

改为：

```js
import { existsSync, readFileSync, rmSync } from 'node:fs'
```

（`writeFileSync` 全文件仅 `startDsh` 一处使用；删写入后必须同步删 import。）

**Step 2: 头注 :30-36 改写**

```text
 * Private-port note: the isolated private port is injected through the
 * plugin's env seam DSH_CASDOOR_DSH_PORT (cordis.patch.yml coerces it with
 * Number(), so the webserver schema accepts it) — no profile patch layer is
 * written and no file outside $RT is touched.
```

**Step 3: T3-m7 — WS 非 101 臂加固（HTTP 臂全过时追加 `ended==='close' && bytes===0`）**

3a. HTTP 矩阵循环（原 :507-533）改为先累计 `httpArmsOk` 再 record（断言与文案不变，仅提取 ok 变量）：

```js
  let httpArmsOk = true
  for (const item of cases) {
    const res = await timedFetch(`${UPSTREAM}${item.path}`, {
      method: item.method,
      headers: {
        ...(item.body === undefined ? {} : { 'content-type': item.contentType ?? 'text/plain' }),
      },
      ...(item.body === undefined ? {} : { body: item.body }),
      redirect: 'manual',
    })
    const contentType = res.headers.get('content-type') ?? ''
    if (item.method === 'HEAD') {
      // HTTP semantics make the veto body unreadable on HEAD, and the veto
      // path emits no content-length either: assert the observable veto
      // (401 + text/plain) and, whenever a length is present, byte exactness.
      const expected = String(Buffer.byteLength(GUARD_HINT))
      const length = res.headers.get('content-length')
      const ok = res.status === 401 && contentType.startsWith('text/plain')
        && (length === null || length === expected)
      httpArmsOk = httpArmsOk && ok
      record(`直连 ${item.label} → 401 固定文案（HEAD 无 body，content-length 如有须逐字）`,
        ok,
        `HTTP ${String(res.status)} ${contentType} content-length=${length ?? 'absent'}（文案 ${expected}B）`)
      continue
    }
    const body = await res.text().catch(() => '')
    const ok = isGuardVeto(res.status, body, contentType)
    httpArmsOk = httpArmsOk && ok
    record(`直连 ${item.label} → 401 固定文案`,
      ok,
      `HTTP ${String(res.status)} ${contentType} body=${JSON.stringify(body.slice(0, 40))}`)
  }
```

3b. WS 两臂（原 :538-546，含其上方注释）替换为：

```js
  // WS direct connect on the registered downlink path: raw upgrade without
  // a credential, and with a fake one. The guard's upgrade veto destroys the
  // socket before any 101 — with the HTTP matrix green the port is provably
  // alive and guarded, so additionally require the zero-byte teardown: a
  // dead port (ECONNREFUSED → ended='error') must not keep this arm green.
  for (const arm of [
    { label: 'WS 直连 /api/remote.mux 无 token', headers: {} },
    { label: 'WS 直连 /api/remote.mux 伪 token', headers: { [IDENTITY_HEADER]: 'not.a.jwt' } },
  ]) {
    const probe = await wsProbe(PRIVATE_PORT, WS_PATH, arm.headers)
    const tornZeroByte = probe.ended === 'close' && probe.bytes === 0
    record(`${arm.label} → 无 101 且零字节拆连`,
      !probe.firstLine.startsWith('HTTP/1.1 101') && (!httpArmsOk || tornZeroByte),
      `${probe.ended} ${String(probe.bytes)}B "${probe.firstLine}"`)
  }
```

语义：`!httpArmsOk || tornZeroByte`——HTTP 臂已全过（端口确证存活且有守卫）时追加零字节拆连硬要求；HTTP 臂已败时不级联失败，维持原「无 101」弱断言。record 调用数不变（仍 2 臂），**51 步计数不变**。依据：`src/guard.ts:40-42`「an upgrade veto destroys the socket instead」。若复跑实测拆连签名不同（如 `ended='headers'` 且 bytes>0，说明宿主 veto 先写了响应），**停下上报，不得静默放宽断言**。

**Step 4: README.md:111 手册行改写**

整行替换为：

```markdown
- 私口 38081 经 `DSH_CASDOOR_DSH_PORT` 环境通道注入（`cordis.patch.yml` 已作 `Number()` 强转，env 字符串端口不再被 webserver schema 拒绝）；drill 不写 profile 用户 patch 层，隔离与清理契约不变。
```

（README:62、:110、:114-131 清理/中断恢复节所述契约均不变，不动。）

**Step 5: 语法门 + 插件门禁**

```bash
cd /Users/wuyongjun/trea/dsh-plugin/.worktrees/port-num-41
node --check plugins/dsh-casdoor-auth/scripts/zero-trust-drill.mjs   # 零输出退出 0
cd plugins/dsh-casdoor-auth && pnpm vitest run && pnpm typecheck && pnpm build
```

预期全绿（drill 为 .mjs，`node --check` 兜语法；包门禁确认无回归）。

**Step 6: 构建宿主 rehearsal worktree（README 演练手册步骤，变量取本 worktree）**

```bash
HOST_REPO=/Users/wuyongjun/trea/deepseek-harness
PLUGIN_WT=/Users/wuyongjun/trea/dsh-plugin/.worktrees/port-num-41

# casdoor 栈（幂等；本轮已 Up）
cd /Users/wuyongjun/trea/dsh-plugin && docker compose up -d casdoor postgres

# 本 worktree 依赖与构建（drill 只读复用网关 lib；被 link 插件需产物）
cd "$PLUGIN_WT" && pnpm install
pnpm --filter dsh-casdoor-gateway build
pnpm --filter dsh-casdoor-auth build
pnpm --filter dsh-multi-tenant... build

# 宿主 rehearsal worktree：先清残留再新建（一次性、零残留）
git -C "$HOST_REPO" worktree remove --force .worktrees/patch-rehearsal-g18 2>/dev/null || true
git -C "$HOST_REPO" worktree add --detach .worktrees/patch-rehearsal-g18 cd5ef8148158c3a752a658978873241fdf8e2bbc
bash "$PLUGIN_WT/scripts/host-patches/apply.sh" --repo "$HOST_REPO/.worktrees/patch-rehearsal-g18"
cd "$HOST_REPO/.worktrees/patch-rehearsal-g18"
pnpm install --frozen-lockfile
pnpm run build        # 全量构建：web profile 需要全部 client bundle（数分钟）

# 隔离 web profile link（DSH_HOME 在 $RT 内）
RT=$(mktemp -d /tmp/zero-trust-g18-XXXX)
DSH_HOME=$RT/dsh-home pnpm -C "$HOST_REPO/.worktrees/patch-rehearsal-g18" dsh \
  plugin --profile web add link:$PLUGIN_WT/plugins/dsh-casdoor-auth
DSH_HOME=$RT/dsh-home pnpm -C "$HOST_REPO/.worktrees/patch-rehearsal-g18" dsh \
  plugin --profile web add link:$PLUGIN_WT/plugins/dsh-multi-tenant/packages/multi-tenant
```

**Step 7: 完整复跑 drill（验收核心）**

```bash
cd "$PLUGIN_WT"
node plugins/dsh-casdoor-auth/scripts/zero-trust-drill.mjs \
  --host-worktree "$HOST_REPO/.worktrees/patch-rehearsal-g18" \
  --rt "$RT"
echo "exit=$?"
```

预期：退出码 0，末行 `ALL PASS (51 steps)`；WS 两臂 detail 形如 `close 0B ""`。已知不计失败项照旧：`GET /manifest.webmanifest` 经网关匿名转发被守卫 401（README:137，#19 领地开放问题，仅 `📝` 记录）。**dsh 能经 env 通道在 38081 起来这件事本身就是强转修复的端到端证明**（修复前 boot 即被 schema 拒绝）。

**Step 8: 零残留核验与宿主清理**

```bash
lsof -nP -iTCP:38081 -iTCP:30820 -sTCP:LISTEN   # 应为空（drill 自清子进程）
test ! -e "$RT" && echo "$RT removed"            # drill 正常结束已删 $RT
git -C "$HOST_REPO/.worktrees/patch-rehearsal-g18" status --porcelain   # patch 的 5 个 M + ?? .dsh-multi-tenant/
git -C "$HOST_REPO/.worktrees/patch-rehearsal-g18" checkout -- .
git -C "$HOST_REPO" worktree remove --force .worktrees/patch-rehearsal-g18
git -C "$HOST_REPO" worktree list   # 回演练前基线（main + dsh-request-guard 两项）
```

**Step 9: 插件门禁复跑 + Commit**

```bash
cd "$PLUGIN_WT/plugins/dsh-casdoor-auth" && pnpm vitest run && pnpm typecheck && pnpm build
cd "$PLUGIN_WT"
git add plugins/dsh-casdoor-auth/scripts/zero-trust-drill.mjs plugins/dsh-casdoor-auth/README.md
git status   # 仅上述 2 文件入暂存
git commit -m "test(casdoor-auth): restore drill env port channel after number coercion"
```

## 测试与验收命令（Issue 明文验收）

```bash
cd plugins/dsh-casdoor-auth && pnpm vitest run && pnpm typecheck && pnpm build   # 三项全绿
```

加完整 drill 复跑全绿（Task 2 Step 6-8：ALL PASS 51 步、exit 0、零残留）。两任务共恰 2 条 commit，各自门禁先行；禁止把局部/聚焦测试表述为全部通过。

## 全局约束（红线）

- 只在 worktree `/Users/wuyongjun/trea/dsh-plugin/.worktrees/port-num-41`（分支 `fix/casdoor-port-41`）改动；不动主工作树与其它 worktree；不 push。
- 提交前插件门禁三项必须全绿（`pnpm vitest run` / `pnpm typecheck` / `pnpm build`）。
- 不改 `services/casdoor-gateway/**`、不改 `scripts/host-patches/**`（#20 并行轨道领地）；宿主仓仅一次性 rehearsal worktree，用后零残留。
- 不动 live 3080 端口进程与正式 38080 私口；drill 只碰 38081/30820/8001。
- `cordis.patch.yml` 除 :19 外逐字保留；golden 断言钉住**整串**强转表达式（含 `Number(`），并 `not.toContain` 旧 `?? 38080` 串防回退。
- 51 步 drill 计数与零残留契约不变；SIGINT/SIGTERM 处理器等 #18 已落地的清理纪律不得回退。
- 文件恰一个末行换行；`git diff --cached --check` 干净。
