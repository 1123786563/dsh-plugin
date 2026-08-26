> 对应 issue：[#15](https://github.com/1123786563/dsh-plugin/issues/15)（状态跟踪以 issue 为准，本文件是计划的仓库内源稿）

## What to build

`casdoor-gateway` 可作为根 docker-compose 的一个服务运行：`docker compose up -d` 后网关在宿主 3080 端口可用，登录→casdoor→转发→dsh 私口全链路正常；网关数据（登录会话 sessions.sqlite + Ed25519 身份私钥）落在持久卷——容器重建不掉登录会话、不换身份私钥。dsh 本体仍留在宿主（它要操作本地文件，不容器化），容器内网关经 `host.docker.internal` 连宿主私口。

issuer 内外分离是本票核心难点：浏览器可见的 OIDC 重定向必须保持 `http://127.0.0.1:8001`（casdoor 实际签发的 iss），而容器内网关对 casdoor 的 discovery/token 请求要走 compose 网络服务名或 `host.docker.internal:8001`；两者分离配置，**iss 校验值仍用外部地址**（注意既有坑：URL.href 尾斜杠 vs casdoor iss 必须精确一致）。

## 实施计划

1. 网关 config 增加"内部发现基址"选项：默认与 issuer 相同（现状不变）；容器形态下配内部地址，openid-client 的 discovery/token 走内部地址，所有 iss/aud 断言仍用外部 issuer 值。
2. 编写 Dockerfile：与网关运行时一致（node 22 slim + pnpm prod install + tsx 入口），注意容器内非 root 用户与数据目录权限。
3. 根 `docker-compose.yml` 增服务：3080 端口映射、与 casdoor 同网络、dataDir 挂持久卷、`restart: unless-stopped`、env 透传（含内部发现基址、upstream 指向 host.docker.internal:38080）。
4. 验证矩阵：up -d 后 `/login` 302 到 casdoor（宿主 8001）；真实账号登录；UI 与 WS 经代理可用；重启网关容器后登录会话仍在、身份私钥未变（用 JWKS kid 对比）。
5. README 部署章节更新：compose 为正式形态，`pnpm dev` 降级为开发模式说明。

服务端出网约束说明：网关对外仅请求 casdoor（管理员配置的固定 OIDC 端点，非用户输入 URL），不引入任何用户可控 URL 的服务端请求。

## Acceptance criteria

- [ ] `docker compose up -d` 后 3080 全链路（登录/UI/WS）可用
- [ ] 重启网关容器：登录会话不掉线、Ed25519 公钥不变
- [ ] issuer 内外分离生效：浏览器重定向仍走 127.0.0.1:8001，容器内 discovery 成功，iss 校验不破
- [ ] README 部署章节与实际一致

## Blocked by

None — can start immediately.

## 文档

- [ADR-0003 fastify + openid-client 网关栈](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0003-fastify-openid-client-stack.md)
- [网关 README](https://github.com/1123786563/dsh-plugin/blob/main/services/casdoor-gateway/README.md)
