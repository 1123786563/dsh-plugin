# 混合 API 代际：v1 摄入 + v3 治理/价格/钱包

后端是自带 fork（分支 feat/subscription-credit-currency），同时服务上游稳定版 v1（`/api/v1/*`）与 fork 扩展的 v3（`/openmeter/*`）。选路原则：流量最大、最需要稳定的摄入走 v1 `POST /api/v1/events`（上游大规模验证，数组批量 + (namespace,id,source) 32 天去重）；余额门禁走 v3 `governance/query`（官方注明设计为轮询+缓存）；价格走 v3 `llm-cost`；充值/授予、扣减、余额展示用 v1/v2 的 customers/grants/entitlements 机制，v3 钱包视图做展示。锁定后果：插件只兼容本 fork（含 v3 端点），不兼容上游原版 OpenMeter——这是有意为之，运营者即 fork 维护者。

## Considered Options

- 全走 v1（可兼容上游）——被否：governance、llm-cost、钱包三支柱能力只存在于 v3，自己再造等于重写。
- 全走 v3——被否：摄入是最高流量路径，v1 成熟度无可替代。
