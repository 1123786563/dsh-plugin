# dsh-plane（中文说明）

把 [Plane](https://github.com/makeplane/plane) 接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）：agent 获得一族 `plane_*` 工具，通过 Plane REST API 操作项目、工作项（issue）、评论、周期、状态与标签，另有一个可触达其余全部端点的原始请求逃生口。Web UI 侧新增**设置卡片**（设置 → 插件）与 **Plane 侧边栏面板**（需 better-sidebar）。

同时支持 Plane Cloud（`api.plane.so`）与自建实例。客户端按激活探测一次 `work-items` 与旧版 `issues` 资源段，新版与旧版社区版都能用。

## 工具一览

| 工具 | 作用 |
| --- | --- |
| `plane_list_projects` | 分页列出工作区项目 |
| `plane_list_issues` | 分页列出项目内工作项，支持排序 |
| `plane_search_issues` | 按名称、描述或编号搜索工作项（全工作区或单项目） |
| `plane_get_issue` | 读取单个工作项完整详情 |
| `plane_create_issue` | 创建工作项（标题、HTML 描述、优先级、状态、经办人、标签、父项、日期） |
| `plane_update_issue` | 局部更新工作项（流转状态、改优先级、改经办人） |
| `plane_delete_issue` | 删除工作项 |
| `plane_list_issue_comments` | 列出工作项下的讨论 |
| `plane_create_issue_comment` | 在工作项下发表评论 |
| `plane_list_metadata` | 列出项目的状态、标签或周期 |
| `plane_request` | 对任意 `/api/v1` 路径发 `GET/POST/PATCH/DELETE`（模块、需求池、里程碑、成员、团队空间……） |

列表类工具返回裁剪后的投影（id、名称、状态、经办人、标签、日期），控制模型上下文体积；详情类工具返回完整解码行。分页信封统一为 `{ results, totalCount, nextCursor, hasNextPage }`。

## 设置卡片（Web UI）

插件在宿主侧注册 `plane` 设置命名空间，在浏览器侧为它在官方插件配置标签页注册**恰好一张**卡片，配置入口就是**设置 → 插件**：

- `baseUrl` — Plane Cloud 或自建实例地址
- `apiKey` — 个人访问令牌；按 secret 存储（读回脱敏，留空草稿表示"不修改"）
- `workspaceSlug` — 调用未显式传 workspace 时的默认值
- `defaultProjectId` — 可选默认项目
- `perPage` — 列表页大小，1-100

保存走持久的、带版本围栏的设置文档；提交后**即时重配工具，无需重启**。组合入口（`cordis.patch.yml`）在没有设置服务挂载时作为回退层。

## 侧边栏面板（better-sidebar）

装有 better-sidebar 时，侧边栏多出一个 Plane 标签页：配置工作区的项目下拉、所选项目的工作项列表（状态 / 优先级 / 经办人）、"加载更多"分页、30 秒自动刷新。数据来自宿主的只读路由 `/plugins/dsh-plane/panel`——**API Key 永不进入浏览器**。未配置 Key 或工作区时显示引导横幅。

## 安装到 dsh profile

```sh
pnpm dsh plugin --profile web add link:/path/to/dsh-plane
```

包声明了 `dsh.bundle.patch` 与 `dsh.client`（web），`dsh plugin` 会自动把 `dsh-plane` 追加进 `dsh.profile.bundles`，Web UI 在 `/plugins` 下直接服务浏览器半区——无需重新构建 web 应用。发布后也可以：

```sh
pnpm dsh plugin --profile web add dsh-plane            # npm
pnpm dsh plugin --profile web add github:you/dsh-plane # github
```

修改 bundle 列表后需重启 `dsh web`（或 headless 运行），插件树在启动时组装。

## 配置

三层，后者覆盖前者：bundle 补丁的环境变量默认值 → profile 的 `cordis.patch.yml` → 卡片写入的设置文档。

```yaml
# profile cordis.patch.yml
- id: plane
  config:
    baseUrl: https://plane.example.com   # 默认 https://api.plane.so（Plane Cloud）
    apiKey: plane_api_xxx                # X-API-Key；个人设置 > 个人访问令牌
    workspaceSlug: my-team               # 调用未显式传 workspace 时的默认值
    defaultProjectId: ''                 # 可选默认项目
    perPage: 50                          # 列表页大小，上限 100
```

dsh 进程能看到变量时，`!!js process.env.PLANE_API_KEY` 形式也可用。`apiKey` 为空时一切照常注册，调用会带着配置指引失败，不会拖垮启动树。优先用设置卡片——免重启、即时生效。

## 开发

```sh
pnpm install
pnpm test        # vitest，fetch 打桩（client、tools、卡片表单、面板路由）
pnpm typecheck
pnpm build       # tsc 声明到 lib/types，tsdown 宿主包，esbuild 客户端工厂到 lib/client.js
```

结构：`src/client.ts` REST 客户端（鉴权、错误映射、资源段协商、分页、活配置访问器），`src/view.ts` 投影裁剪，`src/tools.ts` 工具定义，`src/routes.ts` 只读面板/状态路由，`src/config.ts` schemastery 配置（apiKey 为 `role('secret')`），`src/index.ts` 宿主入口（工具 + 设置命名空间 + 路由），`src/client/*` 浏览器半区（卡片表单、设置卡片、面板、多语言）。

浏览器产物是客户端模块系统的 lazy-CJS 工厂形态：一个只注册 `window.__ModuleLoader__.load({ id, factory })` 的经典脚本，React 外置，服务经 cordis 注入（`scripts/build-client.mjs`）。

## 许可

MIT
