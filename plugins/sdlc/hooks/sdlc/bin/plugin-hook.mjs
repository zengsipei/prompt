#!/usr/bin/env node
import { runClaudeCodeHook } from "../adapters/claude-code.mjs";
import { runCodexHook } from "../adapters/codex.mjs";
import { codexHookFailureJson, hookFailureJson, printJson } from "../core/result.mjs";

const isCodexPlugin = Boolean(process.env.PLUGIN_ROOT);
const runner = isCodexPlugin ? runCodexHook : runClaudeCodeHook;
const label = isCodexPlugin ? "Codex" : "Claude Code";

runner().catch((error) => {
  if (isCodexPlugin) {
    printJson(codexHookFailureJson(error, process.argv[2], `${label} plugin`));
    return;
  }

  printJson(hookFailureJson(error, process.argv[2], `SDLC ${label} plugin`));
});
