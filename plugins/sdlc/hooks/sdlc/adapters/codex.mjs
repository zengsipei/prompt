import { evaluate } from "../core/rules.mjs";
import { asCodexHookJson, printJson } from "../core/result.mjs";
import { inferTargetPaths, inferToolAction, inferToolFailureReason, inferToolSuccess, readStdinJson } from "./common.mjs";

const EVENT_MAP = {
  sessionStart: "session.start",
  SessionStart: "session.start",
  userPromptSubmit: "prompt.submit",
  UserPromptSubmit: "prompt.submit",
  preCompact: "compact.before",
  PreCompact: "compact.before",
  postCompact: "compact.after",
  PostCompact: "compact.after",
  preToolUse: "tool.before",
  PreToolUse: "tool.before",
  postToolUse: "tool.after",
  PostToolUse: "tool.after",
  stop: "session.stop",
  Stop: "session.stop",
};

export function normalizeCodexEventName(eventName, payload = {}) {
  return (
    EVENT_MAP[eventName] ||
    EVENT_MAP[payload.hookEventName] ||
    EVENT_MAP[payload.eventName] ||
    eventName
  );
}

export async function runCodexHook(argv = process.argv.slice(2)) {
  const eventName = argv[0] || "unknown";
  const payload = await readStdinJson();
  const input = payload.tool_input || payload.toolInput || payload.args || payload.arguments || payload.params || {};
  const toolName = payload.tool_name || payload.toolName || payload.name || payload.tool?.name;
  const internalName = normalizeCodexEventName(eventName, payload);

  const event = {
    name: internalName,
    platform: "codex",
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
  printJson(asCodexHookJson(result, eventName));
}
