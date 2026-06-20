import fs from "node:fs";
import path from "node:path";

export const PHASES = ["design", "implement", "test", "debug"];

// 按 profile 分档的软门禁矩阵。硬门禁（红线、施工边界、pending、项目前置门禁）不在此处——它们恒为 block，
// 不随 profile 浮动。这里只放“流程序列”一类的软约束：可偏离、按 profile 决定 off/warn/block。
const GATE_MATRIX = {
  // 默认阶段顺序（跳级 / 乱序）
  phaseOrder: { lite: "off", standard: "warn", full: "warn" },
  // “设计期不许碰源码”——软化后允许边设计边写原型
  designSourceEdit: { lite: "off", standard: "warn", full: "warn" },
  // 施工边界：声明集非空时的拦截力度；空集合由调用方退化为 warn
  boundary: { lite: "warn", standard: "block", full: "block" },
  // 会话 Stop 时阶段完整度
  stop: { lite: "off", standard: "warn", full: "block" },
};

// 取某 profile 下某条软门禁的档位：off（放行不留痕）/ warn（放行+留痕）/ block（拦截）。
export function gateLevel(profile, gateName) {
  const row = GATE_MATRIX[gateName];
  if (!row) {
    return "off";
  }
  const key = String(profile || "standard").trim().toLowerCase();
  return row[key] || row.standard || "warn";
}

export function workspaceRoot(options = {}) {
  return path.resolve(options.cwd || process.env.SDLC_WORKSPACE || process.cwd());
}

export function toPosixPath(value) {
  return value.replace(/\\/g, "/");
}

export function normalizeRelativePath(value, root = workspaceRoot()) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const raw = value.trim();
  if (!raw) {
    return null;
  }

  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const relative = path.relative(root, resolved);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return toPosixPath(resolved);
  }

  return toPosixPath(relative);
}

export function readJsonIfExists(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function readTextIfExists(filePath, fallback = "") {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function appendNdjson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export function currentStatePath(root = workspaceRoot()) {
  return path.join(root, "docs", "_sdlc", "current.json");
}

export function eventsPath(root = workspaceRoot()) {
  return path.join(root, "docs", "_sdlc", "hook-events.ndjson");
}

export function loadCurrentState(root = workspaceRoot()) {
  const state = readJsonIfExists(currentStatePath(root), null);
  if (!state) {
    return null;
  }

  const activeTaskDir = state.activeTaskDir
    ? normalizeRelativePath(state.activeTaskDir, root)
    : null;

  return {
    mode: "enforce",
    strict: true,
    phase: "design",
    stopGate: "warn",
    ...state,
    activeTaskDir,
  };
}

export function taskPath(state, root = workspaceRoot(), relativePath = "") {
  if (!state?.activeTaskDir) {
    return null;
  }
  return path.join(root, state.activeTaskDir, relativePath);
}

export function onlyAiPath(state, root = workspaceRoot(), relativePath = "") {
  return taskPath(state, root, path.join("onlyAI", relativePath));
}

export function hookStatePath(state, root = workspaceRoot()) {
  return onlyAiPath(state, root, "hook-state.json");
}

export function loadHookState(state, root = workspaceRoot()) {
  const filePath = hookStatePath(state, root);
  return filePath ? readJsonIfExists(filePath, {}) : {};
}

export function saveHookState(state, data, root = workspaceRoot()) {
  const filePath = hookStatePath(state, root);
  if (!filePath) {
    return;
  }
  writeJson(filePath, {
    updatedAt: new Date().toISOString(),
    ...data,
  });
}

export function recordEvent(event, result, root = workspaceRoot()) {
  appendNdjson(eventsPath(root), {
    at: new Date().toISOString(),
    event: event.name,
    platform: event.platform,
    action: event.action,
    toolName: event.toolName,
    targetPaths: event.targetPaths,
    decision: result.decision,
    severity: result.severity,
    message: result.message || result.reason,
  });
}
