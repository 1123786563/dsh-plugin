# dsh-plugin

DeepSeek Harness（DSH）插件集合 monorepo。每个子目录 `plugins/<name>` 是一个独立的可发布插件包（声明 `dsh.bundle`，部分还带 `dsh.client` 浏览器半区）。

## 插件

| 目录 | 说明 |
| --- | --- |
| `plugins/dsh-plane` | Plane（makeplane）项目跟踪：`plane_*` 工具族、设置卡片（设置 → 插件）、better-sidebar 面板 |

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
