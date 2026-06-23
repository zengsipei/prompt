---
name: sdlc-setup
description: 初始化当前项目的 SDLC 生命周期状态；要求 sdlc plugin 已通过 marketplace 用户级安装。
---

# sdlc-setup

把当前业务项目接入这套「边界硬、流程软」的 SDLC。plugin/runtime 必须已经用户级安装；本 skill 只写项目级状态，不安装或复制全局 skills/hooks。

**状态边界**：

- 用户级：plugin/runtime，随 Codex / Claude Code plugin cache 管理。
- 项目级：`docs/_sdlc/current.json`、`docs/_sdlc/hook-events.ndjson`、任务目录。

**幂等**：已初始化则先读取现状并报告，不覆盖既有任务状态，除非用户明确要求重建或切换任务。

## 约定

下文 `sdlc-hook` = `node "<RUNTIME_ROOT>/hooks/sdlc/bin/sdlc-hook.mjs"`。`RUNTIME_ROOT` 取自 SessionStart 注入的「运行时」行，或 `sdlc-hook status` 输出的 `runtimeRoot`（runtime 自解析所在目录，不随项目变）。

## Step 1 · 检测项目状态

1. 读取 `docs/_sdlc/current.json` 是否存在。
2. 若存在，先执行 `sdlc-hook status`，把 `activeTaskDir`、`phase`、`profile`、`nextAction` 告诉用户。
3. 若不存在，继续 Step 2。

不要检测或改写 `~/.claude/`、`~/.codex/`、`~/.agents/plugins/`；这些属于 marketplace/plugin 安装层。

## Step 2 · 项目初始化

与用户敲定缺失参数：

- `task-dir`：如 `docs/login-fix`
- `system`：归属系统名
- `profile`：`lite` 低风险小改 / `standard` 默认 / `full` 完整

执行：

```bash
sdlc-hook init --task-dir docs/[task] --system [system] --profile lite|standard|full
```

推荐默认：

- 小范围、1-3 个文件、0.5 天内：`profile lite`
- 一般功能或小重构：`profile standard`
- 跨模块、数据模型、安全权限、外部接口：`profile full`

## Step 3 · 可选项目流程

要把项目专属流程/硬前置（如「implement 前必须 codegraph 检索」）固化进 `docs/_sdlc/registry.json`，转 `sdlc-flow`；否则走内置默认。

## Step 4 · docs 纳管

问用户 跟踪 / 忽略 / 部分。**推荐部分**：人写文档（设计/测试/ADR）进 git，运行时态 `docs/_sdlc/`（`current.json`/`hook-events.ndjson`）写入 `.gitignore` 忽略。

## Step 5 · 冒烟验证

```bash
sdlc-hook status
```

确认 `runtimeRoot` 指向已安装 plugin/runtime，`nextAction` 合理。把结果告诉用户。

## 重跑 / 解除

- 重跑：安全，已初始化时只报告当前状态。
- 切换任务：用户明确要求后重新运行 `init` 指向新的 `task-dir`。
- 解除：删除当前项目的 `docs/_sdlc/` 即解除该仓生命周期状态；不要删除用户级 plugin。
