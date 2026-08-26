# services/nocobase

NocoBase（`nocobase/nocobase:2.2.2`，根 docker-compose 的 `nocobase` + `nocobase-postgres`）的配套资产：**Casdoor 认证插件**的源码与构建。

## 目录

- `plugin-auth-casdoor/` — `@dsh/plugin-auth-casdoor`：NocoBase 外部认证插件（授权码流 OIDC → casdoor）。
  - `src/server/casdoor-auth.ts` — `BaseAuth` 扩展：code 兑换 → claims（userinfo / id_token / JWT access_token 三级回退）→ 绑定 / JIT 建号。
  - `src/server/plugin.ts` — 注册 `casdoor` 认证类型与两个端点：`api/casdoorAuth:getAuthUrl`（带 `X-Authenticator` 头）、`api/casdoorAuth:redirect`（casdoor 回调，state 为携带认证器名的短时 JWT，302 回 `/signin?authenticator=&token=`）。
  - `src/client/` — 登录按钮 + 认证器管理表单（dotted path 绑定 `options.*`）。
- `scripts/build-plugin.mjs` — esbuild 构建到 `plugin-auth-casdoor/dist/`（server CJS / client CJS，`@nocobase/*`、antd、react 全部 external）。

## 挂载与激活机制

compose 把本目录直挂进容器：

```
./services/nocobase/plugin-auth-casdoor → /app/nocobase/storage/plugins/@dsh/plugin-auth-casdoor
```

配合 `APPEND_PRESET_BUILT_IN_PLUGINS=@dsh/plugin-auth-casdoor`，首次 `nocobase install` / 升级时自动安装并启用（不可从插件管理器禁用）。**插件运行时零依赖**（只有宿主提供的 external），因此无需在容器里跑 npm install，改完源码构建 + 重启容器即生效。

两个已知坑（都在包结构上）：

- `package.json` 的 `exports` 必须含 `"./package.json"` —— NocoBase 的 pm 会读它。
- 浏览器侧 issuer（如 `http://127.0.0.1:8001`）与容器侧服务地址（`http://casdoor:8000`）不同：认证器 `options.serverIssuer` 承担后者，缺省回落 issuer。

## 构建

```bash
pnpm --filter dsh-nocobase-service build
docker compose restart nocobase
```

部署、bootstrap、冒烟见 `plugins/dsh-nocobase/README.md`。
