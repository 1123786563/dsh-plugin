# dsh-plugin

面向 deepseek-harness（dsh）宿主的插件 monorepo：每个 `plugins/*` 包是一个 dsh 插件，`services/*` 存放配套外部服务与部署件。

## Language

### 宿主与插件

**dsh 宿主**:
deepseek-harness 进程，通过 profile 的 bundle 清单加载插件。
_Avoid_: 主程序、host

**dsh 插件**:
挂进 dsh 宿主的 cordis 插件包，声明 `dsh.bundle.patch`，导出 name/inject/apply。
_Avoid_: 扩展、addon

**bundle patch**:
`cordis.patch.yml`，以层叠方式向宿主注入插件 entry 与默认配置（env 驱动）。

**profile**:
dsh 宿主的一份命名装配（`~/.dsh/profile/<name>`），决定加载哪些 bundle。

### NocoBase 集成

**NocoBase 实例**:
全局唯一一套自托管 NocoBase（Docker 服务），v1 不按租户拆分。
_Avoid_: NocoBase 应用（与 NocoBase 内部"数据应用"概念撞名）

**Casdoor 认证插件**:
我们自研、运行在 NocoBase 内的 casdoor OIDC 认证扩展，基于开源 `@nocobase/plugin-auth` 扩展机制。
_Avoid_: OIDC 插件（易与 NocoBase 官方商业插件 `@nocobase/plugin-auth-oidc` 混淆）

**JIT 开通**:
casdoor 用户首次登录 NocoBase 时自动创建 NocoBase 用户，默认角色 member。

**绑定**:
按 email 将 casdoor 身份关联到既有 NocoBase 本地用户。

**逃生通道**:
NocoBase 本地 admin 账号，casdoor 不可用时保证管理入口不锁死，仅运维使用。

### 认证拓扑

**casdoor**:
唯一 OIDC IdP，运行于 127.0.0.1:8001。

**casdoor-gateway**:
公口 3080 的认证反代网关，服务于 dsh web 流量；与 NocoBase 登录链路相互独立。

**nocobase 应用**:
casdoor 中为 NocoBase 登录单独注册的 OAuth 应用，isShared——各组织用户均可登录，权限由 NocoBase 自身角色体系管束。
_Avoid_: dsh-gateway 复用（那是网关链路的应用）

**组织后缀**:
casdoor 共享应用跨组织登录时 clientId/aud 携带的 `-org-<org>` 形态；Casdoor 认证插件按组织无关方式校验。

**dsh 插件（NocoBase）**:
`plugins/dsh-nocobase`，负责部署编排、双侧自动配置与健康暴露；NocoBase 逻辑本体在 Casdoor 认证插件内。
