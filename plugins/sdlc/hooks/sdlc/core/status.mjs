import { toPosixPath, workspaceRoot } from "./context.mjs";
import { hookCommand } from "./runtime.mjs";
import {
  loadTaskPlan,
  pendingConfirmations,
  phaseCompletion,
  phasePreconditionEvidenceLabel,
  phasePreconditionsUnmet,
  preconditionStepCommand,
  requiredCapabilityName,
  sdlcProfile,
  taskPlanProgress,
} from "./artifacts.mjs";
import { SUCCESS_EVIDENCE_PHASES } from "./closure.mjs";
import { autoAdvanceNextPhaseFromState, isAutoAdvanceApplicable } from "./autoAdvance.mjs";

// 紧凑视图与关闭证据共用的诊断详情位置（详细 hook 诊断的 latest + 小滚动历史）。
export const DIAGNOSTICS_LOCATION = "docs/_sdlc/session-diagnostics.json";

// 默认阶段顺序（软建议）：design/implement/test 合并后的活动阶段序列。closed 不在其中。
const PHASE_ORDER = ["design", "implement", "test"];

// 下一步动作：full status 与紧凑 status 共用同一判定，杜绝两套 next-step 漂移。
// 证据驱动而非 phase 驱动——design/implement/test 证据齐全即建议 task.close（与 PRD 的关闭哲学一致），
// debug 激活时先提示显式 debug.close。
// 未满足的项目硬前置门禁优先于通用「补齐产物」文案：明确点名缺什么、下一步命令（#16）。
export function nextAction(state, completion, pending, root) {
  if (!state) {
    return "Initialize lifecycle with init --task-dir docs/[task] --system [system].";
  }

  if (pending.length > 0) {
    return `Resolve pending confirmation: ${pending.map((item) => item.name).join(", ")}.`;
  }

  // 未满足的 phase 硬前置门禁优先于「补齐当前阶段产物」：直接点名缺的证据/能力 + 下一步命令。
  const unmet = root ? phasePreconditionsUnmet(state, root, state.phase) : [];
  if (unmet.length > 0) {
    return unmet.map((item) => preconditionNextAction(item)).join(" ");
  }

  const evidenceReady = SUCCESS_EVIDENCE_PHASES.every((phase) => completion[phase]);
  if (evidenceReady) {
    if (state.debugActive) {
      return "完成证据齐全：先 `sdlc-hook debug.close --note <结论>` 关闭排查，再 `sdlc-hook task.close --reason completed` 收尾。";
    }
    return "完成证据齐全：运行 `sdlc-hook task.close --reason completed` 关闭任务（或交由 session.stop 兜底自动关闭）。";
  }

  if (!completion[state.phase]) {
    return `Complete required artifacts for phase ${state.phase}.`;
  }

  const currentIndex = PHASE_ORDER.indexOf(state.phase);
  if (currentIndex >= 0 && currentIndex < PHASE_ORDER.length - 1) {
    // auto-advance 已启用且当前满足严格闸门（可立即执行）时，优先推荐 auto.advance；
    // 否则保持既有 phase.set 手动引导（AC #9 / #11）。
    if (root && isAutoAdvanceApplicable(state, root)) {
      const target = autoAdvanceNextPhaseFromState(state, root);
      if (target) {
        return `运行 \`sdlc-hook auto.advance\` 自动推进到 ${target}（auto-advance 已启用且条件满足）。`;
      }
    }
    return `Enter next phase: ${PHASE_ORDER[currentIndex + 1]}.`;
  }

  return "Inspect current state and choose the next lifecycle command.";
}

// 单个未满足前置门禁的下一步文案：点名缺什么（证据路径 / 能力）+ 抽象步骤的查处命令（#16）。
// required-evidence 直接写明任务相对证据路径；required-capability 写明能力名；两者都给出 `step <name>`。
function preconditionNextAction(precondition) {
  const stepCommand = preconditionStepCommand(precondition);
  const stepHint = stepCommand ? `（${stepCommand}）` : "";

  if (precondition?.enforcement === "required-evidence") {
    const evidencePath =
      precondition.evidence && typeof precondition.evidence.path === "string"
        ? toPosixPath(precondition.evidence.path.trim())
        : "file";
    return `Provide required evidence ${evidencePath} before editing source.${stepHint}`;
  }

  const capability = requiredCapabilityName(precondition);
  return `Run required capability ${capability || "tool"} before editing source.${stepHint}`;
}

function mark(done) {
  return done ? "✓" : "✗";
}

// closed 终端态的精简视图：只告知「上一个任务已关闭 + 如何初始化新任务 + 诊断位置」，
// 刻意不复述完整 bootstrap / 活动任务门禁，避免 resume 把已关闭任务误当活动任务（PRD 核心风险）。
function closedShortMessage(state) {
  const last = state?.lastTask || null;
  const reason = last?.reason ? `（${last.reason}）` : "";
  const lastDir = last?.dir || "上一个任务";
  return [
    `SDLC：上一个任务已关闭${reason}：${lastDir}。当前无活动任务（idle/closed）。`,
    "开始新任务：`sdlc-hook init --task-dir docs/[task] --system [system] --profile lite|standard|full`。",
    `运行时：把 \`sdlc-hook\` 展开为 ${hookCommand()}`,
    `详情：${DIAGNOSTICS_LOCATION}（全局红线仍生效；任务门禁在 init 新任务后恢复）。`,
  ].join("\n");
}

// 紧凑人读视图（≤4 行）：任务/关闭状态 + 下一步 + 紧凑计数 + 诊断位置。
// 既是 `status --short` 的输出，也是 SessionStart / UserPromptSubmit 注入的同一份精简文本，
// 取代旧的长 bootstrap / 长 prompt guidance，降低上下文开销（PRD AC：注入默认 ≤4 行）。
export function shortStatusMessage(state, root = workspaceRoot()) {
  if (!state) {
    return [
      "SDLC：当前目录未初始化生命周期。",
      "初始化：`sdlc-hook init --task-dir docs/[task] --system [system] --profile lite|standard|full`。",
      `运行时：把 \`sdlc-hook\` 展开为 ${hookCommand()}`,
      `详情：${DIAGNOSTICS_LOCATION}`,
    ].join("\n");
  }

  if (state.phase === "closed") {
    return closedShortMessage(state);
  }

  const completion = phaseCompletion(state, root);
  const pending = pendingConfirmations(state, root);
  const progress = taskPlanProgress(loadTaskPlan(state, root));
  const debugFlag = state.debugActive ? "｜debug active" : "";
  const step = state.debugActive
    ? `先 \`sdlc-hook debug.close --note <结论>\` 关闭排查；${nextAction(state, completion, pending, root)}`
    : nextAction(state, completion, pending, root);

  return [
    `SDLC｜任务 ${state.activeTaskDir || "未设置"}｜阶段 ${state.phase || "未设置"}${debugFlag}｜profile ${sdlcProfile(state)}`,
    `下一步：${step}`,
    `进度：design${mark(completion.design)} implement${mark(completion.implement)} test${mark(completion.test)}｜任务 ${progress.completed}/${progress.total}｜待确认 ${pending.length}`,
    `详情 ${DIAGNOSTICS_LOCATION}｜运行时 sdlc-hook = ${hookCommand()}`,
  ].join("\n");
}
