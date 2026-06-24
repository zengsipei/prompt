---
name: sdlc-solo
description: 手动 SDLC solo 模式：边界清晰、预计 ≤3 天的小任务，AI 可自动决策。
disable-model-invocation: true
---

# sdlc-solo

solo 模式：边界清晰、预计 ≤3 天。用 lite profile 走最短路径。

```bash
sdlc-hook init --task-dir docs/[task] --system [system] --profile lite
```

设计 / 施工 / 测试压缩进 `onlyAI/task-plan.json` + `onlyAI/verification.md` 或 `summary.md`。遇真实待确认项，**AI 可自动决策**，但必须在设计文档写明选择理由、风险、取舍——**不要把自动决策伪装成用户确认**。

`onlyAI/task-plan.json` 必须使用 `tasks[]`，每个任务必须有 `status`。完成状态只认：`done`、`completed`、`complete`、`[x]`、`已完成`。不要写成 `subtasks`。

最小示例：

```json
{
  "allowedPaths": ["src/login.ts"],
  "tasks": [
    {
      "id": "T-01",
      "status": "pending",
      "allowedPaths": ["src/login.ts"],
      "verification": ["npm test -- login"]
    }
  ]
}
```

硬约束不豁免：红线、（若已声明的）施工边界与项目前置门禁仍硬拦。solo 只是把**软流程**压到最短，不动硬边界。
