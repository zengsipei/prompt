---
name: sdlc-debug
description: SDLC 排查阶段——复现、定位、修复、回归。用户提到 sdlc-debug，或报告 bug / 报错 / 行为异常时使用。共享语义见 software-dev-process。
---

# sdlc-debug

排查阶段：把猜测变证据。

```bash
sdlc-hook phase.set --phase debug
```

## 步骤

记录到 `006-Debug排查记录.md`（模板见 software-dev-process 产物策略）：

1. **复现**：稳定的复现步骤。
2. **定位证据**（`locate-code` / `deep-think` 取工具链）：用证据指向根因，不把猜测写成结论。
3. **修复点**：最小改动；遇报错先最多 3 次自查重试，不加兜底掩盖错误。
4. **回归**：验证修复且未引入新问题。

完成判据：根因有证据支撑、修复已回归验证。
