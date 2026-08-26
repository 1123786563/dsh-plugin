# 0003 — 网关技术栈：fastify + openid-client（与请求体缓冲的代价）

网关用 fastify（路由/cookie/hooks/logging）+ openid-client（OIDC 授权码 + PKCE + userinfo 回退）+ jose（DshIdentityToken 铸造与两侧验签）；HTTP 与 WebSocket 的**转发核心手写**在 `node:http` 上（流式 pipe / 升级 pipe），不用 `@fastify/http-proxy`。

## Considered Options

- **裸 node:http 全手写（含 OIDC/JWKS）**——被否：JWT 验签手写易踩算法混淆类漏洞；路由/cookie 样板重复。
- **fastify + @fastify/http-proxy 全家桶**——被否：WS 升级的鉴权接缝与请求体处理策略受制于库内部实现，且同样绕不开下述缓冲问题。
- **fastify + 手写转发核心（采纳）**：auth 平面（login/callback/logout/jwks/health）享受 fastify 工效；转发路径零库依赖、完全可控。

## 关键实现事实（fastify 请求体设计限制）

fastify 的 content-type parser **永远先把请求体完整缓冲成 Buffer** 再交给自定义 parser（源码 `content-type-parser.js` 的 run() 自带 data/end 消费）。因此：

1. 代理转发以 `upstream.end(bodyBuffer)` 完成，而非流式 pipe——**网关每个并发请求最多驻留一个请求体副本**；
2. `bodyLimit` 必须覆盖 dsh `/api` 的 300 MiB 附件信封（网关设 320 MiB）；
3. 需显式以 `{parseAs:'buffer'}` 覆盖 `application/json`/`text/plain`——精确注册优先于 `'*'` 通配，默认 JSON parser 会把 body 解析成对象，无法按原字节转发（content-length 失配会让上游挂起）。

内存代价在 v1 接受（单机、并发有限）；若未来需要流式，须把转发核心挪出 fastify 请求生命周期（raw server 层）或演进为独立代理层。
