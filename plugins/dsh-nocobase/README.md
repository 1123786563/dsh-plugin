# dsh-nocobase

NocoBase 低代码平台接入 DeepSeek Harness：根 docker-compose 拉起 NocoBase 实例（固定版本 `2.2.2`），登录走 casdoor OIDC（授权码流），dsh 侧提供设置卡片（实例地址 + 健康状态）与侧边栏打开入口。

## 能力

- **部署**：根 `docker-compose.yml` 的 `nocobase` + `nocobase-postgres`（数据在 `noco-storage` / `noco-pg-data` 卷），`127.0.0.1:13000` 直连。
- **casdoor 登录**：自研 NocoBase 认证插件 `@dsh/plugin-auth-casdoor`（源码在 `services/nocobase/plugin-auth-casdoor`，构建产物直挂进容器）。首次登录 JIT 自动建号（默认角色 member），按 email 自动绑定既有本地用户，二次登录幂等；casdoor 共享应用跨组织（acme / globex / dsh-ops）全员可登，组织无关校验。
- **dsh 集成**：设置 → 插件 里的设置卡片（实例地址编辑、健康徽标、打开链接，保存即生效）+ better-sidebar 侧边栏 tab；宿主半区暴露 `/plugins/dsh-nocobase/status` 健康路由。

## 部署（四步）

```bash
# 1. 拉起 NocoBase（首次会拉镜像并完成初始化；casdoor 需同时可用）
docker compose up -d nocobase

# 2. 双侧幂等配置：casdoor 建 nocobase 应用（isShared）+ NocoBase 建认证器
node plugins/dsh-nocobase/scripts/bootstrap.mjs

# 3. 安装到 dsh profile
pnpm dsh plugin --profile web add link:$(pwd)/plugins/dsh-nocobase
pnpm build && 重启 dsh web

# 4. 端到端冒烟（OIDC 登录全流程，无需浏览器）
node plugins/dsh-nocobase/scripts/smoke.mjs
```

改了认证插件源码后：`pnpm --filter dsh-nocobase-service build && docker compose restart nocobase`（dist 直挂，无需拷贝）。

## 配置

设置命名空间 `nocobase`（设置卡片编辑，env/patch 层可覆盖）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `baseUrl` | `NOCOBASE_ENDPOINT` ?? `http://127.0.0.1:13000` | NocoBase 实例地址（根 compose 的映射） |
| `timeoutMs` | `5000` | 健康探测超时（毫秒） |

bootstrap 环境变量（凭据与两侧地址）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NOCOBASE_URL` / `CASDOOR_URL` | `http://127.0.0.1:13000` / `http://127.0.0.1:8001` | 浏览器视角的两端地址 |
| `CASDOOR_SERVER_URL` | `http://casdoor:8000` | NocoBase 容器内到 casdoor 的服务端地址（compose 网络名） |
| `CASDOOR_ADMIN_CLIENT_ID/SECRET` | `dsh-gateway` / `change-me-64-hex` | casdoor 管理 API 的 Basic 凭据（种子应用） |
| `CASDOOR_NOCOBASE_CLIENT_SECRET` | `nocobase-dsh-secret-2026` | nocobase 应用的 client secret |
| `NOCOBASE_ADMIN_EMAIL/PASSWORD` | 与 compose `INIT_ROOT_*` 一致 | NocoBase root 账号（bootstrap 建认证器用） |

NocoBase 认证器（`authenticators` 表，可在管理界面 用户认证 里改）：`issuer`（浏览器侧 casdoor 地址）、`serverIssuer`（容器侧，缺省同 issuer）、`clientId`/`clientSecret`、`public.autoSignup`、`public.buttonText`。

## 逃生通道

casdoor 不可用时，本地 root 账号仍可密码登录：`nocobase-admin@local.dev` / `NocoBase-Admin1`（来自 compose `INIT_ROOT_*`，**生产环境必须改掉**；smoke 第 7 步会验证它可用）。改 `APP_KEY` 会使所有已发 token 失效。

## v1 边界（有意不做）

- 数据备份 / NocoBase 版本升级编排 / 监控告警 —— 走 NocoBase 官方工具（镜像 tag 固定，升级需手动改 compose 并按官方流程 `nocobase upgrade`）。
- casdoor 角色 → NocoBase 角色自动映射（当前：JIT 默认 member，管理员在 NocoBase 内手动提权）。
- 不经统一网关（独立端口直连）；NocoBase 子路径反代有已知静态资源坑，如需统一域名请用子域名。
- dsh 侧不注册 MCP 工具（v2 候选：把 NocoBase 数据模型暴露给 agent）。
- 多租户：全局一套实例，权限交给 NocoBase 自身角色/ACL 体系。

## 开发

```bash
pnpm build        # tsc + tsdown + 浏览器半区打包
pnpm test         # vitest（manifest/config/form 19 例）
pnpm typecheck
node scripts/bootstrap.mjs   # 幂等，可反复跑
node scripts/smoke.mjs       # 7 步端到端
```

认证插件源码与构建见 `services/nocobase/`（`pnpm --filter dsh-nocobase-service build`）。
