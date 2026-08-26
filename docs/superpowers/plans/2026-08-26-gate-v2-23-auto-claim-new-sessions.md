> 对应 issue：[#23](https://github.com/1123786563/dsh-plugin/issues/23)（状态跟踪以 issue 为准，本文件是计划的仓库内源稿）

## What to build

隔离开启后，用户在 stock Web UI 里**新建或复制（fork）的会话自动认领给当前请求主体**——自己的新会话创建后立即可见可用，不产生"自己都看不到"的孤儿会话（claim-once 幂等，并发安全）。

## 实施计划

1. 接线 #20 的 onSessionCreated 回调 → 插件以当前请求主体 `claimSession`（claim-once 语义天然幂等；冲突意味着 sessionId 已有归属，按 fail-closed 处理并告警日志）。
2. 验证 fork 路径产生的新 sessionId 同样触发回调（fork 的派生会话必须覆盖，否则用户 fork 自己的会话后打不开）。
3. 单测：新建/fork 归属正确、并发创建不冲突、与既有 `/_dsh-multi-tenant/agents/create` 入口行为一致（不回归）。
4. 手动验收：A 新建会话 → 列表立即可见 → 对话正常；fork 同理。

## Acceptance criteria

- [ ] stock UI 新建会话后创建者立即可见可用
- [ ] fork 派生会话同样自动归属
- [ ] 经 /_dsh-multi-tenant 入口创建会话的行为不回退
- [ ] 并发创建无冲突错误

## Blocked by

- #20 — 会话创建回调钩子
- #22 — 会话过滤器（归属可见性管线就位）

## 文档

- [ADR-0005 自动归属决策](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0005-tenant-scoped-session-visibility.md)
