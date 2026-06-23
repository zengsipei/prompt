export function allow(message = "SDLC hook allowed.", extra = {}) {
  return {
    decision: "allow",
    severity: "info",
    message,
    ...extra,
  };
}

const NON_BLOCKING_FAILURE_EVENTS = new Set(["userpromptsubmit", "precompact", "postcompact"]);

export function warn(message, extra = {}) {
  return {
    decision: "allow",
    severity: "warning",
    message,
    ...extra,
  };
}

export function block(reason, extra = {}) {
  return {
    decision: "deny",
    severity: "error",
    reason,
    message: reason,
    ...extra,
  };
}

export function isBlocked(result) {
  return result?.decision === "deny" || result?.decision === "block";
}

export function asHookJson(result, eventName) {
  const payload = {
    decision: isBlocked(result) ? "deny" : "allow",
  };

  if (isBlocked(result)) {
    payload.reason = result.reason || result.message || "SDLC hook blocked this action.";
    return payload;
  }

  if (result.additionalContext) {
    payload.hookSpecificOutput = {
      hookEventName: eventName,
      additionalContext: result.additionalContext,
    };
  }

  if (result.message && result.severity === "warning") {
    payload.reason = result.message;
  }

  return payload;
}

export function asCodexHookJson(result, eventName) {
  if (isCodexPostToolUse(eventName)) {
    return {};
  }

  return asHookJson(result, eventName);
}

export function codexHookFailureJson(error, eventName, label = "Codex") {
  if (isCodexNonBlockingFailureEvent(eventName)) {
    return {};
  }

  return {
    decision: "deny",
    reason: `SDLC ${label} hook failed: ${error.message}`,
  };
}

export function hookFailureJson(error, eventName, label = "SDLC") {
  if (isNonBlockingFailureEvent(eventName)) {
    return {
      decision: "allow",
      reason: `${label} hook failed without blocking: ${error.message}`,
    };
  }

  return {
    decision: "deny",
    reason: `${label} hook failed: ${error.message}`,
  };
}

function isCodexNonBlockingFailureEvent(eventName) {
  return isNonBlockingFailureEvent(eventName) || isCodexPostToolUse(eventName);
}

function isCodexPostToolUse(eventName) {
  return String(eventName || "").toLowerCase() === "posttooluse";
}

function isNonBlockingFailureEvent(eventName) {
  return NON_BLOCKING_FAILURE_EVENTS.has(String(eventName || "").toLowerCase());
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
