# dsh-openmeter

OpenMeter 计费插件 for DeepSeek Harness：把每次 LLM 模型调用的 token 用量实时计量到自托管 OpenMeter（fork），预付余额耗尽自动硬阻断（故障放行），价格取自 OpenMeter llm-cost 价格库（CNY 报价），并在 Web GUI 提供用量面板与收银台。

设计决策见 `CONTEXT.md`（领域术语表）与 `docs/adr/`（5 条 ADR）。

## 能力

- **计量**：每条已提交的 assistant 消息 = 一条 CloudEvents 用量事件（replay 安全，`(sessionId, seq)` 去重）。维度：model / provider / purpose / sessionId / rootSessionId（子代理归集）/ presetId。计费输入 = input + cacheRead + cacheWrite；meter 值 = 计费输入 + output。
- **可靠性（ADR-0002）**：宿主侧 WAL 磁盘队列，至少一次投递，事件 ID 生成后不变；OpenMeter 按 `(namespace, id, source)` 32 天去重，重试不会重复计费；超过去重窗口的未确认记录在重放时丢弃（防双计费）。
- **本地账本**：持久化本地用量账本（SQLite，`(source, eventId)` 幂等写入）逐条镜像每条已计量事件，作为展示/估算的数据源；写入尽力而为（WAL 为准），失败计入健康计数。
- **阻断（ADR-0003）**：`llm/stream` 瀑布流前置门禁，余额耗尽抛错拒绝调用；v3 `governance/query` + 60s 缓存 + 充值/解封后强刷；OpenMeter 不可达时放行并计数（fail-open）。内部户（house）与手动解封不受阻。
- **定价（ADR-0001）**：唯一价格源是 OpenMeter llm-cost 价格库（CNY override），本地缓存用于面板即时估算；断网沿用上次缓存。
- **归属（ADR-0004）**：`agent 预设 → 客户` 映射（收银台编辑），未绑定会话记内部户（照常计量、永不阻断、兼作运营者自用成本视图）。
- **API（ADR-0005）**：摄入走 v1 `/api/v1/events`；门禁/价格走 fork v3 `/api/v3/openmeter/*`；客户/授予/余额走 v1/v2。

## 界面

设置里的一级页面「计费」（不占用插件管理区）：**用量**（本月按客户聚合 + 最近逐调用明细与估算金额）／**收银台**（客户列表+余额、充值=grant、手动阻断/解封、预设↔客户映射）／**设置**（endpoint / token / featureKey / meterSlug / 币种 / 阻断开关等，保存即热生效）。

## 运营者 API 迁移

原全局收银台路由已迁移到运营者前缀 `/api/openmeter/operator/*`,由运营者角色守卫:接线 auth seam 时必须解析出 `isOperator` 策略,stock 部署保持原回环守卫行为。`GET /api/openmeter/status` 与 `GET /api/openmeter/usage` 原地不动;方法、body 契约、成功 payload 形状与迁移前一致。

| 旧路径(已移除) | 新路径 |
| --- | --- |
| `GET/POST /api/openmeter/customers` | `GET/POST /api/openmeter/operator/customers` |
| `POST /api/openmeter/grants` | `POST /api/openmeter/operator/grants` |
| `POST /api/openmeter/block` | `POST /api/openmeter/operator/block` |
| `GET/POST /api/openmeter/bindings` | `GET/POST /api/openmeter/operator/bindings` |

### 410 语义

旧路径保持注册,但对**一切方法、一切调用者**(stock 回环、运营者、租户成员、匿名、非回环来源)一律稳定回答 410,不保留兼容别名。该响应不经过回环守卫、不查 auth seam、不读 store、不调 OpenMeter——与调用者身份或目标是否存在完全无关,零信息泄露:

```json
{ "ok": false, "error": "route-migrated", "to": "/api/openmeter/operator/customers" }
```

### audit 字段

四个变更类成功响应(create 201 / grant 201 / block 200 / binding-set 200)统一附带 `audit` 记录:

```json
{
  "action": "grant.create",
  "target": "cust-acme",
  "at": 1761580800000,
  "actor": { "tenantId": "dsh-ops", "userId": "root" }
}
```

- `action`:`customer.create` / `grant.create` / `block.set` / `binding.set`。
- `target`:customer key 字符串;`binding.set` 为 `{presetId, customerKey}`(空 customerKey 表示解绑)。
- `at`:epoch 毫秒。
- `actor`:仅当 auth seam 在线且解析出策略时存在;stock 回环模式(无 seam)省略该字段,绝不伪造身份。

GET 读响应不变(无 audit,列表 payload 字节兼容)。重复操作语义:block 同值两次均 200(幂等 set,第二次 `audit.at` 不早于第一次)、binding 同对两次均 200、grant 两次均 201(充值有意非幂等)。

### 回滚

迁移不留兼容别名:旧路径在本版本固定 410,不存在「关掉 410 恢复旧路径」的开关。回滚 = 重新部署仍注册旧全局路径的上一版插件构建(连同其 `cordis.patch.yml` 与 `lib/` 产物),客户端即恢复旧路径;已改到运营者前缀的调用方需随回滚一并改回。数据面无迁移:operator store、预算与账本的磁盘格式未变,回滚不涉及任何数据操作。

## 租户自助 API(/me/*)

任意已映射租户的成员(无角色要求)只读本人租户数据;预算写需租户管理者角色。subject 只来自已验签身份解析出的策略——query/body 参数一律不参与归属。未接身份服务(或其身份源请求时缺席)时 `/me/*` 无 stock 回环兼容路径:一律 401 `unauthenticated`,绝不无范围地服务租户数据。

| 路径 | 方法 | 契约要点 |
| --- | --- | --- |
| `/api/openmeter/me/summary` | GET | 本人租户额度摘要。OpenMeter 拒绝时仍 200,以 `availability: "unavailable"` 降级态返回并保留本地 7 天聚合,不带余额、访问标志或错误文本;租户未映射 403 `tenant-unmapped`。 |
| `/api/openmeter/me/usage` | GET | 本人租户持久账本明细(分页)。query:`from`/`to`(整数 epoch 毫秒)、`limit`(1..100,默认 50)、`model`(去空格后非空)、`cursor`(非空);`subject`/`tenantId` 参数一律 400 `subject-not-allowed`;账本 seam 缺席或故障 503 `ledger-unavailable`。行内剥除内部身份(source/eventId/subject)。 |
| `/api/openmeter/me/budget` | GET/PUT | 月度预算预测(响应含 `canManageBudget`)。PUT 需租户管理者角色(默认 `owner`),不足 403 `forbidden`;body 只允许 `{"monthlyBudgetCny": <number>}`,其他键或缺键 400 `invalid-body`,非正数/超过 1e8 400 `invalid-amount`;预算或账本 seam 缺席/读失败 503 `budget-unavailable`(写已保存仍如实答 503)。 |

## 角色与可用面矩阵

| 可用面 | 租户成员(已映射,无管理角色) | 运营者(isOperator) | stock 回环(未接身份服务) |
| --- | --- | --- | --- |
| `/me/summary`、`/me/usage` | ✅ 仅本人租户数据 | ✅ 读自身映射租户(运营者角色不豁免映射要求) | ❌ 401 `unauthenticated` |
| `/me/budget` GET | ✅ | ✅ 同上 | ❌ 401 `unauthenticated` |
| `/me/budget` PUT | ❌ 403 `forbidden`(管理者角色可写) | ✅ 自身映射租户 | ❌ 401 `unauthenticated` |
| `/operator/*`(customers/grants/block/bindings) | ❌ 403 `forbidden` | ✅ 全量(变更带 audit actor) | ✅ 回环守卫放行(audit 无 actor) |
| `GET /api/openmeter/status`、`GET /api/openmeter/usage` | ❌(403,无身份 401) | ✅ | ✅ |
| 旧收银台路径(`/api/openmeter/customers` 等) | 410 `route-migrated`(一切方法、一切调用者) | 同左 | 同左 |

## 部署

### 1. 启动 OpenMeter fork（自托管）

推荐：仓库根目录的统一 compose（`docker-compose.yml`，含 Kafka/ClickHouse/Postgres/Redis 与 server/sink/balance/billing 四进程；镜像从同级 `../openmeter` 检出用 `Dockerfile.local` 构建，配置见 `services/openmeter/`；API 宿主端口 `127.0.0.1:8888` 即插件默认 endpoint）：

```sh
cd /Users/wuyongjun/trea/dsh-plugin
docker compose up -d        # 首次构建镜像需数分钟；只起计费栈：… up -d openmeter openmeter-sink openmeter-balance openmeter-billing
```

备选：宿主进程直跑（自备 Kafka/ClickHouse/Postgres/Redis，参考 fork 根 `config.yaml`）：

```sh
cd /path/to/openmeter
go build -o build/server ./cmd/server
go build -o build/sink-worker ./cmd/sink-worker
go build -o build/balance-worker ./cmd/balance-worker
go build -o build/billing-worker ./cmd/billing-worker
go build -o build/notification-service ./cmd/notification-service
./build/server --config config.yaml                 # API :8888
TELEMETRY_ADDRESS=:10001 ./build/sink-worker --config config.yaml
TELEMETRY_ADDRESS=:10002 ./build/balance-worker --config config.yaml   # 余额扣减必需
TELEMETRY_ADDRESS=:10003 ./build/billing-worker --config config.yaml
TELEMETRY_ADDRESS=:10004 ./build/notification-service --config config.yaml
```

注：宿主直跑时各进程遥测端口必须互不相同（`:10000` 被 server 占用）；compose 里各容器网络命名空间独立，无此约束。

### 2. 引导（幂等）

```sh
node scripts/bootstrap.mjs [endpoint]
# 可选环境变量：OPENMETER_ENDPOINT、OPENMETER_TOKEN、OPENMETER_HOUSE_SUBJECT、
# DEMO_CUSTOMER、DEMO_GRANT_AMOUNT（0 跳过示例充值）
```

创建：meter `dsh_llm_tokens`、feature `dsh_llm`（unit_cost=llm，provider/model/token_type 维度映射）、house + demo 客户（usageAttribution 绑 subject）、metered entitlement（月周期）、示例充值。llm-cost 价格库为空时功能仍可用（成本 0、估算显示「未定价」），用 `POST /api/v3/openmeter/llm-cost/overrides` 录入 CNY 销售价（价格字段是**字符串**数值）。

### 3. 安装到 dsh profile

```sh
pnpm dsh plugin --profile web add link:/Users/wuyongjun/trea/dsh-plugin/plugins/dsh-openmeter
pnpm build   # 本目录内，之后重启 dsh web
```

### 4. 冒烟（端到端资金路径）

```sh
node scripts/smoke.mjs [endpoint]
```

验证：预设绑定归属 → WAL → 摄入 → meter 出数 → llm-cost 定价扣减余额 → 耗尽后 governance 拒绝 → gate 阻断 → house 放行 → 故障放行。会在 OpenMeter 里建 `smoke-cust` 客户并留少量测试数据。

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `endpoint` | `http://127.0.0.1:8888` | fork API 地址 |
| `token` | 空 | Bearer token（OSS 默认无鉴权，回环可空） |
| `houseSubject` | `house` | 内部户 subject（永不阻断） |
| `featureKey` | `dsh_llm` | 门禁 feature（key 只允许 `[a-z0-9_]`） |
| `eventType` / `eventSource` | `dsh.llm.call` / `dsh` | CloudEvents 类型/来源 |
| `meterSlug` | `dsh_llm_tokens` | token meter |
| `quoteCurrency` | `CNY` | 报价币种 |
| `blockEnabled` | `true` | 余额耗尽硬阻断（false=只计量） |
| `accessCacheTtlMs` | `60000` | 门禁缓存 TTL |
| `priceRefreshMs` | `300000` | 价格刷新间隔 |
| `batchSize` | `100` | 摄入批量 |
| `dataDir` | 空 → `$DSH_HOME/openmeter` | WAL + 运营状态目录 |

## v2 候选（本版有意不做）

- 消息气泡内联成本标注（当前在面板逐调用明细中呈现；气泡需侵入 trajectory 布局）
- 信用预留（reserve-before-spend，fork 已支持）、DSH 内扫码/线下付款收款
- 会话事后改绑、用量图表、Stripe 自动对账

## 开发

```sh
pnpm --dir plugins/dsh-openmeter test        # pretest 自动先 build,干净树可跑
pnpm --dir plugins/dsh-openmeter typecheck
pnpm --dir plugins/dsh-openmeter build
```

(在插件目录内则 `pnpm test && pnpm typecheck && pnpm build` 等价;`lint` 脚本不存在。)

宿主半区 `src/`（pipeline / wal / ledger / forwarder / gate / estimator / store / routes / openmeter client），浏览器半区 `src/client/`（设置一级「计费」页面：用量/收银台/设置卡片），契约见各文件头注释。
