# AI 辅助开发工作流

这是一个 hooks-first 的 SDLC 流程运行时。目标是把少数硬约束交给用户级插件里的 hooks 执行，把具体业务项目过程记录留在业务项目自己的 `docs/_sdlc` 和 `docs/[task]` 中。

## 安装模型

推荐 **用户级安装 plugin/runtime，项目级保存状态**。安装入口在仓库根目录的 marketplace manifest 中；本目录是实际 plugin root。

- 用户级：安装本插件，保存 `skills/`、平台专用 hook 配置和 `hooks/sdlc/` runtime。
- 项目级：只生成 `docs/_sdlc/current.json`、`docs/_sdlc/hook-events.ndjson` 和任务目录。
- 不建议每个项目复制一份 `hooks/sdlc/`，否则流程规则会在项目之间漂移。

未初始化的项目（没有 `docs/_sdlc/current.json`）不会被 SDLC 管理：全局 hooks 即使被平台触发，也直接 no-op，不注入上下文、不拦截工具、不写事件。项目调用 `sdlc-setup` / `sdlc-hook init` 后，hooks 才按该项目状态开始验证。

本插件结构同时兼容 Codex 和 Claude Code：

```text
.codex-plugin/plugin.json     # Codex 插件入口
.claude-plugin/plugin.json    # Claude Code 插件入口
skills/                       # 平台共享 skills
hooks/codex-hooks.json        # Codex 插件 hook 入口
hooks/claude-hooks.json       # Claude Code 插件 hook 入口
hooks/sdlc/                   # SDLC runtime
```

`.codex-plugin/plugin.json` 和 `.claude-plugin/plugin.json` 分别通过 `hooks` 字段指向自己的 hook 配置文件。两个 hook 配置都调用 `hooks/sdlc/bin/plugin-hook.mjs`，再由它分发到对应平台 adapter，业务项目不需要复制 runtime。

手动或旧配置接入时，用户级 hook 命令仍可使用绝对 runtime 路径，例如：

```bash
node <RUNTIME_ROOT>/hooks/sdlc/bin/sdlc-hook.mjs status
node <RUNTIME_ROOT>/hooks/sdlc/bin/sdlc-hook.mjs init --task-dir docs/login-fix --system 用户中心 --profile standard
```

`<RUNTIME_ROOT>` 是 runtime 所在目录（本插件目录或装到用户目录的副本）。runtime 从自身位置自解析该路径，hook 报错、`help`、skill 命令拿到的都是已解析的真实路径，`status` 的 `runtimeRoot` 也会打印它，通常不必手填。命令工作目录应为当前业务项目根，也可用 `SDLC_WORKSPACE` 显式指定。

平台接入示例：

- Codex: `hooks/sdlc/manifests/codex.config.example.toml`
- Claude Code: `hooks/sdlc/manifests/claude.settings.example.json`

hook 事件源文件是 `hooks/sdlc/manifests/sdlc-hooks.json`。修改事件名、matcher 或 enabled / implemented 状态后运行：

```bash
node hooks/sdlc/bin/generate-hook-configs.mjs
```

该命令会生成 `hooks/codex-hooks.json`、`hooks/claude-hooks.json` 和两个平台示例配置；测试会检查这些生成物是否与中性 manifest 漂移。

## 硬约束

项目初始化后，这些规则默认由 hooks 执行，不依赖 agent 自觉：

- 待确认文档未处理时阻断源文件编辑和阶段切换。
- 实现阶段只允许修改 `onlyAI/task-plan.json` 或施工文档列出的路径，以及生命周期文档。

设计阶段源码编辑是软约束：`lite` 静默放行，`standard` / `full` warn + 留痕，允许边设计边写原型；正式施工进入 `implement` 后再由施工边界硬拦。

查看当前状态：

```bash
node <RUNTIME_ROOT>/hooks/sdlc/bin/sdlc-hook.mjs status
```

`status` 会返回：

- `nextAction`
- `blockingReasons`
- `requiredArtifacts`
- `recommendedReads`
- `allowedPaths`

agent 应优先使用这些字段，避免反复检索历史文档。

> **`completion.*` 是「产物完成」而非「阶段推进」**：`completion.design` / `completion.implement` / `completion.test` 只表示对应**产物**对当前任务目录与 profile 已存在/通过（例如 `003-文件改动记录.md`、`onlyAI/verification.md` 齐备），**不代表当前切片已正式进入或完成该阶段**。因此 `phase=implement` 但 `completion.test=true`（任务目录里早已有测试报告）时，`nextAction` 仍可能建议「进入 test」——这是基于产物完整度的下一步建议，与当前所在阶段并不矛盾。要看「我现在卡在哪」，以 `state.phase` 为准；要看「还差哪些产物」，看 `completion.*` 与 `blockingReasons`。`status` 还会在 `phasePreconditions` 列出未满足的硬前置门禁，未满足时 `nextAction` / `blockingReasons` 会直接点名缺什么（含任务相对证据路径）与下一步命令。

## 风险档位

`profile` 控制必需产物和软门禁力度，不改变红线、待确认、项目前置门禁、implement 施工边界等硬约束。

| 档位 | 适用场景 | 必需产物 |
| --- | --- | --- |
| `lite` | 0.5 天内、1-3 个文件、无 DB/权限/外部接口/架构风险 | `current.json`、`onlyAI/task-plan.json`、`onlyAI/verification.md` 或 `summary.md` |
| `standard` | 一般功能、小型重构、影响面明确 | `001-概要设计.md`、`onlyAI/task-plan.json`、`003-文件改动记录.md`、`onlyAI/verification.md` |
| `full` | 跨模块、数据模型、安全权限、外部依赖、高风险上线 | 完整设计、施工、测试、报告和自审文档 |

初始化时选择：

```bash
node <RUNTIME_ROOT>/hooks/sdlc/bin/sdlc-hook.mjs init --task-dir docs/login-fix --system 用户中心 --profile lite
```

默认是 `standard`。

## 机器可读施工边界

优先使用 `docs/[task]/onlyAI/task-plan.json`：

```json
{
  "allowedPaths": ["src/shared.ts"],
  "tasks": [
    {
      "id": "T-01",
      "status": "done",
      "allowedPaths": ["src/login.ts"],
      "verification": ["npm test"]
    }
  ]
}
```

Markdown 施工文档仍兼容，但只作为回退。`task-plan.json` 是 hooks 判断允许路径和任务完成度的首选来源。

## 待确认

待确认只用于用户必须承担取舍的情况，例如业务语义、外部依赖、权限/安全风险、不可逆数据模型选择。

不要因为“存在两个技术方案”就自动生成待确认；能从代码、配置、现有文档确认的，先查清楚。

待确认处理标记：

- `状态：已处理`
- `决策状态：已决策`

## 产物原则

- 不为了填模板制造低价值文档。
- 能从代码、目录、依赖、配置自然推断的内容不写。
- `onlyAI/` 用于过程记录；面向用户的结论放在任务目录正式文档或 `summary.md`。
- 施工记录默认写文件、意图、验证结果；只有 full 档或审计需要时再写行号范围。

## 测试

从本插件根目录运行：

```bash
node hooks/sdlc/tests/run-tests.mjs
```
