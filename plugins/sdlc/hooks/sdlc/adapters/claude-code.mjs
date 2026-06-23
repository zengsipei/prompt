import { evaluate } from "../core/rules.mjs";
import { asHookJson, printJson } from "../core/result.mjs";
import { inferTargetPaths, inferToolAction, inferToolFailureReason, inferToolSuccess, readStdinJson } from "./common.mjs";

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
  printJson(asHookJson(result, eventName));
}
