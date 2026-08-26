# dsh-openmeter

OpenMeter 计费插件 for DeepSeek Harness：把每次 LLM 模型调用的 token 用量实时计量到自托管 OpenMeter（fork），预付余额耗尽自动硬阻断（故障放行），价格取自 OpenMeter llm-cost 价格库（CNY 报价），并在 Web GUI 提供用量面板与收银台。

设计决策见 `CONTEXT.md`（领域术语表）与 `docs/adr/`（5 条 ADR）。

## 能力

- **计量**：每条已提交的 assistant 消息 = 一条 CloudEvents 用量事件（replay 安全，`(sessionId, seq)` 去重）。维度：model / provider / purpose / sessionId / rootSessionId（子代理归集）/ presetId。计费输入 = input + cacheRead + cacheWrite；meter 值 = 计费输入 + output。
- **可靠性（ADR-0002）**：宿主侧 WAL 磁盘队列，至少一次投递，事件 ID 生成后不变；OpenMeter 按 `(namespace, id, source)` 32 天去重，重试不会重复计费；超过去重窗口的未确认记录在重放时丢弃（防双计费）。
- **阻断（ADR-0003）**：`llm/stream` 瀑布流前置门禁，余额耗尽抛错拒绝调用；v3 `governance/query` + 60s 缓存 + 充值/解封后强刷；OpenMeter 不可达时放行并计数（fail-open）。内部户（house）与手动解封不受阻。
- **定价（ADR-0001）**：唯一价格源是 OpenMeter llm-cost 价格库（CNY override），本地缓存用于面板即时估算；断网沿用上次缓存。
- **归属（ADR-0004）**：`agent 预设 → 客户` 映射（收银台编辑），未绑定会话记内部户（照常计量、永不阻断、兼作运营者自用成本视图）。
- **API（ADR-0005）**：摄入走 v1 `/api/v1/events`；门禁/价格走 fork v3 `/api/v3/openmeter/*`；客户/授予/余额走 v1/v2。

## 界面

- 侧边栏「计费」标签页：**用量**（本月按客户聚合 + 最近逐调用明细与估算金额）／**收银台**（客户列表+余额、充值=grant、手动阻断/解封、预设↔客户映射）。
- 设置 → 插件 → OpenMeter：endpoint / token / featureKey / meterSlug / 币种 / 阻断开关等，保存即热生效。

## 部署

### 1. 启动 OpenMeter fork（自托管）

基础设施（Kafka/ClickHouse/Postgres/Redis）按 fork 的 `docker-compose.base.yaml` 或既有远程实例；应用层从源码构建：

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

注：各进程遥测端口必须互不相同（`:10000` 被 server 占用）。

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
pnpm test && pnpm typecheck && pnpm build
```

宿主半区 `src/`（pipeline / wal / forwarder / gate / estimator / store / routes / openmeter client），浏览器半区 `src/client/`（settings card + better-sidebar 面板），契约见各文件头注释。
