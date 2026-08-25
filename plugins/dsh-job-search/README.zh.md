# dsh-job-search

[English](README.md) | 中文

面向 DeepSeek Harness 的租户隔离求职能力：候选人档案、可插拔门户抓取、匹配度排序、投递追踪、面试准备，以及会话头部的求职看板。

## 提供什么

- **工具**（面向模型）：`job_search_setup` → `job_search_scrape` → `job_search_rank` → `job_search_apply` → `job_search_interview_prep` → `job_search_outcome`。生成类工具返回装配好的 brief（档案 + 职位 + 匹配分 + 写作指引），由会话中的模型据此撰写简历与求职信。
- **看板**（浏览器）：会话头部的“求职看板”入口，读取只读路由 `/plugins/dsh-job-search/pipeline.json`——档案行、投递漏斗、最近职位与投递。租户管道有内容时才出现。
- **存储**：`job_search` 存储域（`profiles` / `jobs` / `applications`），以不透明的 `TenantId` 键控；所有查询按租户过滤，一个租户的数据不会到达另一个。要求 profile 已提供存储栈（`dsh-storage` + 后端 + `dsh-storage-domain`）——官方 web profile 已具备。

## 安装到 profile

```sh
pnpm dsh plugin --profile web add link:/Users/wuyongjun/trea/dsh-plugin/plugins/dsh-job-search
```

包声明了 `dsh.bundle.patch`，`dsh plugin` 会自动把它追加进 `dsh.profile.bundles`；之后重启 `dsh web`。

## 配置（profile 的 `cordis.patch.yml`）

```yaml
- id: job-search
  config:
    defaultTenantId: default
    portals:
      - id: freehire
        label: FreeHire
        searchUrl: 'https://freehire.me/api/jobs?search={query}&location={location}'
        enabled: true
```

`portals` 是 JSON 门户适配器列表（`{query}` / `{location}` 占位符）。需要授权访问的招聘平台（BOSS直聘、拉勾）不随包提供：用运营方自己的凭证为每块板实现一个 `PortalAdapter`——`src/portals.ts` 的接口就是全部契约。

## 开发

```sh
pnpm install
pnpm test && pnpm typecheck && pnpm build
```

## 已知限制

- 匹配度打分是关键词重叠启发式（`src/tools.ts`）；模型会在会话内细化。
- 不做简历/求职信 PDF 编译（未移植源工作流的 LaTeX/ATS 管线）。
- 看板是拉取式（激活、重连、手动刷新）。
