---
name: software-dev-process
description: SDLC 路由：用户要求按本仓流程推进但阶段不清时使用。
---

# Software Development Process（路由）

只做两件事：**路由**（进哪个 skill）+ 指向**共享语义**。各阶段步骤在各自 skill；流程讲解 / 答疑在 `sdlc-ask`。

## 拱顶石：边界硬，流程软

- **流程顺序可偏离**（软）：可跳级、可边设计边写原型；hooks 只 warn + 留痕。
- **声明的必做动作硬拦**（block，不降级）：内置红线、施工边界 `allowedPaths`、待确认文档、项目经 registry 声明的前置门禁。
- 冲突优先级：红线 > 硬门禁 > 任务目标 > 项目惯例。hooks 是权威，skill 文本不能覆盖 hook 结果。

## 路由：用哪个 skill

| 触发 | skill | 何时 |
|---|---|---|
| 项目初始化 | `sdlc-setup` | 为当前项目建生命周期状态 |
| 流程答疑 / 讲解 | `sdlc-ask` | 「现在该做什么 / 为什么被拦 / 某 skill 怎么用」 |
| 需求 / 设计 / 待确认 | `sdlc-design` | 需求理解、概要/详细设计 |
| 写代码 | `sdlc-implement` | 在施工边界内编码 + 留痕 |
| 验证 | `sdlc-test` | 验证本次改动风险面 |
| 排查 | `sdlc-debug` | 复现、定位、修复、回归 |
| 小任务 | `sdlc-solo` | 边界清晰 ≤3 天、可自动决策 |
| 固化流程 | `sdlc-flow` | 把口语流程沉淀进项目 registry |

不确定就先 `status` 看 `nextAction`，按它走。

## 首要动作

进任一阶段前先取状态（**不要**先通读历史任务文档）：

```bash
sdlc-hook status   # = node "<RUNTIME_ROOT>/hooks/sdlc/bin/sdlc-hook.mjs" status；路径见 SessionStart「运行时」行或 status.runtimeRoot
```

只读 status 的 `recommendedReads` 与 `docs/_sdlc/current.json`；当前文件回答不了下一步时才扩大检索。能从代码、目录、依赖一眼看出的事实不写进新文档，也不反复检索。

## 仪式吸收进 skill

阶段 skill 自调 `phase.set`；你和用户**永不手敲** phase.enter/exit。开局只 `init` 轻声明一次（或用 `sdlc-setup`）：

```bash
sdlc-hook init --task-dir docs/[task] --system [system] --profile lite|standard|full
sdlc-hook phase.set --phase implement
```

## 工具编排：抽象步骤 + registry

阶段 skill 只提**抽象步骤**（`collect-context` / `locate-code` / `deep-think` / `plan-tasks` / `query-db` / `web-search` / `run-tests`）；具体工具链（优先 → 降级）由 registry 解析，项目可覆盖：

```bash
sdlc-hook step locate-code     # 取该抽象步骤的工具链
sdlc-hook registry show        # 看项目的有效流程
```

换工具只改 registry、不改 skill。把项目口语流程沉淀成 registry → `sdlc-flow`。

## 共享语义 / 产物策略 / 答疑

`profile` 含义、`activeTaskDir`、待确认标记、`onlyAI/`、SQL 放置、产物与模板策略等讲解 → 见 `sdlc-ask`（只读讲解前门）。模板在 `skills/software-dev-process/assets/`（**勿改模板本身**）。
