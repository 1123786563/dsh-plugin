# Issue #21 — 重启自愈 tracer：live 网关形态切换 + 三档演练 + 部署收口

- **Issue**: https://github.com/1123786563/dsh-plugin/issues/21 （[门禁v2 09] 宿主 ApiProxy 会话访问过滤钩子（ADR-0004 钩子②）——正文实为重启自愈 tracer）
- **用户批准**: 2026-08-30 16:4x 用户回复「1」，批准等待事项 1（live 3080 切换 + 整机重启/Docker 运行时重启物理演练配合）。
- **依赖**: 原生 blocked_by {#15 CLOSED, #18 CLOSED} 满足。

## 范围

1. **部署形态 repo 收口**（T1，分支 feat/gate-v2-21-restart-heal）：
   - `docker-compose.yml` casdoor-gateway：数据卷改 bind mount `${HOME}/.dsh-casdoor-gateway:/data`（launch-token 通道：宿主插件写 `webserver-token.json`，容器网关读取）+ `user: "501:20"`（宿主 uid 匹配，token 0600 可读、数据目录可写）；移除闲置命名卷声明。
   - `services/casdoor-gateway/deploy/`：`com.dsh.web.plist`（dsh web 常驻：RunAtLoad+KeepAlive，WorkingDirectory=harness patch worktree）与 `com.dsh.gate-stack.plist`（登录时幂等保障 OrbStack+门禁栈）。
   - `services/casdoor-gateway/README.md` 部署节收口：compose=正式形态、pnpm dev=开发模式、launchd 常驻部署、自愈链说明、**排障手册（3080 不通检查顺序：容器→cookie→casdoor→私口）**、重启自愈演练 ladder（三档+fail-closed）、逃生门/回滚路径。
   - `services/casdoor-gateway/docs/restart-heal-drills.md`：演练手册 + 证据登记表（后续轮填充证据后提交）。
   - `scripts/host-patches/README.md` 状态表补一行：dsh-request-guard worktree = live 运行时，勿清理。
2. **live 切换**（T2，controller 亲执——Ruling R2）：
   - staging：插件构建核验、live profile `dsh plugin add link:` ×2、profile cordis.patch.yml 覆盖（guardEnabled: true + identityPublicKey 钉公钥 + gatewayDataDir）、网关 3099 临时预检（healthz/login 302/JWKS kid 与钉公钥一致）。
   - cutover（分离脚本，180s 延迟武装）：杀旧 dsh web（3080 直连）→ launchd 接管新 dsh web（patch worktree，38080 私口+guard）→ compose 起网关占 3080 → sanity（login 302、38080 直连 401）→ wake-log + 删运行锁。
3. **验证与演练**（T3，后续轮，controller 亲执）：
   - 切换后验证：3080 全链路（casdoor 登录→UI→API→WS）、38080 直连矩阵 401（多方法/路径/WS 拒绝/伪造 token）、dsh-admin 会话可见性。
   - 演练 ladder：tier-1 `docker compose down && up -d`；fail-closed（仅停网关→38080 全 401→起回→会话不掉）；tier-2 **OrbStack 重启**（Ruling R5：等效"Docker Desktop 重启"档）；tier-3 **整机重启**（最后一击，全部 repo 工作 push/merge 后执行；重启后验证由下一轮完成）。
   - 证据（命令输出摘要）填入 restart-heal-drills.md 并留 issue comment。
4. **发布**（T4）：全分支终审 → PR → merge → Issue #21 关闭（含证据评论）。

## 非目标

- 不改网关/插件运行时代码（#19/#22/#25 已收口面）；发现缺陷走新 Issue/后续 PR。
- 不做 #27 存量迁移（依赖本 Issue 关闭后解锁）。
- 不触碰 compose project "docker-compose"（无关第三方栈：docker-compose-casdoor-1/postgres/valkey）。
- 不动 OrbStack 之外的系统配置；launchd agent 仅新增上述两个 label。

## 任务拆分

| 任务 | 内容 | 执行者 |
|---|---|---|
| T1 | 部署形态 repo 收口（compose+deploy plists+README+drills 手册+host-patches README 行） | implementer subagent + 独立双审 |
| T2 | live 切换（staging+武装 cutover） | controller（R2：破坏性 live 操作 + 会话自杀式步骤） |
| T3 | 切换后验证 + tier-1/fail-closed/tier-2 演练 + 证据 | controller（后续唤醒轮） |
| T4 | 证据提交 + 终审 + PR/merge/关票 | implementer subagent（证据提交）+ controller |
| T5 | tier-3 整机重启 + 重启后验证 | controller（最后一击；验证在下一轮） |

## 测试与验收命令

- T1 门禁：`docker compose config -q`（渲染合法）、`plutil -lint` 两个 plist、README 节齐全性 grep、既有 `pnpm -r typecheck/build` 不回归（本分支无 TS 改动，跑受影响包：services/casdoor-gateway build）。
- T3 验收矩阵（live）：`curl -sI http://127.0.0.1:3080/login` 302→casdoor；`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:38080/` = 401（含多路径/方法）；网关停时 38080 仍全 401（fail-closed）；三档重启后 3080 自动可用 + 登录会话存活（同 cookie）+ 38080 全 401。
- Issue AC 对应：①整机重启自动恢复（T5+下一轮验证）②fail-closed（T3）③文档与行为一致（T3 核验+T4 收口）。

## 全局约束

- live 物理操作按用户批准范围执行；整机重启必须在全部 repo 工作 push/merge 之后（R8）。
- 切换失败逃生门必须始终可用：guard 关（profile patch guardEnabled: false）→ 全回退（profile 移除插件 + launchctl bootout com.dsh.web + 旧形态重启）；写入排障手册与用户报告。
- 运行锁由 cutover 脚本收尾删除（R7）；武装窗口内新唤醒见锁即跳过。
- 每一步 live 操作前证据采集（前后状态、命令输出）进 SDD workspace，最终摘要进 repo 手册与 issue 评论。
- 网关数据卷 bind mount 后**绝不** `docker compose down -v`（会清 casdoor 种子与网关身钥）。
