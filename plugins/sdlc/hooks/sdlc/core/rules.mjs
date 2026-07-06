import { gateLevel, loadCurrentState, loadHookState, recordEvent, saveHookState, workspaceRoot } from "./context.mjs";
import {
  implementationAllowedPaths,
  loadTaskPlan,
  isAllowedImplementationPath,
  isLifecyclePath,
  pendingConfirmations,
  phaseCompletion,
  phasePreconditionEvidenceLabel,
  phasePreconditionsUnmet,
  preconditionStepCommand,
  recordRequiredCapabilityResult,
  sdlcProfile,
  taskPlanProgress,
} from "./artifacts.mjs";
import { allow, block, warn } from "./result.mjs";
import { detectRedline } from "./redlines.mjs";
import { currentSessionId, diagnosticsEntry, recordDiagnostics, recordInferredSessionName, startSession } from "./session.mjs";
import { completionEvidenceReady, performClose } from "./closure.mjs";
import { shortStatusMessage } from "./status.mjs";

const WRITE_ACTIONS = new Set(["fs.write", "fs.edit", "fs.delete"]);
const KNOWN_SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".sql",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
]);

// SessionStart 注入：默认改为与 `status --short` 同源的紧凑视图（≤4 行），
// 取代旧的长 bootstrap 复述，降低上下文开销（PRD AC：注入默认 ≤4 行）。
// closed 终端态、未初始化、活动任务的分支都由 shortStatusMessage 统一处理；
// 全局红线 / 施工边界 / 待确认仍由 tool / stop hook 硬强制，不依赖注入文本。
export function sessionContextMessage(state, root = workspaceRoot()) {
  return shortStatusMessage(state, root);
}

export function evaluate(event, options = {}) {
  const root = workspaceRoot(options);
  const state = options.state || loadCurrentState(root);
  const normalizedEvent = {
    targetPaths: [],
    ...event,
  };

  if (!state) {
    return allow("No SDLC lifecycle state; hook inactive.");
  }

  let result;
  switch (normalizedEvent.name) {
    case "session.start":
      // 每个执行会话起点都建立轻量会话记录（active-task 与 idle/closed 都建），
      // 后续事件据此归属。best-effort：telemetry 失败绝不阻断 hook 决策。
      try {
        startSession(root, state, normalizedEvent);
      } catch {
        // Session record is best-effort; never fail the hook on telemetry.
      }
      result = allow("Injected SDLC lifecycle context.", {
        additionalContext: sessionContextMessage(state, root),
      });
      break;
    case "prompt.submit":
      result = allow("Injected soft SDLC prompt guidance.", {
        additionalContext: promptGuidanceMessage(state, root),
      });
      break;
    case "tool.before":
      result = evaluateBeforeTool(normalizedEvent, state, root);
      break;
    case "tool.after":
      result = evaluateAfterTool(normalizedEvent, state, root);
      break;
    case "compact.before":
      result = evaluatePreCompact(state, root);
      break;
    case "compact.after":
      result = evaluatePostCompact(state, root);
      break;
    case "session.stop":
      result = evaluateStop(normalizedEvent, state, root, options);
      break;
    // 仪式吸收进 skill：phase.set 是新主入口；phase.enter 作为别名，均软化（恒放行 + 留痕）。
    case "phase.set":
    case "phase.enter":
      result = evaluatePhaseSet(normalizedEvent, state, root);
      break;
    case "phase.exit":
      result = allow(`Phase exit recorded: ${normalizedEvent.phase || state?.phase || "unknown"}.`);
      break;
    default:
      result = allow("No SDLC rule matched this event.");
  }

  if (shouldRecordEvent(normalizedEvent, state)) {
    try {
      const sessionId = normalizedEvent.sessionId || currentSessionId(root);
      // 事件流写紧凑摘要（含 sessionId 归属）；同一事件的完整长诊断分流到 session-diagnostics.json。
      recordEvent(normalizedEvent, result, root, sessionId);
      recordDiagnostics(root, diagnosticsEntry(normalizedEvent, result, sessionId));
    } catch {
      // Hook decisions must not fail just because telemetry cannot be written.
    }
  }

  if (state) {
    try {
      saveHookState(
        state,
        {
          phase: state.phase,
          activeTaskDir: state.activeTaskDir,
          lastEvent: normalizedEvent.name,
          lastDecision: result.decision,
          lastMessage: result.message || result.reason,
        },
        root,
      );
    } catch {
      // Ignore state persistence failures; the decision above is still valid.
    }
  }

  return result;
}

function evaluateAfterTool(event, state, root) {
  const recorded = recordRequiredCapabilityResult(state, root, event);
  if (!recorded) {
    return allow("Recorded SDLC hook event.");
  }

  if (recorded.status === "failed") {
    return allow("Recorded failed required capability tool call.");
  }

  return allow("Recorded satisfied required capability.");
}

function shouldRecordEvent(event, state) {
  if (event.name === "prompt.submit" || event.name === "compact.before" || event.name === "compact.after") {
    return true;
  }

  if (event.name !== "session.start") {
    return true;
  }

  return state?.recordSessionStart === true || isTruthyEnv(process.env.SDLC_RECORD_SESSION_START);
}

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/iu.test(String(value || "").trim());
}

function evaluateBeforeTool(event, state, root) {
  // 0) 红线优先于一切——破坏性操作恒 block，不看 phase / profile。
  const redline = detectRedline(event);
  if (redline) {
    return redline;
  }

  // 0.5) closed 终端态：红线之外不再施加任何任务专属门禁（pending / 项目前置 / 施工边界）。
  // 任务已关闭、activeTaskDir 为空，旧任务边界不应影响无关工作——红线之后即放行。
  if (state?.phase === "closed") {
    return allow("Closed lifecycle: task-specific SDLC gates inactive; global redlines still apply.");
  }

  if (!WRITE_ACTIONS.has(event.action) && event.action !== "command.exec") {
    return allow("Read-only or unknown-safe action.");
  }

  const paths = event.targetPaths || [];
  const profile = sdlcProfile(state);

  if (event.action === "command.exec") {
    return evaluateCommand(event, state, profile, root);
  }

  // 只有触及非生命周期文件（≈源码）才进入硬/软门禁；改任务文档恒放行。
  const touchesSource = paths.some((target) => !isLifecyclePath(target, state));
  if (!touchesSource) {
    return allow("Lifecycle document edit allowed.");
  }

  // 2) pending 待确认——硬拦（恒 block）。
  const pendingGate = evaluatePendingConfirmations(state, root, "源码编辑");
  if (pendingGate) {
    return pendingGate;
  }

  // 3) 项目声明的硬前置门禁（按当前阶段）——硬拦。流程灵活后，声明的必做动作不降级为建议。
  const preconditionGate = evaluatePhasePreconditions(state, root);
  if (preconditionGate) {
    return preconditionGate;
  }

  // 4) 施工边界——implement 阶段硬拦；声明集为空（典型 lite/solo 未声明）或 lite profile 退化为 warn。
  if (state.phase === "implement") {
    const illegal = paths.filter((target) => !isAllowedImplementationPath(target, state, root));
    if (illegal.length === 0) {
      return allow("Implementation edit within boundary.");
    }

    const declared = implementationAllowedPaths(state, root);
    const level = declared.size === 0 ? "warn" : gateLevel(profile, "boundary");
    const message = [
      "施工编辑超出已声明的施工边界。",
      `越界路径：${illegal.join(", ")}`,
      declared.size === 0
        ? "当前未声明任何边界：运行 scope.infer 从 git diff 自动播种，或在 003-施工文档.md / task-plan.json 列出。"
        : "把文件加入 task-plan.json / 003-施工文档.md 的 allowedPaths（可用 scope.infer 自动补），再重试。",
    ].join("\n");
    return level === "block" ? block(message) : warn(message);
  }

  // 5) 设计期改源码——软（按 profile：lite=off 放行，standard/full=warn 留痕）。允许边设计边写原型。
  if (state.phase === "design") {
    if (gateLevel(profile, "designSourceEdit") === "off") {
      return allow("Design-phase source edit allowed (lite).");
    }
    return warn(
      [
        `当前处于 design 阶段且在改源码：${paths.join(", ")}`,
        "允许边设计边写原型，但请随后补齐设计产物；正式施工请进入 implement 并声明边界。",
      ].join("\n"),
    );
  }

  // test / debug 阶段：放行源码编辑（验证与修复需要）。
  return allow("SDLC lifecycle checks passed.");
}

// UserPromptSubmit 注入：与 SessionStart 同源的紧凑视图（≤4 行），取代旧的多行 prompt guidance。
// 仅作上下文延续；硬强制仍由 tool / stop hook 负责。
export function promptGuidanceMessage(state, root = workspaceRoot()) {
  return shortStatusMessage(state, root);
}

function evaluatePreCompact(state, root) {
  const summary = sdlcRuntimeSummary(state, root);
  saveHookState(state, { compactSummary: summary }, root);

  return allow("Saved SDLC runtime summary for compaction.", {
    additionalContext: compactSummaryMessage(summary),
  });
}

function evaluatePostCompact(state, root) {
  const hookState = loadHookState(state, root);
  const summary = isRuntimeSummary(hookState.compactSummary)
    ? hookState.compactSummary
    : sdlcRuntimeSummary(state, root);

  return allow("Restored SDLC runtime summary after compaction.", {
    additionalContext: compactSummaryMessage(summary),
  });
}

export function sdlcRuntimeSummary(state, root = workspaceRoot()) {
  const completion = phaseCompletion(state, root);
  const pending = pendingConfirmations(state, root);
  const unmet = phasePreconditionsUnmet(state, root, state?.phase);
  const allowed = implementationAllowedPaths(state, root);
  const taskPlan = loadTaskPlan(state, root);
  const { total: taskCount, completed: completedTaskCount } = taskPlanProgress(taskPlan);

  const unmetPreconditions = [];
  if (pending.length > 0) {
    unmetPreconditions.push(`pending confirmations: ${pending.map((item) => item.name).join(", ")}`);
  }
  for (const item of unmet) {
    unmetPreconditions.push(phasePreconditionEvidenceLabel(item));
  }

  return {
    savedAt: new Date().toISOString(),
    activeTaskDir: state?.activeTaskDir || null,
    phase: state?.phase || null,
    profile: sdlcProfile(state),
    mode: state?.mode || null,
    unmetPreconditions,
    satisfiedCapabilities: satisfiedCapabilities(state, {
      completion,
      allowed,
      taskPlan,
      taskCount,
      completedTaskCount,
    }),
    completion,
    taskProgress: {
      total: taskCount,
      completed: completedTaskCount,
    },
  };
}

function satisfiedCapabilities(state, context) {
  const values = [];

  values.push("lifecycle-state");

  if (context.taskPlan) {
    values.push("machine-readable-task-plan");
  }

  if (context.allowed.size > 0) {
    values.push("implementation-boundary");
  }

  if (context.completion?.design) {
    values.push("design-complete");
  }

  if (context.completion?.implement) {
    values.push("implementation-complete");
  }

  if (context.completion?.test) {
    values.push("verification-complete");
  }

  return values;
}

function compactSummaryMessage(summary) {
  const unmet = summary.unmetPreconditions?.length
    ? summary.unmetPreconditions.join("; ")
    : "none detected";
  const capabilities = summary.satisfiedCapabilities?.length
    ? summary.satisfiedCapabilities.join(", ")
    : "none";

  return [
    "SDLC compact runtime summary:",
    `- Active task: ${summary.activeTaskDir || "unset"}`,
    `- Phase: ${summary.phase || "unset"}`,
    `- Profile: ${summary.profile || "standard"}`,
    `- Unmet preconditions: ${unmet}`,
    `- Satisfied capabilities: ${capabilities}`,
    `- Task progress: ${summary.taskProgress?.completed || 0}/${summary.taskProgress?.total || 0}`,
  ].join("\n");
}

function isRuntimeSummary(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "activeTaskDir" in value);
}

function evaluateCommand(event, state, profile, root) {
  const command = event.command || "";
  if (!looksWriteLikeCommand(command)) {
    return allow("Command does not look like a filesystem write.");
  }

  const paths = event.targetPaths || [];
  const sourceTargets = paths.filter((target) => !isLifecyclePath(target, state));

  if (sourceTargets.length > 0) {
    const pendingGate = evaluatePendingConfirmations(state, root, "源码写类命令");
    if (pendingGate) {
      return pendingGate;
    }

    const preconditionGate = evaluatePhasePreconditions(state, root);
    if (preconditionGate) {
      return preconditionGate;
    }
  }

  // 设计期的写类命令触及源码：软提示（不再 block，红线已在前面拦掉危险命令）。
  if (sourceTargets.length > 0 && state.phase === "design" && gateLevel(profile, "designSourceEdit") !== "off") {
    return warn(
      `design 阶段的写类命令触及源码：${sourceTargets.join(", ")}。允许，但建议尽快补齐设计产物或进入 implement。`,
    );
  }

  return allow("Write-like command passed SDLC checks.");
}

function evaluatePendingConfirmations(state, root, label) {
  const pending = pendingConfirmations(state, root);
  if (pending.length === 0) {
    return null;
  }

  return block(
    [
      `待确认文档未处理，${label}被硬拦。`,
      `待确认：${pending.map((item) => item.name).join(", ")}`,
      "先把待确认文档处理完（标记“状态：已处理”/“决策状态：已决策”），再重试。",
    ].join("\n"),
  );
}

function evaluatePhasePreconditions(state, root) {
  const unmet = phasePreconditionsUnmet(state, root, state.phase);
  if (unmet.length === 0) {
    return null;
  }

  return block(
    [
      `当前阶段 ${state.phase} 有项目声明的前置门禁未满足：`,
      ...unmet.map((item) => {
        const label = `需先提供 ${phasePreconditionEvidenceLabel(item)}${item.reason ? `（${item.reason}）` : ""}`;
        const stepCommand = preconditionStepCommand(item);
        const hint = stepCommand ? `\n下一步：${stepCommand}` : "";
        return `- ${label}${hint}`;
      }),
      "这是项目通过 registry 声明的硬约束，先完成前置动作再改源码。",
    ].join("\n"),
  );
}

// phase.set / phase.enter：恒放行（仪式吸收进 skill）。仅就“跳级”与“未满足前置”给软提示。
function evaluatePhaseSet(event, state, root) {
  const target = event.phase || state.phase;
  const messages = [];

  const order = ["design", "implement", "test"];
  const targetIndex = order.indexOf(target);
  if (targetIndex > 0) {
    const complete = phaseCompletion(state, root);
    const previous = order[targetIndex - 1];
    if (!complete[previous]) {
      messages.push(`提示：${previous} 阶段产物尚未完整即进入 ${target}（允许，留意补齐）。`);
    }
  }

  const unmet = phasePreconditionsUnmet(state, root, target);
  if (unmet.length > 0) {
    messages.push(
      `注意：${target} 有项目前置门禁未满足：${unmet.map(phasePreconditionEvidenceLabel).join(", ")}（改源码时会被硬拦）。`,
    );
  }

  return messages.length > 0 ? warn(messages.join("\n")) : allow(`Phase set: ${target}.`);
}

function evaluateStop(event, state, root, options = {}) {
  // closed 终端态：任务已关闭，无阶段完整度可评，stop 不再按旧任务门禁判定。
  if (state?.phase === "closed") {
    return allow("Closed lifecycle; no active task to stop-gate.");
  }

  // #14：每次 session.stop 都 best-effort 记录推断会话名（自动路径，平台 rename 失败静默）。
  // 在读完 state.phase 后、任何关闭动作前采集，命名反映 stop 时刻的阶段 / 任务信号；
  // 若随后兜底自动关闭，则把该名透传进关闭证据（performClose 的 sessionName 选项）。
  const { name: inferredSessionName } = recordInferredSessionName(state, root, "stop");

  const profile = sdlcProfile(state);
  const phase = event.phase || state.phase;
  const complete = phaseCompletion(state, root);
  const pending = pendingConfirmations(state, root);

  // 兜底自动关闭（fallback auto-close）：design/implement/test 完成证据齐全且无待确认时，
  // session.stop 自动以 completed 收尾。由完成证据驱动、与当前 phase 字符串无关（phase 即便不是
  // test 也可关闭，AC1/AC2）；绝不臆造 canceled/wontfix/superseded（非成功收尾只能显式 task.close）。
  if (state?.activeTaskDir) {
    const evidence = completionEvidenceReady(state, root, { completion: complete, pending });
    if (evidence.ready) {
      // debug 仍激活：不自动关闭，只给简短提示要求显式 debug.close（AC4）。stop 不硬拦，仅留痕提示。
      if (state.debugActive) {
        return warn(
          [
            "完成证据齐全，但 debug 仍处于激活态：session.stop 不自动关闭任务。",
            "先 `sdlc-hook debug.close --note <排查结论>` 显式关闭 debug，再 stop 即会自动收尾，",
            "或随后 `sdlc-hook task.close --reason completed` 手动收尾。",
          ].join("\n"),
        );
      }

      // 证据齐全且无 active debug：以 completed 自动收尾，写与显式 completed close 一致的关闭证据
      //（performClose 标记 trigger="session.stop" / autoClosed=true 以区分兜底来源，AC5）。
      const closed = performClose(state, root, {
        reason: "completed",
        note: "session.stop 兜底自动关闭：完成证据齐全且无待确认 / active debug。",
        completion: complete,
        pending,
        trigger: "session.stop",
        sessionName: inferredSessionName,
      });
      // 同步本地 state 至 closed/null：使 evaluate 末尾的 saveHookState 跳过已关闭任务的 hook-state 写入；
      // 全局事件审计（hook-events.ndjson / session-diagnostics.json）仍照常记录本次 stop。
      state.phase = "closed";
      state.activeTaskDir = null;
      return allow(
        [
          `session.stop 兜底自动关闭已完成任务：${closed.taskDir}（completed）。`,
          `最终关闭证据：${closed.closureRelPath}`,
          "生命周期进入 closed：无活动任务，旧任务门禁不再生效（全局红线仍在）。",
        ].join("\n"),
        {
          autoClosed: true,
          closeReason: "completed",
          completed: true,
          lastTask: closed.nextState.lastTask,
          closureEvidence: closed.closureRelPath,
        },
      );
    }
  }

  const notes = [];
  if (pending.length > 0) {
    notes.push(`存在未处理待确认：${pending.map((item) => item.name).join(", ")}。`);
  }

  // Stop 完整度档位：兼容旧 stopGate=block 与显式 require-complete；否则按 profile。
  const level =
    state.stopGate === "block" || event.requireComplete === true || options.requireComplete === true
      ? "block"
      : gateLevel(profile, "stop");

  if (!complete[phase]) {
    const message = `阶段 ${phase} 尚未完成。${notes.join(" ")}`.trim();
    if (level === "block") {
      return block(`Stop gate blocked: ${message}`);
    }
    if (level === "warn") {
      return warn(`Stop gate warning: ${message}`);
    }
    return notes.length > 0 ? warn(notes.join(" ")) : allow(`Stop allowed (lite) for phase ${phase}.`);
  }

  return notes.length > 0 ? warn(notes.join(" ")) : allow(`Stop gate passed for phase ${phase}.`);
}

function looksWriteLikeCommand(command) {
  return (
    /\b(Set-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|rm|mv|cp|touch|mkdir|git\s+apply|npm\s+run\s+build|pnpm\s+run\s+build|yarn\s+build)\b/i.test(
      command,
    ) || /[>]{1,2}/u.test(command)
  );
}

export function isLikelySourcePath(relativePath) {
  if (!relativePath || relativePath.startsWith("docs/")) {
    return false;
  }
  const ext = relativePath.includes(".") ? relativePath.slice(relativePath.lastIndexOf(".")).toLowerCase() : "";
  return KNOWN_SOURCE_EXTENSIONS.has(ext);
}
