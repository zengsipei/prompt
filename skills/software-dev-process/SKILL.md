---
name: software-dev-process
description: 仓库级 SDLC 的路由与共享语义。用户提到 sdlc-design / sdlc-implement / sdlc-test / sdlc-debug / sdlc-solo / sdlc-flow，或要求按本仓库 SDLC 推进、但不确定进哪个阶段时使用。
---

# Software Development Process（路由）

把开发拆成可独立触发的阶段 skill。本 skill 只做两件事：**路由**（该用哪个）+ 沉淀**所有阶段共享、不能靠直觉推断的语义**。各阶段的步骤在各自 skill 里。

## 拱顶石：边界硬，流程软

- **流程顺序可偏离**（软）：可跳级、可边设计边写原型；hooks 只 warn + 留痕。
- **声明的必做动作硬拦**（hooks block，不降级为建议）：内置红线、施工边界 `allowedPaths`、待确认文档、项目经 registry 声明的前置门禁。
- 冲突优先级：红线 > 硬门禁 > 任务目标 > 项目惯例。

## 路由：用哪个阶段 skill

| 触发词 | skill | 何时 |
|---|---|---|
| sdlc-design | `sdlc-design` | 需求理解、概要/详细设计、待确认 |
| sdlc-implement | `sdlc-implement` | 在施工边界内写代码 + 留痕 |
| sdlc-test | `sdlc-test` | 验证本次改动的风险面 |
| sdlc-debug | `sdlc-debug` | 复现、定位、修复、回归 |
| sdlc-solo | `sdlc-solo` | 边界清晰 ≤3 天、可自动决策的小任务 |
| sdlc-flow | `sdlc-flow` | 把口语流程沉淀为项目 registry（工具编排 + 硬前置） |

不确定就先看 `status` 的 `nextAction`，按它走。

## 首要动作

进入任一阶段前，先取状态（**不要**先通读历史任务文档）：

```bash
node <SDLC_RUNTIME>/hooks/sdlc/bin/sdlc-hook.mjs status
```

只读 status 的 `recommendedReads` 与 `docs/_sdlc/current.json`；当前文件回答不了下一步时，才扩大检索。能从代码、目录、依赖、配置一眼看出的事实不写进新文档，也不反复检索。

## Hooks 是权威

准入、施工边界、待确认、前置门禁都由 hooks 判定，skill 文本不能覆盖 hook 结果。被拒就满足拒绝消息指出的条件，不要绕开边界改源文件。

## 仪式吸收进 skill

阶段 skill 自己调 `phase.set` 设阶段；你和用户**永不手敲** phase.enter/exit。开局只 `init` 轻声明一次（task dir / system / profile）：

```bash
node <SDLC_RUNTIME>/hooks/sdlc/bin/sdlc-hook.mjs init --task-dir docs/[task] --system [system] --profile lite|standard|full
node <SDLC_RUNTIME>/hooks/sdlc/bin/sdlc-hook.mjs phase.set --phase implement
```

## 工具编排：抽象步骤 + registry

阶段 skill 只提**抽象步骤**（`collect-context` / `locate-code` / `deep-think` / `plan-tasks` / `query-db` / `web-search` / `run-tests`）。具体工具链（优先→降级）由 registry 解析，内置默认可被项目覆盖：

```bash
node <SDLC_RUNTIME>/hooks/sdlc/bin/sdlc-hook.mjs step locate-code   # 取该抽象步骤的工具链
node <SDLC_RUNTIME>/hooks/sdlc/bin/sdlc-hook.mjs registry show       # 看项目的有效流程
```

换工具只改 registry、不改 skill。把项目口语流程沉淀成 registry → 用 `sdlc-flow`。

## 不明显但重要的语义

- `current.json` 的 `activeTaskDir` 是当前任务根，后续 SDLC 文档默认落在这里。
- `profile`：`lite`=0.5 天内低风险小改；`standard`=默认；`full`=完整阶段文档+测试报告+自审。profile 还调软门禁档位（lite 最松、full 最严）。
- `systemName` 是任务归属系统，后续索引与知识沉淀沿用，别临时改名。
- 待确认已处理的可识别标记：`状态：已处理` 或 `决策状态：已决策`。
- `onlyAI/` 是过程记录区（扫描、执行、验证、自审）；面向用户的正式结论不要只写在 `onlyAI/`。
- SQL 变更脚本放当前任务目录的 `sql/`，不散落到源码目录或聊天记录。

## 产物策略

只产出本阶段真实需要的文档，不为填满模板制造低价值章节。模板在 `skills/software-dev-process/assets/`（**勿改模板本身**）：

- `概要设计模板.md` / `详细设计模板.md` / `施工文档模板.md` / `文件改动记录模板.md`
- `测试用例模板.md` / `测试报告模板.md` / `Debug排查记录模板.md` / `待确认模板.md`
