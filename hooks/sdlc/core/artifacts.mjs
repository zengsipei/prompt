import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadHookState, readJsonIfExists, readTextIfExists, saveHookState, taskPath, toPosixPath } from "./context.mjs";
import { loadRegistry, registryPhasePreconditions } from "./registry.mjs";

const CONFIRMATION_DONE_PATTERNS = [
  /(?:\*\*)?状态(?:\*\*)?[：:]\s*已处理/u,
  /(?:\*\*)?决策状态(?:\*\*)?[：:]\s*已决策/u,
];
const PROFILES = new Set(["lite", "standard", "full"]);

export function fileExists(filePath) {
  return Boolean(filePath && fs.existsSync(filePath));
}

export function confirmationStatus(filePath) {
  if (!fileExists(filePath)) {
    return "none";
  }

  const text = readTextIfExists(filePath);
  return CONFIRMATION_DONE_PATTERNS.some((pattern) => pattern.test(text))
    ? "handled"
    : "pending";
}

export function pendingConfirmations(state, root) {
  if (!state?.activeTaskDir) {
    return [];
  }

  return [
    "001-概要设计-待确认.md",
    "002-详细设计-待确认.md",
  ]
    .map((name) => {
      const filePath = taskPath(state, root, name);
      return {
        name,
        path: filePath,
        status: confirmationStatus(filePath),
      };
    })
    .filter((item) => item.status === "pending");
}

export function taskPlanPath(state, root) {
  return taskPath(state, root, path.join("onlyAI", "task-plan.json"));
}

export function loadTaskPlan(state, root) {
  const plan = readJsonIfExists(taskPlanPath(state, root), null);
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    return null;
  }
  return plan;
}

export function sdlcProfile(state) {
  const profile = String(state?.profile || "standard").trim().toLowerCase();
  return PROFILES.has(profile) ? profile : "standard";
}

export function phaseCompletion(state, root) {
  if (!state?.activeTaskDir) {
    return {
      design: false,
      implement: false,
      test: false,
      debug: false,
    };
  }

  const design1Doc = taskPath(state, root, "001-概要设计.md");
  const design1Confirmation = taskPath(state, root, "001-概要设计-待确认.md");
  const detailDoc = taskPath(state, root, "002-详细设计.md");
  const buildDoc = taskPath(state, root, "003-施工文档.md");
  const design2Confirmation = taskPath(state, root, "002-详细设计-待确认.md");
  const changeRecord = taskPath(state, root, "003-文件改动记录.md");
  const operationsLog = taskPath(state, root, path.join("onlyAI", "operations-log.md"));
  const taskPlan = taskPlanPath(state, root);
  const testCases = taskPath(state, root, "004-测试用例.md");
  const testReport = taskPath(state, root, "005-测试报告.md");
  const verification = taskPath(state, root, path.join("onlyAI", "verification.md"));
  const summary = taskPath(state, root, "summary.md");
  const profile = sdlcProfile(state);

  // 待确认未处理直接判定设计未完成（与硬 pending 拦截一致）。
  const confirmationsHandled =
    confirmationStatus(design1Confirmation) !== "pending" &&
    confirmationStatus(design2Confirmation) !== "pending";
  const taskPlanExists = fileExists(taskPlan);
  const tasksDone = implementationTasksCompleted(state, root, readTextIfExists(buildDoc));

  // design-1（概要）与 design-2（详细）合并为单一 design 阶段，完成度按 profile 递进。
  let designComplete;
  if (profile === "lite") {
    designComplete = taskPlanExists && confirmationsHandled;
  } else if (profile === "standard") {
    designComplete = fileExists(design1Doc) && taskPlanExists && confirmationsHandled;
  } else {
    designComplete =
      fileExists(design1Doc) && fileExists(detailDoc) && fileExists(buildDoc) && confirmationsHandled;
  }

  if (profile === "lite") {
    return {
      design: designComplete,
      implement: designComplete && tasksDone,
      test: fileExists(verification) || fileExists(summary),
      debug: fileExists(taskPath(state, root, "006-Debug排查记录.md")),
    };
  }

  if (profile === "standard") {
    return {
      design: designComplete,
      implement: designComplete && fileExists(changeRecord) && tasksDone,
      test: fileExists(verification),
      debug: fileExists(taskPath(state, root, "006-Debug排查记录.md")),
    };
  }

  return {
    design: designComplete,
    implement: designComplete && fileExists(changeRecord) && fileExists(operationsLog) && tasksDone,
    test: fileExists(testCases) && fileExists(testReport) && fileExists(verification),
    debug: fileExists(taskPath(state, root, "006-Debug排查记录.md")),
  };
}

export function implementationTasksCompleted(state, root, buildDocText = "") {
  const taskPlan = loadTaskPlan(state, root);
  if (taskPlan) {
    return allTaskPlanTasksCompleted(taskPlan);
  }
  return allTasksCompleted(buildDocText);
}

export function allTaskPlanTasksCompleted(taskPlan) {
  const tasks = Array.isArray(taskPlan?.tasks) ? taskPlan.tasks : [];
  if (tasks.length === 0) {
    return false;
  }

  return tasks.every((task) => {
    const status = String(task?.status || "").trim().toLowerCase();
    return ["done", "completed", "complete", "[x]", "已完成"].includes(status);
  });
}

export function allTasksCompleted(text) {
  const taskRows = text
    .split(/\r?\n/u)
    .filter((line) => /^\|\s*T-\d+/u.test(line));

  if (taskRows.length === 0) {
    return false;
  }

  return taskRows.every((line) => /\|\s*\[x\]\s*\|/iu.test(line));
}

export function lifecycleDocPaths(state) {
  if (!state?.activeTaskDir) {
    return ["docs/_sdlc/"];
  }

  return [
    "docs/_sdlc/",
    `${state.activeTaskDir}/`,
  ].map(toPosixPath);
}

export function isLifecyclePath(relativePath, state) {
  if (!relativePath) {
    return false;
  }

  const normalized = toPosixPath(relativePath);
  return lifecycleDocPaths(state).some((prefix) => normalized.startsWith(prefix));
}

export function implementationAllowedPaths(state, root) {
  const taskPlan = loadTaskPlan(state, root);
  if (taskPlan) {
    return implementationAllowedPathsFromTaskPlan(taskPlan);
  }

  const buildDoc = taskPath(state, root, "003-施工文档.md");
  const text = readTextIfExists(buildDoc);
  const taskLines = text
    .split(/\r?\n/u)
    .filter((line) => /^\|\s*T-\d+/u.test(line));
  const sourceText = taskLines.length > 0 ? taskLines.join("\n") : text;
  const matches = sourceText.matchAll(/`([^`]+)`/gu);
  const allowed = new Set();

  for (const match of matches) {
    const value = match[1].trim();
    if (!value || value.includes("[") || value.includes("]")) {
      continue;
    }
    allowed.add(toPosixPath(value).replace(/\/+$/u, ""));
  }

  return allowed;
}

export function implementationAllowedPathsFromTaskPlan(taskPlan) {
  const allowed = new Set();
  collectAllowedPaths(taskPlan?.allowedPaths, allowed);

  if (Array.isArray(taskPlan?.tasks)) {
    for (const task of taskPlan.tasks) {
      collectAllowedPaths(task?.allowedPaths, allowed);
    }
  }

  return allowed;
}

function collectAllowedPaths(values, allowed) {
  if (!Array.isArray(values)) {
    return;
  }

  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = toPosixPath(value.trim()).replace(/\/+$/u, "");
    if (!normalized || normalized.includes("[") || normalized.includes("]")) {
      continue;
    }
    allowed.add(normalized);
  }
}

export function isAllowedImplementationPath(relativePath, state, root) {
  if (isLifecyclePath(relativePath, state)) {
    return true;
  }

  const normalized = toPosixPath(relativePath);
  const allowed = implementationAllowedPaths(state, root);

  for (const allowedPath of allowed) {
    if (normalized === allowedPath || normalized.startsWith(`${allowedPath}/`)) {
      return true;
    }
  }

  return false;
}

// 从 git 推断“已在场”的文件集：相对 HEAD 的改动（staged+unstaged）∪ 未跟踪新文件。
// 用于 scope.infer 自动播种施工边界声明，避免手维护清单（§4 声明自动化）。
// 不是 git 仓库或 git 不可用时返回空集合——调用方据此退化为只提示。
export function inferAllowedPathsFromGit(root) {
  const paths = new Set();
  const commands = [
    ["diff", "--name-only", "HEAD"],
    ["ls-files", "--others", "--exclude-standard"],
  ];

  for (const args of commands) {
    try {
      const out = execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const line of out.split(/\r?\n/u)) {
        const value = line.trim();
        if (value) {
          paths.add(toPosixPath(value).replace(/\/+$/u, ""));
        }
      }
    } catch {
      // git 不可用或非仓库：忽略该来源。
    }
  }

  return paths;
}

export function phasePreconditionEvidenceLabel(precondition) {
  if (precondition?.enforcement === "required-evidence") {
    const evidence = precondition.evidence;
    if (evidence?.type === "file" && typeof evidence.path === "string" && evidence.path.trim()) {
      return `file evidence ${toPosixPath(evidence.path.trim())}`;
    }

    return "unsupported required evidence";
  }

  if (precondition?.enforcement === "required-capability") {
    const capability = requiredCapabilityName(precondition);
    const aliases = requiredCapabilityToolAliases(precondition);
    if (capability && aliases.length > 0) {
      return `capability ${capability} via ${aliases.join(" | ")}`;
    }
    if (capability) {
      return `capability ${capability}`;
    }
    return "unsupported required capability";
  }

  return "unsupported precondition";
}

export function requiredEvidenceSatisfied(state, root, precondition) {
  if (precondition?.enforcement !== "required-evidence") {
    return true;
  }

  const evidence = precondition.evidence;
  if (!evidence || evidence.type !== "file") {
    return false;
  }

  const evidencePath = evidence.path;
  if (typeof evidencePath !== "string" || !evidencePath.trim() || path.isAbsolute(evidencePath.trim())) {
    return false;
  }

  const taskRoot = taskPath(state, root);
  if (!taskRoot) {
    return false;
  }

  const resolved = path.resolve(taskRoot, evidencePath.trim());
  const relativeToTask = path.relative(taskRoot, resolved);
  if (relativeToTask.startsWith("..") || path.isAbsolute(relativeToTask)) {
    return false;
  }

  return fs.existsSync(resolved) && readTextIfExists(resolved).trim().length > 0;
}

export function requiredCapabilityName(precondition) {
  return typeof precondition?.capability === "string" ? precondition.capability.trim() : "";
}

export function requiredCapabilityToolAliases(precondition) {
  if (!Array.isArray(precondition?.tools)) {
    return [];
  }

  const aliases = [];
  for (const item of precondition.tools) {
    const value = typeof item === "string" ? item : item?.name;
    if (typeof value !== "string") {
      continue;
    }

    const alias = value.trim();
    if (alias) {
      aliases.push(alias);
    }
  }
  return aliases;
}

export function requiredCapabilityMatchesTool(precondition, toolName) {
  const normalizedTool = normalizeToolName(toolName);
  if (!normalizedTool) {
    return false;
  }

  return requiredCapabilityToolAliases(precondition).some((alias) => normalizeToolName(alias) === normalizedTool);
}

export function requiredCapabilitySatisfied(state, root, precondition, phase = state?.phase) {
  if (precondition?.enforcement !== "required-capability") {
    return true;
  }

  const key = requiredCapabilityKey(state, precondition, phase);
  if (!key) {
    return false;
  }

  const hookState = loadHookState(state, root);
  const summaries = Array.isArray(hookState.satisfiedCapabilities) ? hookState.satisfiedCapabilities : [];
  return summaries.some((summary) => sameCapabilityKey(summary, key));
}

export function matchingRequiredCapabilityPreconditions(state, root, phase, toolName) {
  if (!state?.activeTaskDir) {
    return [];
  }

  const registry = loadRegistry(root);
  return registryPhasePreconditions(registry, phase).filter(
    (pre) => pre?.enforcement === "required-capability" && requiredCapabilityMatchesTool(pre, toolName),
  );
}

export function recordRequiredCapabilityResult(state, root, event) {
  const matches = matchingRequiredCapabilityPreconditions(state, root, state?.phase, event?.toolName);
  if (matches.length === 0) {
    return null;
  }

  const at = new Date().toISOString();
  if (event.success === false) {
    const failures = matches.map((precondition) => capabilitySummary(state, precondition, event, at, "failed"));
    const lastCapabilityFailure = failures.length === 1 ? failures[0] : { failedAt: at, failures };
    saveHookState(state, { lastCapabilityFailure }, root);
    return { status: "failed", failures };
  }

  const summaries = matches.map((precondition) => capabilitySummary(state, precondition, event, at, "satisfied"));
  const hookState = loadHookState(state, root);
  const previous = Array.isArray(hookState.satisfiedCapabilities) ? hookState.satisfiedCapabilities : [];
  const next = previous.filter((item) => !summaries.some((summary) => sameCapabilityKey(item, summary)));
  next.push(...summaries);
  saveHookState(state, { satisfiedCapabilities: next }, root);
  return { status: "satisfied", summaries };
}

function capabilitySummary(state, precondition, event, at, status) {
  const summary = {
    taskDir: state.activeTaskDir,
    phase: state.phase,
    step: typeof precondition.step === "string" ? precondition.step.trim() : "",
    capability: requiredCapabilityName(precondition),
    toolName: typeof event?.toolName === "string" ? event.toolName : "",
    matchedAlias: matchedToolAlias(precondition, event?.toolName),
    platform: typeof event?.platform === "string" ? event.platform : "",
    action: typeof event?.action === "string" ? event.action : "",
  };

  if (status === "failed") {
    return {
      ...summary,
      failedAt: at,
      reason: event?.failureReason || "Tool call reported failure.",
    };
  }

  return {
    ...summary,
    satisfiedAt: at,
  };
}

function requiredCapabilityKey(state, precondition, phase = state?.phase) {
  const taskDir = state?.activeTaskDir;
  const step = typeof precondition?.step === "string" ? precondition.step.trim() : "";
  const capability = requiredCapabilityName(precondition);
  const phaseName = typeof phase === "string" ? phase.trim() : "";

  if (!taskDir || !phaseName || !step || !capability) {
    return null;
  }

  return {
    taskDir,
    phase: phaseName,
    step,
    capability,
  };
}

function sameCapabilityKey(left, right) {
  return (
    left?.taskDir === right?.taskDir &&
    left?.phase === right?.phase &&
    left?.step === right?.step &&
    left?.capability === right?.capability
  );
}

function matchedToolAlias(precondition, toolName) {
  const normalizedTool = normalizeToolName(toolName);
  return requiredCapabilityToolAliases(precondition).find((alias) => normalizeToolName(alias) === normalizedTool) || "";
}

function normalizeToolName(value) {
  return String(value || "").trim().toLowerCase();
}

// 项目声明的硬前置门禁（registry.phasePreconditions[phase]）中，尚未满足的项。
// 支持 required-evidence（非空文件证据）和 required-capability（成功工具调用）。
export function phasePreconditionsUnmet(state, root, phase) {
  if (!state?.activeTaskDir) {
    return [];
  }

  const registry = loadRegistry(root);
  return registryPhasePreconditions(registry, phase).filter((pre) => {
    if (pre?.enforcement === "required-evidence") {
      return !requiredEvidenceSatisfied(state, root, pre);
    }

    if (pre?.enforcement === "required-capability") {
      return !requiredCapabilitySatisfied(state, root, pre, phase);
    }

    return false;
  });
}
