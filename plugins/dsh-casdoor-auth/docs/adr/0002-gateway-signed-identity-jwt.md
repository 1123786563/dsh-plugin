# 0002 — 网关签发短期 JWT 作为跨进程身份传递

网关验证登录会话后，用本地 Ed25519 私钥铸造短期 **DshIdentityToken**（iss=`dsh-casdoor-gateway`、aud=`dsh-casdoor-auth`、TTL≈60s、claims: tenant/user/name/roles），经 `x-dsh-identity` 头转发；dsh 侧插件对网关公开的 JWKS（`/.well-known/jwks.json`）验签后物化 Principal。

## Considered Options

- **HMAC 对称签名身份头**——被否：dsh 侧持共享密钥即能伪造身份，密钥泄露面大；且需自防重放。
- **纯网络隔离 + 明文头**——被否：私口万一被本机其他进程摸到即可伪造；缺少纵深。
- **网关签发非对称 JWT（采纳）**：私钥永不离网关数据目录；dsh 只消费公钥；短期 exp 防重放；jose 在两侧验签/铸造成熟可靠。

## 附带决策：特权方法镜像门禁

转发时 Host 改写为私口 authority，宿主对 PRIVILEGED 15 方法的 loopback 钉死等效"对已登录者放行"。故网关**镜像该清单**并要求 casdoor 特权角色（默认 `dsh-admin`），非管理员对这些方法 403；清单可用 `GATEWAY_PRIVILEGED_METHODS` 覆盖，与宿主 `PRIVILEGED_METHODS`（client-connection）保持人工同步。
