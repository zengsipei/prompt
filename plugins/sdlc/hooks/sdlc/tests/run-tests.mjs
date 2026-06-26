import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { evaluate } from "../core/rules.mjs";
import { allow, asCodexHookJson, asHookJson, block, codexHookFailureJson, hookFailureJson, warn } from "../core/result.mjs";
import { currentStatePath, eventsPath, hookStatePath, readJsonIfExists, writeJson } from "../core/context.mjs";
import { currentSessionId, diagnosticsPath, sessionPath } from "../core/session.mjs";
import {
  implementationAllowedPaths,
  inferAllowedPathsFromGit,
  phaseCompletion,
  phasePreconditionsUnmet,
} from "../core/artifacts.mjs";
import { loadRegistry, resolveStep } from "../core/registry.mjs";
import { closeDebug, closeTask, setPhase, statusPayload } from "../adapters/manual.mjs";
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

  // prompt.submit：只注入软指导并留痕，不阻断用户 prompt。
  {
    const root = makeWorkspace();
    seedCurrent(root, { phase: "implement", profile: "standard" });
    writeJson(path.join(root, "docs", "login-fix", "onlyAI", "task-plan.json"), {
      tasks: [{ id: "T-01", status: "pending", allowedPaths: ["src/login.ts"] }],
    });

    const result = evaluate({ name: "prompt.submit", platform: "test", rawEventName: "UserPromptSubmit" }, { cwd: root });
    assert.equal(result.decision, "allow");
    assert.match(result.additionalContext, /advisory/u);
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
}

run();
console.log("sdlc hooks tests passed");
