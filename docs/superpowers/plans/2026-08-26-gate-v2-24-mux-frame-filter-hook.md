> 对应 issue：[#24](https://github.com/1123786563/dsh-plugin/issues/24)（状态跟踪以 issue 为准，本文件是计划的仓库内源稿）

## What to build

宿主 WS 下行泵（`events.mux`/`events.host`）支持**每连接帧过滤**：连接建立时携带请求主体，三类判定点——订阅基线（连接即全量订阅的循环）、实时事件广播、新增会话补订阅——入队前都先过外部过滤器。未配置时行为与 upstream 一致。

宿主事实（探索确认）：mux 是纯下行流，客户端消息属协议违规；当前**连接即对全部会话建立订阅**、广播无收件人过滤——这是"登录用户实时收到所有租户会话事件全文"泄露面的根。帧过滤语义：会话类帧按该连接过滤器判定；events.host 的**会话引用类帧**（session-added/removed 等）同样按可见性过滤，非会话状态帧（宿主/workspace 级）放行。

## 实施计划

1. 钩子协议：连接建立时 `(principal) => frameFilter(sessionId, frameType) => bool`；未配置 = 不过滤。
2. 接线三个判定点：初始订阅循环、session/event 广播、session/created 补订阅。
3. events.host 帧分流：会话引用类走过滤器、纯状态帧放行。
4. 宿主单测：未配置不变；配置后三类判定点均生效（不可见会话的基线/实时/新增帧不入队）；过滤不破坏自己会话帧的完整性。
5. 并入 `dsh-request-guard` 分支与工具链。

## Acceptance criteria

- [ ] 未配置：宿主现有测试全绿
- [ ] 配置后：订阅基线/实时事件/新增会话帧均经判定，不可见会话帧不入该连接队列
- [ ] events.host 会话引用帧按可见性过滤、状态帧放行
- [ ] patch 并入工具链管理

## Blocked by

- #20 — 钩子②（同一宿主分支串行 + 请求主体贯通管线复用）

## 文档

- [ADR-0004 钩子③设计](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0004-host-guard-hooks-patch.md)
- [ADR-0005 事件流泄露面](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0005-tenant-scoped-session-visibility.md)
