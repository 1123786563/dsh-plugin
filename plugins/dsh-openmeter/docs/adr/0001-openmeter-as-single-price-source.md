# OpenMeter 为唯一价格源，报价币种 CNY

DSH 侧不维护本地价格表；所有对客户的销售价（含加价）以 CNY 录入 OpenMeter 的 llm-cost 价格库（按 namespace override 表达），插件启动/定时拉取 `llm-cost/prices` 缓存到本地，仅用于界面即时估算。理由：账本延迟是秒级（Kafka 微批），即时展示不能查账本；价格改一处、账本与估算同步生效，避免两份价格表漂移。

## Considered Options

- 本地独立维护卖价表，OpenMeter 只收 token——被否：两份价格表必然漂移，收款依据与展示口径不一致。
