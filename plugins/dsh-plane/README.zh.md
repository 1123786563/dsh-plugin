# dsh-plane（中文说明）

把 [Plane](https://github.com/makeplane/plane) 做成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件——**Plane 兼容引擎直接跑在宿主进程内**：无容器、无 Python、无数据库服务。引擎为 TypeScript 实现的 Plane 兼容域模型（工作区、项目、工作项、状态、标签、周期、模块、评论），数据落在 `$DSH_HOME/plane` 下的 JSON 存储；对外提供 `/api/v1` 兼容 HTTP 面（plane-sdk、plane-mcp-server、curl 可直接指向）、agent 的 `plane_*` 工具族、设置卡片（设置 → 插件）、侧边栏面板，以及整页看板 `/plugins/dsh-plane/app`。

这是对 Plane 公开 API 契约的净室兼容实现——未 vendor、未复制任何 Plane 源码（Plane 为 AGPL-3.0，本插件保持 MIT）。需要完整 Plane 功能（页面、视图、需求池、SSO、实时协作）时，把 `backend` 切到 `remote`，同一套工具直连 Plane Cloud 或自托管实例。

## 组成

```
plane_* 工具 ───────┐
看板页（ui）────────┼── PlaneV1Router ── PlaneEngine ── store.json（$DSH_HOME/plane）
外部 SDK/MCP ───────┘   （进程内路由）     （域操作）      （原子写 + .bak 备份）
                       ▲
                       └─ /plugins/dsh-plane/api/v1/*  — X-API-Key 鉴权
                       └─ /plugins/dsh-plane/ui/v1/*   — 同源免 key
```

- **`local` 后端（默认）**：引擎在首次使用时惰性启动，播种 `dsh` 工作区、`DSH` 项目与 Plane 默认五状态（Backlog / Todo / In Progress / Done / Cancelled）。工作项按项目自增编号（`DSH-1`、`DSH-2`…）；进入 completed 组状态自动盖 `completed_at`。每次变更经串行原子保存链落盘（tmp + rename，旧文件保留为 `.bak`，损坏自动回退）。
- **`remote` 后端**：与引擎化之前完全一致——面向 Plane Cloud（`api.plane.so`）或自建实例的 REST 客户端，按激活探测一次 `work-items` 与旧版 `issues` 资源段。设置卡片保存即切换后端，无需重启。

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `plane_list_projects` | 分页列出工作区项目 |
| `plane_create_project` | 创建项目（自动播种默认状态） |
| `plane_update_project` | 局部更新项目（名称、标识、描述、可见性） |
| `plane_list_issues` | 分页列出项目内工作项，支持排序 |
| `plane_search_issues` | 按名称、描述或编号搜索工作项（全工作区或单项目） |
| `plane_get_issue` | 读取单个工作项完整详情 |
| `plane_create_issue` | 创建工作项（标题、HTML 描述、优先级、状态、经办人、标签、父项、日期） |
| `plane_update_issue` | 局部更新工作项（流转状态、改优先级、改经办人） |
| `plane_delete_issue` | 删除工作项 |
| `plane_list_issue_comments` | 列出工作项下的讨论 |
| `plane_create_issue_comment` | 在工作项下发表评论 |
| `plane_list_metadata` | 列出项目的状态、标签或周期 |
| `plane_request` | 对任意 `/api/v1` 路径发 `GET/POST/PATCH/DELETE`（模块、周期挂摘、成员……） |

列表类工具返回裁剪后的投影，控制模型上下文体积。本地引擎输出 Plane 真实信封键（`total_count`、`next_cursor`、`prev_cursor`、`next_page_results`…）与 `value:offset:is_prev` 游标，与公开 API 对齐。

## HTTP 面（local 后端）

| 路径 | 鉴权 | 用途 |
| --- | --- | --- |
| `/plugins/dsh-plane/api/v1/...` | `X-API-Key: <引擎 key>` | v1 兼容面——plane-sdk、plane-mcp-server、curl 指向这里 |
| `/plugins/dsh-plane/ui/v1/...` | 同源免 key | 同一路由器的浏览器半区入口——key 不进页面 |
| `/plugins/dsh-plane/app` | 同源免 key | 整页看板（看板/列表视图、详情抽屉、评论） |
| `/plugins/dsh-plane/panel` `/state` | 同源免 key | 面板数据与连接/引擎状态 |

引擎 key 首次启动生成，设置卡片（local 后端）可见。v1 面覆盖工作项、项目、状态、标签、周期（含挂摘）、模块（含挂摘）、成员与 `users/me`；`work-items/` 与旧版 `issues/` 双路径段可用，其余路径 404 带清晰错误。

## 设置卡片（Web UI）

配置入口是**设置 → 插件**，`plane` 命名空间：

- `backend` — `local`（进程内引擎）或 `remote`（REST 客户端）；保存即切换
- local：`dataDir`（存储目录，默认 `$DSH_HOME/plane`，改动重启后生效）+ 引擎状态块（项目/工作项/评论计数与引擎 API Key）
- remote：`baseUrl`、`apiKey`（secret 存储，读回脱敏，留空草稿表示"不修改"）
- 两者通用：`workspaceSlug`（local 回退播种的 `dsh`）、`defaultProjectId`、`perPage`

## 侧边栏面板（better-sidebar）

装有 better-sidebar 时，侧边栏 Plane 标签页展示项目下拉与工作项列表，local 模式下支持内联新建、状态/优先级快改，并提供整页看板入口。数据全部来自宿主侧路由——**remote 的 API Key 永不进入浏览器**。

## 安装到 dsh profile

```sh
pnpm dsh plugin --profile web add link:/path/to/dsh-plane
```

包声明了 `dsh.bundle.patch` 与 `dsh.client`（web）。修改 bundle 列表后重启 `dsh web`。除此之外无需部署任何东西——local 后端零容器、零服务。

## 配置

三层，后者覆盖前者：bundle 补丁的环境变量默认值（`PLANE_BACKEND`、`PLANE_BASE_URL`、`PLANE_API_KEY`、`PLANE_WORKSPACE_SLUG`、`PLANE_DEFAULT_PROJECT_ID`、`DSH_PLANE_DATA_DIR`）→ profile 的 `cordis.patch.yml` → 卡片写入的设置文档。

## 开发

```sh
pnpm install
pnpm test        # vitest：引擎域、v1 路由契约、双后端工具、路由、卡片表单
pnpm typecheck
pnpm build       # tsc 声明、tsdown 宿主包、esbuild 客户端工厂 + 整页看板 bundle
```

结构：`src/engine/` 域引擎（模型、JSON 存储、分页、序列化、key），`src/api/router.ts` v1 兼容路由器（工具、HTTP 挂载、测试三方共用），`src/backend.ts` local/remote 后端接缝，`src/client.ts` 远端 REST 客户端，`src/tools.ts` 工具定义，`src/routes.ts` webServer 挂载，`src/client/*` 设置卡片半区，`src/app/` 整页看板。

## v1 边界（有意不做）

页面（Pages）、视图、需求池、工作项关联、附件/webhook、多用户经办人（引擎单主体——即 key 持有者）、实时协作、remote→local 数据迁移。local 后端下按 casdoor 身份映射经办人是 v2 候选。

## 许可

MIT
