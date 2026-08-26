# CONTEXT — dsh-openmeter（DSH ↔ OpenMeter 计费插件）

本文件是 dsh-openmeter 插件的领域术语表（glossary），只记术语与业务规则，不记实现细节。

## 术语

### 计量事件 (Metering Event)
一次 LLM 模型调用的不可变用量记录。度量值：inputTokens、outputTokens、cacheReadTokens、cacheWriteTokens、reasoningTokens；维度：model、provider、sessionId、rootSessionId、presetId、purpose。

purpose 标注调用的业务目的：conversation（对话）、compaction（上下文压缩）、session-title（会话起标题）。压缩与起标题调用是否向客户计费，是独立的商业决策（见 Round 3）。

v1 只计量 LLM 调用；其他资源类型（工具调用、子代理派生成本）留待未来扩展。

### 计费输入 (Billed Input)
模型调用中参与输入计费的 token 总量 = 未命中缓存的输入（inputTokens）+ 缓存读（cacheReadTokens）+ 缓存写（cacheWriteTokens）。缓存读与缓存写的单价通常不同于普通输入单价，是价格表的独立条目。

### 子代理调用 (Subagent Call)
由主会话派生的子代理所发起的模型调用。它是一条独立的计量事件：sessionId 指向子代理会话，rootSessionId 指向主会话。归集口径双轨并存：按 rootSessionId 聚合即「算主会话的」，按 sessionId 聚合即「独立统计」。

### Subject（计费主体）
OpenMeter 中用量归集与扣费的主体。运营者代跑形态下，客户即主体；归属由「agent 预设 → 客户」映射决定。

### 预设绑定 (Preset Binding)
agent 预设 ID 到客户的映射，是会话计费归属的唯一来源。会话启动时按其预设查表定归属；查不到映射的会话记入内部户。

### 内部户 (House Account)
运营者自己的计费主体。未绑定预设的会话（通常是运营者自己的开发会话）记入内部户：照常计量、照常出成本视图，但永不阻断。

### 收银台 (Cashier Panel)
DSH 侧的运营面板，OpenMeter OSS 无管理界面，收银台即唯一管理面。v1 职责：客户列表与余额查看、充值/调额（创建授予）、手动阻断/解封、预设↔客户映射编辑。

### 本地估算 (Local Estimate)
由本地价格表即时算出的金额，用于 DSH 界面展示。口径为面向客户的销售价（加价机制待定）。

### 账本 (Ledger)
OpenMeter 侧按 meter/price 聚合出的权威金额，是收款依据。本地估算与账本允许存在口径差：本地估算是展示用的近似值。

账本更新是异步的：事件被接受（已确认摄入）与事件可查询、可扣减余额之间存在秒级延迟。因此任何「即时」金额展示都不能依赖账本查询。

### 事件幂等性 (Event Idempotency)
计费系统按（命名空间、事件来源、事件 ID）在 32 天窗口内去重。因此上报方可以安全地采用「至少一次」投递：重试与重复上报不会造成重复计费。

### 信用预留 (Credit Reservation)
先冻结额度、后结算用量的扣费机制：模型调用前预留一块额度，调用结束后按实际用量结算、释放余量；预留超过授权时限（默认 5 分钟）自动失效。相比「先查余额再调用」，它能防止并发调用联合超支。v1 不启用，留待 v2 评估。

### 预付钱包 (Prepaid Wallet)
客户先充值、后消费的收款模式：充值形成信用授予（grants），模型用量按优先级逐笔扣减授予余额，余额不为负；余额是否足够决定能否继续调用。多个授予可并存（如赠送额度与付费额度），按优先级顺序消耗。

### 计费阻断 (Block)
客户余额不足以继续服务时，拒绝发起新模型调用的强制行为。运营者可解封或补充额度。与「计费系统故障放行」相区分：前者是商业决策（没钱不服务），后者是可用性决策（账房着火不关门）。

### 报价币种 (Quote Currency)
对客户报价与开票使用的货币，定为 CNY。模型上游成本多以 USD 计价，加价与汇率策略在 OpenMeter 价格表中一次性表达，插件不感知汇率。
