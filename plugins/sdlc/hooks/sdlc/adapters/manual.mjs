import path from "node:path";
import fs from "node:fs";
import {
  currentStatePath,
  ensureDir,
  loadCurrentState,
  readJsonIfExists,
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
  phasePreconditionsUnmet,
  pendingConfirmations,
  sdlcProfile,
  taskPlanDiagnostics,
  taskPlanPath,
} from "../core/artifacts.mjs";
import { effectiveFlow, loadRegistry, resolveStep } from "../core/registry.mjs";
import { evaluate } from "../core/rules.mjs";
import { printJson } from "../core/result.mjs";
import { hookCommand, RUNTIME_ROOT } from "../core/runtime.mjs";
import { inferTargetPaths, parseArgs } from "./common.mjs";

// 默认阶段顺序（软建议）：design-1/design-2 已合并为 design。
const PHASE_ORDER = ["design", "implement", "test"];
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
    return status(root);
  }

  // 仪式吸收进 skill：phase.set 是主入口，phase.enter 作别名——都只“设阶段 + 软提示”，不再硬门禁。
  if (command === "phase.set" || command === "phase.enter") {
    return setPhase(args, root);
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

function setPhase(args, root) {
  const raw = readJsonIfExists(currentStatePath(root), null);
  if (!raw) {
    printJson({ decision: "deny", reason: "Lifecycle not initialized; run init first." });
    process.exitCode = 2;
    return;
  }

  const target = args.phase;
  if (!target) {
    throw new Error("phase.set requires --phase design|implement|test|debug");
  }

  writeJson(currentStatePath(root), { ...raw, phase: target });

  // 软提示（跳级 / 未满足前置）。phase.set 恒放行。
  const result = evaluate(
    { name: "phase.set", platform: "manual", phase: target },
    { cwd: root, state: loadCurrentState(root) },
  );
  printJson({
    decision: result.decision === "deny" ? "deny" : "allow",
    phase: target,
    severity: result.severity,
    message: result.message || result.reason,
  });
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
  return {
    state,
    completion,
    pendingConfirmations: pending.map((item) => item.name),
    profile: sdlcProfile(state),
    runtimeRoot: RUNTIME_ROOT,
    nextAction: nextAction(state, completion, pending),
    blockingReasons: blockingReasons(state, root, completion, pending),
    requiredArtifacts: requiredArtifacts(state, root),
    recommendedReads: recommendedReads(state),
    allowedPaths: allowedPaths(state, root),
    phasePreconditions: state ? phasePreconditionsUnmet(state, root, state.phase) : [],
    flow: effectiveFlow(loadRegistry(root)),
  };
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
    ],
  });
}

function nextAction(state, completion, pending) {
  if (!state) {
    return "Initialize lifecycle with init --task-dir docs/[task] --system [system].";
  }

  if (pending.length > 0) {
    return `Resolve pending confirmation: ${pending.map((item) => item.name).join(", ")}.`;
  }

  if (!completion[state.phase]) {
    return `Complete required artifacts for phase ${state.phase}.`;
  }

  const currentIndex = PHASE_ORDER.indexOf(state.phase);
  if (currentIndex >= 0 && currentIndex < PHASE_ORDER.length - 1) {
    return `Enter next phase: ${PHASE_ORDER[currentIndex + 1]}.`;
  }

  if (state.phase === "test" && completion.test) {
    return "Task lifecycle is complete; summarize results and keep knowledge in the task/system docs.";
  }

  return "Inspect current state and choose the next lifecycle command.";
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

function recommendedReads(state) {
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
