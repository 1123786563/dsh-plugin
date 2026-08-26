# dsh-open-design

将 [nexu-io/open-design](https://github.com/nexu-io/open-design)（Apache-2.0）
的设计引擎技能目录移植为 DeepSeek Harness 插件。安装后，profile 内所有会话
的技能目录都会合并进 `open-design` 提供者：

- **75 个可移植功能技能** —— 取自上游 `skills/`，剔除 85 个指向上游仓库的
  目录存根，及依赖 OpenDesign daemon CLI 的 `agent-browser`、
  `ecommerce-image-workflow`。
- **`od-deck-framework`** —— 固定幻灯片框架（1920×1080 画布、缩放适配、键盘
  导航、打印出 PDF），提取自上游 `apps/daemon/src/prompts/deck-framework.ts`，
  骨架在 `skills/od-deck-framework/references/skeleton.html`。
- **`od-design-systems`** —— 152 个品牌级设计系统（Apple、Stripe、Vercel、
  Nike、微信、小红书…），每个含 DESIGN.md（+中文变体）、USAGE.md、编译后
  tokens、组件库；裁掉了 `source/`、`system/` 与非中文本地化变体
  （38MB → 15MB）。

## 工作方式

宿主半区把官方 `@deepseek-ai/dsh-skill-filesystem` 以隔离模式
（`includeDefaultRoots: false`）应用到包内 `skills/` 目录，注册为
`ctx.skills` 的 `open-design` 提供者 —— 解析、监听、失效全部复用官方机制。
无浏览器半区。

| 配置 | 默认 | 说明 |
|---|---|---|
| `customSkillDirs` | `[]` | 追加在包内目录之后的本地技能根 |
| `watch` | `true` | 监听目录变化热刷新目录（catalog） |

## 安装

```sh
pnpm dsh plugin --profile web add link:/Users/wuyongjun/trea/dsh-plugin/plugins/dsh-open-design
```

修改 bundle 列表后重启 `dsh web`。或在运行中的会话用 dsh-super-injector：
`dev_inject_plugin(dir)` 注入、`dev_reload_package` 热重载。

## 配套 preset

「设计师人格」（澄清简报 → 锁定方向 → 一次性验证的官方 designer prompt 改写）
不在本插件内，由 `~/.dsh/.agent-presets/open-design` preset 提供 —— 两者组合
等价于完整的 OpenDesign 体验；只装插件则任何会话都能用这些技能。

## 未移植（依赖 OpenDesign 桌面应用 / daemon）

沙箱 iframe 预览、Inspect/Picker、导出 PDF/PPTX/ZIP、HyperFrames 视频管线、
`od` CLI media/browser providers。`<question-form>` 宿主解析由 DSH 的
`ask_user_question` 工具等价替代。

## 刷新上游

```sh
git clone --depth 1 https://github.com/nexu-io/open-design.git /tmp/open-design
# 按上文筛选规则替换 skills/；骨架从 deck-framework.ts 重新提取
```

上游 `skills/AGENTS.md` 与 `plugins/spec/AGENT-DEVELOPMENT.md` 定义技能格式；
DSH 侧按同样的 SKILL.md 约定加载，`od:`/`triggers` 等额外 frontmatter 键被
忽略、无需修改。
