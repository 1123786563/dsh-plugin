# 0004 — 宿主本地 patch：通用守卫与过滤钩子（三件套）

**状态：已接受（2026-08-26 设计共识，两阶段实施中）**

为达成"本机任意非网关进程不能绕过门禁"（威胁模型 Q1=b）与 fail-closed（Q4=a），在 deepseek-harness 宿主上维护一组**本地 patch**，全部以通用钩子形态存在（宿主只定义回调协议，不包含任何 casdoor/租户产品知识），实现由 dsh-casdoor-auth 提供：

1. **请求守卫钩子**（webserver 层，~60 行）：每 HTTP 请求与 WS 升级前调用，守卫可否决（401/403）并把验出的身份附加到请求上下文。未配置钩子 = 宿主行为完全不变。
2. **会话访问过滤钩子**（ApiProxy 语义层，~100 行）：`session.list/search/history/prompt/export` 等方法调用插件提供的过滤器——列表按归属过滤响应，带 sessionId 的方法做准入判定，未知会话 fail-closed。
3. **mux 帧过滤钩子**（events.mux/events.host，~80 行）：每 WS 连接按其请求主体过滤订阅基线、实时事件与新增会话帧。

配套语义：zero-trust 无白名单（Q6=a，含静态资源；网关侧 `*.webmanifest` 匿名转发随之取消，一切请求带 token）；dsh 侧验签优先用**钉住的公钥**（env 注入），回退网关 JWKS——网关短暂不可达不阻碍验签，但 60 秒 token TTL 保证 fail-closed。

## Considered Options

- **纯插件拦截**（`connection.rpc.intercept('/api')`）——被否：拦截器槽位每通道唯一，已被 dsh-base bundle 激活的 typert-gateway（@deepseek-ai/dsh-api-gateway）占用；WS 升级无插件接缝；插件裸路由不经 `/api`。
- **网关轻 BFF**（网关解析 session.list 响应改写、逐方法查归属）——被否：WS 帧过滤仍只能宿主做（网关做帧过滤需解析 WS 协议、维护 sessionId→owner 映射，破坏其流式管道设计）；授权逻辑与认证守卫分散两处。
- **拦截器机制链式化改造**——被否：patch 复杂度不低，且 WS 仍需另行 patch，两处分散。
- **OS 防火墙（pf 按 user 匹配挡私口）**——被否：依赖网关以专用用户运行，规则脆弱、系统升级易失效，且无应用层身份语义。
- **宿主三件套通用钩子（采纳）**：唯一能全覆盖（一切路由 + `/api` + WS 升级 + 插件裸路由）的代码层方案；钩子中性可提 upstream；产品逻辑全部留在插件。

## Consequences

- deepseek-harness 从零 patch 变为携带本地分支 `dsh-request-guard`（单 commit）；`.patch` 副本 + 应用脚本存 dsh-plugin 仓 `scripts/host-patches/`，宿主升级 = `git fetch && rebase`，可随时回到干净 upstream（Q8=a）。
- patch 总量约 200–300 行（远大于仅守卫的 30–50 行，因 Q7=b 把授权也纳入）；每次宿主升级需人工重放，冲突风险集中在 webserver/ApiProxy 的分发点。
- 宿主 `node:http` 无全局中间件的事实不变——本 patch 正是补上这一缺失的扩展点。
