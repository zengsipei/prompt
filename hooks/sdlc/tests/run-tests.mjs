import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { evaluate } from "../core/rules.mjs";
import { allow, asCodexHookJson, asHookJson, codexHookFailureJson, hookFailureJson } from "../core/result.mjs";
import { eventsPath, hookStatePath, readJsonIfExists, writeJson } from "../core/context.mjs";
import {
  implementationAllowedPaths,
  inferAllowedPathsFromGit,
  phaseCompletion,
  phasePreconditionsUnmet,
} from "../core/artifacts.mjs";
import { loadRegistry, resolveStep } from "../core/registry.mjs";
import { statusPayload } from "../adapters/manual.mjs";
import { RUNTIME_ROOT, hookCommand, resolveRuntimeRoot } from "../core/runtime.mjs";
import {
  GENERATE_HOOK_CONFIGS_COMMAND,
  checkGeneratedHookArtifacts,
  generatedHookArtifacts,
  readHookManifest,
} from "../core/hook-config-generator.mjs";
import { normalizeCodexEventName } from "../adapters/codex.mjs";
import { normalizeClaudeCodeEventName } from "../adapters/claude-code.mjs";

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
    assert.deepEqual(asCodexHookJson(allowed, "PreToolUse"), { decision: "allow" });
    assert.deepEqual(asCodexHookJson(allow("ok", { additionalContext: "ctx" }), "UserPromptSubmit"), {
      decision: "allow",
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "ctx",
      },
    });
    assert.deepEqual(codexHookFailureJson(new Error("boom"), "PostToolUse"), {});
    assert.deepEqual(codexHookFailureJson(new Error("boom"), "PreToolUse"), {
      decision: "deny",
      reason: "SDLC Codex hook failed: boom",
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

  // 红线：恒 block，优先于一切（无 state 也拦）。
  {
    const root = makeWorkspace();
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

  // 无 state：写源码 block（轻声明一次）；只读命令放行（softened）。
  {
    const root = makeWorkspace();
    const blocked = evaluate(event(), { cwd: root });
    assert.equal(blocked.decision, "deny");
    assert.match(blocked.reason, /not initialized/u);

    const readCmd = evaluate(
      { name: "tool.before", platform: "test", action: "command.exec", command: "ls -la", targetPaths: [] },
      { cwd: root },
    );
    assert.equal(readCmd.decision, "allow");
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
}

run();
console.log("sdlc hooks tests passed");
