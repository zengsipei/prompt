# ADR-0001：SDLC 重写为「hooks 守边界 + skill 带流程 + registry 编排工具」

- 状态：已采纳
- 日期：2026-06-21
- 范围：`hooks/sdlc/`、`skills/`、`.codex/AGENTS.md`、插件清单。`apps/`（dashboard）未在本次对齐，作为后续工作。

## Context

旧 SDLC 是「单体 skill + 散文 `AGENTS.md` + 强顺序门禁 hooks」。两个痛点：**硬墙太硬**（强顺序门禁不让边设计边写原型、不让跳级）与**仪式太重**（手动 init / phase.enter / phase.exit / 手维护 allowedPaths）。`.codex/AGENTS.md` 还把整套四阶段流程、工具表、开发哲学重复了一遍，与 skill 形成双份真相源。

## Decision

**按「关心」拆分权威——边界硬、流程软。**

1. **硬 / 软矩阵**（`core/context.mjs` 的 `GATE_MATRIX` + `core/rules.mjs`）：
   - 硬（block，不降级）：内置红线（删核心配置 / SQL `DROP`·`ALTER COLUMN` / push 主分支，见 `core/redlines.mjs`）、待确认文档、施工边界 `allowedPaths`、**项目声明的前置门禁**。
   - 软（warn + 留痕，按 profile 分档）：默认阶段顺序、设计期改源码、Stop 完整度。
2. **阶段合并**：design-1 + design-2 → 单一 `design`。阶段枚举 `design / implement / test / debug`。
3. **施工边界声明自动化**：`scope.infer` 从 `git diff` 播种 `allowedPaths`；未声明任何边界时退化为只提示。边界硬、声明软。
4. **工具编排 registry**（`core/registry.mjs` + `registry/default.json`）：抽象步骤 → 有序工具链（优先 → 降级），内置默认可被 `docs/_sdlc/registry.json` 覆盖。工具「选哪个」是软推荐；「这一步必须发生」可被项目声明为硬前置门禁（`phasePreconditions`，按产物存在与否硬拦）。`sdlc-flow` skill 把口语流程沉淀进项目 registry。
5. **skill 按阶段拆 + 路由**：`software-dev-process` 瘦身为路由 + 共享语义；`sdlc-design/implement/test/debug/solo/flow` 各自单一职责。仪式吸收进 skill（自调 `phase.set`）。
6. **双端薄 bootstrap**：`hooks/sdlc/bootstrap.md`（平台中性，SessionStart 注入两端）+ 瘦身后的 `.codex/AGENTS.md`，只保留角色 + 红线 + 约束优先级 + 路由索引 + 工具降级总则。流程 / 哲学 / 工具表下沉到 skills 与 registry。

统一原则：**流程序列软；声明的必做动作硬；工具选哪个软，但「这一步必须发生」可被项目声明为硬。**

## Consequences

- 可边设计边写原型、可跳级；返工别扭消除。
- 破坏性操作首次获得真正的 hook 硬拦（旧 `rules.mjs` 只在散文里写、未实现）。
- 项目能通过对话把专属流程（如「implement 前 codegraph 检索待改部分」）沉淀为可查看可复用、且硬拦的门禁。
- `apps/sdlc-dashboard` 仍按旧 design-1/design-2 阶段键渲染，completion 显示会错位，需后续对齐。
- `.codex/AGENTS_*.md` 6 个历史变体归档到 `.codex/archive/`，选定 `AGENTS.md` 为 SSOT。
