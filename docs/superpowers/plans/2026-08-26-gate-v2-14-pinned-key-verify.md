> 对应 issue：[#14](https://github.com/1123786563/dsh-plugin/issues/14)（状态跟踪以 issue 为准，本文件是计划的仓库内源稿）

## What to build

`dsh-casdoor-auth` 对 DshIdentityToken（网关 Ed25519 JWT，`x-dsh-identity` 头）的验签支持**公钥钉扎**模式：通过 env 注入网关 Ed25519 公钥后**本地验签**，不依赖网关在线（JWKS 拉取）；未配置时回退现有 JWKS 行为。验签底座就位后，zero-trust 守卫（#18）在网关短暂不可达时仍能校验既有 token，而 60 秒 TTL 仍保证整体 fail-closed。

当前实现：`ctx.casdoorAuth`（CasdoorAuthService）用 `createRemoteJWKSet` 拉网关 `/.well-known/jwks.json`（30s cooldown），`jwtVerify` 限定 EdDSA + iss + aud，失败 resolve undefined。该服务目前只被 multi-tenant 桥调用，本票不改这一点（接线在 #18）。

## 实施计划

1. identity 模块增加公钥解析：env 提供 PEM 或 JWK，构造本地 KeyLike；与 remote JWKS 二选一，**钉扎优先**。
2. EdDSA + iss + aud 校验语义保持不变；失败仍 resolve undefined（不抛出）。
3. env 名与 bundle/profile 注入方式对齐仓库既有约定（`!!js process.env.X` 形态）。
4. 单测矩阵：钉扎验签通过 / 签名不符 / claim 篡改 / exp 过期；无钉扎回退 JWKS（mock 端点）；iss、aud 不符拒绝。

## Acceptance criteria

- [ ] 配置钉公钥时离线验签可用（测试用私钥铸造样本 token，全程不触网）
- [ ] 无钉扎时行为与现状一致（JWKS 拉取路径回归通过）
- [ ] 单测覆盖上述矩阵，全部通过

## Blocked by

None — can start immediately.

## 文档

- [ADR-0002 网关签发短期 JWT 身份传递](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0002-gateway-signed-identity-jwt.md)
- [ADR-0004（dsh 侧验签：钉公钥优先）](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0004-host-guard-hooks-patch.md)
