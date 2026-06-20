---
name: sdlc-design
description: SDLC 设计阶段——需求理解、概要/详细设计、待确认文档。用户提到 sdlc-design 或要进入设计/出方案时使用。共享语义见 software-dev-process。
---

# sdlc-design

设计阶段：把需求收敛为可施工的方案。原 design-1（概要）与 design-2（详细）已合并——按 profile 决定产到哪一层。

进入即设阶段：

```bash
node <SDLC_RUNTIME>/hooks/sdlc/bin/sdlc-hook.mjs phase.set --phase design
```

## 步骤

1. **收集上下文**（抽象步骤 `collect-context`、`locate-code`；用 `sdlc-hook step <name>` 取工具链）。先查项目知识库/历史方案，命中即复用；再定位相关代码。完成判据：接口契约、技术理由、主要风险、验证方式都清楚——不清楚就继续挖，**不在信息不足时强行进规划**。
2. **深度思考与规模评估**（`deep-think`）：判断 ≤3 天 / >3 天；复杂任务用 `plan-tasks` 拆解，产 `onlyAI/task-plan.json`（机器可读，含 `allowedPaths`）。
3. **出设计文档**（按 profile）：lite 只需 task-plan；standard 加 `001-概要设计.md`；full 再加 `002-详细设计.md` + `003-施工文档.md`。模板见 software-dev-process 产物策略。
4. **待确认**：只在真实方案分歧 / 业务不确定 / 外部依赖不明 / 风险需用户承担时，产 `001-概要设计-待确认.md` 或 `002-详细设计-待确认.md`。**待确认未处理会硬拦**后续源码编辑与阶段切换——在本阶段内处理完，标 `状态：已处理`，不删除（留作决策记录）。

边设计边写原型是允许的（软，会留痕）；正式施工请进 `sdlc-implement` 并声明边界。

完成判据：本 profile 的设计产物齐全 + 待确认全部已处理。
