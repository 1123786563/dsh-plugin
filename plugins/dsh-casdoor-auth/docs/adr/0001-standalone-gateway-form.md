# 0001 — 独立网关形态（而非进程内拦截）

Casdoor 登录门禁做成**独立 Node 服务**（dsh-casdoor-gateway）挡在 dsh webserver 之前，dsh 退守 loopback 私口；而不是一个进程内插件去 hook dsh 的请求生命周期。

## Considered Options

- **纯进程内插件**（`connection.rpc.intercept` 挡 `/api` + exact 路由抢 `/`）——被否：宿主 `node:http` 服务无全局中间件，WebSocket 升级路由（`/api/events.mux`、`/api/events.host`）无任何插件接缝，未认证者伪造同源头即可连上事件流；其他插件的命名路由（`/api/openmeter/*`、`/_dsh-multi-tenant` 等）绕过 `/api` 拦截器（最长前缀优先）；SPA 兜底席位已被 frontend-static 独占。
- **插件内前置代理**（webserver 挪私口，插件在同进程起公口代理）——被否：技术上可行且覆盖等价，但代理与 dsh 同进程崩溃域，且端口拓扑寄生在插件里；留作单进程部署的演进选项。
- **独立网关服务（采纳）**：覆盖等价（HTML/静态/`/api`/WS/一切插件路由——公口 socket 在网关手里），隔离彻底，与 dsh-multi-tenant DIRECTION.md 的生产契约（"产品网关在前，DSH Web 当私有后端"）一致。

## Consequences

- 部署物从 1 变 3（casdoor + 网关 + dsh），开发循环需要 casdoor 容器 + 网关进程 + dsh 进程。
- 引入网关→dsh 的跨进程身份传递设计面（见 ADR-0002）。
- dsh 的 DNS-rebinding fence 与特权方法 loopback 钉死保持最严状态（转发时改写 Host/Origin 为私口 authority）。
- 代价由 dev 脚本与 compose 文件吸收，`dsh web` 工作流不变（仅 webserver 端口经 bundle patch 挪到 38080）。
