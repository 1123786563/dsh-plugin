# 重启自愈演练证据登记（Issue #21）

四档演练（tier-1 / fail-closed / tier-2 / tier-3）的**执行命令与验收断言以 [README「重启自愈演练 ladder」](../README.md#重启自愈演练-ladderissue-21) 为准**（本手册复述要点便于逐项勾验，如有出入以 README 为准）。本手册只做**证据登记**：每档跑完后在下方登记表追加一行，登记内容 = 日期 + 档位 + 关键命令输出摘要 + 结论。

## 断言清单（与 README ladder 一致）

| 档位 | 执行命令 | 验收断言 |
| --- | --- | --- |
| tier-1 容器自愈 | `docker compose down && docker compose up -d casdoor postgres casdoor-gateway`（绝不带 `-v`；down 保持整项目、up 定向门禁栈——本机仅门禁栈常驻，多栈环境 down 会连带停 openmeter/nocobase，定向 up 避免把它们拉起） | ① `docker ps` 三容器 Up；② 3080 登录链路 302 → casdoor authorize；③ 同一浏览器 cookie 会话存活（不重登直接可用）；④ 38080 全 401 |
| fail-closed 网关停用 | `docker compose stop casdoor-gateway` → 验 38080 → `docker compose start casdoor-gateway` | ① 停用期间 38080 仍全 401（私口守卫独立于网关在位）；② start 后自动回绿且登录会话不掉 |
| tier-2 OrbStack 重启 | `osascript -e 'quit app "OrbStack"'` && `open -a OrbStack`，等 `docker info` 恢复后验同 tier-1 | 同 tier-1 全套（restart: unless-stopped 容器自愈 + 3080 链路 + 同 cookie 会话 + 38080 全 401） |
| tier-3 整机重启 | 系统重启并登录后验同 tier-1 | 同 tier-1 全套 + launchd 自愈证据（`launchctl print gui/$(id -u)/com.dsh.web` running；gate-stack 已跑过；`tail ~/.dsh-doctor/logs/dsh-web.launchd.log`） |

## 证据登记表

> 证据将由后续轮填入；**Issue #21 关票时在本表登记汇总并留 comment**。每档一行，输出摘要写关键行（容器状态、HTTP 码、免登结论），不贴全文日志。

| 日期 | 档位 | 关键命令输出摘要 | 结论 |
| --- | --- | --- | --- |
| 2026-08-31 | 切换后验证（T2 收口后 00:28–00:50 复测） | finisher 00:00:40 直连矩阵 401/401/401（守卫在位窗口）；00:04:22 起 38080 被 zcode-cli 拉起的 rc.2 主检出直连 web（无守卫代码）占用→矩阵变 200/404/404、API 经 3080 403（网关日志「upstream answers without browser auth (dsh < 0.1.2-alpha)」）；登录全链路✅（dsh-admin→dsh_sid→免登）；WS 带 cookie 连接被撕（rc.2 上游） | 登录/会话链达标；38080 全 401 与 API/WS 面环境性阻断（守卫形态待用户侧解决唤醒链路冲突），守卫行为证据=finisher 矩阵+zero-trust-drill（#18） |
| 2026-08-31 | tier-1 容器自愈 | down（无 -v）→三容器移除、3080 拒连、38080 宿主 web 不受影响（200）；up 定向三服务→healthz 12s 回绿；同 cookie 存活（GET /=200、/login 复访 302→/）；宿主/容器 identity pub md5=f50f661e6cf85aefc686f3ffb42f7bd7 一致 | ①②③ PASS；④ 38080 全 401 环境性阻断（同上）；**附带发现**：冷起后匿名 /login 500 粘滞（casdoor HTTP ~40s 才就绪、网关 discovery 拒连进程内粘滞），`docker restart dsh-casdoor-gateway` 3s 恢复→缺陷登记 #53 |
| 2026-08-31 | fail-closed（折叠裁定 R25） | 独有断言「网关停用期间 38080 全 401」=守卫属性，守卫不在位无法 live 验证；「38080 独立于网关」已由 tier-1 停相证（网关死而 38080=200）；「起回后会话不掉」已由网关重启后同 cookie 免登证 | 折叠登记：live 不可验证部分以 zero-trust-drill（#18 隔离实证）+ finisher 00:00:40 矩阵为证据；守卫恢复在位后可补跑 |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |

### 2026-08-31 环境冲突记录（等待用户决策）

zcode-cli 唤醒链路会自动拉起 rc.2（0.1.1-rc.2）主检出直连 web 占 38080，挤掉 launchd 守卫形态（com.dsh.web EADDRINUSE crash-loop，KeepAlive 保留——直连 web 一旦消失自动夺回）；解法选项 (a) 唤醒链路改走 3080（b) 停止自动拉 web 复用在位 web (c) 守卫 patch 上流合并 (d) 接受窗口式守卫每轮收口。详见 wake-log 2026-08-31 各轮。
