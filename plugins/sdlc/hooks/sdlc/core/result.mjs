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
  const key = normalizedEventName(eventName);

  if (key === "pretooluse") {
    return asCodexPreToolUseJson(result, eventName);
  }

  if (key === "permissionrequest") {
    return asCodexPermissionRequestJson(result, eventName);
  }

  if (key === "posttooluse") {
    return asCodexPostToolUseJson(result, eventName);
  }

  if (key === "sessionstart" || key === "userpromptsubmit") {
    return asCodexContextHookJson(result, eventName);
  }

  if (key === "precompact" || key === "postcompact") {
    return asCodexCommonHookJson(result);
  }

  if (key === "stop" || key === "subagentstop") {
    return asCodexStopHookJson(result);
  }

  return asHookJson(result, eventName);
}

export function codexHookFailureJson(error, eventName, label = "Codex") {
  if (isCodexNonBlockingFailureEvent(eventName)) {
    return {};
  }

  return asCodexHookJson(block(`SDLC ${label} hook failed: ${error.message}`), eventName);
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
  return isNonBlockingFailureEvent(eventName) || normalizedEventName(eventName) === "posttooluse";
}

function asCodexPreToolUseJson(result, eventName) {
  if (isBlocked(result)) {
    return {
      hookSpecificOutput: {
        hookEventName: eventName,
        permissionDecision: "deny",
        permissionDecisionReason: result.reason || result.message || "SDLC hook blocked this action.",
      },
    };
  }

  return withCodexSystemMessage({}, result);
}

function asCodexPermissionRequestJson(result, eventName) {
  if (isBlocked(result)) {
    return {
      hookSpecificOutput: {
        hookEventName: eventName,
        decision: {
          behavior: "deny",
          message: result.reason || result.message || "SDLC hook blocked this action.",
        },
      },
    };
  }

  return withCodexSystemMessage({}, result);
}

function asCodexPostToolUseJson(result, eventName) {
  const payload = {};
  if (isBlocked(result)) {
    payload.decision = "block";
    payload.reason = result.reason || result.message || "SDLC hook blocked this action.";
  }

  return withCodexSystemMessage(payload, result);
}

function asCodexContextHookJson(result, eventName) {
  const payload = withCodexAdditionalContext({}, result, eventName);
  if (isBlocked(result)) {
    payload.decision = "block";
    payload.reason = result.reason || result.message || "SDLC hook blocked this action.";
  }

  return withCodexSystemMessage(payload, result);
}

function asCodexCommonHookJson(result) {
  if (isBlocked(result)) {
    return {
      continue: false,
      stopReason: result.reason || result.message || "SDLC hook blocked this action.",
    };
  }

  return withCodexSystemMessage({}, result);
}

function asCodexStopHookJson(result) {
  if (isBlocked(result)) {
    return {
      decision: "block",
      reason: result.reason || result.message || "SDLC hook blocked this action.",
    };
  }

  return withCodexSystemMessage({}, result);
}

function withCodexAdditionalContext(payload, result, eventName) {
  if (!result.additionalContext) {
    return payload;
  }

  payload.hookSpecificOutput = {
    hookEventName: eventName,
    additionalContext: result.additionalContext,
  };
  return payload;
}

function withCodexSystemMessage(payload, result) {
  if (result.message && result.severity === "warning") {
    payload.systemMessage = result.message;
  }

  return payload;
}

function normalizedEventName(eventName) {
  return String(eventName || "").toLowerCase();
}

function isNonBlockingFailureEvent(eventName) {
  return NON_BLOCKING_FAILURE_EVENTS.has(String(eventName || "").toLowerCase());
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
