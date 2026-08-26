# Domain docs

This is a multi-context monorepo. Before exploring a task:

1. Read [`CONTEXT-MAP.md`](../../CONTEXT-MAP.md).
2. Read the root [`CONTEXT.md`](../../CONTEXT.md).
3. Read each context-local `CONTEXT.md` and applicable ADRs named by the map.

Use the glossary vocabulary in issue titles, plans, tests, and implementation notes. In particular, keep `Tenant`, `Principal`, `Subject`, `预设绑定`, `账本`, `预付钱包`, `额度`, and `计费阻断` distinct. If a needed concept is absent from the glossary, record the gap for domain modeling instead of silently inventing a synonym.

System-wide ADRs live under `docs/adr/`; context-specific ADRs live under the relevant plugin's `docs/adr/`. If an output conflicts with an ADR, surface the conflict explicitly and identify the ADR before proceeding.
