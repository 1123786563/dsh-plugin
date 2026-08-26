# Context map

本仓库是多上下文 monorepo。处理任务时先读根上下文，再读取与改动范围直接相关的上下文和 ADR。

| Context | Scope | Read when |
| --- | --- | --- |
| [`CONTEXT.md`](CONTEXT.md) | 宿主、插件边界、NocoBase 集成、认证拓扑 | 任何跨插件或基础设施任务 |
| [`plugins/dsh-openmeter/CONTEXT.md`](plugins/dsh-openmeter/CONTEXT.md) | DSH ↔ OpenMeter 计量、钱包、账本、收银台、阻断 | 用量、额度、计费归属或 OpenMeter 任务 |
| [`plugins/dsh-casdoor-auth/CONTEXT.md`](plugins/dsh-casdoor-auth/CONTEXT.md) | Casdoor 登录会话、Tenant、Principal、网关门禁 | 身份、租户、登录、网关或角色任务 |
| `plugins/dsh-multi-tenant/` | 租户隔离与会话归属实现 | 会话 ownership、租户边界或跨租户访问任务 |

系统级 ADR 位于 `docs/adr/`（如目录存在）；上下文级 ADR 位于相关插件的 `docs/adr/`。若目录不存在，按需创建，不把缺失本身当作阻塞项。
