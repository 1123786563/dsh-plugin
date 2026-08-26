> 对应 issue：[#21](https://github.com/1123786563/dsh-plugin/issues/21)（状态跟踪以 issue 为准，本文件是计划的仓库内源稿）

## What to build

**tracer——本次事故场景（机器重启后门禁消失、浏览器直达私口裸奔）永久闭环。** Docker Desktop 重启、整机重启后，门禁栈自动恢复：casdoor + 网关容器随 `restart: unless-stopped` 自愈，3080 可登录、登录会话存活、私口 38080 依旧全 401。部署与排障文档与运行态对齐。

## 实施计划

1. 演练三档：`docker compose down && up -d`、重启 Docker Desktop、整机重启；每档验证容器自愈、3080 登录链路、会话存活、直连 38080 全 401（依赖 #18 守卫）。
2. fail-closed 演练：仅停网关容器 → 38080 全 401；起回 → 自动恢复（登录会话不掉）。
3. 部署文档收口：compose 为正式形态、`pnpm dev` 为开发模式、排障手册（3080 不通的检查顺序：容器→cookie→casdoor→私口）。
4. 演练证据记录（命令输出摘要）留档。

## Acceptance criteria

- [ ] 整机重启后无需手动操作，3080 门禁自动可用、私口全 401
- [ ] 停网关容器 → 38080 全 401；恢复 → 自动回绿且登录会话不掉线
- [ ] 部署/排障文档与实际行为一致

## Blocked by

- #15 — 网关容器化基础
- #18 — zero-trust 私口落地（重启验收的"门禁自动恢复"语义依赖守卫）

## 文档

- [ADR-0004 部署节（fail-closed/容器化）](https://github.com/1123786563/dsh-plugin/blob/main/plugins/dsh-casdoor-auth/docs/adr/0004-host-guard-hooks-patch.md)
- [网关 README](https://github.com/1123786563/dsh-plugin/blob/main/services/casdoor-gateway/README.md)
