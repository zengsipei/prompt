---
name: sdlc-setup
description: 初始化 / 安装本项目 SDLC——全局装 skills + hooks（Claude 与 Codex 双端）与/或为当前项目建生命周期状态。用户提到 sdlc-setup、要安装/配置/初始化这套 SDLC、首次在某项目启用本流程时使用。幂等，可重跑。
---

# sdlc-setup

把这套「边界硬、流程软」的 SDLC 装好并接通。两件独立的事，按检测结果只做缺的那部分：

- **A. 全局安装**（每台机器一次）：skills + hooks 进 `~/.claude/`（和 Codex 用户配置）。
- **B. 项目初始化**（每个仓库一次）：建 `docs/_sdlc/` 生命周期状态。

**幂等**：每步先检测，已就位就跳过；重跑不破坏既有配置。合并而非覆盖用户的 `settings.json`。

## 约定

下文 `sdlc-hook` = `node "<RUNTIME_ROOT>/hooks/sdlc/bin/sdlc-hook.mjs"`。`RUNTIME_ROOT` 取自 SessionStart 注入的「运行时」行，或 `sdlc-hook status` 输出的 `runtimeRoot`（runtime 自解析所在目录，不随项目变）。

## Step 1 · 检测现状

1. 全局 skills：`~/.claude/skills/` 下是否有 `sdlc-*`、`software-dev-process`（缺 → 需 A）。
2. 全局 hooks：`~/.claude/settings.json` 的 `hooks` 是否已含 SDLC 条目（缺 → 需 A）。
3. Codex：用户 Codex 配置（随版本，通常 `~/.codex/config.toml`）`[hooks]` 是否已含 SDLC（双端用户才需要）。
4. 项目：当前仓 `docs/_sdlc/current.json` 是否存在（缺 → 需 B）。

把结论告诉用户，只对缺的部分往下做。

## Step 2 · 全局安装（A，缺则做）

先问安装方式（影响是否随本仓更新自动生效）：

- **软链回本仓**（维护者推荐）：`~/.claude/skills/<name>` 符号链接到 `RUNTIME_ROOT/skills/<name>`；hooks 指向 `RUNTIME_ROOT/hooks/sdlc/...`。改本仓即时生效。Windows 建符号链接需开发者模式或管理员。
- **拷贝快照**：把 `skills/` 与运行时拷进 `~/.claude/`；稳定、与本仓解耦，更新需重跑 `sdlc-setup --update`。

然后：

1. **skills**：把 9 个（`sdlc-setup`、`sdlc-ask`、`software-dev-process`、`sdlc-design/implement/test/debug/solo/flow`）软链或拷到 `~/.claude/skills/`。
2. **Claude hooks**：以 `RUNTIME_ROOT/hooks/sdlc/manifests/claude.settings.example.json` 为模板，把其中 `<RUNTIME_ROOT>` 全部替换为绝对 `RUNTIME_ROOT`，再**深合并**进 `~/.claude/settings.json` 的 `hooks`（保留用户已有 hook，按事件追加，勿整体覆盖）。命令入口是 `claude-hook.mjs`。
3. **Codex 端**（双端用户）：把 `manifests/codex.config.example.toml` 的 `[hooks]` 条目（`<RUNTIME_ROOT>` 同样替换）合并进 Codex 用户配置。bootstrap 经 `codex-hook.mjs` 的 `sessionStart` 注入，与 Claude 同源。

> 注：插件方式安装时无需本步——`.claude-plugin/plugin.json` 经 `${CLAUDE_PLUGIN_ROOT}` 自动接 `plugin-hook.mjs`。`sdlc-setup` 面向自用全局安装。

## Step 3 · 项目初始化（B，缺则做）

1. 与用户敲定：`task-dir`（如 `docs/login-fix`）、`system`（归属系统名）、`profile`（`lite` 低风险小改 / `standard` 默认 / `full` 完整）。
2. 执行 init（写 `current.json`，含自解析的 `runtimeRoot`）：
   ```bash
   sdlc-hook init --task-dir docs/[task] --system [system] --profile lite|standard|full
   ```
3. **既定流程**（可选）：要把项目专属流程/硬前置（如「implement 前必须 codegraph 检索」）固化进 `docs/_sdlc/registry.json`，转 `sdlc-flow`；否则走内置默认。
4. **docs 纳管**：问用户 跟踪 / 忽略 / 部分。**推荐部分**——人写文档（设计/测试/ADR）进 git，运行时态 `docs/_sdlc/`（`current.json`/`hook-events.ndjson`）写入 `.gitignore` 忽略。

## Step 4 · 冒烟验证

```bash
sdlc-hook status
```

确认 `runtimeRoot` 指向真实运行时、`nextAction` 合理。再开一个新会话确认 SessionStart 注入了 bootstrap + 运行时行 + 路由索引。把结果告诉用户。

## 重跑 / 更新 / 卸载

- 重跑：安全，已就位的步骤跳过。
- `--update`：拷贝安装时用，从本仓刷新 `~/.claude/` 下的 skills 与运行时。
- 卸载：删 `~/.claude/skills/sdlc-*` 等链接/副本，并从 `~/.claude/settings.json`（及 Codex 配置）移除 SDLC hook 条目。项目内删 `docs/_sdlc/` 即解除该仓的生命周期。
