import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gateLevel, loadCurrentState, recordEvent, saveHookState, workspaceRoot } from "./context.mjs";
import {
  implementationAllowedPaths,
  isAllowedImplementationPath,
  isLifecyclePath,
  pendingConfirmations,
  phaseCompletion,
  phasePreconditionsUnmet,
  sdlcProfile,
} from "./artifacts.mjs";
import { allow, block, warn } from "./result.mjs";
import { detectRedline } from "./redlines.mjs";

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

const BOOTSTRAP_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bootstrap.md");

function readBootstrap() {
  try {
    return fs.readFileSync(BOOTSTRAP_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

// SessionStart 注入：共享 bootstrap（角色+红线+约束优先级+路由索引+降级总则）+ 当前生命周期状态。
// 两端（Codex/Claude）同源交付——这是双端 bootstrap 的 SSOT。
export function sessionContextMessage(state) {
  const lines = [];
  const bootstrap = readBootstrap();
  if (bootstrap) {
    lines.push(bootstrap, "");
  }

  if (!state) {
    lines.push(
      "SDLC 生命周期尚未初始化（本仓库无 docs/_sdlc/current.json）。",
      "改源码前先经路由 skill `software-dev-process` 走 init 轻声明一次。",
    );
  } else {
    lines.push(
      `当前任务：${state.activeTaskDir || "未设置"}　阶段：${state.phase || "未设置"}　profile：${state.profile || "standard"}`,
      "流程顺序可偏离（软，会留痕）；红线 / 施工边界 / 待确认 / 项目声明的前置门禁会被硬拦。",
    );
  }

  return lines.join("\n");
}

export function evaluate(event, options = {}) {
  const root = workspaceRoot(options);
  const state = options.state || loadCurrentState(root);
  const normalizedEvent = {
    targetPaths: [],
    ...event,
  };

  let result;
  switch (normalizedEvent.name) {
    case "session.start":
      result = allow("Injected SDLC lifecycle context.", {
        additionalContext: sessionContextMessage(state),
      });
      break;
    case "tool.before":
      result = evaluateBeforeTool(normalizedEvent, state, root);
      break;
    case "tool.after":
      result = allow("Recorded SDLC hook event.");
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
      recordEvent(normalizedEvent, result, root);
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

function shouldRecordEvent(event, state) {
  if (event.name !== "session.start") {
    return true;
  }

  return state?.recordSessionStart === true || isTruthyEnv(process.env.SDLC_RECORD_SESSION_START);
}

function isTruthyEnv(value) {
  return /^(1|true|yes|on)$/iu.test(String(value || "").trim());
}

function evaluateBeforeTool(event, state, root) {
  // 0) 红线优先于一切——破坏性操作恒 block，不看 state / phase / profile。
  const redline = detectRedline(event);
  if (redline) {
    return redline;
  }

  if (!WRITE_ACTIONS.has(event.action) && event.action !== "command.exec") {
    return allow("Read-only or unknown-safe action.");
  }

  const paths = event.targetPaths || [];
  const sourceWrite = WRITE_ACTIONS.has(event.action) && paths.some((target) => !isLifecyclePath(target, state));

  // 1) 无 state：开局轻声明一次（§8）。只拦写源码 / 写类命令；读类命令放行。
  if (!state) {
    const writeLikeCommand = event.action === "command.exec" && looksWriteLikeCommand(event.command || "");
    if (sourceWrite || writeLikeCommand) {
      return block(
        [
          "SDLC lifecycle is not initialized.",
          "Create docs/_sdlc/current.json or run init via the router skill `software-dev-process`:",
          "node <SDLC_RUNTIME>/hooks/sdlc/bin/sdlc-hook.mjs init --task-dir docs/[task-dir] --system [system-name] --profile lite|standard|full",
          "Source edits and write-like commands need lifecycle state first.",
        ].join("\n"),
      );
    }
    return allow("No lifecycle state; non-source action allowed.");
  }

  const profile = sdlcProfile(state);

  if (event.action === "command.exec") {
    return evaluateCommand(event, state, profile);
  }

  // 只有触及非生命周期文件（≈源码）才进入硬/软门禁；改任务文档恒放行。
  const touchesSource = paths.some((target) => !isLifecyclePath(target, state));
  if (!touchesSource) {
    return allow("Lifecycle document edit allowed.");
  }

  // 2) pending 待确认——硬拦（恒 block）。
  const pending = pendingConfirmations(state, root);
  if (pending.length > 0) {
    return block(
      [
        "待确认文档未处理，源码编辑被硬拦。",
        `待确认：${pending.map((item) => item.name).join(", ")}`,
        "先把待确认文档处理完（标记“状态：已处理”/“决策状态：已决策”），再重试。",
      ].join("\n"),
    );
  }

  // 3) 项目声明的硬前置门禁（按当前阶段）——硬拦。流程灵活后，声明的必做动作不降级为建议。
  const unmet = phasePreconditionsUnmet(state, root, state.phase);
  if (unmet.length > 0) {
    return block(
      [
        `当前阶段 ${state.phase} 有项目声明的前置门禁未满足：`,
        ...unmet.map((item) => `- 需先产出 ${item.requireArtifact}${item.reason ? `（${item.reason}）` : ""}`),
        "这是项目通过 registry 声明的硬约束，先完成前置动作再改源码。",
      ].join("\n"),
    );
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

function evaluateCommand(event, state, profile) {
  const command = event.command || "";
  if (!looksWriteLikeCommand(command)) {
    return allow("Command does not look like a filesystem write.");
  }

  const paths = event.targetPaths || [];
  const sourceTargets = paths.filter((target) => !isLifecyclePath(target, state));

  // 设计期的写类命令触及源码：软提示（不再 block，红线已在前面拦掉危险命令）。
  if (sourceTargets.length > 0 && state.phase === "design" && gateLevel(profile, "designSourceEdit") !== "off") {
    return warn(
      `design 阶段的写类命令触及源码：${sourceTargets.join(", ")}。允许，但建议尽快补齐设计产物或进入 implement。`,
    );
  }

  return allow("Write-like command passed SDLC checks.");
}

// phase.set / phase.enter：恒放行（仪式吸收进 skill）。仅就“跳级”与“未满足前置”给软提示。
function evaluatePhaseSet(event, state, root) {
  if (!state) {
    return block("Cannot set a phase before lifecycle is initialized (run init).");
  }

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
      `注意：${target} 有项目前置门禁未满足：${unmet.map((item) => item.requireArtifact).join(", ")}（改源码时会被硬拦）。`,
    );
  }

  return messages.length > 0 ? warn(messages.join("\n")) : allow(`Phase set: ${target}.`);
}

function evaluateStop(event, state, root, options = {}) {
  if (!state) {
    return allow("No active SDLC lifecycle state.");
  }

  const profile = sdlcProfile(state);
  const phase = event.phase || state.phase;
  const complete = phaseCompletion(state, root);
  const pending = pendingConfirmations(state, root);

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
