#!/usr/bin/env node
import { runClaudeCodeHook } from "../adapters/claude-code.mjs";
import { hookFailureJson, printJson } from "../core/result.mjs";

runClaudeCodeHook().catch((error) => {
  printJson(hookFailureJson(error, process.argv[2], "SDLC Claude Code"));
});
