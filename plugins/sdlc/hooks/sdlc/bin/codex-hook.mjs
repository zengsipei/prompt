#!/usr/bin/env node
import { runCodexHook } from "../adapters/codex.mjs";
import { codexHookFailureJson, printJson } from "../core/result.mjs";

runCodexHook().catch((error) => {
  printJson(codexHookFailureJson(error, process.argv[2], "Codex"));
});
