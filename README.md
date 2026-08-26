# dsh-plugin

DeepSeek Harness（DSH）插件集合 monorepo。每个子目录 `plugins/<name>` 是一个独立的可发布插件包（声明 `dsh.bundle`，部分还带 `dsh.client` 浏览器半区）。

## 插件

| 目录 | 说明 |
| --- | --- |
| `plugins/dsh-plane` | Plane（makeplane）项目跟踪：`plane_*` 工具族、设置卡片（设置 → 插件）、better-sidebar 面板 |
| `plugins/dsh-job-search` | 租户隔离求职：`job_search_*` 工具族（建档/抓取/排序/投递/面试/结果）+ 会话头部"求职看板" |
| `plugins/dsh-open-design` | OpenDesign 设计引擎技能目录：以 `open-design` 提供者向宿主技能注册表注册 77 个设计技能 + 152 个品牌级设计系统 + 固定幻灯片框架（来自 nexu-io/open-design，Apache-2.0） |
| `plugins/dsh-openmeter` | OpenMeter 计费：LLM 调用逐条计量（WAL 至少一次投递）→ 自托管 fork；预付余额耗尽硬阻断（故障放行）；llm-cost 价格库 CNY 报价 + 即时估算；侧边栏用量面板 + 收银台（客户/充值/阻断/预设绑定） |

## 安装某个插件到 dsh profile

```sh
# 在 dsh 检出目录（或任何能解析到 dsh CLI 的地方）
pnpm dsh plugin --profile web add link:/Users/wuyongjun/trea/dsh-plugin/plugins/dsh-plane
```

包声明了 `dsh.bundle.patch`，`dsh plugin` 会自动把包名追加进 `dsh.profile.bundles`。修改 bundle 列表后重启 `dsh web`。

## 开发

```sh
pnpm install
pnpm test         # 所有插件
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
