import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { evaluate } from "../core/rules.mjs";
import { allow, asCodexHookJson, asHookJson, block, codexHookFailureJson, hookFailureJson, warn } from "../core/result.mjs";
import { currentStatePath, eventsPath, hookStatePath, loadCurrentState, readJsonIfExists, writeJson } from "../core/context.mjs";
import { applyManualRename, currentSessionId, diagnosticsPath, recordInferredSessionName, sessionPath } from "../core/session.mjs";
import {
  implementationAllowedPaths,
  inferAllowedPathsFromGit,
  phaseCompletion,
  phasePreconditionsUnmet,
} from "../core/artifacts.mjs";
import { loadRegistry, resolveStep } from "../core/registry.mjs";
import { closeDebug, closeTask, renameSession, setPhase, statusPayload } from "../adapters/manual.mjs";
import { DIAGNOSTICS_LOCATION, nextAction, shortStatusMessage } from "../core/status.mjs";
import { RUNTIME_ROOT, hookCommand, resolveRuntimeRoot } from "../core/runtime.mjs";
import {
  GENERATE_HOOK_CONFIGS_COMMAND,
  checkGeneratedHookArtifacts,
  generatedHookArtifacts,
  readHookManifest,
} from "../core/hook-config-generator.mjs";
import { normalizeCodexEventName } from "../adapters/codex.mjs";
import { asClaudeHookJson, normalizeClaudeCodeEventName } from "../adapters/claude-code.mjs";
import { inferTargetPaths } from "../adapters/common.mjs";

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sdlc-hooks-"));
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function readEvents(root) {
  const filePath = eventsPath(root);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function seedCurrent(root, overrides = {}) {
  const state = {
    activeTaskDir: "docs/login-fix",
    phase: "design",
    mode: "enforce",
    strict: true,
    stopGate: "warn",
    systemName: "用户中心",
    ...overrides,
  };
  writeJson(path.join(root, "docs", "_sdlc", "current.json"), state);
  fs.mkdirSync(path.join(root, "docs", "login-fix", "onlyAI"), { recursive: true });
  return state;
}

function event(extra) {
  return {
    name: "tool.before",
    platform: "test",
    action: "fs.edit",
    targetPaths: ["src/login.ts"],
    ...extra,
  };
}

const pollutedApplyPatchPayload = `*** Begin Patch
*** Update File: server.js
@@
-const lifecycleFiles = [];
+const lifecycleFiles = [
+  "current.json",
+  "hook-events.ndjson",
+  "registry.json",
+  "001-概要设计.md",
+];
+const render = (task) => task.items.map((item) => ({
+  id: item.id,
+  label: \`<span>{\${item.name}}</span>\`,
+}));
*** End Patch`;

function run() {
  // hook 配置生成物不得从中性 manifest 漂移。
  {
    const drift = checkGeneratedHookArtifacts(RUNTIME_ROOT);
    assert.deepEqual(
      drift,
      [],
      `Generated hook configs are out of date: ${drift.join(", ")}. Run: ${GENERATE_HOOK_CONFIGS_COMMAND}`,
    );

    const generated = generatedHookArtifacts(readHookManifest(RUNTIME_ROOT));
    assert.ok(generated.has("hooks/codex-hooks.json"));
    assert.ok(generated.has("hooks/claude-hooks.json"));
    assert.ok(generated.get("hooks/codex-hooks.json").includes("UserPromptSubmit"));
    assert.ok(generated.get("hooks/codex-hooks.json").includes("PreCompact"));
    assert.ok(generated.get("hooks/codex-hooks.json").includes("PostCompact"));
    assert.ok(!generated.get("hooks/codex-hooks.json").includes("SubagentStart"));
    assert.ok(!generated.get("hooks/codex-hooks.json").includes("SubagentStop"));
    assert.ok(!generated.get("hooks/claude-hooks.json").includes("SubagentStart"));
    assert.ok(!generated.get("hooks/claude-hooks.json").includes("SubagentStop"));
  }

  // runtime 根解析：自解析落在真实运行时（含 CLI 入口，验证上溯路径正确）；override 生效；
  // hookCommand 给出可执行真实命令，不含未解析占位符。
  {
    assert.ok(RUNTIME_ROOT.length > 0, "RUNTIME_ROOT 非空");
    assert.ok(
      fs.existsSync(path.join(RUNTIME_ROOT, "hooks", "sdlc", "bin", "sdlc-hook.mjs")),
      "RUNTIME_ROOT 应指向含 CLI 入口的真实运行时根",
    );
    assert.equal(resolveRuntimeRoot(), RUNTIME_ROOT);
    assert.equal(resolveRuntimeRoot("/custom/root"), "/custom/root");
    assert.equal(hookCommand(), `node "${RUNTIME_ROOT}/hooks/sdlc/bin/sdlc-hook.mjs"`);
    assert.ok(!hookCommand().includes("<"), "hookCommand 不含未解析占位符");
  }

  // 结果序列化原语（result.mjs 未改）。
  {
    const allowed = allow("ok");
    assert.deepEqual(asHookJson(allowed, "PostToolUse"), { decision: "allow" });
    assert.deepEqual(asCodexHookJson(allowed, "PostToolUse"), {});
    assert.deepEqual(asCodexHookJson(allowed, "PreToolUse"), {});
    assert.deepEqual(asCodexHookJson(allowed, "Stop"), {});
    assert.deepEqual(asCodexHookJson(warn("阶段未完成"), "Stop"), { systemMessage: "阶段未完成" });
    assert.deepEqual(asCodexHookJson(block("阶段未完成"), "Stop"), {
      decision: "block",
      reason: "阶段未完成",
    });
    assert.deepEqual(asCodexHookJson(allow("ok", { additionalContext: "ctx" }), "UserPromptSubmit"), {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "ctx",
      },
    });
    assert.deepEqual(codexHookFailureJson(new Error("boom"), "PostToolUse"), {});
    assert.deepEqual(codexHookFailureJson(new Error("boom"), "PreToolUse"), {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "SDLC Codex hook failed: boom",
      },
    });
    assert.deepEqual(codexHookFailureJson(new Error("boom"), "UserPromptSubmit"), {});
    assert.deepEqual(hookFailureJson(new Error("boom"), "UserPromptSubmit", "SDLC Claude Code"), {
      decision: "allow",
      reason: "SDLC Claude Code hook failed without blocking: boom",
    });
    assert.deepEqual(hookFailureJson(new Error("boom"), "PreCompact", "SDLC Claude Code"), {
      decision: "allow",
      reason: "SDLC Claude Code hook failed without blocking: boom",
    });
  }

  // Codex 适配层分事件合同：Codex hooks 不是统一 allow/deny JSON。
  {
    assert.deepEqual(asCodexHookJson(block("待确认未处理"), "PreToolUse"), {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "待确认未处理",
      },
    });
    assert.deepEqual(asCodexHookJson(warn("设计期改源码"), "PreToolUse"), {
      systemMessage: "设计期改源码",
    });
    assert.deepEqual(asCodexHookJson(allow("ok", { additionalContext: "ctx" }), "SessionStart"), {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "ctx" },
    });
    assert.deepEqual(asCodexHookJson(warn("prompt guidance"), "UserPromptSubmit"), {
      systemMessage: "prompt guidance",
    });
    assert.deepEqual(asCodexHookJson(block("prompt blocked"), "UserPromptSubmit"), {
      decision: "block",
      reason: "prompt blocked",
    });
    assert.deepEqual(asCodexHookJson(warn("pre compact warning"), "PreCompact"), {
      systemMessage: "pre compact warning",
    });
    assert.deepEqual(asCodexHookJson(block("pre compact blocked"), "PreCompact"), {
      continue: false,
      stopReason: "pre compact blocked",
    });
    assert.deepEqual(asCodexHookJson(warn("post compact warning"), "PostCompact"), {
      systemMessage: "post compact warning",
    });
    assert.deepEqual(asCodexHookJson(allow("ok", { additionalContext: "ctx" }), "PreToolUse"), {});
    assert.deepEqual(asCodexHookJson(allow("ok", { additionalContext: "ctx" }), "PostToolUse"), {});
    assert.deepEqual(asCodexHookJson(block("tool feedback"), "PostToolUse"), {
      decision: "block",
      reason: "tool feedback",
    });
    assert.deepEqual(asCodexHookJson(block("permission denied"), "PermissionRequest"), {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny",
          message: "permission denied",
        },
      },
    });
  }

  // Claude 适配层分事件合同（asClaudeHookJson）：PreToolUse 用嵌套 permissionDecision；Stop 用 top-level block；
  // 注入事件用 hookSpecificOutput.additionalContext；allow 不强批（空对象/仅 systemMessage）。见 docs/adr/0002。
  {
    // PreToolUse block → 嵌套 permissionDecision: deny（不是 top-level deny，否则 Claude 忽略、拦不住）。
    assert.deepEqual(asClaudeHookJson(block("待确认未处理"), "PreToolUse"), {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "待确认未处理",
      },
    });
    // PreToolUse allow → 空对象（绝不发 permissionDecision:"allow"，否则强批绕过用户权限系统）。
    assert.deepEqual(asClaudeHookJson(allow("ok"), "PreToolUse"), {});
    // PreToolUse warn → systemMessage 软提示，不阻断。
    assert.deepEqual(asClaudeHookJson(warn("设计期改源码"), "PreToolUse"), { systemMessage: "设计期改源码" });
    // SessionStart 注入 → hookSpecificOutput.additionalContext（无 top-level decision）。
    assert.deepEqual(asClaudeHookJson(allow("ok", { additionalContext: "ctx" }), "SessionStart"), {
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "ctx" },
    });
    // 未初始化 SessionStart（allow 无 ctx）→ 空对象，静默。
    assert.deepEqual(asClaudeHookJson(allow("inactive"), "SessionStart"), {});
    // UserPromptSubmit 注入 → additionalContext。
    assert.deepEqual(asClaudeHookJson(allow("ok", { additionalContext: "guide" }), "UserPromptSubmit"), {
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "guide" },
    });
    // Stop block → top-level decision: block（Stop / PostToolUse 仍以 top-level 为当前格式）。
    assert.deepEqual(asClaudeHookJson(block("阶段未完成"), "Stop"), { decision: "block", reason: "阶段未完成" });
    // Stop warn → systemMessage；PostToolUse allow → 空对象。
    assert.deepEqual(asClaudeHookJson(warn("阶段未完成"), "Stop"), { systemMessage: "阶段未完成" });
    assert.deepEqual(asClaudeHookJson(allow("recorded"), "PostToolUse"), {});
  }

  // 平台事件名归一化：prompt / compact 进入中性内部事件。
  {
    assert.equal(normalizeCodexEventName("UserPromptSubmit"), "prompt.submit");
    assert.equal(normalizeCodexEventName("preCompact"), "compact.before");
    assert.equal(normalizeCodexEventName("postCompact"), "compact.after");
    assert.equal(normalizeCodexEventName("unknown", { hookEventName: "PreCompact" }), "compact.before");
    assert.equal(normalizeClaudeCodeEventName("UserPromptSubmit"), "prompt.submit");
    assert.equal(normalizeClaudeCodeEventName("PreCompact"), "compact.before");
    assert.equal(normalizeClaudeCodeEventName("PostCompact"), "compact.after");
    assert.equal(normalizeClaudeCodeEventName("unknown", { hook_event_name: "PostCompact" }), "compact.after");
  }

  // session.start 默认不记事件。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "design" });
    const result = evaluate({ name: "session.start", platform: "test" }, { cwd: root });
    assert.equal(result.decision, "allow");
    assert.equal(readEvents(root), "");
  }

  // session.start 建立轻量会话记录（active-task 状态），即便事件流默认不记。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement" });
    evaluate({ name: "session.start", platform: "test" }, { cwd: root });

    const session = readJsonIfExists(sessionPath(root), null);
    assert.ok(session, "session.start 应写 docs/_sdlc/session.json");
    assert.ok(typeof session.sessionId === "string" && session.sessionId.length > 0, "应生成 sessionId");
    assert.equal(session.active, true);
    assert.equal(session.activeTaskDir, "docs/login-fix");
    assert.equal(session.phase, "implement");
    // 仅建会话记录，不写事件流（与上面的默认不记一致）。
    assert.equal(readEvents(root), "");
  }

  // idle/closed 状态：session.start 仍建会话记录，但标记 inactive，不复活上一个任务。
  {
    const root = makeWorkspace();
    seedCurrent(root, { activeTaskDir: null, phase: "closed" });
    evaluate({ name: "session.start", platform: "test" }, { cwd: root });

    const session = readJsonIfExists(sessionPath(root), null);
    assert.ok(session, "idle/closed 也应建会话记录");
    assert.ok(session.sessionId.length > 0);
    assert.equal(session.active, false);
    assert.equal(session.activeTaskDir, null);
    assert.equal(session.phase, "closed");
  }

  // 后续事件归属到当前 session，写紧凑结构化摘要；完整长诊断分流到 session-diagnostics.json。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "test" });
    evaluate({ name: "session.start", platform: "test" }, { cwd: root });
    const sessionId = currentSessionId(root);
    assert.ok(sessionId, "session.start 后应能读到当前 session id");

    evaluate(
      { name: "tool.before", platform: "test", action: "fs.edit", targetPaths: ["src/login.ts", "src/auth.ts"] },
      { cwd: root },
    );

    const lines = readEvents(root).trim().split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.event, "tool.before");
    assert.equal(last.sessionId, sessionId, "事件应携带当前 session id");
    assert.equal(last.pathCount, 2, "紧凑摘要用 pathCount 取代完整 targetPaths");
    assert.equal(last.detail, "docs/_sdlc/session-diagnostics.json", "事件流应指向详细诊断位置");
    assert.equal(last.targetPaths, undefined, "事件流不再内联完整路径");
    assert.equal(last.message, undefined, "事件流不再写长 message");
    assert.equal(typeof last.summary, "string");

    const diag = readJsonIfExists(diagnosticsPath(root), null);
    assert.ok(diag, "应写 docs/_sdlc/session-diagnostics.json");
    assert.equal(diag.latest.event, "tool.before");
    assert.equal(diag.latest.sessionId, sessionId);
    assert.deepEqual(diag.latest.targetPaths, ["src/login.ts", "src/auth.ts"], "详细诊断保留完整路径");
    assert.ok(typeof diag.latest.message === "string" && diag.latest.message.length > 0, "详细诊断保留完整 message");
    assert.ok(Array.isArray(diag.history) && diag.history.length >= 1);
    assert.equal(diag.history[0].event, "tool.before", "history 最新在前");
  }

  // 诊断 history 是「小滚动历史」：超过上限只留最近 N 条，且 latest / history[0] 是最新一条。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "test" });
    evaluate({ name: "session.start", platform: "test" }, { cwd: root });
    for (let i = 0; i < 25; i += 1) {
      evaluate(
        { name: "tool.after", platform: "test", action: "fs.edit", targetPaths: [`src/file-${i}.ts`], success: true },
        { cwd: root },
      );
    }

    const diag = readJsonIfExists(diagnosticsPath(root), null);
    assert.ok(diag.history.length <= 20, "history 不应无界增长");
    assert.equal(diag.latest.targetPaths[0], "src/file-24.ts", "latest 是最近一条");
    assert.equal(diag.history[0].targetPaths[0], "src/file-24.ts", "history 倒序，最新在前");
  }

  // 新的 session.start 生成新 session id，后续事件归属切换到新会话。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "test" });
    evaluate({ name: "session.start", platform: "test" }, { cwd: root });
    const first = currentSessionId(root);
    evaluate({ name: "session.start", platform: "test" }, { cwd: root });
    const second = currentSessionId(root);
    assert.ok(first && second, "两次 session.start 都应有 id");
    assert.notEqual(first, second, "每个 session.start 是一个新会话");

    evaluate(
      { name: "tool.after", platform: "test", action: "fs.edit", targetPaths: ["src/x.ts"], success: true },
      { cwd: root },
    );
    const lines = readEvents(root).trim().split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.sessionId, second, "事件应归属到最新会话");
  }

  // 未初始化项目：全局 hook 被触发也直接 no-op，不注入、不拦截、不写 docs/_sdlc。
  {
    const root = makeWorkspace();
    const events = [
      { name: "session.start", platform: "test" },
      { name: "prompt.submit", platform: "test", rawEventName: "UserPromptSubmit" },
      { name: "compact.before", platform: "test", rawEventName: "PreCompact" },
      { name: "compact.after", platform: "test", rawEventName: "PostCompact" },
      { name: "tool.before", platform: "test", action: "fs.edit", targetPaths: ["src/login.ts"] },
      { name: "tool.after", platform: "test", action: "fs.edit", targetPaths: ["src/login.ts"], success: true },
      { name: "session.stop", platform: "test" },
    ];

    for (const item of events) {
      const result = evaluate(item, { cwd: root });
      assert.equal(result.decision, "allow");
      assert.equal(result.severity, "info");
      assert.equal(result.additionalContext, undefined);
      assert.equal(result.reason, undefined);
    }

    assert.equal(readEvents(root), "");
    assert.equal(fs.existsSync(path.join(root, "docs", "_sdlc")), false);
  }

  // prompt.submit：注入与 status --short 同源的紧凑视图（≤4 行）并留痕，不阻断用户 prompt。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "pending", allowedPaths: ["src/login.ts"] }],
    });

    const result = evaluate({ name: "prompt.submit", platform: "test", rawEventName: "UserPromptSubmit" }, { cwd: root });
    assert.equal(result.decision, "allow");
    assert.ok(result.additionalContext.split("\n").length <= 4, "prompt 注入紧凑视图 ≤4 行");
    assert.doesNotMatch(result.additionalContext, /advisory/u, "不再注入旧的多行 advisory guidance");
    assert.match(result.additionalContext, /docs\/_sdlc\/session-diagnostics\.json/u, "紧凑视图含诊断位置");
    assert.match(result.additionalContext, /docs\/login-fix/u, "紧凑视图含活动任务");
    assert.match(readEvents(root), /"event":"prompt.submit"/u);
  }

  // compact.before / compact.after：保存并恢复短运行时摘要，且 prompt/compact 事件只写 debug 留痕。
  {
    const root = makeWorkspace();
    const state = seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "_sdlc", "registry.json"), {
      phasePreconditions: {
        implement: [
          {
            step: "locate-code",
            enforcement: "required-evidence",
            evidence: { type: "file", path: "onlyAI/locate-code.md" },
          },
        ],
      },
    });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });

    const saved = evaluate({ name: "compact.before", platform: "test", rawEventName: "PreCompact" }, { cwd: root });
    assert.equal(saved.decision, "allow");
    assert.match(saved.additionalContext, /SDLC compact runtime summary/u);

    const hookState = readJsonIfExists(hookStatePath(state, root), {});
    assert.equal(hookState.compactSummary.activeTaskDir, "docs/login-fix");
    assert.equal(hookState.compactSummary.phase, "implement");
    assert.deepEqual(hookState.compactSummary.unmetPreconditions, ["file evidence onlyAI/locate-code.md"]);
    assert.ok(hookState.compactSummary.satisfiedCapabilities.includes("lifecycle-state"));
    assert.ok(hookState.compactSummary.satisfiedCapabilities.includes("machine-readable-task-plan"));
    assert.ok(hookState.compactSummary.satisfiedCapabilities.includes("implementation-boundary"));

    const restored = evaluate({ name: "compact.after", platform: "test", rawEventName: "PostCompact" }, { cwd: root });
    assert.equal(restored.decision, "allow");
    assert.match(restored.additionalContext, /file evidence onlyAI\/locate-code.md/u);

    const events = readEvents(root);
    assert.match(events, /"event":"compact.before"/u);
    assert.match(events, /"event":"compact.after"/u);
    assert.equal(fs.existsSync(path.join(root, "docs", "login-fix", "001-概要设计.md")), false);
    assert.equal(fs.existsSync(path.join(root, "docs", "login-fix", "summary.md")), false);
  }

  // 红线：在已初始化 SDLC 项目内恒 block，优先于一切。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "design" });
    const del = evaluate(
      { name: "tool.before", platform: "test", action: "fs.delete", targetPaths: ["package.json"] },
      { cwd: root },
    );
    assert.equal(del.decision, "deny");
    assert.match(del.reason, /红线/u);

    const push = evaluate(
      { name: "tool.before", platform: "test", action: "command.exec", command: "git push origin main", targetPaths: [] },
      { cwd: root },
    );
    assert.equal(push.decision, "deny");
    assert.match(push.reason, /主分支/u);

    const drop = evaluate(
      {
        name: "tool.before",
        platform: "test",
        action: "command.exec",
        command: "mysql -e 'DROP TABLE users'",
        targetPaths: [],
      },
      { cwd: root },
    );
    assert.equal(drop.decision, "deny");
    assert.match(drop.reason, /DROP/u);
  }

  // 设计期改源码：standard → warn 放行 + 留痕（不再 block）；lite → 静默放行。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "design", profile: "standard" });
    const warned = evaluate(event(), { cwd: root });
    assert.equal(warned.decision, "allow");
    assert.equal(warned.severity, "warning");
    assert.match(warned.message, /design 阶段/u);

    seedCurrent(root, { phase: "design", profile: "lite" });
    const silent = evaluate(event(), { cwd: root });
    assert.equal(silent.decision, "allow");
    assert.equal(silent.severity, "info");
  }

  // implement 施工边界：声明集内放行，越界按 profile 硬拦。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      allowedPaths: ["src/shared.ts"],
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts", "README.md"] }],
    });

    assert.equal(evaluate(event({ targetPaths: ["src/login.ts"] }), { cwd: root }).decision, "allow");
    assert.equal(evaluate(event({ targetPaths: ["src/shared.ts"] }), { cwd: root }).decision, "allow");
    const blocked = evaluate(event({ targetPaths: ["src/other.ts"] }), { cwd: root });
    assert.equal(blocked.decision, "deny");
    assert.match(blocked.reason, /施工边界/u);
  }

  // Codex apply_patch：只从真实 patch header 推断目标，不把 patch body 当 shell command 路径扫描。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["server.js"] }],
    });

    const targetPaths = inferTargetPaths("apply_patch", { command: pollutedApplyPatchPayload }, root);
    assert.deepEqual(targetPaths, ["server.js"]);

    const allowed = evaluate(
      event({ platform: "codex", toolName: "apply_patch", action: "fs.edit", targetPaths }),
      { cwd: root },
    );
    assert.equal(allowed.decision, "allow");
  }

  // Codex apply_patch：越界 patch header 仍会被 implement 施工边界硬拦。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["server.js"] }],
    });

    const targetPaths = inferTargetPaths(
      "apply_patch",
      {
        command: `*** Begin Patch
*** Update File: src/outside.js
@@
-export const value = 1;
+export const value = 2;
*** End Patch`,
      },
      root,
    );
    assert.deepEqual(targetPaths, ["src/outside.js"]);

    const blocked = evaluate(
      event({ platform: "codex", toolName: "apply_patch", action: "fs.edit", targetPaths }),
      { cwd: root },
    );
    assert.equal(blocked.decision, "deny");
    assert.match(blocked.reason, /施工边界/u);
  }

  // 施工边界“空退化”：implement 下未声明任何边界 → warn（不 block），即使 standard。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "standard" });
    const degraded = evaluate(event({ targetPaths: ["src/login.ts"] }), { cwd: root });
    assert.equal(degraded.decision, "allow");
    assert.equal(degraded.severity, "warning");
    assert.match(degraded.message, /未声明任何边界/u);
  }

  // pending 待确认：硬拦源码编辑（恒 block）。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });
    write(path.join(root, "docs", "login-fix", "002-详细设计-待确认.md"), "**状态**：待处理");
    const result = evaluate(event({ targetPaths: ["src/login.ts"] }), { cwd: root });
    assert.equal(result.decision, "deny");
    assert.match(result.reason, /待确认/u);
  }

  // 项目声明的 required-evidence 文件门禁：缺失/空白 → block 源码；生命周期文档仍放行；非空 → 放行。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "_sdlc", "registry.json"), {
      phasePreconditions: {
        implement: [
          {
            step: "locate-code",
            enforcement: "required-evidence",
            evidence: { type: "file", path: "onlyAI/locate-code.md" },
            reason: "codegraph 检索待修改部分",
          },
        ],
      },
    });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });

    const unmet = phasePreconditionsUnmet({ activeTaskDir: "docs/login-fix" }, root, "implement");
    assert.equal(unmet.length, 1);

    const blocked = evaluate(event({ targetPaths: ["src/login.ts"] }), { cwd: root });
    assert.equal(blocked.decision, "deny");
    assert.match(blocked.reason, /前置门禁/u);

    const lifecycleEdit = evaluate(event({ targetPaths: ["docs/login-fix/003-文件改动记录.md"] }), { cwd: root });
    assert.equal(lifecycleEdit.decision, "allow");

    write(path.join(root, "docs", "login-fix", "onlyAI", "locate-code.md"), "   \n\t");
    const emptyEvidence = phasePreconditionsUnmet({ activeTaskDir: "docs/login-fix" }, root, "implement");
    assert.equal(emptyEvidence.length, 1);

    write(path.join(root, "docs", "login-fix", "onlyAI", "locate-code.md"), "# codegraph 检索结果");
    assert.equal(phasePreconditionsUnmet({ activeTaskDir: "docs/login-fix" }, root, "implement").length, 0);
    const allowed = evaluate(event({ targetPaths: ["src/login.ts"] }), { cwd: root });
    assert.equal(allowed.decision, "allow");
  }

  // 项目声明的 required-capability 门禁：当前 phase 内成功匹配的 PostToolUse 满足门禁。
  {
    const root = makeWorkspace();
    const state = seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "_sdlc", "registry.json"), {
      phasePreconditions: {
        implement: [
          {
            step: "locate-code",
            enforcement: "required-capability",
            capability: "semantic code search",
            tools: ["codegraph", "mcp__codegraph__search"],
          },
        ],
      },
    });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });

    const before = evaluate(event({ targetPaths: ["src/login.ts"] }), { cwd: root });
    assert.equal(before.decision, "deny");
    assert.match(before.reason, /semantic code search/u);

    const recorded = evaluate(
      {
        name: "tool.after",
        platform: "test",
        rawEventName: "PostToolUse",
        toolName: "codegraph",
        success: true,
      },
      { cwd: root },
    );
    assert.equal(recorded.decision, "allow");

    const hookState = readJsonIfExists(hookStatePath(state, root), {});
    assert.equal(hookState.satisfiedCapabilities.length, 1);
    assert.equal(hookState.satisfiedCapabilities[0].taskDir, "docs/login-fix");
    assert.equal(hookState.satisfiedCapabilities[0].phase, "implement");
    assert.equal(hookState.satisfiedCapabilities[0].step, "locate-code");
    assert.equal(hookState.satisfiedCapabilities[0].capability, "semantic code search");
    assert.equal(hookState.satisfiedCapabilities[0].toolName, "codegraph");

    const after = evaluate(event({ targetPaths: ["src/login.ts"] }), { cwd: root });
    assert.equal(after.decision, "allow");
  }

  // required-capability：失败调用不满足门禁，只更新 lastCapabilityFailure 供排查。
  {
    const root = makeWorkspace();
    const state = seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "_sdlc", "registry.json"), {
      phasePreconditions: {
        implement: [
          {
            step: "locate-code",
            enforcement: "required-capability",
            capability: "semantic code search",
            tools: ["codegraph"],
          },
        ],
      },
    });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });

    evaluate(
      {
        name: "tool.after",
        platform: "test",
        rawEventName: "PostToolUse",
        toolName: "codegraph",
        success: false,
        failureReason: "index unavailable",
      },
      { cwd: root },
    );

    const hookState = readJsonIfExists(hookStatePath(state, root), {});
    assert.equal(hookState.satisfiedCapabilities, undefined);
    assert.equal(hookState.lastCapabilityFailure.capability, "semantic code search");
    assert.equal(hookState.lastCapabilityFailure.toolName, "codegraph");
    assert.equal(hookState.lastCapabilityFailure.reason, "index unavailable");

    const blocked = evaluate(event({ targetPaths: ["src/login.ts"] }), { cwd: root });
    assert.equal(blocked.decision, "deny");
  }

  // required-capability：tools 是同一能力的别名集合，任一别名成功即可满足。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "_sdlc", "registry.json"), {
      phasePreconditions: {
        implement: [
          {
            step: "locate-code",
            enforcement: "required-capability",
            capability: "semantic code search",
            tools: ["codegraph", "mcp__codegraph__search"],
          },
        ],
      },
    });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });

    evaluate(
      {
        name: "tool.after",
        platform: "test",
        rawEventName: "PostToolUse",
        toolName: "mcp__codegraph__search",
        success: true,
      },
      { cwd: root },
    );

    const allowed = evaluate(event({ targetPaths: ["src/login.ts"] }), { cwd: root });
    assert.equal(allowed.decision, "allow");
  }

  // required-capability：同 task/phase/step/capability 的重复成功覆盖 summary，完整历史仍在事件日志。
  {
    const root = makeWorkspace();
    const state = seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "_sdlc", "registry.json"), {
      phasePreconditions: {
        implement: [
          {
            step: "locate-code",
            enforcement: "required-capability",
            capability: "semantic code search",
            tools: ["codegraph", "mcp__codegraph__search"],
          },
        ],
      },
    });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });

    evaluate(
      {
        name: "tool.after",
        platform: "test",
        rawEventName: "PostToolUse",
        toolName: "codegraph",
        success: true,
      },
      { cwd: root },
    );
    evaluate(
      {
        name: "tool.after",
        platform: "test",
        rawEventName: "PostToolUse",
        toolName: "mcp__codegraph__search",
        success: true,
      },
      { cwd: root },
    );

    const hookState = readJsonIfExists(hookStatePath(state, root), {});
    assert.equal(hookState.satisfiedCapabilities.length, 1);
    assert.equal(hookState.satisfiedCapabilities[0].toolName, "mcp__codegraph__search");
    assert.equal(hookState.satisfiedCapabilities[0].matchedAlias, "mcp__codegraph__search");

    const events = readEvents(root);
    assert.equal((events.match(/"event":"tool.after"/gu) || []).length, 2);
    assert.equal((events.match(/"success":true/gu) || []).length, 2);
  }

  // required-capability：满足状态不跨 phase 复用，且只匹配当前 phase 的 preconditions。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "design", profile: "standard" });
    writeJson(path.join(root, "docs", "_sdlc", "registry.json"), {
      phasePreconditions: {
        design: [
          {
            step: "locate-code",
            enforcement: "required-capability",
            capability: "semantic code search",
            tools: ["codegraph"],
          },
        ],
        implement: [
          {
            step: "locate-code",
            enforcement: "required-capability",
            capability: "semantic code search",
            tools: ["codegraph"],
          },
        ],
      },
    });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });

    evaluate(
      {
        name: "tool.after",
        platform: "test",
        rawEventName: "PostToolUse",
        toolName: "codegraph",
        success: true,
      },
      { cwd: root },
    );

    const designEdit = evaluate(event({ targetPaths: ["src/login.ts"] }), { cwd: root });
    assert.equal(designEdit.decision, "allow");
    assert.equal(designEdit.severity, "warning");

    seedCurrent(root, { phase: "implement", profile: "standard" });
    const implementEdit = evaluate(event({ targetPaths: ["src/login.ts"] }), { cwd: root });
    assert.equal(implementEdit.decision, "deny");
    assert.match(implementEdit.reason, /semantic code search/u);
  }

  // required-capability：未满足时也会阻断触及源码的写类命令，但不阻断生命周期文档命令。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "_sdlc", "registry.json"), {
      phasePreconditions: {
        implement: [
          {
            step: "locate-code",
            enforcement: "required-capability",
            capability: "semantic code search",
            tools: ["codegraph"],
          },
        ],
      },
    });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });

    const sourceCommand = evaluate(
      {
        name: "tool.before",
        platform: "test",
        action: "command.exec",
        command: "npm run build > src/login.ts",
        targetPaths: ["src/login.ts"],
      },
      { cwd: root },
    );
    assert.equal(sourceCommand.decision, "deny");
    assert.match(sourceCommand.reason, /semantic code search/u);

    const lifecycleCommand = evaluate(
      {
        name: "tool.before",
        platform: "test",
        action: "command.exec",
        command: "Set-Content docs/login-fix/onlyAI/notes.md ok",
        targetPaths: ["docs/login-fix/onlyAI/notes.md"],
      },
      { cwd: root },
    );
    assert.equal(lifecycleCommand.decision, "allow");
  }

  // required-capability：满足状态不跨 task 复用。
  {
    const root = makeWorkspace();
    seedCurrent(root, { activeTaskDir: "docs/login-fix", phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "_sdlc", "registry.json"), {
      phasePreconditions: {
        implement: [
          {
            step: "locate-code",
            enforcement: "required-capability",
            capability: "semantic code search",
            tools: ["codegraph"],
          },
        ],
      },
    });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });

    evaluate(
      {
        name: "tool.after",
        platform: "test",
        rawEventName: "PostToolUse",
        toolName: "codegraph",
        success: true,
      },
      { cwd: root },
    );

    assert.equal(evaluate(event({ targetPaths: ["src/login.ts"] }), { cwd: root }).decision, "allow");

    seedCurrent(root, { activeTaskDir: "docs/password-fix", phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "password-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });

    const otherTask = evaluate(event({ targetPaths: ["src/login.ts"] }), { cwd: root });
    assert.equal(otherTask.decision, "deny");
    assert.match(otherTask.reason, /semantic code search/u);
  }

  // registry 合并：项目覆盖替换某步骤工具链，默认步骤仍在。
  {
    const root = makeWorkspace();
    writeJson(path.join(root, "docs", "_sdlc", "registry.json"), {
      steps: { "locate-code": { summary: "项目定位", tools: [{ name: "codegraph" }] } },
    });
    const registry = loadRegistry(root);
    const locate = resolveStep(registry, "locate-code");
    assert.equal(locate.tools[0].name, "codegraph");
    assert.ok(resolveStep(registry, "run-tests"), "默认步骤应保留");
    assert.equal(resolveStep(registry, "no-such-step"), null);
  }

  // git 推断优雅降级（非 git 目录返回空 Set，不抛错）。
  {
    const root = makeWorkspace();
    const inferred = inferAllowedPathsFromGit(root);
    assert.ok(inferred instanceof Set);
  }

  // phase.set：恒放行，跳级给 warn。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "design", profile: "standard" });
    const result = evaluate({ name: "phase.set", platform: "test", phase: "implement" }, { cwd: root });
    assert.equal(result.decision, "allow");
    assert.equal(result.severity, "warning");
    assert.match(result.message, /尚未完整/u);
  }

  // Stop 完整度按 profile 分档：lite=off 放行 / standard=warn / full=block。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "test", profile: "lite" });
    const lite = evaluate({ name: "session.stop", platform: "test" }, { cwd: root });
    assert.equal(lite.decision, "allow");

    seedCurrent(root, { phase: "test", profile: "standard" });
    const standard = evaluate({ name: "session.stop", platform: "test" }, { cwd: root });
    assert.equal(standard.decision, "allow");
    assert.equal(standard.severity, "warning");

    seedCurrent(root, { phase: "test", profile: "full" });
    const full = evaluate({ name: "session.stop", platform: "test" }, { cwd: root });
    assert.equal(full.decision, "deny");
  }

  // phaseCompletion：合并后的 design 键 + lite 全流程完成。
  {
    const root = makeWorkspace();
    const state = seedCurrent(root, { phase: "test", profile: "lite" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });
    write(path.join(root, "docs", "login-fix", "summary.md"), "# Summary");

    const completion = phaseCompletion(state, root);
    assert.equal(completion.design, true);
    assert.equal(completion.implement, true);
    assert.equal(completion.test, true);
    assert.equal(Object.prototype.hasOwnProperty.call(completion, "design-1"), false);
  }

  // statusPayload：暴露 flow 与 phasePreconditions，allowedPaths 含声明集。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "pending", allowedPaths: ["src/login.ts"] }],
    });

    const payload = statusPayload(root);
    assert.equal(payload.state.phase, "implement");
    assert.ok(payload.allowedPaths.includes("src/login.ts"));
    assert.ok(Array.isArray(payload.phasePreconditions));
    assert.ok(payload.flow.order.includes("design"));
    assert.deepEqual(
      Array.from(implementationAllowedPaths(payload.state, root)).sort(),
      ["src/login.ts"],
    );
  }

  // statusPayload：task-plan schema 违约时给出可操作诊断，而不是只提示 implement incomplete。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "lite" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      subtasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });

    const payload = statusPayload(root);
    assert.equal(payload.completion.implement, false);
    assert.ok(
      payload.blockingReasons.some((reason) => /tasks.*subtasks/u.test(reason)),
      `Expected subtasks diagnostic, got: ${payload.blockingReasons.join(" | ")}`,
    );

    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", allowedPaths: ["src/login.ts"] }],
    });

    const missingStatusPayload = statusPayload(root);
    assert.ok(
      missingStatusPayload.blockingReasons.some((reason) => /status/u.test(reason)),
      `Expected missing status diagnostic, got: ${missingStatusPayload.blockingReasons.join(" | ")}`,
    );
  }

  // task.close --reason completed：design/implement/test 证据齐全且无待确认时成功关闭，
  // 进入 closed 终端态、清空 activeTaskDir、写 lastTask 与最终关闭证据（含 sessionId / 诊断引用）。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "test", profile: "lite" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done" }],
    });
    write(path.join(root, "docs", "login-fix", "onlyAI", "verification.md"), "ok\n");
    evaluate({ name: "session.start", platform: "test" }, { cwd: root });
    const sessionId = currentSessionId(root);

    const result = closeTask({ reason: "completed" }, root);
    assert.equal(result.decision, "allow");
    assert.equal(result.completed, true);

    const cur = readJsonIfExists(currentStatePath(root), null);
    assert.equal(cur.phase, "closed");
    assert.equal(cur.activeTaskDir, null, "closed 态不存 active task");
    assert.equal(cur.lastTask.dir, "docs/login-fix", "previous task 经显式 lastTask 保留");
    assert.equal(cur.lastTask.reason, "completed");
    assert.equal(cur.lastTask.completed, true);
    assert.equal(cur.lastTask.closureEvidence, "docs/login-fix/onlyAI/closure.json");

    const closure = readJsonIfExists(path.join(root, "docs", "login-fix", "onlyAI", "closure.json"), null);
    assert.ok(closure, "应写最终关闭证据 closure.json");
    assert.equal(closure.reason, "completed");
    assert.equal(closure.completed, true);
    assert.deepEqual(closure.completion, { design: true, implement: true, test: true, debug: false });
    assert.equal(closure.sessionId, sessionId, "关闭证据带当前 session id");
    assert.equal(closure.sessionName, null, "session name 未知时记 null（if known）");
    assert.equal(closure.diagnostics, "docs/_sdlc/session-diagnostics.json", "关闭证据含诊断引用");
  }

  // task.close --reason completed：证据不齐时拒绝关闭，任务保持活动、不写关闭证据。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "design", profile: "lite" });
    const result = closeTask({ reason: "completed" }, root);
    assert.equal(result.decision, "deny");
    assert.match(result.reason, /完成证据不齐/u);

    const cur = readJsonIfExists(currentStatePath(root), null);
    assert.equal(cur.phase, "design", "拒绝时不改阶段");
    assert.equal(cur.activeTaskDir, "docs/login-fix", "拒绝时保留活动任务");
    assert.ok(
      !fs.existsSync(path.join(root, "docs", "login-fix", "onlyAI", "closure.json")),
      "拒绝时不写关闭证据",
    );
  }

  // task.close 非成功关闭（canceled/wontfix/superseded）：缺 --note 拒绝；带 note 可关闭未完成工作，
  // 并在 lastTask 与关闭证据里保留 reason 与 note，completed=false。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "lite" });

    const missingNote = closeTask({ reason: "canceled" }, root);
    assert.equal(missingNote.decision, "deny");
    assert.match(missingNote.reason, /需要 --note/u);
    assert.equal(readJsonIfExists(currentStatePath(root), null).phase, "implement", "缺 note 时不关闭");

    const closed = closeTask({ reason: "wontfix", note: "上游已修复" }, root);
    assert.equal(closed.decision, "allow");
    assert.equal(closed.completed, false, "非成功关闭 completed=false");

    const cur = readJsonIfExists(currentStatePath(root), null);
    assert.equal(cur.phase, "closed");
    assert.equal(cur.activeTaskDir, null);
    assert.equal(cur.lastTask.reason, "wontfix");
    assert.equal(cur.lastTask.note, "上游已修复");
    assert.equal(cur.lastTask.completed, false);

    const closure = readJsonIfExists(path.join(root, "docs", "login-fix", "onlyAI", "closure.json"), null);
    assert.equal(closure.reason, "wontfix");
    assert.equal(closure.note, "上游已修复");
    assert.equal(closure.completed, false);
  }

  // task.close 边界：无活动任务 / 非法或缺失 reason 一律拒绝。
  {
    const root = makeWorkspace();
    seedCurrent(root, { activeTaskDir: null, phase: "closed" });
    assert.equal(closeTask({ reason: "completed" }, root).decision, "deny", "无活动任务不可关闭");

    const root2 = makeWorkspace();
    seedCurrent(root2, { phase: "test", profile: "lite" });
    assert.equal(closeTask({ reason: "bogus" }, root2).decision, "deny", "非法 reason 拒绝");
    assert.equal(closeTask({}, root2).decision, "deny", "缺 reason 拒绝");
  }

  // closed 终端态门禁：任务专属门禁全部失效（源码编辑放行），但全局红线仍 block。
  {
    const root = makeWorkspace();
    seedCurrent(root, { activeTaskDir: null, phase: "closed" });

    const sourceEdit = evaluate(
      { name: "tool.before", platform: "test", action: "fs.edit", targetPaths: ["src/whatever.ts"] },
      { cwd: root },
    );
    assert.equal(sourceEdit.decision, "allow", "closed 态任务门禁失效，源码编辑放行");

    const pushMain = evaluate(
      { name: "tool.before", platform: "test", action: "command.exec", command: "git push origin main" },
      { cwd: root },
    );
    assert.equal(pushMain.decision, "deny", "closed 态全局红线仍生效（push 主分支被拦）");

    const delConfig = evaluate(
      { name: "tool.before", platform: "test", action: "fs.delete", targetPaths: ["package.json"] },
      { cwd: root },
    );
    assert.equal(delConfig.decision, "deny", "closed 态删除核心配置仍被红线拦");
  }

  // closed 终端态 session 注入：只说“上个任务已关闭 + 如何初始化新任务”，不复述活动任务门禁那段。
  {
    const root = makeWorkspace();
    seedCurrent(root, {
      activeTaskDir: null,
      phase: "closed",
      lastTask: { dir: "docs/login-fix", reason: "completed" },
    });
    const result = evaluate({ name: "session.start", platform: "test" }, { cwd: root });
    assert.equal(result.decision, "allow");
    const ctx = result.additionalContext || "";
    assert.match(ctx, /已关闭/u, "closed 注入应说明上个任务已关闭");
    assert.match(ctx, /init --task-dir/u, "closed 注入应给出初始化新任务的命令");
    assert.doesNotMatch(ctx, /当前任务：/u, "closed 注入不复述活动任务那一行");
    assert.ok(ctx.split("\n").length <= 4, "closed 注入 ≤4 行");
    assert.match(ctx, /docs\/_sdlc\/session-diagnostics\.json/u, "closed 注入含诊断位置");
  }

  // #11 debug 激活：phase.set --phase debug 显式把 debug 标记为 active 并记录激活元数据，
  // 不靠文件名 / 日志推断。AC：进入 debug 阶段显式标记 debugActive。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "lite" });
    evaluate({ name: "session.start", platform: "test" }, { cwd: root });
    const sessionId = currentSessionId(root);

    const result = setPhase({ phase: "debug" }, root);
    assert.equal(result.decision, "allow");

    const cur = readJsonIfExists(currentStatePath(root), null);
    assert.equal(cur.phase, "debug");
    assert.equal(cur.debugActive, true, "进入 debug 阶段应显式置 debugActive=true");
    assert.ok(cur.debugActivatedAt, "应记录 debug 激活时间");
    assert.equal(cur.debugSessionId, sessionId, "应记录激活时的 session id");

    // 切到别的阶段不应静默清除 debugActive（关闭必须显式经 debug.close）。
    setPhase({ phase: "implement" }, root);
    const afterSwitch = readJsonIfExists(currentStatePath(root), null);
    assert.equal(afterSwitch.debugActive, true, "切换阶段不得静默关闭激活的 debug");
  }

  // #11 debug.close：缺 note / note 过短一律拒绝且保持 debugActive；有效 note 清除激活态并写 lastDebug。
  // AC：debug.close 校验 note；清除 active debug 并记录 note、关闭时间与会话元数据。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "debug", profile: "lite", debugActive: true, debugActivatedAt: "2026-06-26T00:00:00.000Z" });
    evaluate({ name: "session.start", platform: "test" }, { cwd: root });
    const sessionId = currentSessionId(root);

    const missing = closeDebug({}, root);
    assert.equal(missing.decision, "deny", "缺 note 拒绝");
    assert.match(missing.reason, /note/u);
    assert.equal(readJsonIfExists(currentStatePath(root), null).debugActive, true, "缺 note 时 debug 仍激活");

    const tooShort = closeDebug({ note: "ok" }, root);
    assert.equal(tooShort.decision, "deny", "note 过短拒绝");
    assert.equal(readJsonIfExists(currentStatePath(root), null).debugActive, true, "过短时 debug 仍激活");

    const closed = closeDebug({ note: "已定位并修复空指针解引用" }, root);
    assert.equal(closed.decision, "allow");

    const cur = readJsonIfExists(currentStatePath(root), null);
    assert.ok(!cur.debugActive, "有效 note 后清除 debugActive");
    assert.equal(cur.lastDebug.note, "已定位并修复空指针解引用");
    assert.ok(cur.lastDebug.closedAt, "记录 debug 关闭时间");
    assert.equal(cur.lastDebug.activatedAt, "2026-06-26T00:00:00.000Z", "保留激活时间");
    assert.equal(cur.lastDebug.sessionId, sessionId, "记录会话元数据 session id");
  }

  // #11 debug.close 边界：未激活 debug 时拒绝（无可关闭的排查）。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "test", profile: "lite" });
    const result = closeDebug({ note: "无关紧要的说明" }, root);
    assert.equal(result.decision, "deny", "未激活 debug 不可 debug.close");
  }

  // #11 task.close --reason completed 被 active debug 拦截：即便完成证据齐全，也必须先关 debug。
  // AC：completed close 在 debug 激活时被拦并提示先关 debug。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "debug", profile: "lite", debugActive: true });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done" }],
    });
    write(path.join(root, "docs", "login-fix", "onlyAI", "verification.md"), "ok\n");

    const blocked = closeTask({ reason: "completed" }, root);
    assert.equal(blocked.decision, "deny", "debug 激活时 completed close 被拦");
    assert.match(blocked.reason, /debug/u, "提示先关 debug");

    const cur = readJsonIfExists(currentStatePath(root), null);
    assert.notEqual(cur.phase, "closed", "被拦时不进入 closed");
    assert.equal(cur.debugActive, true, "被拦时 debug 仍激活");
    assert.ok(
      !fs.existsSync(path.join(root, "docs", "login-fix", "onlyAI", "closure.json")),
      "被拦时不写关闭证据",
    );

    // 显式关掉 debug 后，同一任务可成功完成关闭。
    closeDebug({ note: "排查完毕，根因已修复" }, root);
    const ok = closeTask({ reason: "completed" }, root);
    assert.equal(ok.decision, "allow", "关掉 debug 后 completed close 放行");
    assert.equal(readJsonIfExists(currentStatePath(root), null).phase, "closed");
  }

  // #11 非成功关闭可在 debug 激活时关闭，但需保留“关闭时 debug 仍激活”的事实。
  // AC：非成功 close 可带 active debug 关闭并保留 debugActiveAtClose。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "debug", profile: "lite", debugActive: true });

    const closed = closeTask({ reason: "canceled", note: "需求取消，排查中止" }, root);
    assert.equal(closed.decision, "allow", "非成功关闭允许在 debug 激活时关闭");

    const cur = readJsonIfExists(currentStatePath(root), null);
    assert.equal(cur.phase, "closed");
    assert.equal(cur.lastTask.debugActiveAtClose, true, "lastTask 保留关闭时 debug 仍激活");
    assert.ok(!cur.debugActive, "关闭后清除 debug 激活态");

    const closure = readJsonIfExists(path.join(root, "docs", "login-fix", "onlyAI", "closure.json"), null);
    assert.equal(closure.debugActiveAtClose, true, "关闭证据保留 debug 仍激活的事实");
  }

  // #12 session.stop 兜底自动关闭（AC1）：design/implement/test 证据齐全且无待确认时，
  // stop 自动以 completed 收尾，进入 closed 终端态、写最终关闭证据并标记 stop fallback 来源。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "test", profile: "lite" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done" }],
    });
    write(path.join(root, "docs", "login-fix", "onlyAI", "verification.md"), "ok\n");
    evaluate({ name: "session.start", platform: "test" }, { cwd: root });
    const sessionId = currentSessionId(root);

    const result = evaluate({ name: "session.stop", platform: "test" }, { cwd: root });
    assert.equal(result.decision, "allow");
    assert.equal(result.autoClosed, true, "证据齐全时 stop 兜底自动关闭");
    assert.equal(result.completed, true);

    const cur = readJsonIfExists(currentStatePath(root), null);
    assert.equal(cur.phase, "closed", "自动关闭后进入 closed 终端态");
    assert.equal(cur.activeTaskDir, null, "closed 态不存 active task");
    assert.equal(cur.lastTask.dir, "docs/login-fix", "previous task 经显式 lastTask 保留");
    assert.equal(cur.lastTask.reason, "completed");
    assert.equal(cur.lastTask.completed, true);
    assert.equal(cur.lastTask.closeTrigger, "session.stop", "lastTask 标记兜底来源");
    assert.equal(cur.lastTask.autoClosed, true);

    const closure = readJsonIfExists(path.join(root, "docs", "login-fix", "onlyAI", "closure.json"), null);
    assert.ok(closure, "auto-close 写最终关闭证据 closure.json");
    assert.equal(closure.reason, "completed", "兜底关闭不臆造非成功 reason");
    assert.equal(closure.completed, true);
    assert.equal(closure.closeTrigger, "session.stop", "关闭证据区分 stop fallback 来源");
    assert.equal(closure.autoClosed, true);
    assert.ok(closure.note && closure.note.length > 0, "auto-close note 区分兜底来源");
    assert.equal(closure.sessionId, sessionId, "关闭证据带当前 session id");
  }

  // #12 由完成证据驱动、与 phase 字符串无关（AC2）：phase 仍是 implement，但证据齐全即可自动关闭。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "lite" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done" }],
    });
    write(path.join(root, "docs", "login-fix", "onlyAI", "verification.md"), "ok\n");

    const result = evaluate({ name: "session.stop", platform: "test" }, { cwd: root });
    assert.equal(result.autoClosed, true, "证据齐全则即便 phase!=test 也自动关闭（证据驱动而非 phase 驱动）");

    const cur = readJsonIfExists(currentStatePath(root), null);
    assert.equal(cur.phase, "closed");
    assert.equal(cur.lastTask.completed, true);
  }

  // #12 待确认未处理则不自动关闭（AC3）：保持任务活动、不写关闭证据。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "test", profile: "lite" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done" }],
    });
    write(path.join(root, "docs", "login-fix", "onlyAI", "verification.md"), "ok\n");
    // 未处理的待确认（无「状态：已处理」标记）：阻止自动关闭。
    write(path.join(root, "docs", "login-fix", "001-概要设计-待确认.md"), "待确认事项，尚未处理。\n");

    const result = evaluate({ name: "session.stop", platform: "test" }, { cwd: root });
    assert.notEqual(result.autoClosed, true, "有未处理待确认时不自动关闭");

    const cur = readJsonIfExists(currentStatePath(root), null);
    assert.equal(cur.phase, "test", "未自动关闭，任务保持活动");
    assert.equal(cur.activeTaskDir, "docs/login-fix");
    assert.ok(
      !fs.existsSync(path.join(root, "docs", "login-fix", "onlyAI", "closure.json")),
      "未自动关闭时不写关闭证据",
    );
  }

  // #12 debug 激活则不自动关闭、只提示显式 debug.close（AC4）：stop 不硬拦，但给出 warning 提示。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "test", profile: "lite", debugActive: true });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done" }],
    });
    write(path.join(root, "docs", "login-fix", "onlyAI", "verification.md"), "ok\n");

    const result = evaluate({ name: "session.stop", platform: "test" }, { cwd: root });
    assert.notEqual(result.autoClosed, true, "debug 激活时不自动关闭");
    assert.equal(result.decision, "allow", "提示但不硬拦 stop");
    assert.equal(result.severity, "warning");
    assert.match(result.message, /debug\.close/u, "提示显式关闭 debug");

    const cur = readJsonIfExists(currentStatePath(root), null);
    assert.equal(cur.phase, "test", "debug 激活时 stop 不关闭任务");
    assert.equal(cur.activeTaskDir, "docs/login-fix");
    assert.equal(cur.debugActive, true, "debug 仍激活");
    assert.ok(
      !fs.existsSync(path.join(root, "docs", "login-fix", "onlyAI", "closure.json")),
      "debug 激活时不写关闭证据",
    );
  }

  // #12 auto-close 与显式 completed close 写「同结构」关闭证据（AC5）：仅 closeTrigger / autoClosed / note 区分来源。
  {
    const setup = (r) => {
      seedCurrent(r, { phase: "test", profile: "lite" });
      writeJson(path.join(r, "docs", "login-fix", "onlyAI", "task-plan.json"), {
        tasks: [{ id: "T-01", status: "done" }],
      });
      write(path.join(r, "docs", "login-fix", "onlyAI", "verification.md"), "ok\n");
    };

    const manualRoot = makeWorkspace();
    setup(manualRoot);
    closeTask({ reason: "completed" }, manualRoot);
    const manualClosure = readJsonIfExists(path.join(manualRoot, "docs", "login-fix", "onlyAI", "closure.json"), null);

    const autoRoot = makeWorkspace();
    setup(autoRoot);
    evaluate({ name: "session.stop", platform: "test" }, { cwd: autoRoot });
    const autoClosure = readJsonIfExists(path.join(autoRoot, "docs", "login-fix", "onlyAI", "closure.json"), null);

    assert.deepEqual(
      Object.keys(autoClosure).sort(),
      Object.keys(manualClosure).sort(),
      "auto-close 与显式关闭写同结构关闭证据",
    );
    assert.equal(autoClosure.reason, manualClosure.reason, "两者 reason 都是 completed");
    assert.equal(autoClosure.reason, "completed");
    assert.equal(autoClosure.completed, true);
    assert.deepEqual(autoClosure.completion, manualClosure.completion, "完成证据一致");
    // 仅来源标记不同。
    assert.equal(manualClosure.closeTrigger, "manual");
    assert.equal(manualClosure.autoClosed, false);
    assert.equal(autoClosure.closeTrigger, "session.stop");
    assert.equal(autoClosure.autoClosed, true);
    assert.notEqual(autoClosure.note, manualClosure.note, "note 区分兜底来源");
  }

  // #14 stop-time 会话命名 + 手动 rename（AC 覆盖）。
  // 14a session.stop 兜底自动关闭时记录推断名：slug + 当前阶段（无事件/诊断时降级为此）。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "test", profile: "lite" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), { tasks: [{ id: "T-01", status: "done" }] });
    write(path.join(root, "docs", "login-fix", "onlyAI", "verification.md"), "ok\n");
    evaluate({ name: "session.start", platform: "test" }, { cwd: root });
    const sessionId = currentSessionId(root);

    const result = evaluate({ name: "session.stop", platform: "test" }, { cwd: root });
    assert.equal(result.decision, "allow");
    assert.equal(result.autoClosed, true, "证据齐全时 stop 兜底自动关闭");

    const closure = readJsonIfExists(path.join(root, "docs", "login-fix", "onlyAI", "closure.json"), null);
    assert.equal(closure.sessionName, "login-fix: test", "stop-time 推断名 = slug:phase");
    assert.equal(closure.sessionId, sessionId);

    const session = readJsonIfExists(sessionPath(root), null);
    assert.equal(session.sessionName, "login-fix: test", "session 记录带推断名");
    assert.equal(session.sessionNameSource, "stop", "命名来源标记为 stop");
    assert.equal(session.platformRename.available, false, "生产路径平台 rename 不可用");
  }

  // 14b 诊断含测试命令 + 源码路径时，推断名带上 test 标记与触及区域。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "test", profile: "lite" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), { tasks: [{ id: "T-01", status: "done" }] });
    write(path.join(root, "docs", "login-fix", "onlyAI", "verification.md"), "ok\n");
    evaluate({ name: "session.start", platform: "test" }, { cwd: root });
    const sessionId = currentSessionId(root);
    // 直接播种诊断历史：测试命令 + 源码路径（按当前 sessionId 归属），模拟跑过测试并改过 src。
    writeJson(diagnosticsPath(root), {
      latest: { command: "npm test", targetPaths: ["src/login.ts"], sessionId },
      history: [{ command: "npm test", targetPaths: ["src/login.ts"], sessionId }],
    });

    evaluate({ name: "session.stop", platform: "test" }, { cwd: root });
    const closure = readJsonIfExists(path.join(root, "docs", "login-fix", "onlyAI", "closure.json"), null);
    assert.equal(closure.sessionName, "login-fix: test: src", "推断名含 test 标记与触及区域");
  }

  // 14c 手动 rename：写本地名 + 默认平台 rename 不可用、给出显式反馈（AC：手动输出报告平台状态）。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "design" });
    const result = renameSession({ name: "login-auth-flow" }, root);
    assert.equal(result.decision, "allow");
    assert.equal(result.sessionName, "login-auth-flow");
    assert.match(result.message, /平台 session rename 不可用/u, "默认报告平台 rename 不可用");
    const session = readJsonIfExists(sessionPath(root), null);
    assert.equal(session.sessionName, "login-auth-flow", "session 记录被手动名覆盖");
    assert.equal(session.sessionNameSource, "manual", "命名来源标记为 manual");
    assert.equal(session.platformRename.available, false);
  }

  // 14c（续）平台 rename 能力可用时：applied / 被拒 两种显式反馈。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "design" });
    const prev = process.env.SDLC_SESSION_RENAME;
    try {
      process.env.SDLC_SESSION_RENAME = "ok";
      const ok = renameSession({ name: "flow-a" }, root);
      assert.match(ok.message, /已应用/u, "平台 rename 可用时报告已应用");
      assert.equal(ok.platformRename.available, true);
      assert.equal(ok.platformRename.applied, true);

      process.env.SDLC_SESSION_RENAME = "fail";
      const rejected = renameSession({ name: "flow-b" }, root);
      assert.match(rejected.message, /被拒绝/u, "平台 rename 被拒时报告被拒绝");
      assert.equal(rejected.platformRename.available, true);
      assert.equal(rejected.platformRename.applied, false, "被拒记录为未应用");
      assert.ok(rejected.platformRename.error, "被拒带错误原因");
    } finally {
      if (prev === undefined) delete process.env.SDLC_SESSION_RENAME;
      else process.env.SDLC_SESSION_RENAME = prev;
    }
  }

  // 14d 自动路径平台 rename 失败时静默：不阻断生命周期、result 不报平台错误，仅 session 记录留存。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "test", profile: "lite" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), { tasks: [{ id: "T-01", status: "done" }] });
    write(path.join(root, "docs", "login-fix", "onlyAI", "verification.md"), "ok\n");
    evaluate({ name: "session.start", platform: "test" }, { cwd: root });
    const prev = process.env.SDLC_SESSION_RENAME;
    try {
      process.env.SDLC_SESSION_RENAME = "fail";
      const result = evaluate({ name: "session.stop", platform: "test" }, { cwd: root });
      assert.equal(result.decision, "allow", "自动路径平台 rename 失败不阻断生命周期");
      assert.equal(result.autoClosed, true);
      assert.doesNotMatch(result.message, /rename|重命名|被拒绝/u, "自动路径对平台失败保持静默");
      const session = readJsonIfExists(sessionPath(root), null);
      assert.equal(session.platformRename.available, true);
      assert.equal(session.platformRename.applied, false, "失败记录为未应用");
      assert.ok(session.platformRename.error, "失败原因留存于 session 记录");
    } finally {
      if (prev === undefined) delete process.env.SDLC_SESSION_RENAME;
      else process.env.SDLC_SESSION_RENAME = prev;
    }
  }

  // #13 紧凑 status / 注入：status --short 与 hook 注入同源紧凑视图（≤4 行），含任务/关闭状态、
  // 下一步、紧凑计数、诊断位置；覆盖 active / incomplete / debug-active / complete / closed 五态。

  // #13 active / incomplete：紧凑视图 ≤4 行，含任务、阶段、下一步、紧凑计数与诊断位置。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "design", profile: "standard" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "pending" }],
    });

    const msg = shortStatusMessage(loadCurrentState(root), root);
    const lines = msg.split("\n");
    assert.ok(lines.length <= 4, `active 紧凑视图 ≤4 行，实际 ${lines.length}`);
    assert.match(msg, /任务 docs\/login-fix/u, "含活动任务");
    assert.match(msg, /阶段 design/u, "含当前阶段");
    assert.match(msg, /下一步：/u, "含下一步动作");
    assert.match(msg, /任务 0\/1/u, "含紧凑任务计数");
    assert.match(msg, /待确认 0/u, "含待确认计数");
    assert.match(msg, new RegExp(DIAGNOSTICS_LOCATION.replace(/\//gu, "\\/"), "u"), "含诊断位置");
    // incomplete：design 阶段产物未齐 → 下一步提示补齐当前阶段产物。
    assert.match(msg, /Complete required artifacts for phase design/u, "incomplete 提示补齐当前阶段");
  }

  // #13 debug-active：紧凑视图标记 debug active，并提示先 debug.close。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "debug", profile: "lite", debugActive: true });

    const msg = shortStatusMessage(loadCurrentState(root), root);
    assert.ok(msg.split("\n").length <= 4, "debug-active 紧凑视图 ≤4 行");
    assert.match(msg, /debug active/u, "标记 debug 激活态");
    assert.match(msg, /debug\.close/u, "提示先显式关闭 debug");
  }

  // #13 complete：design/implement/test 证据齐全 → 下一步建议 task.close --reason completed。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "test", profile: "lite" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done" }],
    });
    write(path.join(root, "docs", "login-fix", "onlyAI", "verification.md"), "ok\n");

    const msg = shortStatusMessage(loadCurrentState(root), root);
    assert.ok(msg.split("\n").length <= 4, "complete 紧凑视图 ≤4 行");
    assert.match(msg, /完成证据齐全/u, "证据齐全提示");
    assert.match(msg, /task\.close --reason completed/u, "建议显式关闭任务");
    assert.match(msg, /design✓ implement✓ test✓/u, "紧凑计数标记三阶段完成");
  }

  // #13 closed：紧凑视图只说上个任务已关闭 + 如何初始化新任务 + 诊断位置，≤4 行，不复述活动任务门禁。
  {
    const root = makeWorkspace();
    seedCurrent(root, {
      activeTaskDir: null,
      phase: "closed",
      lastTask: { dir: "docs/login-fix", reason: "completed" },
    });

    const msg = shortStatusMessage(loadCurrentState(root), root);
    assert.ok(msg.split("\n").length <= 4, "closed 紧凑视图 ≤4 行");
    assert.match(msg, /已关闭/u, "说明上个任务已关闭");
    assert.match(msg, /docs\/login-fix/u, "保留上个任务目录");
    assert.match(msg, /init --task-dir/u, "给出初始化新任务命令");
    assert.match(msg, new RegExp(DIAGNOSTICS_LOCATION.replace(/\//gu, "\\/"), "u"), "含诊断位置");
    assert.doesNotMatch(msg, /当前任务：/u, "不复述活动任务那一行");
  }

  // #13 status --short 与注入同源：UserPromptSubmit / SessionStart 注入文本 == shortStatusMessage。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });

    const expected = shortStatusMessage(loadCurrentState(root), root);
    const sessionStart = evaluate({ name: "session.start", platform: "test" }, { cwd: root });
    const promptSubmit = evaluate(
      { name: "prompt.submit", platform: "test", rawEventName: "UserPromptSubmit" },
      { cwd: root },
    );
    assert.equal(sessionStart.additionalContext, expected, "SessionStart 注入即 status --short 同源视图");
    assert.equal(promptSubmit.additionalContext, expected, "UserPromptSubmit 注入即 status --short 同源视图");
    assert.ok(sessionStart.additionalContext.split("\n").length <= 4, "SessionStart 注入 ≤4 行");
  }

  // #16 status guidance：未满足的 required-evidence 前置门禁让 status 直接点名证据路径与下一步命令。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "_sdlc", "registry.json"), {
      phasePreconditions: {
        implement: [
          {
            step: "locate-code",
            enforcement: "required-evidence",
            evidence: { type: "file", path: "onlyAI/locate-code.md" },
            reason: "codegraph 检索待修改部分",
          },
        ],
      },
    });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });

    const payload = statusPayload(root);
    assert.match(payload.nextAction, /onlyAI\/locate-code\.md/u, "nextAction 应点名缺的证据路径");
    assert.match(payload.nextAction, /step locate-code/u, "nextAction 应给出下一步命令");
    assert.ok(
      payload.blockingReasons.some(
        (reason) => /Unmet phase precondition/u.test(reason) && /onlyAI\/locate-code\.md/u.test(reason),
      ),
      `blockingReasons 应含清晰的未满足前置原因，got: ${payload.blockingReasons.join(" | ")}`,
    );
  }

  // #16 紧凑视图：未满足前置时下一步直接点名证据路径，且仍 ≤4 行。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "_sdlc", "registry.json"), {
      phasePreconditions: {
        implement: [
          { step: "locate-code", enforcement: "required-evidence", evidence: { type: "file", path: "onlyAI/locate-code.md" } },
        ],
      },
    });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });

    const msg = shortStatusMessage(loadCurrentState(root), root);
    assert.match(msg, /onlyAI\/locate-code\.md/u, "紧凑视图下一步应点名证据路径");
    assert.ok(msg.split("\n").length <= 4, `紧凑视图应 ≤4 行，实际 ${msg.split("\n").length}`);
  }

  // #16 deny 可操作性：缺 required-evidence 时改源码被拒，且原因点名证据路径 + 下一步命令，保留硬拦说明。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "_sdlc", "registry.json"), {
      phasePreconditions: {
        implement: [
          {
            step: "locate-code",
            enforcement: "required-evidence",
            evidence: { type: "file", path: "onlyAI/locate-code.md" },
            reason: "codegraph 检索待修改部分",
          },
        ],
      },
    });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });

    const blocked = evaluate(event({ targetPaths: ["src/login.ts"] }), { cwd: root });
    assert.equal(blocked.decision, "deny");
    assert.match(blocked.reason, /前置门禁/u, "保留硬拦说明");
    assert.match(blocked.reason, /onlyAI\/locate-code\.md/u, "deny 原因应点名证据路径");
    assert.match(blocked.reason, /step locate-code/u, "deny 原因应给出下一步命令");
  }

  // #16 证据保持真实：空白/空文件不构成满足；hooks 不自动生成证据文件（违反即破坏硬前置语义）。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "_sdlc", "registry.json"), {
      phasePreconditions: {
        implement: [
          { step: "locate-code", enforcement: "required-evidence", evidence: { type: "file", path: "onlyAI/locate-code.md" } },
        ],
      },
    });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });

    write(path.join(root, "docs", "login-fix", "onlyAI", "locate-code.md"), "   \n\t  ");
    assert.equal(
      phasePreconditionsUnmet({ activeTaskDir: "docs/login-fix" }, root, "implement").length,
      1,
      "空白证据仍不满足",
    );

    fs.rmSync(path.join(root, "docs", "login-fix", "onlyAI", "locate-code.md"));
    assert.equal(
      phasePreconditionsUnmet({ activeTaskDir: "docs/login-fix" }, root, "implement").length,
      1,
      "删除证据文件后（未被自动重建）仍不满足",
    );
    assert.equal(
      fs.existsSync(path.join(root, "docs", "login-fix", "onlyAI", "locate-code.md")),
      false,
      "hooks 不应自动创建证据文件",
    );
  }

  // #16 required-capability 前置：未满足时 status 与 deny 都点名能力 + 步骤命令。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "_sdlc", "registry.json"), {
      phasePreconditions: {
        implement: [
          {
            step: "locate-code",
            enforcement: "required-capability",
            capability: "semantic code search",
            tools: ["codegraph"],
            reason: "必须先成功使用语义检索",
          },
        ],
      },
    });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });

    const payload = statusPayload(root);
    assert.match(payload.nextAction, /semantic code search/u, "capability 前置 nextAction 点名能力");
    assert.match(payload.nextAction, /step locate-code/u, "capability 前置 nextAction 给出步骤命令");
    assert.ok(
      payload.blockingReasons.some((reason) => /Unmet phase precondition/u.test(reason)),
      `capability 前置 blockingReasons 应含未满足原因，got: ${payload.blockingReasons.join(" | ")}`,
    );

    const blocked = evaluate(event({ targetPaths: ["src/login.ts"] }), { cwd: root });
    assert.equal(blocked.decision, "deny");
    assert.match(blocked.reason, /semantic code search/u, "deny 点名能力");
    assert.match(blocked.reason, /step locate-code/u, "deny 给出步骤命令");
  }

  // #16 completion 语义：completion.* 是「产物完成」而非「阶段推进」——phase=implement 但
  // completion.implement=true 时 nextAction 仍按产物完整度推荐进入 test；既有测试产物
  // （completion.test=true）同样只表示产物齐备，不改变当前所在阶段。两者都不矛盾。
  {
    const root = makeWorkspace();
    const state = seedCurrent(root, { phase: "implement", profile: "lite" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "done", allowedPaths: ["src/login.ts"] }],
    });
    // 当前切片在 implement：无测试产物 → completion.test=false；任务计划完成 → completion.implement=true。
    const completion = phaseCompletion(state, root);
    assert.equal(completion.implement, true, "任务计划完成使 completion.implement=true（产物完成）");
    assert.equal(completion.test, false, "尚无测试产物 → completion.test=false");
    assert.equal(state.phase, "implement", "当前阶段仍是 implement（未切到 test）");
    assert.match(
      nextAction(state, completion, [], root),
      /Enter next phase: test/u,
      "phase=implement 且 completion.implement=true 时仍推荐进入 test，不与当前阶段矛盾（completion.* 是产物完成）",
    );

    // 既有测试产物（历史报告）使 completion.test=true：仍只表示产物齐备，不表示阶段已推进。
    write(path.join(root, "docs", "login-fix", "onlyAI", "verification.md"), "ok\n");
    const completion2 = phaseCompletion(state, root);
    assert.equal(completion2.test, true, "既有测试产物使 completion.test=true");
    assert.equal(state.phase, "implement", "completion.test=true 不改变当前阶段（仍 implement）");
    assert.match(
      nextAction(state, completion2, [], root),
      /task\.close --reason completed/u,
      "completion.* 全齐备时建议关闭任务，仍与 phase=implement 不矛盾",
    );
  }
}

run();
console.log("sdlc hooks tests passed");
