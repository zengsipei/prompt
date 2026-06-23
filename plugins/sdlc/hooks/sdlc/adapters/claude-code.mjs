import { evaluate } from "../core/rules.mjs";
import { isBlocked, printJson } from "../core/result.mjs";
import { inferTargetPaths, inferToolAction, inferToolFailureReason, inferToolSuccess, readStdinJson } from "./common.mjs";

// Claude Code 的 hook 决策合同是分事件的，与平台中立的 core/result.mjs 不同：
// - PreToolUse：top-level `decision` 已废弃，须用嵌套 hookSpecificOutput.permissionDecision（allow/deny/ask）。
// - Stop / PostToolUse：仍以 top-level `decision` / `reason` 为当前格式。
// - SessionStart / UserPromptSubmit / PreCompact / PostCompact：hookSpecificOutput.additionalContext 注入。
// allow 一律映射为「不下决策」（空对象，或仅 systemMessage 软提示），绝不发 permissionDecision:"allow"——
// 那会强制批准、绕过用户自己的权限系统。见 docs/adr/0002。
const CONTEXT_INJECTION_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact"]);

export function asClaudeHookJson(result, eventName) {
  const blocked = isBlocked(result);
  const reason = result.reason || result.message || "SDLC hook blocked this action.";
  const isWarning = result.severity === "warning" && Boolean(result.message);

  if (eventName === "PreToolUse") {
    if (blocked) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      };
    }
    return isWarning ? { systemMessage: result.message } : {};
  }

  if (CONTEXT_INJECTION_EVENTS.has(eventName)) {
    if (result.additionalContext) {
      return {
        hookSpecificOutput: {
          hookEventName: eventName,
          additionalContext: result.additionalContext,
        },
      };
    }
    return isWarning ? { systemMessage: result.message } : {};
  }

  // Stop / PostToolUse / 其它：top-level decision 仍为当前格式。
  if (blocked) {
    return { decision: "block", reason };
  }
  return isWarning ? { systemMessage: result.message } : {};
}

const EVENT_MAP = {
  SessionStart: "session.start",
  UserPromptSubmit: "prompt.submit",
  PreCompact: "compact.before",
  PostCompact: "compact.after",
  PreToolUse: "tool.before",
  PostToolUse: "tool.after",
  Stop: "session.stop",
};

export function normalizeClaudeCodeEventName(eventName, payload = {}) {
  return (
    EVENT_MAP[eventName] ||
    EVENT_MAP[payload.hook_event_name] ||
    EVENT_MAP[payload.hookEventName] ||
    eventName
  );
}

export async function runClaudeCodeHook(argv = process.argv.slice(2)) {
  const eventName = argv[0] || "unknown";
  const payload = await readStdinJson();
  const input = payload.tool_input || payload.toolInput || payload.args || payload.arguments || {};
  const toolName = payload.tool_name || payload.toolName || payload.name;
  const internalName = normalizeClaudeCodeEventName(eventName, payload);

  const event = {
    name: internalName,
    platform: "claude-code",
    rawEventName: eventName,
    toolName,
    action: inferToolAction(toolName, input),
    targetPaths: inferTargetPaths(toolName, input),
    command: input.command,
    success: inferToolSuccess(payload),
    failureReason: inferToolFailureReason(payload),
    payload,
  };

  const result = evaluate(event);
  printJson(asClaudeHookJson(result, eventName));
}
