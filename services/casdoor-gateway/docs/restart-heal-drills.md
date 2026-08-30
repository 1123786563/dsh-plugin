# 重启自愈演练证据登记（Issue #21）

四档演练（tier-1 / fail-closed / tier-2 / tier-3）的**执行命令与验收断言以 [README「重启自愈演练 ladder」](../README.md#重启自愈演练-ladderissue-21) 为准**（本手册复述要点便于逐项勾验，如有出入以 README 为准）。本手册只做**证据登记**：每档跑完后在下方登记表追加一行，登记内容 = 日期 + 档位 + 关键命令输出摘要 + 结论。

## 断言清单（与 README ladder 一致）

| 档位 | 执行命令 | 验收断言 |
| --- | --- | --- |
| tier-1 容器自愈 | `docker compose down && docker compose up -d`（绝不带 `-v`） | ① `docker ps` 三容器 Up；② 3080 登录链路 302 → casdoor authorize；③ 同一浏览器 cookie 会话存活（不重登直接可用）；④ 38080 全 401 |
| fail-closed 网关停用 | `docker compose stop casdoor-gateway` → 验 38080 → `docker compose start casdoor-gateway` | ① 停用期间 38080 仍全 401（私口守卫独立于网关在位）；② start 后自动回绿且登录会话不掉 |
| tier-2 OrbStack 重启 | `osascript -e 'quit app "OrbStack"'` && `open -a OrbStack`，等 `docker info` 恢复后验同 tier-1 | 同 tier-1 全套（restart: unless-stopped 容器自愈 + 3080 链路 + 同 cookie 会话 + 38080 全 401） |
| tier-3 整机重启 | 系统重启并登录后验同 tier-1 | 同 tier-1 全套 + launchd 自愈证据（`launchctl print gui/$(id -u)/com.dsh.web` running；gate-stack 已跑过；`tail ~/.dsh-doctor/logs/dsh-web.launchd.log`） |

## 证据登记表

> 证据将由后续轮填入；**Issue #21 关票时在本表登记汇总并留 comment**。每档一行，输出摘要写关键行（容器状态、HTTP 码、免登结论），不贴全文日志。

| 日期 | 档位 | 关键命令输出摘要 | 结论 |
| --- | --- | --- | --- |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |
