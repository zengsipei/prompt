import path from "node:path";
import fs from "node:fs";
import {
  currentStatePath,
  ensureDir,
  loadCurrentState,
  readJsonIfExists,
  recordEvent,
  saveHookState,
  workspaceRoot,
  writeJson,
} from "../core/context.mjs";
import {
  implementationAllowedPaths,
  inferAllowedPathsFromGit,
  isLifecyclePath,
  lifecycleDocPaths,
  loadTaskPlan,
  phaseCompletion,
  phasePreconditionEvidenceLabel,
  phasePreconditionsUnmet,
  pendingConfirmations,
  preconditionStepCommand,
  requiredCapabilityName,
  sdlcProfile,
  taskPlanDiagnostics,
  taskPlanPath,
} from "../core/artifacts.mjs";
import { effectiveAutoAdvance, effectiveFlow, loadRegistry, resolveStep, validateAutoAdvanceOrder } from "../core/registry.mjs";
import { evaluate } from "../core/rules.mjs";
import { allow, block, printJson } from "../core/result.mjs";
import { hookCommand, RUNTIME_ROOT } from "../core/runtime.mjs";
import { nextAction, shortStatusMessage } from "../core/status.mjs";
import { applyManualRename, currentSessionId, sessionPath } from "../core/session.mjs";
import { autoAdvanceNextPhaseFromState, evaluateAutoAdvanceGate } from "../core/autoAdvance.mjs";
import { CLOSE_REASONS, performClose, SUCCESS_EVIDENCE_PHASES, SUCCESSFUL_CLOSE_REASON } from "../core/closure.mjs";
import { inferTargetPaths, parseArgs } from "./common.mjs";

// 默认阶段顺序（软建议）：design-1/design-2 已合并为 design。下一步推断已下沉到 core/status.mjs。
const PROFILE_ARTIFACTS = {
  lite: {
    design: ["onlyAI/task-plan.json"],
    implement: ["onlyAI/task-plan.json"],
    test: ["onlyAI/verification.md", "summary.md"],
  },
  standard: {
    design: ["001-概要设计.md", "onlyAI/task-plan.json"],
    implement: ["onlyAI/task-plan.json", "003-文件改动记录.md"],
    test: ["onlyAI/verification.md"],
  },
  full: {
    design: ["001-概要设计.md", "002-详细设计.md", "003-施工文档.md"],
    implement: ["003-施工文档.md", "003-文件改动记录.md", "onlyAI/operations-log.md"],
    test: ["004-测试用例.md", "005-测试报告.md", "onlyAI/verification.md"],
  },
};
const PROFILE_RECOMMENDED_READS = {
  lite: {
    design: ["prd/", "onlyAI/task-plan.json"],
    implement: ["onlyAI/task-plan.json", "onlyAI/verification.md"],
    test: ["onlyAI/verification.md", "summary.md"],
    debug: ["006-Debug排查记录.md", "onlyAI/verification.md"],
  },
  standard: {
    design: ["prd/", "001-概要设计.md", "onlyAI/task-plan.json"],
    implement: ["onlyAI/task-plan.json", "003-文件改动记录.md", "onlyAI/verification.md"],
    test: ["onlyAI/verification.md"],
    debug: ["006-Debug排查记录.md", "onlyAI/verification.md"],
  },
  full: {
    design: ["prd/", "001-概要设计.md", "002-详细设计.md", "003-施工文档.md"],
    implement: ["003-施工文档.md", "onlyAI/task-plan.json", "onlyAI/operations-log.md"],
    test: ["004-测试用例.md", "onlyAI/verification.md", "onlyAI/testing.md"],
    debug: ["006-Debug排查记录.md", "onlyAI/operations-log.md", "onlyAI/verification.md"],
  },
};

export function runManual(argv = process.argv.slice(2)) {
  const command = argv[0] || "help";
  const args = parseArgs(argv.slice(1));
  const root = workspaceRoot();

  if (command === "init") {
    return initLifecycle(args, root);
  }

  if (command === "status") {
    // 默认输出完整机读 JSON；--short 输出与 hook 注入同源的紧凑人读视图（≤4 行）。
    if (args.short === true) {
      process.stdout.write(`${shortStatusMessage(loadCurrentState(root), root)}\n`);
      return;
    }
    return status(root);
  }

  // 仪式吸收进 skill：phase.set 是主入口，phase.enter 作别名——都只“设阶段 + 软提示”，不再硬门禁。
  if (command === "phase.set" || command === "phase.enter") {
    const result = setPhase(args, root);
    printJson(result);
    if (result.decision === "deny") {
      process.exitCode = 2;
    }
    return;
  }

  if (command === "phase.exit") {
    return runEvent({ name: "phase.exit", phase: args.phase }, root);
  }

  // 施工边界声明自动化：从 git diff 播种 task-plan.json 的 allowedPaths（§4）。
  if (command === "scope.infer") {
    return scopeInfer(root);
  }

  // 工具编排 registry：查看有效流程 / 解析某抽象步骤的工具链。
  if (command === "registry") {
    const sub = args._[0] || "show";
    if (sub === "show") {
      return registryShow(root);
    }
    return printJson({ usage: ["registry show"] });
  }

  if (command === "step") {
    return stepShow(root, args._[0] || args.step);
  }

  if (command === "tool.before") {
    return runEvent(
      {
        name: "tool.before",
        platform: "manual",
        action: args.action || "fs.edit",
        targetPaths: args.path ? [args.path] : inferTargetPaths(args.tool, args),
        command: args.command,
      },
      root,
    );
  }

  if (command === "session.stop") {
    return runEvent(
      {
        name: "session.stop",
        platform: "manual",
        requireComplete: args["require-complete"] === true,
      },
      root,
      { requireComplete: args["require-complete"] === true },
    );
  }

  // 手动覆盖会话名：显式命名并 best-effort 尝试平台 rename；输出平台 rename 是否 applied / unavailable。
  if (command === "session.rename") {
    const result = renameSession(args, root);
    printJson(result);
    if (result.decision === "deny") {
      process.exitCode = 2;
    }
    return;
  }

  // 显式关闭任务：completed 需 design/implement/test 证据齐全且无待确认；
  // canceled/wontfix/superseded 需 --note，可关闭未完成工作。关闭后进入 closed 终端态。
  if (command === "task.close") {
    const result = closeTask(args, root);
    printJson(result);
    if (result.decision === "deny") {
      process.exitCode = 2;
    }
    return;
  }

  // 显式关闭 debug：debug 是条件阶段，仅在显式激活后参与关闭判定。
  // 关闭需 --note（短即可），清除激活态并记录排查结论与会话元数据。
  if (command === "debug.close") {
    const result = closeDebug(args, root);
    printJson(result);
    if (result.decision === "deny") {
      process.exitCode = 2;
    }
    return;
  }

  // auto.advance：registry-gated 的阶段自动推进（issue #17）。默认只推进一阶段；
  // --until-blocked 连续推进直到被严格闸门拒绝或生命周期完成。拒绝时 exit code 2 且不改 current.json。
  if (command === "auto.advance") {
    const result = autoAdvance(args, root);
    printJson(result);
    if (result.decision === "deny") {
      process.exitCode = 2;
    }
    return;
  }

  return help();
}

function initLifecycle(args, root) {
  if (!args["task-dir"]) {
    throw new Error("init requires --task-dir docs/[task-dir]");
  }

  const activeTaskDir = args["task-dir"].replace(/\\/g, "/");
  const state = {
    activeTaskDir,
    phase: args.phase || "design",
    mode: args.mode || "enforce",
    strict: args.strict !== "false",
    stopGate: args["stop-gate"] || "warn",
    profile: sdlcProfile({ profile: args.profile }),
    systemName: args.system || args["system-name"] || "",
    runtimeRoot: RUNTIME_ROOT,
    createdAt: new Date().toISOString(),
  };

  ensureDir(path.join(root, activeTaskDir, "onlyAI"));
  writeJson(currentStatePath(root), state);
  saveHookState(state, state, root);
  printJson({
    decision: "allow",
    message: "SDLC lifecycle initialized.",
    state,
  });
}

// phase.set / phase.enter：设阶段 + 软提示。返回 result（不 printJson），供 runManual 与测试共用同一 seam。
// 进入 debug 阶段时显式置 debugActive=true 并记录激活元数据——debug 激活态必须显式声明，
// 不得从文件名 / 日志 / 偶发文本推断；切换到别的阶段不会静默清除（关闭须显式经 debug.close）。
export function setPhase(args, root) {
  const raw = readJsonIfExists(currentStatePath(root), null);
  if (!raw) {
    return block("Lifecycle not initialized; run init first.");
  }

  const target = args.phase;
  if (!target) {
    throw new Error("phase.set requires --phase design|implement|test|debug");
  }

  const nextState = { ...raw, phase: target };
  if (target === "debug" && !raw.debugActive) {
    const sessionRecord = readJsonIfExists(sessionPath(root), null);
    nextState.debugActive = true;
    nextState.debugActivatedAt = new Date().toISOString();
    nextState.debugSessionId = sessionRecord?.sessionId || currentSessionId(root) || null;
  }
  writeJson(currentStatePath(root), nextState);

  // 软提示（跳级 / 未满足前置）。phase.set 恒放行。
  const result = evaluate(
    { name: "phase.set", platform: "manual", phase: target },
    { cwd: root, state: loadCurrentState(root) },
  );
  return {
    decision: result.decision === "deny" ? "deny" : "allow",
    phase: target,
    severity: result.severity,
    message: result.message || result.reason,
  };
}

function scopeInfer(root) {
  const state = loadCurrentState(root);
  if (!state?.activeTaskDir) {
    printJson({ decision: "deny", reason: "No active task; run init first." });
    process.exitCode = 2;
    return;
  }

  const inferred = Array.from(inferAllowedPathsFromGit(root))
    .filter((item) => !isLifecyclePath(item, state))
    .sort();
  const plan = loadTaskPlan(state, root) || {};
  const merged = new Set(Array.isArray(plan.allowedPaths) ? plan.allowedPaths : []);
  for (const item of inferred) {
    merged.add(item);
  }
  plan.allowedPaths = Array.from(merged).sort();

  const planPath = taskPlanPath(state, root);
  writeJson(planPath, plan);
  printJson({
    decision: "allow",
    message: inferred.length > 0
      ? "Seeded施工边界 allowedPaths from git diff."
      : "git 无改动可推断；allowedPaths 未变（无声明时施工边界退化为只提示）。",
    inferred,
    allowedPaths: plan.allowedPaths,
    taskPlan: `${state.activeTaskDir}/onlyAI/task-plan.json`,
  });
}

function registryShow(root) {
  printJson({ decision: "allow", flow: effectiveFlow(loadRegistry(root)) });
}

function stepShow(root, name) {
  if (!name) {
    throw new Error("step requires a step name, e.g. step locate-code");
  }
  const resolved = resolveStep(loadRegistry(root), name);
  if (!resolved) {
    return printJson({ decision: "allow", step: name, found: false, message: `Unknown step: ${name}` });
  }
  printJson({ decision: "allow", step: resolved });
}

function status(root) {
  printJson(statusPayload(root));
}

export function statusPayload(root) {
  const state = loadCurrentState(root);
  const completion = phaseCompletion(state, root);
  const pending = pendingConfirmations(state, root);
  // auto-advance 有效配置 + 配置合法性（AC #3：无效 order 在 status 暴露清晰配置错误）。
  const autoAdvanceConfig = effectiveAutoAdvance(loadRegistry(root));
  const autoAdvanceConfigError = validateAutoAdvanceOrder(autoAdvanceConfig.order);
  const autoAdvanceApplicable =
    state?.activeTaskDir && !autoAdvanceConfigError ? evaluateAutoAdvanceGate(state, root).allowed : false;
  return {
    state,
    completion,
    pendingConfirmations: pending.map((item) => item.name),
    profile: sdlcProfile(state),
    runtimeRoot: RUNTIME_ROOT,
    nextAction: nextAction(state, completion, pending, root),
    blockingReasons: blockingReasons(state, root, completion, pending),
    requiredArtifacts: requiredArtifacts(state, root),
    recommendedReads: recommendedReads(state),
    allowedPaths: allowedPaths(state, root),
    phasePreconditions: state ? phasePreconditionsUnmet(state, root, state.phase) : [],
    flow: effectiveFlow(loadRegistry(root)),
    autoAdvance: {
      ...autoAdvanceConfig,
      configError: autoAdvanceConfigError,
      applicable: autoAdvanceApplicable,
    },
  };
}

// CLOSE_REASONS / SUCCESSFUL_CLOSE_REASON / SUCCESS_EVIDENCE_PHASES 与 performClose 下沉到
// core/closure.mjs，供 task.close 与 session.stop 兜底关闭共用同一关闭核心（见上方 import）。
// debug.close 的 note 最短长度（去空白后）。note 必填、可短，但不接受空 / 过短的占位。
const DEBUG_NOTE_MIN_LENGTH = 4;

// 显式关闭活动任务，把生命周期推入 closed 终端态。
// 返回 result（不 printJson），供 runManual 与运行时测试共用同一高层 seam。
export function closeTask(args = {}, root = workspaceRoot()) {
  const state = loadCurrentState(root);
  if (!state || !state.activeTaskDir) {
    return block("没有活动任务可关闭：task.close 需要已初始化且尚未关闭的任务。");
  }

  const reason = typeof args.reason === "string" ? args.reason.trim().toLowerCase() : "";
  if (!CLOSE_REASONS.includes(reason)) {
    return block(`task.close 需要 --reason，取值之一：${CLOSE_REASONS.join(" | ")}。`);
  }

  const note = typeof args.note === "string" ? args.note.trim() : "";
  const completion = phaseCompletion(state, root);
  const pending = pendingConfirmations(state, root);
  const completed = reason === SUCCESSFUL_CLOSE_REASON;
  // 关闭时 debug 是否仍激活——非成功关闭允许带 active debug 关闭，但须把这一事实记进最终证据。
  const debugActiveAtClose = Boolean(state.debugActive);

  if (completed) {
    // debug 是条件关闭门：completed 收尾不得静默关闭未结的排查。debug 激活则先 block，要求显式 debug.close。
    if (debugActiveAtClose) {
      return block(
        [
          "task.close --reason completed 被拒：debug 仍处于激活态，完成收尾不得静默关闭未结的排查。",
          "先 `sdlc-hook debug.close --note <排查结论>` 显式关闭 debug，再重试 completed 关闭。",
        ].join("\n"),
      );
    }

    // 成功关闭：design/implement/test 证据齐全且无待确认，否则拒绝并保持任务活动。
    const missing = SUCCESS_EVIDENCE_PHASES.filter((phase) => !completion[phase]);
    if (missing.length > 0 || pending.length > 0) {
      const reasons = [];
      if (missing.length > 0) {
        reasons.push(`未完成阶段证据：${missing.join(", ")}`);
        reasons.push(...taskPlanDiagnostics(state, root));
      }
      if (pending.length > 0) {
        reasons.push(`未处理待确认：${pending.map((item) => item.name).join(", ")}`);
      }
      return block(
        [
          "task.close --reason completed 被拒：完成证据不齐，任务保持活动。",
          ...reasons,
          "补齐缺失证据后重试，或改用 --reason canceled|wontfix|superseded --note <说明> 关闭未完成工作。",
        ].join("\n"),
      );
    }
  } else if (!note) {
    // 非成功关闭：必须给出简短 close note，便于日后理解为何未完成即关闭。
    return block(`task.close --reason ${reason} 需要 --note <简短说明>，以记录未完成即关闭的缘由。`);
  }

  // 写最终关闭证据 + 转 closed 终端态：与 session.stop 兜底自动关闭共用 performClose 同一核心，
  // 保证两条路径写入完全一致的关闭证据（trigger="manual" 标记来源；debugActiveAtClose 仍由核心固化）。
  const { nextState, closureRelPath, taskDir } = performClose(state, root, {
    reason,
    note,
    completion,
    pending,
    trigger: "manual",
  });

  return allow(
    [
      `任务已关闭（${reason}${completed ? "，已完成" : "，未完成"}）：${taskDir}。`,
      `最终关闭证据：${closureRelPath}`,
      "生命周期进入 closed：无活动任务，旧任务门禁不再生效（全局红线仍在）。",
      "开始新任务：`sdlc-hook init --task-dir docs/[task] --system [system]`。",
    ].join("\n"),
    {
      closeReason: reason,
      completed,
      lastTask: nextState.lastTask,
      closureEvidence: closureRelPath,
    },
  );
}

// 显式关闭 debug：清除激活态、记录排查结论与会话元数据。
// debug 是条件阶段——仅在显式激活（phase.set --phase debug）后才需要、也才能被关闭。
// 返回 result（不 printJson），与 closeTask 共用同一高层 seam，供运行时测试驱动。
export function closeDebug(args = {}, root = workspaceRoot()) {
  const state = loadCurrentState(root);
  if (!state) {
    return block("生命周期未初始化：debug.close 需要已初始化的项目。");
  }
  if (!state.debugActive) {
    return block(
      "当前没有处于激活态的 debug：先 `sdlc-hook phase.set --phase debug` 进入 debug 再 debug.close。",
    );
  }

  const note = typeof args.note === "string" ? args.note.trim() : "";
  if (note.length < DEBUG_NOTE_MIN_LENGTH) {
    return block(
      `debug.close 需要 --note <简短说明>（至少 ${DEBUG_NOTE_MIN_LENGTH} 字），用于记录排查结论；当前 note 缺失或过短。`,
    );
  }

  const closedAt = new Date().toISOString();
  const sessionRecord = readJsonIfExists(sessionPath(root), null);
  const sessionId = sessionRecord?.sessionId || currentSessionId(root) || null;
  const sessionName = sessionRecord?.sessionName || sessionRecord?.name || null;

  // 清除激活态，把排查结论与会话元数据固化进 lastDebug（轻量、可独立审计）。
  const nextState = { ...state };
  delete nextState.debugActive;
  delete nextState.debugActivatedAt;
  delete nextState.debugSessionId;
  nextState.lastDebug = {
    note,
    closedAt,
    activatedAt: state.debugActivatedAt || null,
    sessionId,
    sessionName,
  };
  writeJson(currentStatePath(root), nextState);

  return allow(
    [
      `debug 已关闭：${note}`,
      "debug 激活态已清除；完成证据齐备后可 `sdlc-hook task.close --reason completed` 收尾。",
    ].join("\n"),
    { note, closedAt, lastDebug: nextState.lastDebug },
  );
}

// auto.advance：registry-gated 的阶段自动推进（issue #17）。
// 返回 result（不 printJson），供 runManual 与运行时测试共用同一高层 seam。
// 拒绝（含配置非法）时 decision:"deny"、不改 current.json、exit code 2；成功时写新相位并返回含
// nextAction / recommendedReads 的更新状态上下文。每次尝试（成功或拒绝）都写审计事件到 hook-events.ndjson。
export function autoAdvance(args = {}, root = workspaceRoot()) {
  const state0 = loadCurrentState(root);
  if (!state0 || !state0.activeTaskDir) {
    return block("生命周期未初始化：auto.advance 需要已初始化的项目。");
  }

  const untilBlocked = args["until-blocked"] === true;
  const trace = [];
  let workingState = state0;
  let lastDenied = null;

  // 单步或 --until-blocked：循环推进直到严格闸门拒绝或已是末阶段。
  // 即便 --until-blocked 也至少推进一次（闸门可用时）。
  for (;;) {
    const gate = evaluateAutoAdvanceGate(workingState, root);
    if (!gate.allowed) {
      lastDenied = gate;
      break;
    }

    const from = workingState.phase;
    const to = gate.target;
    const nextState = advancePhaseState(workingState, to, root);
    writeJson(currentStatePath(root), nextState);
    recordAutoAdvanceEvent(from, to, "allow", root);
    trace.push({ from, to, decision: "allow" });
    workingState = loadCurrentState(root);

    if (!untilBlocked) {
      break;
    }
  }

  // 零次推进 = 被拒绝：写拒绝审计、返回 deny、exit code 2、不改动 current.json。
  if (trace.length === 0) {
    const denyReason = lastDenied?.configError || lastDenied?.reason || "无法自动推进。";
    recordAutoAdvanceEvent(state0.phase, null, "deny", root, denyReason);
    return block(denyReason, {
      advanced: false,
      from: state0.phase,
      to: null,
      trace,
      configError: lastDenied?.configError || undefined,
    });
  }

  const finalState = loadCurrentState(root);
  const completion = phaseCompletion(finalState, root);
  const pending = pendingConfirmations(finalState, root);
  const from = state0.phase;
  const to = finalState.phase;
  const message = untilBlocked
    ? `auto.advance --until-blocked 推进 ${trace.length} 次：${trace.map((step) => `${step.from}→${step.to}`).join(", ")}。`
    : `auto.advance 推进 ${from} → ${to}。`;
  return allow(message, {
    advanced: true,
    from,
    to,
    trace,
    nextAction: nextAction(finalState, completion, pending, root),
    recommendedReads: recommendedReads(finalState),
    state: finalState,
  });
}

// 推进后的状态：写目标相位；若目标是 debug 则显式激活（与 phase.set --phase debug 一致），
// 视为项目已把 debug 写进 autoAdvance.order 的显式 opt-in。
function advancePhaseState(state, target, root) {
  const nextState = { ...state, phase: target };
  if (target === "debug" && !state.debugActive) {
    const sessionRecord = readJsonIfExists(sessionPath(root), null);
    nextState.debugActive = true;
    nextState.debugActivatedAt = new Date().toISOString();
    nextState.debugSessionId = sessionRecord?.sessionId || currentSessionId(root) || null;
  }
  return nextState;
}

// 审计事件：每次 auto.advance 尝试（成功 / 拒绝）都落 hook-events.ndjson，便于事后审计推进轨迹。
function recordAutoAdvanceEvent(from, to, decision, root, reason = "") {
  const event = {
    name: "auto.advance",
    platform: "manual",
    action: "sdlc.phase.advance",
    targetPaths: [],
    fromPhase: from,
    toPhase: to,
  };
  const result = decision === "allow" ? allow(`auto.advance ${from} → ${to}`) : block(reason || "auto.advance denied");
  recordEvent(event, result, root, currentSessionId(root));
}

// 手动会话重命名：显式覆盖 session 名，best-effort 尝试平台 rename；返回平台 rename 反馈。
// 返回 result（不 printJson），供 runManual 与运行时测试共用同一高层 seam（#14）。
export function renameSession(args = {}, root = workspaceRoot()) {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) {
    return block("session.rename 需要 --name <会话名>。");
  }

  // applyManualRename 负责写 session 记录 + best-effort 平台 rename，返回平台结果。
  const { rename } = applyManualRename(name, root);
  const feedback = rename.available
    ? rename.applied
      ? "平台 session rename 已应用。"
      : `平台 session rename 被拒绝（${rename.error || "unknown"}）；本地会话名已记录。`
    : "平台 session rename 不可用；本地会话名已记录。";

  return allow(`会话名已设为「${name}」。${feedback}`, {
    sessionName: name,
    platformRename: rename,
  });
}

function runEvent(event, root, options = {}) {
  const result = evaluate(
    {
      platform: "manual",
      targetPaths: [],
      ...event,
    },
    {
      cwd: root,
      ...options,
    },
  );
  printJson(result);
  if (result.decision === "deny") {
    process.exitCode = 2;
  }
}

function help() {
  printJson({
    usage: [
      `${hookCommand()} init --task-dir docs/[task] --system [system] --profile lite|standard|full`,
      `${hookCommand()} status`,
      `${hookCommand()} phase.set --phase implement`,
      `${hookCommand()} scope.infer`,
      `${hookCommand()} registry show`,
      `${hookCommand()} step locate-code`,
      `${hookCommand()} tool.before --action fs.edit --path src/foo.ts`,
      `${hookCommand()} session.stop --require-complete`,
      `${hookCommand()} session.rename --name "会话名"`,
      `${hookCommand()} task.close --reason completed`,
      `${hookCommand()} task.close --reason canceled|wontfix|superseded --note "原因"`,
      `${hookCommand()} debug.close --note "排查结论"`,
      `${hookCommand()} auto.advance [--until-blocked]`,
    ],
  });
}

function blockingReasons(state, root, completion, pending) {
  if (!state) {
    return ["docs/_sdlc/current.json is missing."];
  }

  const reasons = [];
  if (pending.length > 0) {
    reasons.push(`Pending confirmations: ${pending.map((item) => item.name).join(", ")}.`);
  }
  if (!completion[state.phase]) {
    reasons.push(`Current phase ${state.phase} is incomplete.`);
    reasons.push(...taskPlanDiagnostics(state, root));
  }
  // 未满足的项目硬前置门禁：点名缺什么（含任务相对证据路径），便于 status 直接定位（#16）。
  // required-capability 与 required-evidence 用不同措辞，避免把能力门禁误说成「提供证据」。
  for (const item of phasePreconditionsUnmet(state, root, state.phase)) {
    const label = phasePreconditionEvidenceLabel(item);
    const detail =
      item.enforcement === "required-capability"
        ? `Run required capability ${requiredCapabilityName(item) || "tool"} before editing source`
        : "Provide required evidence before editing source";
    const stepCommand = preconditionStepCommand(item);
    const hint = stepCommand ? `（${stepCommand}）` : "";
    reasons.push(
      `Unmet phase precondition: ${label}${item.reason ? ` (${item.reason})` : ""}. ${detail}.${hint}`,
    );
  }
  return reasons;
}

function requiredArtifacts(state, root) {
  if (!state?.activeTaskDir) {
    return [];
  }

  const artifactsByPhase = PROFILE_ARTIFACTS[sdlcProfile(state)] || PROFILE_ARTIFACTS.standard;
  return (artifactsByPhase[state.phase] || []).map((relativePath) => {
    const fullPath = path.join(root, state.activeTaskDir, relativePath);
    return {
      path: `${state.activeTaskDir}/${relativePath}`.replace(/\\/g, "/"),
      exists: fs.existsSync(fullPath),
    };
  });
}

export function recommendedReads(state) {
  if (!state?.activeTaskDir) {
    return ["docs/_sdlc/current.json"];
  }

  const readsByPhase = PROFILE_RECOMMENDED_READS[sdlcProfile(state)] || PROFILE_RECOMMENDED_READS.standard;
  const taskReads = readsByPhase[state.phase] || [];
  return [
    "docs/_sdlc/current.json",
    ...taskReads.map((relativePath) => `${state.activeTaskDir}/${relativePath}`.replace(/\\/g, "/")),
  ];
}

function allowedPaths(state, root) {
  if (!state) {
    return [];
  }

  const lifecycle = lifecycleDocPaths(state).map((item) => `${item}*`);
  if (state.phase !== "implement") {
    return lifecycle;
  }

  return [
    ...lifecycle,
    ...Array.from(implementationAllowedPaths(state, root)).sort(),
  ];
}
