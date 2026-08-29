# Issue #15 — 网关容器化基础（casdoor-gateway 进根 compose）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development — implement task-by-task with fresh implementer subagents, per-task spec + quality review, ≤5 fix rounds, final full-branch review.

- **Issue:** https://github.com/1123786563/dsh-plugin/issues/15（注意：该系列 issue 标题序号比正文少 1，#15 标题错标为「v2 03 验签增强」，**以正文为准**——正文是网关容器化基础；无补充评论，已核实）
- **Working repo:** dsh-plugin 检出于 `/Users/wuyongjun/trea/dsh-plugin`，隔离 worktree `.worktrees/gate-v2-15`，分支 `feat/gate-v2-15-gateway-docker`，基于 **main @ 4d2f04e**（worktree 已建好、干净）。
- **References:** ADR-0003（`plugins/dsh-casdoor-auth/docs/adr/0003-fastify-openid-client-stack.md`）；网关 README（`services/casdoor-gateway/README.md`）；路线图源稿 `docs/superpowers/plans/2026-08-26-gate-v2-15-gateway-containerization.md`。

## 范围

1. **issuer 内外分离（核心难点）**：网关 config 新增「内部发现基址」`CASDOOR_INTERNAL_ISSUER`（裸 origin，默认 = `CASDOOR_ISSUER`，未配置时行为与现状零差异）。配置后：openid-client 的 discovery 请求、token 兑换（`oidc.ts` 手动 POST）、JWKS 拉取（`createRemoteJWKSet` 的 URL）全部走内部基址；**浏览器可见的 authorize 重定向、RP-initiated logout URL、以及 ID-token `iss` 校验值一律保持外部 issuer**。
2. **Dockerfile**：`services/casdoor-gateway/Dockerfile` 多阶段构建——node:22-slim + corepack pnpm@11.7.0（与根 `packageManager` 一致）+ `pnpm fetch` / `pnpm --filter dsh-casdoor-gateway install --offline --frozen-lockfile` / `tsc` 构建 / `pnpm deploy --prod` 产出按 lockfile 修剪的 prod node_modules；运行阶段非 root（内置 `node` 用户）、`/data` 数据目录、入口 `node lib/server.js`。仓库根新增 `.dockerignore`。
3. **根 compose 服务**：`docker-compose.yml` 增 `casdoor-gateway` 服务——默认 `"127.0.0.1:3080:3080"`（正式形态不变）、`restart: unless-stopped`、`casdoor-gateway-data:/data` 持久卷、与 casdoor 同 compose 网络（内部基址用服务名 `http://casdoor:8000`）、upstream 指向 `http://host.docker.internal:38080`（dsh 本体留在宿主）、凭据经 `env_file: ./services/casdoor-gateway/.env` 透传（该文件 gitignored）。
4. **e2e 扩展**：`scripts/e2e.mjs` 增加（a）`E2E_GATEWAY_URL` 外部网关模式（不自行 spawn，对已运行的容器网关跑全链路）；（b）WS 升级步骤（现有九步完全没覆盖 WS）；（c）`E2E_RESTART_CMD` 重启持久性步骤（同一 cookie 跨容器重启仍有效 + JWKS kid 前后一致）。
5. **文档**：网关 README 部署章节改为 compose 正式形态（`pnpm dev` 降级为开发模式说明，含 issuer 内外分离的解释）；根 README 的服务表/端口表补 casdoor-gateway；`.env.example` 增 `CASDOOR_INTERNAL_ISSUER` 说明。

## 非目标

- **不动 `plugins/`**（dsh 侧半区是并行轨道 #18 的地盘；#14 的钉公钥 `identityPublicKey` 在插件 config，网关侧无对应 env 字段，无需透传——已核实 `services/casdoor-gateway/src/config.ts` 无相关字段）。
- 不容器化 dsh 本体（它操作本地文件）；不改 casdoor 服务定义（不加 healthcheck、不动 app.ini/init_data.json 种子）。
- 不解决真实 dsh 私口联调（38080 本轮无监听，用 stub 上游；真实链路列入「需人工/下轮」清单）。
- 不做 TLS/公网暴露、不改转发核心（proxy.ts）、不做 `docker compose up -d` 之外的开机自启编排。
- 不 push、不 `down -v`、不动宿主 3080 上的 live 进程。

## 关键事实（规划期读码/环境结论，implementer 直接采信）

1. **casdoor 的 discovery 端点由 `origin` 钉死在外部形式**：`docker/app.ini` 设 `origin = http://127.0.0.1:8001`，因此无论从哪个地址 fetch `/.well-known/openid-configuration`，返回的 `issuer`/`token_endpoint`/`jwks_uri` 都是 `http://127.0.0.1:8001/...`。**仅把 discovery 请求改走内部地址不够**——`oidc.ts` 的 `completeLogin` 手动 POST 到 metadata 里的绝对 `token_endpoint`，`verifyKey` 把 metadata 的 `jwks_uri` 交给 `createRemoteJWKSet`；这两个 URL 必须在使用点做「外部位 → 内部基址」的 origin 替换，否则容器内不可达。
2. **openid-client v6 的 issuer 校验可绕开且应自行补强**：`performDiscovery`（`node_modules/openid-client/build/index.js` L259–301）只在传入 URL **不含** `/.well-known/` 时才校验 `metadata.issuer === server.href`；传显式 well-known URL 则走 `_nodiscoverycheck` 路径。方案：discovery 一律用 `new URL('/.well-known/openid-configuration', internalIssuer)` 显式 URL，然后**自己断言** `new URL(metadata.issuer).href === new URL(外部 issuerString).href`，不符抛 `LoginError`（misconfiguration fails loud；同时钉死「URL.href 尾斜杠 vs casdoor iss 无尾斜杠」的既有坑——两侧都过 `new URL().href` 归一化后比较）。
3. **`buildAuthorizationUrl` 用 metadata 的 `authorization_endpoint`**：casdoor 返回外部位形式 → 浏览器重定向天然保持外部 issuer，不需要改。`idpLogoutUrl` 手工从 `options.issuer`（外部）构造，也不动。
4. **种子 redirect URIs 是 `http://127.0.0.1:3080/casdoor/callback` 与 `http://127.0.0.1:3099/casdoor/callback`**（`docker/init_data.json`，已解析核实）。宿主 3080 被 live dsh web 占用（已核实 PID 监听中），本轮验证端口取 **3099**（种子已授权、当前空闲）。e2e.mjs 现用的 30820 **不在**种子列表——宿主模式 e2e 是否仍能登录取决于 casdoor 卷内 App 对象的实际 redirect 配置，需起来后实测（见风险）。
5. **casdoor 容器 Exited(2) 诊断**：日志尾部至 07:57 仍在正常服务请求（含一次完整登录链），无 panic；同刻 `dsh-postgres-1` Exited(0)；`RestartCount=0`。高度指向 12h 前人工 `docker compose stop`（beego 收 SIGTERM 退出码 2），非崩溃。`docker compose up -d casdoor` 应可直接拉回（卷 `dsh_casdoor-data` 保留、已播种：alice/alice-Acme1、bob/bob-Globex1、dsh-admin/dsh-Admin1，应用 `dsh-gateway`，secret `change-me-64-hex` 见 `services/casdoor-gateway/.env`）。implementer 先 `docker inspect`/`docker logs` 复核再 up。
6. **机器上另有一个无关 compose 项目**（project `docker-compose`）的 casdoor 跑在 `0.0.0.0:8000`，与根 compose 的 `127.0.0.1:8001` 无端口冲突——不要触碰、不要混淆。
7. **#14 钉公钥与本票的交点**：插件侧 `identityPublicKey`（ADR-0004 pin-first）+ `gatewayJwksUrl` 默认 `http://127.0.0.1:3080/.well-known/jwks.json`。compose 把容器 3080 映射回宿主 3080，插件（宿主侧）取 JWKS 不受影响；钉公钥模式下连 JWKS 都不取。容器重建不换钥由 `/data` 持久卷保证，验收用 JWKS kid 前后对比证明。
8. **e2e.mjs 的 WS/stub 覆盖面结论**：stub 上游带 upgrade handler（回 101），但九步主流程**没有任何一步发起 WS 升级**——WS 代理只被 `tests/app.spec.ts` 的单元测试覆盖（401 拒绝 + 鉴权后 101）。本票 Task 3 在 e2e 补容器级 WS 步骤。
9. **UpstreamAuth 的 token 文件位置缺口（真实 dsh 场景）**：`upstream-auth.ts` 读 `dataDir/webserver-token.json`，容器内即 `/data/webserver-token.json`（卷内）；而插件按 `gatewayDataDir: '~/.dsh-casdoor-gateway'` 写在**宿主 home**。容器网关对启用 browser-auth 的真实 dsh 拿不到 launch token。本轮 stub 上游无此问题；真实链路列入开放问题（bind-mount 宿主 token 文件或让插件写共享路径，需与 #18 轨道协调）。

## 任务拆分（3 任务，每任务单 implementer、单 commit）

> 粒度理由：brief 建议 2–3 任务。取 3——Task 1 是纯逻辑、完全 TDD 可测，独立可审；Task 2 是纯构建产物，`docker build` 单命令可验、不依赖 compose；Task 3 是接线 + 验收矩阵 + 文档，依赖前两者。合并 2+3 会让镜像构建问题与 compose/文档变更混在一个审查单元里，故不合并。

### Task 1 — 内部发现基址：config 字段 + oidc.ts 内外分离（TDD）

**Files:**
- Modify: `services/casdoor-gateway/src/config.ts`（`GatewayConfig` 增 `casdoorInternalIssuer: URL`；`loadGatewayConfig` 读 `CASDOOR_INTERNAL_ISSUER`，fallback 为**已解析的** `casdoorIssuer.href`——默认即「与 issuer 相同」；复用 `parseUrl` 的 bare-origin 校验，错误字段名 `CASDOOR_INTERNAL_ISSUER`；JSDoc 写明「网关自身发起的 discovery/token/JWKS 用这个基址；iss/aud 断言与浏览器重定向保持外部 issuer」）
- Modify: `services/casdoor-gateway/src/oidc.ts`：
  - `CasdoorOidcOptions` 增 `internalIssuer: URL`（非可选——config 层已把默认收敛为等于 issuer，单一代码路径、无行为分叉）；`server.ts` 传 `config.casdoorInternalIssuer`。
  - `configuration()`：改调 `oidc.discovery(new URL('/.well-known/openid-configuration', this.options.internalIssuer), clientId, secret, undefined, INSECURE)`（显式 well-known URL → 绕开库的 issuer-match；见关键事实 2）；discovery 成功后自断言 `new URL(metadata.issuer).href !== new URL(this.issuerString).href → throw LoginError`（含两侧字段名的外部/内部值，便于排障）。
  - 新增 `private internalize(url: URL): URL`：当 `url.origin === options.issuer.origin && options.internalIssuer.origin !== options.issuer.origin` 时，把同 path+query 搬到 `internalIssuer.origin`；否则原样返回。在 `completeLogin` 的 `tokenEndpoint` 与 `verifyKey` 的 `jwksUri` 使用点应用；`verifyKey` 的 fallback 路径（无 jwks_uri 时）直接从 `internalIssuer` 构造 `/.well-known/jwks`。
  - `beginLogin`/`idpLogoutUrl` 不动（authorize 与 logout 保持外部位，见关键事实 3）。
  - `server.ts` 启动日志在内部基址 ≠ 外部 issuer 时追加一段（如 `discovery via http://casdoor:8000`）——这是验收时「容器内 discovery 走内部地址」的日志证据源。
- Test: 新增 `tests/oidc.spec.ts`（该模块目前零单测；范式对齐 app.spec.ts：node:http 起本地 stub IdP，vitest 直 import `../src/oidc.ts`）＋ 新增 `tests/config.spec.ts`（config 解析聚焦用例）。
  - stub IdP：单端口监听 127.0.0.1:0；`GET /.well-known/openid-configuration` 返回**外部位形式的 metadata**（`issuer`/`authorization_endpoint`/`token_endpoint`/`jwks_uri` 全部指向传入的外部 origin——模拟 casdoor origin 钉死行为）；`POST <token>` 记录到达的 host/port 并返回用 jose Ed25519 签发的 id_token（`iss`=外部、`aud`=clientId、`sub`/`roles` 齐备）；`GET <jwks>` 返回验签公钥。

**TDD 步骤：**
1. 先写失败测试 `tests/oidc.spec.ts`：
   - a) **默认零差异**：不配内部基址（internal=external=stub 端口）——`beginLogin` 的 authorize URL、token POST、jwks fetch 全部落在外部 origin（即 stub 本身）；iss 断言通过。
   - b) **内外分离**：`issuer=http://127.0.0.1:<外部端口>`（**该端口无监听**，一旦请求打到即 ECONNREFUSED 快速失败），`internalIssuer=http://127.0.0.1:<stub端口>`——断言：`beginLogin` 返回的 authorize URL origin 仍是外部；`completeLogin` 的 token POST **到达 stub**（记录命中）；id_token（iss=外部）验签通过；jwks fetch 到达 stub；`idpLogoutUrl` 仍从外部 issuer 构造。
   - c) **fail loud**：stub 的 discovery 返回 `issuer` 与配置不符 → `LoginError`（含尾斜杠变体：metadata 带尾斜杠也能归一化通过/不带也通过；错值才抛）。
   - d) 边界：callback 缺 code/state、aud 不匹配等既有行为不回归（可少量补，不重测 app.spec 已覆盖面）。
2. `tests/config.spec.ts`：默认 `casdoorInternalIssuer.href === casdoorIssuer.href`；显式 env 解析；非 bare origin 拒绝且错误消息含字段名。
3. 聚焦运行确认 RED：`pnpm --filter dsh-casdoor-gateway exec vitest run tests/oidc.spec.ts tests/config.spec.ts`。
4. 实现上述 config/oidc 改动。
5. GREEN + 既有测试全绿（app/gate/identity-token/sessions 不改不红）+ `pnpm --filter dsh-casdoor-gateway typecheck`。

**验收命令：**
```sh
cd /Users/wuyongjun/trea/dsh-plugin/.worktrees/gate-v2-15
pnpm --filter dsh-casdoor-gateway test          # 全部 vitest（新增 + 既有）
pnpm --filter dsh-casdoor-gateway typecheck
```

**Commit:** `feat(gateway): split internal OIDC discovery base from browser issuer`

### Task 2 — Dockerfile + .dockerignore（可重复构建，验收矩阵驱动）

**Files:**
- NEW `services/casdoor-gateway/Dockerfile`（多阶段）：
  - builder `FROM node:22-slim`：`corepack enable && corepack prepare pnpm@11.7.0 --activate`（对齐根 `packageManager`）；`WORKDIR /repo`；COPY 整个 dockerignore 后的上下文（`pnpm-lock.yaml`、`pnpm-workspace.yaml`、根 `package.json`、`plugins/`、`services/`——pnpm 解析整个 workspace 需要全部 package.json）；`pnpm fetch`（按 lockfile 拉全量 store，可缓存层）；`pnpm --filter dsh-casdoor-gateway install --offline --frozen-lockfile`；`pnpm --filter dsh-casdoor-gateway run build`（tsc → `lib/`）；`pnpm --filter dsh-casdoor-gateway deploy --prod /deploy`（产出按 lockfile 修剪、自包含的 prod node_modules）。
  - runtime `FROM node:22-slim`：显式 `COPY --from=builder /deploy/node_modules /app/node_modules`、`COPY --from=builder /repo/services/casdoor-gateway/lib /app/lib`、`COPY --from=builder /repo/services/casdoor-gateway/package.json /app/`（显式拷贝，不依赖 deploy 的文件拷贝语义）；`RUN mkdir /data && chown node:node /app /data`；`USER node`；`ENV GATEWAY_DATA_DIR=/data NODE_ENV=production`；`EXPOSE 3080`；`ENTRYPOINT ["node", "lib/server.js"]`。
  - **与 Issue 原文「tsx 入口」的偏差，有意为之并论证**：tsx 是 devDependency（dev 用 `pnpm dev`），生产镜像跑 tsc 产物 `lib/server.js`——与 `pnpm start`、e2e.mjs（spawn `lib/server.js`）同构，prod 依赖更小、无 devtool 入镜像；满足「与网关运行时一致」的意图。
  - **fetch+deploy 论证（lockfile 一致/可重复）**：所有依赖解析经 `pnpm-lock.yaml`（`--frozen-lockfile --offline` 从 fetch 的 store 装），`deploy --prod` 按同一 lockfile 修剪出运行时 node_modules——不存在按 manifest 漂移安装的路径。
  - 镜像内不放 healthcheck 工具（slim 无 curl/wget）；健康检查由 compose 侧 `node -e fetch` 完成（根 compose nocobase 已有同款先例）。
- NEW 仓库根 `.dockerignore`：`node_modules`、`**/node_modules`、`**/lib`、`.git`、`.worktrees`、`.mimosa`、`.playwright-mcp`、`.superpowers`、`.DS_Store`、`**/*.tsbuildinfo`、`.env`、`**/.env`——**`.env` 必须排除**：凭据绝不进 build context/镜像层。

**TDD/验证步骤（构建产物用验收矩阵，不写单测）：**
1. `docker build -f services/casdoor-gateway/Dockerfile -t dsh-casdoor-gateway:local .`（仓库根执行）→ 成功。
2. 立即重复 build → 全层缓存命中（可重复构建证据：两次输出对比，无重新拉装）。
3. `docker image inspect dsh-casdoor-gateway:local --format '{{.Config.User}}'` → `node`（非 root）。
4. `docker run --rm dsh-casdoor-gateway:local node -e 'console.log(process.getuid())'` → `1000`。
5. 缺配置 fail loud：`docker run --rm dsh-casdoor-gateway:local`（无凭据 env）→ 非零退出、错误消息含 `CASDOOR_CLIENT_ID`。
6. lockfile 一致性：镜像内 `node /app/node_modules/fastify/package.json` 版本与 `pnpm-lock.yaml` 解析版本一致（抽查 fastify/openid-client/jose）。

**Commit:** `build(gateway): reproducible container image for the gateway`

### Task 3 — compose 服务 + e2e 容器模式 + 文档 + 验收矩阵执行

**Files:**
- Modify `docker-compose.yml`（认证段落内、保持中文注释风格）：
  ```yaml
  casdoor-gateway:
    build: { context: ., dockerfile: services/casdoor-gateway/Dockerfile }
    container_name: dsh-casdoor-gateway
    restart: unless-stopped
    depends_on: [casdoor]        # casdoor 无 healthcheck，started 即可；见风险
    env_file: [./services/casdoor-gateway/.env]   # CASDOOR_CLIENT_ID/SECRET（gitignored）
    ports:
      - "127.0.0.1:${GATEWAY_HOST_PORT:-3080}:3080"   # 正式默认 3080；本轮验证用 3099 覆盖
    environment:
      GATEWAY_HOST: 0.0.0.0                 # 覆盖 env_file 里的 127.0.0.1（environment 优先）
      GATEWAY_PORT: "3080"
      GATEWAY_PUBLIC_URL: ${GATEWAY_PUBLIC_URL:-http://127.0.0.1:3080}
      DSH_UPSTREAM_URL: http://host.docker.internal:38080
      CASDOOR_ISSUER: http://127.0.0.1:8001
      CASDOOR_INTERNAL_ISSUER: http://casdoor:8000    # compose 网络服务名（内部发现/兑换/JWKS）
      GATEWAY_DATA_DIR: /data
    volumes:
      - casdoor-gateway-data:/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 10s
  # volumes 段增：casdoor-gateway-data:
  ```
  端口参数化说明：`GATEWAY_HOST_PORT`/`GATEWAY_PUBLIC_URL` 必须成对覆盖（redirect URI 与映射端口一致）；默认值即正式形态 3080，**不为验证改正式配置**。内部基址选 compose 服务名 `http://casdoor:8000`（不走 Docker Desktop 的 host 转发，IdP 流量留在 compose 网内；备选 `http://host.docker.internal:8001` 写进 .env.example 注释）。
- Modify `services/casdoor-gateway/scripts/e2e.mjs`：
  - `E2E_GATEWAY_URL`：设则跳过 spawn `lib/server.js` 与本地 dataDir 逻辑（finally 不 kill 外部网关），全链路打该 URL；casdoor 常量维持 8001。
  - 新增 **WS 升级步骤**（两种模式都跑）：带登录 cookie 对 `${GATEWAY}/api/events.mux` 发裸 `http.request` 升级（照抄 tests/app.spec.ts `upgradeRequest` 形态），断言 `upgrade` 事件（101）；未登录升级仍 401 的断言顺带补上。
  - `E2E_RESTART_CMD`（仅外部模式可用）：登录后执行该命令（如 `docker compose restart casdoor-gateway`）→ 等 `/healthz` → 断言 (a) 同一 cookie 再请求 `/api/*` 非 401；(b) `/.well-known/jwks.json` 的 `kid` 与重启前一致。
  - 宿主模式 30820 与种子 redirect 列表不符的问题：新增 `E2E_GATEWAY_PORT` 覆盖（默认值待 casdoor 起来后实测——卷内 App 若无 30820 则默认改 3099 并在 commit 里说明理由）。
- Modify `services/casdoor-gateway/.env.example`：增 `CASDOOR_INTERNAL_ISSUER=`（空=同 CASDOOR_ISSUER；容器形态 `http://casdoor:8000`；解释 issuer 内外分离一句话）。
- Modify `services/casdoor-gateway/README.md`：部署章节改 compose 正式形态（up -d casdoor-gateway、凭据 env_file、卷、3099 验证端口说明、issuer 内外分离原理与尾斜杠坑）；「快速开始」的 `pnpm dev` 降级为开发模式。
- Modify 根 `README.md`：compose 服务表与端口表补 casdoor-gateway（3080；host.docker.internal 连宿主 dsh）。

**步骤：** 代码/文档改动 → 执行下方完整验收矩阵 → 全绿后 commit。

**Commit:** `feat(compose): run casdoor-gateway as a root compose service`

## 测试与验收命令（完整矩阵）

**本轮环境硬约束（必须遵守）**：宿主 3080 是 live dsh web（自动化会话自身的运行时）——**严禁停止/重启/端口冲突**；compose 正式配置保持 3080，验证一律用 `GATEWAY_HOST_PORT=3099 GATEWAY_PUBLIC_URL=http://127.0.0.1:3099` 覆盖；casdoor 用根 compose `dsh` 项目，**不得 `down -v`**；38080 无监听 → stub 上游（e2e 自动起）；种子账号即真实账号。

```sh
WT=/Users/wuyongjun/trea/dsh-plugin/.worktrees/gate-v2-15
cd $WT

# 0) casdoor 诊断 + 拉起（先读后写）
docker inspect dsh-casdoor --format '{{.State.ExitCode}} {{.State.FinishedAt}}'
docker logs dsh-casdoor --tail 30          # 复核无 panic（规划期结论：人工 stop，见关键事实 5）
docker compose up -d casdoor               # 连带 postgres（Exited(0)，干净退出）
curl -s http://127.0.0.1:8001/.well-known/openid-configuration | head -c 400
#   期望：issuer http://127.0.0.1:8001（origin 钉死的外部形式）

# 1) 单元测试（Task 1 验收，前两条即可）
pnpm --filter dsh-casdoor-gateway test && pnpm --filter dsh-casdoor-gateway typecheck

# 2) 镜像（Task 2 验收）
docker compose build casdoor-gateway       # 或 docker build -f services/casdoor-gateway/Dockerfile .
docker compose build casdoor-gateway       # 第二次全层缓存 = 可重复
docker image inspect dsh-casdoor-gateway:local --format '{{.Config.User}}'   # 期望 node

# 3) 正式形态不变形（不实际 up）
docker compose config | sed -n '/casdoor-gateway:/,/^  [a-z]/p'
#   期望：默认映射 127.0.0.1:3080:3080、PUBLIC_URL 默认 3080、INTERNAL_ISSUER=casdoor:8000

# 4) 本轮容器验证（3099 覆盖；stub 上游由 e2e 自动 spawn 在宿主 38080）
GATEWAY_HOST_PORT=3099 GATEWAY_PUBLIC_URL=http://127.0.0.1:3099 docker compose up -d casdoor-gateway
curl -sSI http://127.0.0.1:3099/login | grep -i '^location'
#   期望：location 以 http://127.0.0.1:8001/login/oauth/authorize 开头（浏览器重定向仍外部 issuer）
docker exec dsh-casdoor-gateway node -e "fetch('http://casdoor:8000/.well-known/openid-configuration').then(r=>r.json()).then(d=>console.log('discovery-ok issuer='+d.issuer))"
#   期望：容器内可达 casdoor 服务名，且返回的 issuer 是外部形式（这就是需要 origin 替换的证据）
docker logs dsh-casdoor-gateway 2>&1 | grep -o 'discovery via [^)]*'   # Task 1 加的启动日志证据

# 5) 全链路 + WS + 重启持久性（种子真实账号）
E2E_GATEWAY_URL=http://127.0.0.1:3099 \
E2E_RESTART_CMD='docker compose restart casdoor-gateway' \
CASDOOR_CLIENT_SECRET=change-me-64-hex \
  node services/casdoor-gateway/scripts/e2e.mjs
#   期望：ALL PASS——未登录 302/401、alice 登录、代理、403、登出、admin 放行
#         + WS 升级两步（未登录 401 / 已登录 101）
#         + 重启后：同 cookie 仍有效（非 401）、JWKS kid 前后一致

# 6) kid 对比的独立证据（不依赖脚本输出）
curl -s http://127.0.0.1:3099/.well-known/jwks.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).keys[0].kid))"

# 7) 收尾：停网关容器（3099 释放；casdoor 保持运行留给后续轮；绝不 down -v）
docker compose stop casdoor-gateway
```

**验收判据（对 Issue 四条 AC）**：
- AC1「3080 全链路」：本轮以 3099 等价验证（同代码路径、同 compose 服务；3080 被 live 进程占用，属环境约束）+ `docker compose config` 证明默认 3080——两条证据都进实施报告。
- AC2「重启不掉会话、公钥不变」：矩阵步骤 5 的 `E2E_RESTART_CMD` 断言 + 步骤 6 的 kid。
- AC3「issuer 内外分离」：步骤 4 的 location（外部）+ 容器内 discovery（内部地址可达、返回外部形式）+ Task 1 单测 b/c + iss 校验在真实登录中通过（步骤 5 完整走通即隐含）。
- AC4「README 与实际一致」：文档 diff 审查 + 步骤命令与 README 示例逐字对齐。

## 全局约束

1. **iss 校验值一律用外部 issuer**：`internalize` 只替换 discovery/token/JWKS 三个服务端使用点；authorize/logout/`jwtVerify` 的 issuer 永远外部位。尾斜杠精确一致坑：所有 issuer 比较先过 `new URL(x).href` 归一化（casdoor iss 无尾斜杠、URL.href 有）。
2. **默认零差异**：`CASDOOR_INTERNAL_ISSUER` 未配置时 `casdoorInternalIssuer === casdoorIssuer`（config 层显式收敛），`internalize` 恒等——不许出现「未配置走旧分支」的重复代码；既有测试不改不红。
3. **不动 `plugins/`**（#18 并行轨道地盘）；不改 casdoor 服务定义与种子文件。
4. **不 push**；全部工作在 `.worktrees/gate-v2-15`（分支 `feat/gate-v2-15-gateway-docker`），每任务单 commit，不混入无关改动。
5. **不动 live 进程**：不 bind/kill/重启宿主 3080 的任何进程；验证用 3099 覆盖参数，正式配置默认值不动。
6. **compose 变更保留既有服务与注释风格**（中文分节注释、`restart: unless-stopped`、loopback 端口绑定惯例）；新服务与 casdoor 同默认网络。
7. **`.env`/`.env.example`**：新增字段必须有说明；`.env` 已 gitignore，绝不入 git、绝不进 build context（`.dockerignore` 排除）；凭据只经 `env_file` 透传。
8. **服务端出网约束**（路线图原文）：内部基址替换只作用于管理员配置的两个固定 origin（issuer/internal），任何用户输入（returnTo 等）不进服务端请求 URL。
9. **容器安全基线**：非 root（`node` 用户）、`/data` 属主 node、无 secrets 入镜像层、healthcheck 用 node 内置 fetch。
10. **e2e 宿主模式既有行为保持**（新增步骤/模式为纯增量；若默认端口 30820→3099 需变更，commit message 说明实测依据）。
11. **commit 信息**用各任务给定的单条 message；测试范式/命名对齐现有 `*.spec.ts`。

## 本轮可自动验证 vs 需人工/下轮

**本轮自动**：Task 1 全部单测；镜像构建/缓存/非 root/lockfile 抽查；compose config 正式形态渲染；3099 容器全链路（种子账号登录、UI 代理到 stub、WS 升级、403/登出/admin）；重启持久性（会话 + JWKS kid）；文档与命令一致性。
**需人工/下轮**：真实 dsh 私口（38080）上的 UI/WS 全链路（本轮无监听）；UpstreamAuth launch-token 在容器内的文件交接（关键事实 9 的缺口）；`docker compose up -d` 全量默认端口（3080）在干净机器上的实测（本机被 live 进程占用）；e2e 宿主模式 30820 在当前 casdoor 卷内 App 配置下的可用性复核。
