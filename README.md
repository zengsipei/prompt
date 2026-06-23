# AI 辅助开发工作流

这个仓库是 `yuki` marketplace。实际插件在 `plugins/sdlc/`，用于把 hooks-first 的 SDLC runtime 安装到用户级环境；业务项目状态只写入业务项目自己的 `docs/_sdlc/` 和任务目录。

## 安装

把 `<repo-url>` 替换成当前仓库地址。不要在文档里绑定某个 fork，agent 应优先从当前 remote 或用户给的链接推断。

Codex:

```powershell
codex plugin marketplace add <repo-url>
codex plugin add sdlc@yuki
```

Claude Code:

```powershell
claude plugin marketplace add <repo-url>
claude plugin install sdlc@yuki
```

安装后，按平台提示完成信任/启用 hooks。之后在业务项目中使用 `/sdlc-setup` 初始化项目级生命周期状态。

## 结构

```text
.agents/plugins/marketplace.json   # Codex marketplace: yuki
.claude-plugin/marketplace.json    # Claude Code marketplace: yuki
plugins/sdlc/.codex-plugin/        # Codex plugin manifest
plugins/sdlc/.claude-plugin/       # Claude Code plugin manifest
plugins/sdlc/skills/               # SDLC skills
plugins/sdlc/hooks/                # Platform hooks and SDLC runtime
plugins/sdlc/README.md             # Runtime usage and development notes
```

全局只安装 plugin/runtime。项目级状态、hook 事件和任务文档留在业务项目，不写入 marketplace 或 plugin cache。
