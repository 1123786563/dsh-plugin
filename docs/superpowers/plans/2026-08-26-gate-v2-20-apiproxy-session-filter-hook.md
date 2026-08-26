> 对应 issue：[#20](https://github.com/1123786563/dsh-plugin/issues/20)（状态跟踪以 issue 为准，本文件是计划的仓库内源稿）

## What to build

宿主语义层的通用钩子：`session.list`/`session.search` 等**列表方法的响应**交给外部过滤器改写；**带 sessionId 的方法**（history/prompt/fork/export/cancel 等，含 GET 直达的 export 旁路）在分发前交外部准入判定；**会话创建/fork 成功后**回调外部观察者。未配置时行为与 upstream 一致。判定点可读取 #13 守卫附加的请求主体。钩子协议产品无关（listFilter / accessCheck / onSessionCreated 三个可选回调）。

宿主事实：列表与准入判定都在 ApiProxy 域方法内（`session.list` 契约明言 v1 全量返回）；`/api` 拦截器槽位已被 dsh-base 激活的 typert-gateway 占用，所以本钩子走 ApiProxy 内部接缝而非拦截器。

## 实施计划

1. 定义钩子协议：`listFilter(principal, items) => items`、`accessCheck(principal, sessionId) => allow|deny`、`onSessionCreated(principal, sessionId)`——全部可选，缺省即现状。
2. 接线三个点：列表方法响应出口过滤；带 sessionId 的 UNARY 方法分发前准入（deny → 403）；创建/fork 成功后回调。**GET 直达的 export 路径单独接线**（它不经 POST 分发）。
3. 请求主体从守卫附加的上下文取（无主体时的行为：钩子在则 fail-closed 拒绝——与 zero-trust 一致）。
4. 宿主单测：未配置不变；配置后列表被改写、准入被拒 403、回调收到 (principal, sessionId)、export 旁路受控。
5. 并入 `dsh-request-guard` 分支与 #17 工具链（patch 重导出）。

## Acceptance criteria

- [ ] 未配置钩子：宿主现有测试全绿
- [ ] 列表响应经外部过滤器改写；带 sessionId 方法可被外部判定拒绝（403）；session.export GET 旁路同样受控
- [ ] onSessionCreated 回调携带请求主体与 sessionId
- [ ] 钩子为通用形态，patch 并入工具链管理

## Blocked by

- #17 — patch 工具链（宿主分支第二处改动需走既有工具链）

## 文档

- [ADR-0004 钩子②设计](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0004-host-guard-hooks-patch.md)
- [ADR-0005 三个泄露面与判定语义](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0005-tenant-scoped-session-visibility.md)
