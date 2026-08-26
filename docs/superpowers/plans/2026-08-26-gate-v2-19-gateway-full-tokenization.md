> 对应 issue：[#19](https://github.com/1123786563/dsh-plugin/issues/19)（状态跟踪以 issue 为准，本文件是计划的仓库内源稿）

## What to build

网关对**一切转发请求**注入 `x-dsh-identity`，包括目前唯一豁免的 credentialless 资产（`*.webmanifest`，现为匿名转发、token 为空串）——私口 zero-trust（#18）之下不留任何匿名透传路径。上线顺序必须**先守卫后本票**，否则 manifest 请求会被私口 401 打破 UI。

## 实施计划

1. 网关 gate 的 credentialless 白名单移除（或收窄为空配置），资产请求同样走登录会话校验 + 逐请求 token 铸造。
2. 网关单测更新：manifest 请求经会话转发且带有效 identity 头。
3. e2e 回归：经网关 manifest 200、直连 401；全链路 UI 无资源加载失败。

## Acceptance criteria

- [ ] 经网关的 webmanifest 请求 200 且携带有效 x-dsh-identity
- [ ] 网关不再存在匿名转发路径（代码与测试双重确认）
- [ ] e2e 全绿，UI 资源加载无回退

## Blocked by

- #18 — zero-trust 私口落地（守卫必须先就位）

## 文档

- [ADR-0004（zero-trust：静态资源不豁免）](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0004-host-guard-hooks-patch.md)
