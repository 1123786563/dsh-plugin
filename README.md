# dsh-plugin

DeepSeek Harness（DSH）插件集合 monorepo。每个子目录 `plugins/<name>` 是一个独立的可发布插件包（声明 `dsh.bundle`，部分还带 `dsh.client` 浏览器半区）；`services/` 下是与插件配套的独立服务。

## 插件

| 目录 | 说明 |
| --- | --- |
| `plugins/dsh-plane` | Plane（makeplane）项目跟踪：`plane_*` 工具族、设置卡片（设置 → 插件）、better-sidebar 面板 |
| `plugins/dsh-job-search` | 租户隔离求职：`job_search_*` 工具族（建档/抓取/排序/投递/面试/结果）+ 会话头部"求职看板" |
| `plugins/dsh-open-design` | OpenDesign 设计引擎技能目录：以 `open-design` 提供者向宿主技能注册表注册 77 个设计技能 + 152 个品牌级设计系统 + 固定幻灯片框架（来自 nexu-io/open-design，Apache-2.0） |
| `plugins/dsh-openmeter` | OpenMeter 计费：LLM 调用逐条计量（WAL 至少一次投递）→ 自托管 fork；预付余额耗尽硬阻断（故障放行）；llm-cost 价格库 CNY 报价 + 即时估算；侧边栏用量面板 + 收银台（客户/充值/阻断/预设绑定） |
| `plugins/dsh-casdoor-auth` | Casdoor 登录门禁（dsh 侧半区）：验证网关 DshIdentityToken → `ctx.casdoorAuth`，SPA 401 登出监视器，装配 dsh-multi-tenant Agent 层租户隔离。与 `services/casdoor-gateway` 配套 |
| `plugins/dsh-nocobase` | NocoBase 低代码平台：根 compose 拉起实例（固定 2.2.2），casdoor OIDC 登录（自研 `@dsh/plugin-auth-casdoor`，JIT 建号 + email 绑定），设置卡片（实例地址/健康）+ 侧边栏打开入口 |

## 配套服务

| 目录 | 说明 |
| --- | --- |
| `services/casdoor-gateway` | Casdoor 认证网关（根 compose 服务 `casdoor-gateway`）：持有公口，OIDC 登录（授权码+PKCE）、SQLite 登录会话、特权方法角色门禁、HTTP/WebSocket 全量转发到 loopback 私口上的 dsh webserver |
| `services/higress-gateway` | Higress AI 网关本地部署模板：官方一键安装封装（env 驱动端口）+ 冒烟脚本；配套 `plugins/dsh-higress` |
| `services/openmeter` | 根 compose 里 OpenMeter fork 栈的配置（`openmeter.yaml`）与 Postgres 初始化 SQL；配套 `plugins/dsh-openmeter` |
| `services/nocobase` | NocoBase 的 Casdoor 认证插件源码与构建（`@dsh/plugin-auth-casdoor`，构建产物直挂进容器）；配套 `plugins/dsh-nocobase` |

## 本地外部服务（docker compose）

所有容器化外部依赖集中在根目录 `docker-compose.yml`，仓库根一条命令拉起：

```sh
docker compose up -d        # casdoor（认证 IdP）+ casdoor-gateway（认证网关）+ OpenMeter fork 栈（计费）
```

| 服务 | 宿主端口 | 服务的插件 |
| --- | --- | --- |
| casdoor | `127.0.0.1:8001` | dsh-casdoor-auth / services/casdoor-gateway / dsh-nocobase |
| casdoor-gateway | `127.0.0.1:3080`（`GATEWAY_HOST_PORT` 可改映射端口） | dsh-casdoor-auth 的公口入口（容器经 `host.docker.internal:38080` 回连宿主 dsh 私口；凭据经 `services/casdoor-gateway/.env`） |
| openmeter（fork 全栈：kafka/clickhouse/postgres/redis + server/sink/balance/billing） | `127.0.0.1:8888`（插件默认 endpoint） | dsh-openmeter |
| nocobase（+ nocobase-postgres） | `127.0.0.1:13000` | dsh-nocobase |

openmeter 镜像从同级 `../openmeter` 检出构建（fork 的 v3 API 是插件必需），可用 `OPENMETER_SRC_DIR` 覆盖路径。有意不并入：higress（官方安装脚本自管容器，走 `services/higress-gateway/install.sh`）、Plane（`dsh-plane` 面向 Plane Cloud 或既有自托管实例）。

## 安装某个插件到 dsh profile

```sh
# 在 dsh 检出目录（或任何能解析到 dsh CLI 的地方）
pnpm dsh plugin --profile web add link:/Users/wuyongjun/trea/dsh-plugin/plugins/dsh-plane
```

包声明了 `dsh.bundle.patch`，`dsh plugin` 会自动把包名追加进 `dsh.profile.bundles`。修改 bundle 列表后重启 `dsh web`。

## 开发

```sh
pnpm install
pnpm test         # 所有插件与服务
pnpm typecheck
pnpm build
```

## 新增插件

```sh
mkdir plugins/<name> && cd plugins/<name>
# 以 plugins/dsh-plane 为模板：package.json（dsh.bundle.patch + exports）
# src/、tests/、tsconfig.json、tsdown.config.ts、cordis.patch.yml
```

各插件构建产物（`lib/`）不入库；profile 通过 `link:` 直连源码目录，`pnpm build` 后即生效（浏览器半区刷新页面，宿主半区需重启 dsh web）。
