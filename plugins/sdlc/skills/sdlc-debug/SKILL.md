---
name: sdlc-debug
description: SDLC 排查：用户报告 bug、报错或行为异常时使用。
---

# sdlc-debug

排查阶段：把猜测变证据。debug 是**条件阶段**——进入即显式激活，必须显式关闭，不会被任务收尾静默带过。

```bash
sdlc-hook phase.set --phase debug
```

进入即把 debug 标记为激活态（写入生命周期 state，不靠文件名/日志推断）。激活期间 `task.close --reason completed` 会被拦截，要求先关闭 debug。

## 步骤

记录到 `006-Debug排查记录.md`（模板见 software-dev-process 产物策略）：

1. **复现**：稳定的复现步骤。
2. **定位证据**（`locate-code` / `deep-think` 取工具链）：用证据指向根因，不把猜测写成结论。
3. **修复点**：最小改动；遇报错先最多 3 次自查重试，不加兜底掩盖错误。
4. **回归**：验证修复且未引入新问题。

完成判据：根因有证据支撑、修复已回归验证。

## 关闭 debug

排查结束后显式关闭（note 必填、可短，记录排查结论）：

```bash
sdlc-hook debug.close --note "根因与修复结论"
```

关闭后清除 debug 激活态并写入 `lastDebug`；此时若完成证据齐备即可 `task.close --reason completed` 收尾。非成功关闭（canceled/wontfix/superseded）可在 debug 仍激活时进行，但最终关闭证据会保留 `debugActiveAtClose` 这一事实。
