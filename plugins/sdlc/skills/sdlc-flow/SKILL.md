---
name: sdlc-flow
description: SDLC registry：用户要固化或查看项目流程/工具约定时使用，如「X 前必须 Y」「定位代码用 codegraph」。
---

# sdlc-flow

把用户口语描述的项目流程，沉淀成 `docs/_sdlc/registry.json`（项目覆盖），让各种工具编排进 SDLC，且**可查看、可复用**。

## 何时

用户描述项目专属流程或工具约定时——「当前项目先做 X 再做 Y」「implement 前必须先检索待改部分」「定位代码优先用 codegraph」。

## 步骤

1. **听清意图**，归入三类：
   - **工具绑定**（软）：某抽象步骤优先用哪个工具 + 降级链 → 写 `steps[<step>].tools`。
   - **顺序**（软）：阶段/步骤的建议先后 → 写 `order`。
   - **硬前置门禁**（硬）：「某阶段前必须做某步」→ 写 `phasePreconditions[<phase>]`，每项声明 `enforcement: "required-evidence"` 与 `evidence`。当前支持文件证据：`{ "type": "file", "path": "onlyAI/locate-code.md" }`，路径相对当前任务目录；hooks 据文件是否存在且去除空白后非空，在该阶段的源码编辑处**硬拦**。
2. **对齐抽象步骤名**：内置集 `collect-context / locate-code / deep-think / plan-tasks / query-db / web-search / run-tests`；没有合适的可新增。
3. **写入** `docs/_sdlc/registry.json`：与内置 default 深合并——`steps`/`phasePreconditions` 按键覆盖，`order` 整体替换。
4. **回读确认**：`sdlc-hook registry show` 打印有效流程给用户核对。

## 例：「implement 前用 codegraph 检索待改部分」

```json
{
  "steps": {
    "locate-code": {
      "tools": [{ "name": "codegraph" }, { "name": "grep/glob/read", "note": "降级" }]
    }
  },
  "phasePreconditions": {
    "implement": [
      {
        "step": "locate-code",
        "enforcement": "required-evidence",
        "evidence": { "type": "file", "path": "onlyAI/locate-code.md" },
        "reason": "codegraph 检索待修改部分"
      }
    ]
  }
}
```

工具「选哪个」是软推荐（codegraph 优先、可降级）；「这一步必须发生」是硬门禁——缺 `onlyAI/locate-code.md` 或文件只有空白时 implement 的源码编辑被 block。这正是「流程序列软、声明的必做动作硬」。
