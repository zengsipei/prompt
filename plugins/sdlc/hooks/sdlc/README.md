# SDLC Hooks Runtime

This runtime makes the software development process enforceable without relying
on skill matching. Skills can still call the manual CLI, but lifecycle rules live
in `hooks/sdlc/core`.

## Architecture

```text
platform hook payload
  -> adapters/codex.mjs or adapters/claude-code.mjs
  -> core/rules.mjs
  -> docs/_sdlc/current.json + task artifacts
```

Install the marketplace repository once, then install the `sdlc` plugin from the
`yuki` marketplace. In source form, the plugin root is `plugins/sdlc/`; after
installation, the plugin cache contains the same platform entries and runtime:

```text
.codex-plugin/plugin.json
.claude-plugin/plugin.json
hooks/codex-hooks.json
hooks/claude-hooks.json
hooks/sdlc/
skills/
```

`.codex-plugin/plugin.json` and `.claude-plugin/plugin.json` point to their own
hook config files through the manifest `hooks` field. Both configs call
`hooks/sdlc/bin/plugin-hook.mjs` through the platform plugin root environment
variable, so business projects do not need to copy `hooks/sdlc/`. The project
only needs lifecycle state files under `docs/`.

Manual or unsupported platforms call the same core from the project root:

```bash
node <RUNTIME_ROOT>/hooks/sdlc/bin/sdlc-hook.mjs status
```

`<RUNTIME_ROOT>` self-resolves from the runtime's own on-disk location (dev repo /
installed plugin cache / plugin dir), so hook messages, `help`, and
`status.runtimeRoot` all emit the resolved absolute path. Use the `sdlc-setup`
skill only to initialize project-level lifecycle state after the plugin is
installed.

## State Contract

Repository state:

```text
docs/_sdlc/current.json
docs/_sdlc/hook-events.ndjson
docs/[task-dir]/onlyAI/hook-state.json
docs/[task-dir]/onlyAI/task-plan.json   # optional machine-readable plan
```

Minimal `current.json`:

```json
{
  "activeTaskDir": "docs/login-fix",
  "phase": "design",
  "mode": "enforce",
  "strict": true,
  "stopGate": "warn",
  "profile": "standard",
  "systemName": "用户中心"
}
```

Set `"stopGate": "block"` when the platform hook should block session stop for
an incomplete active phase. The default is `"warn"` to avoid blocking status
questions or planning-only turns.

`profile` controls required artifacts:

- `lite`: `current.json`, `onlyAI/task-plan.json`, and `onlyAI/verification.md` or `summary.md`.
- `standard`: `001-概要设计.md`, `onlyAI/task-plan.json`, `003-文件改动记录.md`, and `onlyAI/verification.md`.
- `full`: complete design, construction, test report, and review artifacts.

## Manual Commands

```bash
node <RUNTIME_ROOT>/hooks/sdlc/bin/sdlc-hook.mjs init --task-dir docs/login-fix --system 用户中心 --profile lite
node <RUNTIME_ROOT>/hooks/sdlc/bin/sdlc-hook.mjs status
node <RUNTIME_ROOT>/hooks/sdlc/bin/sdlc-hook.mjs phase.set --phase implement
node <RUNTIME_ROOT>/hooks/sdlc/bin/sdlc-hook.mjs scope.infer
node <RUNTIME_ROOT>/hooks/sdlc/bin/sdlc-hook.mjs registry show
node <RUNTIME_ROOT>/hooks/sdlc/bin/sdlc-hook.mjs step locate-code
node <RUNTIME_ROOT>/hooks/sdlc/bin/sdlc-hook.mjs tool.before --action fs.edit --path src/login.ts
node <RUNTIME_ROOT>/hooks/sdlc/bin/sdlc-hook.mjs session.stop --require-complete
```

Phases are `design / implement / test / debug` (former design-1/design-2 are merged into
`design`). Skills self-call `phase.set`; humans never type `phase.enter`/`phase.exit`.
`scope.infer` seeds the construction boundary from `git diff` into `onlyAI/task-plan.json`.

`status` returns both raw lifecycle state and agent guidance:

```json
{
  "nextAction": "Complete required artifacts for phase implement.",
  "blockingReasons": ["Current phase implement is incomplete."],
  "requiredArtifacts": [{ "path": "docs/task/003-文件改动记录.md", "exists": true }],
  "recommendedReads": ["docs/_sdlc/current.json", "docs/task/onlyAI/task-plan.json"],
  "allowedPaths": ["docs/_sdlc/*", "docs/task/*", "src/login.ts"]
}
```

Use `recommendedReads` before searching broadly. Use `allowedPaths` to avoid
guessing the current implementation boundary.

Prompt and compact hooks are advisory continuity hooks, not gates:

- `UserPromptSubmit` injects soft SDLC guidance and records the event for debugging.
- `PreCompact` saves `compactSummary` in `docs/[task-dir]/onlyAI/hook-state.json`.
- `PostCompact` re-injects the saved summary after compaction.

The compact summary includes the active task, phase, unmet preconditions, and
satisfied lifecycle capabilities. These hooks must not create PRDs, handoffs, or
task artifacts; hard enforcement remains in tool and stop hooks.

## Machine-readable Task Plan

When present, `docs/[task-dir]/onlyAI/task-plan.json` is the preferred source
for implementation boundaries and task completion. Markdown construction docs
remain supported as a fallback.

Minimal shape:

```json
{
  "allowedPaths": ["src/shared.ts"],
  "tasks": [
    {
      "id": "T-01",
      "status": "done",
      "allowedPaths": ["src/login.ts", "README.md"],
      "verification": ["npm test"]
    }
  ]
}
```

Task `status` values considered complete: `done`, `completed`, `complete`,
`[x]`, and `已完成`.

## Platform Wiring

- Codex plugin hook config: `hooks/codex-hooks.json`
- Claude Code plugin hook config: `hooks/claude-hooks.json`
- Codex example: `hooks/sdlc/manifests/codex.config.example.toml`
- Claude Code example: `hooks/sdlc/manifests/claude.settings.example.json`
- Neutral event manifest: `hooks/sdlc/manifests/sdlc-hooks.json`

`hooks/sdlc/manifests/sdlc-hooks.json` is the source of truth for hook events.
After changing event names, matchers, or enabled / implemented flags, regenerate
the derived platform files:

```bash
node hooks/sdlc/bin/generate-hook-configs.mjs
```

The generated outputs are `hooks/codex-hooks.json`, `hooks/claude-hooks.json`,
`hooks/sdlc/manifests/codex.config.example.toml`, and
`hooks/sdlc/manifests/claude.settings.example.json`. Tests fail if these files
drift from the neutral manifest.

The example manifests are for manual or legacy user-level hook wiring with an
absolute `<RUNTIME_ROOT>` path. The core rules do not depend on either
platform.

## Hard vs Soft（边界硬，流程软）

权威按「关心」拆分。**流程序列**可偏离（软）；**声明的必做动作**硬拦（block，不降级）。

硬（block）：

1. 内置红线（恒 block，最高优先级）：删 `package.json`/`tsconfig.json`、SQL `DROP`/`ALTER COLUMN`、`git push` 主分支。见 `core/redlines.mjs`。
2. 待确认文档未处理：冻结源码编辑。
3. 项目声明的前置门禁：`registry.phasePreconditions[phase]` 声明的 required-evidence 文件证据缺失或去除空白后为空，或 required-capability 尚未由当前阶段的成功工具调用满足时，冻结该阶段源码编辑。
4. 施工边界 `allowedPaths`（implement）：越界编辑按 profile block；**未声明任何边界时退化为 warn**。

软（warn + 留痕，按 profile 分档，见 `core/context.mjs` 的 `GATE_MATRIX`）：

- 默认阶段顺序（跳级 / 乱序）、设计期改源码、Stop 完整度。
- `lite` 最松（多为 off）、`standard` 默认、`full` 最严（Stop 可 block）。

`phase.set` 恒放行，只对跳级 / 未满足前置给软提示——仪式吸收进 skill。

## Registry（工具编排）

抽象步骤 → 有序工具链（优先 → 降级）。内置默认 `registry/default.json`，项目覆盖
`docs/_sdlc/registry.json`（深合并：`steps`/`phasePreconditions` 按键覆盖、`order` 整体替换）。

```json
{
  "steps": { "locate-code": { "tools": [{ "name": "codegraph" }, { "name": "grep/glob/read", "note": "降级" }] } },
  "phasePreconditions": {
    "implement": [
      {
        "step": "locate-code",
        "enforcement": "required-evidence",
        "evidence": { "type": "file", "path": "onlyAI/locate-code.md" },
        "reason": "codegraph 检索待修改部分"
      },
      {
        "step": "locate-code",
        "enforcement": "required-capability",
        "capability": "semantic code search",
        "tools": ["codegraph", "mcp__codegraph__search"],
        "reason": "必须先成功使用语义检索定位代码"
      }
    ]
  }
}
```

工具「选哪个」是软推荐（registry + 降级）；「这一步必须发生」可被项目声明为硬前置门禁
（支持 `required-evidence` 文件证据，以及 `required-capability` 成功工具调用；`tools` 是同一能力的工具名/平台名别名集合，不是降级链）。文件路径相对当前任务目录，且必须存在并有非空白内容。用 `sdlc-flow` skill
把口语流程沉淀进项目 registry，用 `registry show` 回看。
