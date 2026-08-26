> 对应 issue：[#18](https://github.com/1123786563/dsh-plugin/issues/18)（状态跟踪以 issue 为准，本文件是计划的仓库内源稿）

## What to build

**tracer——本次"直连绕过门禁"事故的最终修复。** 本机任意进程直连 dsh 私口（38080）的**一切请求**——index.html、静态资源、webmanifest、`/api` 任意方法、`session.export` GET 旁路、WS 升级——一律收到 401 与提示文案"请走 http://127.0.0.1:3080"；经网关（3080）的正常全链路（登录→UI→API→WS）不受任何影响。网关不在 = 私口死（fail-closed）。

实现：`dsh-casdoor-auth` 把 #14 的验签能力接进 #13 的宿主守卫钩子——每个进入私口的请求验 `x-dsh-identity`，有效则放行并物化请求主体 {tenantId, userId, roles}，无效 401。

## 实施计划

1. 插件注册守卫实现：调 CasdoorAuthService（钉公钥优先）验 `x-dsh-identity` → 放行 + 返回请求主体；任何失败 → 401 + 提示文案（plain text，运维可读）。
2. 守卫配置经 bundle/profile patch 注入：钉公钥 env、守卫开关 env（开关 = 逃生门：关闭即回到门禁前形态）。
3. 更新 live web profile 配置并重启 dsh 实例（web profile bundle 已 link 安装，只补配置）。
4. e2e 扩展直连负路径矩阵：HTTP 任意方法/路径直连 401、WS 直连升级被拒、缺/伪/过期 token 401、静态资源与 webmanifest 401。
5. fail-closed 演练：停网关 → 私口整体 401；起回 → 恢复。

## Acceptance criteria

- [ ] curl 直连 38080 任意路径/方法 → 401（含提示文案）
- [ ] 直连 WS 升级被拒；伪造/过期 x-dsh-identity → 401
- [ ] 经 3080 登录后 UI/API/WS 全部正常（含静态资源加载）
- [ ] 停网关 → 私口全 401（fail-closed）；恢复后自动可用
- [ ] 守卫开关关闭时系统回到门禁前形态（逃生门可用）

## Blocked by

- #13 — 宿主请求守卫钩子
- #14 — 验签增强（钉公钥优先）

## 文档

- [ADR-0004 zero-trust 私口与 fail-closed](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0004-host-guard-hooks-patch.md)
- [CONTEXT.md zero-trust 业务规则](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/CONTEXT.md)
