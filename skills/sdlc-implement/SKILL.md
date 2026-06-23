---
name: sdlc-implement
description: SDLC 施工：用户要开始编码或在已声明施工边界内改代码时使用。
---

# sdlc-implement

施工阶段：在**施工边界**内逐任务编码。边界硬、声明自动化。

进入即设阶段：

```bash
sdlc-hook phase.set --phase implement
```

## 先满足硬门禁（否则源码编辑被 block）

- **施工边界 `allowedPaths`**：先声明，可自动播种——
  ```bash
  sdlc-hook scope.infer   # 从 git diff 写入 task-plan.json
  ```
  也可在 `003-施工文档.md` 用反引号列出文件，或直接写进 `onlyAI/task-plan.json` 的 `allowedPaths`。改边界外文件会被硬拦（standard/full）；无声明时退化为只提示（lite/solo）。
- **项目前置门禁**：若项目 registry 声明了 implement 前置（如「codegraph 检索待修改部分」），**必须先产出对应产物**，否则源码编辑被硬拦。`status` 的 `phasePreconditions` 列出未满足项。
- **待确认**：有未处理待确认会硬拦——先回 `sdlc-design` 处理。

## 逐任务循环

每个任务：① 按该任务文件清单编码（`locate-code` 取定位工具链）→ ② 在 `003-文件改动记录.md` 记本次改动文件（full 才写行号范围）→ ③ 更新 `003-施工文档.md` / task-plan 的任务状态 → ④ full 追加 `onlyAI/operations-log.md`。

小步保持可编译可验证；新增/改动代码同步补中文注释。公共组件改动须在施工文档醒目标红并单独取得用户许可。连续 3 次相同失败必须暂停问用户。

完成判据：所有任务状态为完成 + 文件改动记录齐全（standard/full）。
