> 对应 issue：[#13](https://github.com/1123786563/dsh-plugin/issues/13)（状态跟踪以 issue 为准，本文件是计划的仓库内源稿）

## What to build

deepseek-harness 宿主获得一个**通用的请求守卫扩展点**：每个 HTTP 请求与每个 WebSocket 升级在分发前先调用可选的守卫回调；守卫可以否决请求（401，响应体可定制），也可以把一个身份对象附加到请求上下文供下游 `/api` 处理链读取。**未配置守卫时，宿主行为与 upstream 完全一致**（这是可提给 upstream 的中性扩展点，不含任何 casdoor/租户产品词汇）。

宿主关键事实：WebServer 是裸 `node:http`，无全局中间件；webserver Config schema 只有 host/port。本票就是补上这一缺失的扩展点。改动在本地分支 `dsh-request-guard` 上以单 commit 维护（分支基于 upstream master，当前 upstream 为 dsh-v0.1.1-rc.2、零本地 patch）。

## 实施计划

1. 在 webserver 服务定义守卫注册协议：异步回调 `(request, kind) => principal | veto(status, body)`，kind 区分 http/upgrade；提供注册入口（服务方法或配置注入，二选一以宿主既有风格为准）。
2. 接线两个调用点：HTTP request 分发入口、upgrade 分发入口；否决时 HTTP 返回 401 + 守卫给定文案，upgrade 直接拒绝握手。
3. 守卫放行时，把返回的 principal 存入请求上下文，保证 `/api` 处理链（ApiProxy 桥）能取到——为 #20 的语义层钩子铺路。
4. 宿主单测三态：未配置（行为不变）、配置放行（principal 可达 /api 链）、配置否决（HTTP 与 upgrade 各一）。
5. 在 `dsh-request-guard` 分支单 commit 提交，保持与 upstream diff 最小。

## Acceptance criteria

- [ ] 未配置守卫：宿主现有测试全绿，HTTP/WS 行为与 upstream 一致
- [ ] 配置守卫后：普通请求与 WS 升级均可被否决（401，自定义响应体生效）
- [ ] 守卫返回的身份对象在 /api 处理链中可读取
- [ ] 改动为通用形态（无产品词汇），单 commit 位于 dsh-request-guard 分支

## Blocked by

None — can start immediately.

## 文档

- [ADR-0004 宿主守卫与过滤钩子三件套](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0004-host-guard-hooks-patch.md)
- [CONTEXT.md 术语：请求守卫/请求主体](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/CONTEXT.md)
