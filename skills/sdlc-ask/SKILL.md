---
name: sdlc-ask
description: SDLC 答疑：用户问下一步、拦截原因、阶段产物、skill 用法或 profile 时使用；只读。
---

# sdlc-ask

这套 SDLC 的**讲解与向导**前门。面向「还不熟这套流程」的人，把当前状态、规则、下一步说清楚，并指到该用的 skill。

## 契约：只读

**只解释、只引导。绝不**修改 `docs/_sdlc/` 状态、绝不 `phase.set`/`init`/`scope.infer`、绝不替用户做有门禁的动作，更不教人绕过边界。要动手，引导用户去对应阶段 skill。

## 回答前先看状态

```bash
sdlc-hook status
```
（`sdlc-hook` = `node "<RUNTIME_ROOT>/hooks/sdlc/bin/sdlc-hook.mjs"`，路径见 SessionStart 注入的「运行时」行或 status 的 `runtimeRoot`。）

`status` 给出 `nextAction`（下一步）、`blockingReasons`（被什么挡）、`phasePreconditions`（未满足的硬前置）、`allowedPaths`（当前施工边界）、`recommendedReads`（该读哪些）。基于它回答，别凭空猜。

## 常见问题怎么答

- **现在该做什么？** → 念 `status.nextAction`；阶段不清就按路由索引指 skill。
- **为什么被拦 / 报错？** → 对照拦截来源解释，并给满足条件的最短路径：
  - 红线（删核心配置 / SQL `DROP`·`ALTER COLUMN` / push 主分支）→ 恒拦，需用户显式确认改方案。
  - 待确认文档未处理 → 回 `sdlc-design` 把文档标「状态：已处理 / 决策状态：已决策」。
  - 项目前置门禁未满足 → 先产出 `phasePreconditions` 要求的产物（如 codegraph 检索结果）。
  - 施工越界 → 把文件纳入 `allowedPaths`（`sdlc-implement` 里 `scope.infer` 自动播种）。
- **某 skill 怎么用 / 进哪个？** → 见下「路由」；说明该 skill 何时用、产出什么。
- **手动跑命令？** → 给展开后的 `sdlc-hook ...`；提醒仪式（phase.set）已吸收进阶段 skill，通常不必手敲。

## 路由：用哪个阶段 skill

| 触发 | skill | 何时 |
|---|---|---|
| 安装/初始化 | `sdlc-setup` | 全局装 skills+hooks、或为项目建生命周期状态 |
| 需求/设计/待确认 | `sdlc-design` | 需求理解、概要/详细设计 |
| 写代码 | `sdlc-implement` | 在施工边界内编码 + 留痕 |
| 验证 | `sdlc-test` | 验证本次改动风险面 |
| 排查 | `sdlc-debug` | 复现、定位、修复、回归 |
| 小任务 | `sdlc-solo` | 边界清晰 ≤3 天、可自动决策 |
| 固化流程 | `sdlc-flow` | 把口语流程沉淀进项目 registry |
| 总览/不确定 | `software-dev-process` | 纯路由 |

## 不明显但重要的语义

- `current.json.activeTaskDir` 是当前任务根，后续 SDLC 文档默认落这里。
- `profile`：`lite`=0.5 天内低风险小改；`standard`=默认；`full`=完整阶段文档+测试报告+自审。profile 还调软门禁档位（`lite` 最松、`full` 最严）。
- `systemName` 是任务归属系统，后续索引与知识沉淀沿用，别临时改名。
- 待确认已处理的可识别标记：`状态：已处理` 或 `决策状态：已决策`。
- `onlyAI/` 是过程记录区（扫描、执行、验证、自审）；面向用户的正式结论不要只写在 `onlyAI/`。
- SQL 变更脚本放当前任务目录的 `sql/`，不散落到源码目录或聊天记录。

## 产物策略

只产出本阶段真实需要的文档，不为填满模板制造低价值章节。模板在 `skills/software-dev-process/assets/`（**勿改模板本身**）：`概要设计模板.md` / `详细设计模板.md` / `施工文档模板.md` / `文件改动记录模板.md` / `测试用例模板.md` / `测试报告模板.md` / `Debug排查记录模板.md` / `待确认模板.md`。

## 拱顶石：边界硬，流程软

流程顺序可偏离（hooks warn + 留痕）；声明的必做动作硬拦（hooks block，不降级）：内置红线、施工边界、待确认、项目经 registry 声明的前置门禁。冲突优先级：红线 > 硬门禁 > 任务目标 > 项目惯例。hooks 是权威，skill 文本不能覆盖 hook 结果。
