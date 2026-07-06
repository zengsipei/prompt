import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eventsPath, readJsonIfExists, workspaceRoot, writeJson } from "./context.mjs";

// 详细诊断的滚动历史上限：只留最近 N 条，避免无界增长污染磁盘/上下文。
const DIAGNOSTICS_HISTORY_LIMIT = 20;
// 紧凑摘要的单行长度上限（诊断条目里附带一行速览，完整内容仍在 message 字段）。
const SUMMARY_MAX_LENGTH = 160;

// 轻量会话记录：落在 docs/_sdlc 下而非 activeTaskDir 内，所以无活动任务（idle/closed）时也能建。
export function sessionPath(root = workspaceRoot()) {
  return path.join(root, "docs", "_sdlc", "session.json");
}

// 详细 hook 诊断：latest（最近一条）+ history（小滚动历史）。
export function diagnosticsPath(root = workspaceRoot()) {
  return path.join(root, "docs", "_sdlc", "session-diagnostics.json");
}

// session.start 建立轻量会话记录并返回 session id。
// active-task 与 idle/closed 都建记录；后者标记 active:false，不复活上一个任务。
// 平台若已带 sessionId 则沿用，否则本地生成，保证后续事件归属一致。
export function startSession(root = workspaceRoot(), state = null, event = null) {
  const sessionId = (event && event.sessionId) || randomUUID();
  const activeTaskDir = state?.activeTaskDir || null;
  const phase = state?.phase || null;
  const record = {
    sessionId,
    startedAt: new Date().toISOString(),
    active: Boolean(activeTaskDir) && phase !== "closed",
    activeTaskDir,
    phase,
    platform: event?.platform || null,
  };
  writeJson(sessionPath(root), record);
  return sessionId;
}

// 读当前会话 id；无会话记录时返回 null（早于任何 session.start 的事件可无归属）。
export function currentSessionId(root = workspaceRoot()) {
  const record = readJsonIfExists(sessionPath(root), null);
  return record?.sessionId || null;
}

function compactSummary(message) {
  if (!message) {
    return "";
  }
  const firstLine = String(message).split("\n", 1)[0].trim();
  return firstLine.length > SUMMARY_MAX_LENGTH ? `${firstLine.slice(0, SUMMARY_MAX_LENGTH - 1)}…` : firstLine;
}

// 构造一条完整诊断条目：保留长 message 与完整 targetPaths 等细节，
// 这些细节从紧凑事件流分流到此处，供深入排查时读取。
export function diagnosticsEntry(event, result, sessionId = null) {
  return {
    at: new Date().toISOString(),
    sessionId: sessionId || null,
    event: event?.name || null,
    rawEventName: event?.rawEventName || null,
    platform: event?.platform || null,
    action: event?.action || null,
    toolName: event?.toolName || null,
    success: event?.success,
    failureReason: event?.failureReason || null,
    // command.exec 事件的命令文本（单行截断）：供 stop-time 推断「测试类命令」信号。
    // 仅 command 类事件有值；其余记 null。详细诊断本就持有完整细节，这是其职责。
    command: event?.command ? compactSummary(event.command) : null,
    targetPaths: Array.isArray(event?.targetPaths) ? event.targetPaths : [],
    decision: result?.decision || null,
    severity: result?.severity || null,
    summary: compactSummary(result?.message || result?.reason),
    message: result?.message || result?.reason || "",
  };
}

// 把详细诊断写入 latest + 小滚动 history；history 按时间倒序保留最近 N 条。
export function recordDiagnostics(root = workspaceRoot(), entry = null) {
  if (!entry) {
    return;
  }
  const previous = readJsonIfExists(diagnosticsPath(root), null);
  const history = Array.isArray(previous?.history) ? previous.history : [];
  writeJson(diagnosticsPath(root), {
    latest: entry,
    history: [entry, ...history].slice(0, DIAGNOSTICS_HISTORY_LIMIT),
  });
}

// —— stop-time 本地会话命名 + best-effort 平台 rename（#14） ——

// 测试类命令模式：从 command 文本推断当前会话是否跑过测试。best-effort，命中即用。
const TEST_COMMAND_RE =
  /\b(pytest|jest|vitest|mocha|rspec|cargo\s+test|go\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|ng\s+test|--test)\b/iu;

// 平台 session rename 能力探测：best-effort。当前无平台提供受支持的 session rename API，
// 默认 unavailable。环境变量 SDLC_SESSION_RENAME 供测试 / 异常安装模拟平台能力
// （unavailable | fail | ok）；生产路径恒为 unavailable，rename 永不阻断生命周期。
export function platformRenameCapability() {
  const value = String(process.env.SDLC_SESSION_RENAME || "unavailable").trim().toLowerCase();
  return value === "ok" || value === "fail" ? value : "unavailable";
}

// 尝试平台 rename：仅在能力可用时尝试，返回是否应用 / 是否可用 / 失败原因。
// 自动路径（stop）对失败静默；手动路径（session.rename）据结果给显式反馈。
export function attemptPlatformRename(sessionId, name) {
  const capability = platformRenameCapability();
  if (capability === "unavailable") {
    return { available: false, applied: false, error: null };
  }
  if (capability === "fail") {
    return { available: true, applied: false, error: "platform rename rejected" };
  }
  return { available: true, applied: true, error: null };
}

// 取 task 目录的最后一段作为 slug：docs/login-fix → login-fix。
function taskSlug(state) {
  const taskDir = state?.activeTaskDir || state?.lastTask?.dir || null;
  if (!taskDir) {
    return null;
  }
  const segments = String(taskDir).replace(/\\/gu, "/").split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

// 读当前会话的事件流（紧凑 ndjson），按 sessionId 过滤。session.start 默认不记事件，
// 故这里拿到的是 tool / prompt / compact 等后续事件——足以推断主导动作与活动密度。
function readCurrentSessionEvents(root, sessionId) {
  if (!sessionId) {
    return [];
  }
  let raw;
  try {
    raw = fs.readFileSync(eventsPath(root), "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line);
      if (entry && entry.sessionId === sessionId) {
        events.push(entry);
      }
    } catch {
      // 跳过损坏行：事件流是 append-only，单行损坏不应阻断推断。
    }
  }
  return events;
}

function mostFrequent(values) {
  if (!values || values.length === 0) {
    return null;
  }
  const counts = new Map();
  for (const value of values) {
    if (!value) {
      continue;
    }
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

// 觱及区域：从当前会话诊断 history 的完整 targetPaths 取最高频目录前缀。
// 仅看源码路径（排除 docs/ 生命周期文档），best-effort——history 只留最近 N 条，
// 信号不全时降级为 null。
function inferArea(diagEntries) {
  const dirs = [];
  for (const entry of diagEntries) {
    for (const p of Array.isArray(entry?.targetPaths) ? entry.targetPaths : []) {
      if (typeof p !== "string" || !p || p.startsWith("docs/")) {
        continue;
      }
      const idx = p.lastIndexOf("/");
      dirs.push(idx > 0 ? p.slice(0, idx) : p);
    }
  }
  return mostFrequent(dirs);
}

function isTestLikeCommand(command) {
  return typeof command === "string" && TEST_COMMAND_RE.test(command);
}

// 从低成本运行时信号推断一个有用会话名：task slug、phase / closed、当前会话事件的主导动作、
// 觱及区域、测试类命令。不读完整对话历史（PRD AC1 / AC22）。信号 where available：
// 无 session.start 时降级为 slug + phase 仍能给出名字。
export function inferSessionName(state, root = workspaceRoot(), sessionId = null) {
  const slug = taskSlug(state);
  const isClosed = state?.phase === "closed";
  const phase = isClosed ? "closed" : state?.phase || null;

  const events = readCurrentSessionEvents(root, sessionId);
  const diag = readJsonIfExists(diagnosticsPath(root), null);
  const diagEntries = Array.isArray(diag?.history)
    ? diag.history.filter((entry) => sessionId == null || entry?.sessionId === sessionId)
    : [];

  const dominantAction = mostFrequent(events.map((entry) => entry.action).filter(Boolean));
  const testLike = diagEntries.some((entry) => isTestLikeCommand(entry.command));
  const area = inferArea(diagEntries);

  const parts = [];
  if (slug) {
    parts.push(slug);
  }
  if (testLike) {
    parts.push("test");
  } else if (phase) {
    parts.push(phase);
  }
  if (area) {
    parts.push(area);
  } else if (dominantAction && !testLike) {
    parts.push(dominantAction);
  }

  return parts.length > 0 ? parts.join(": ") : "sdlc-session";
}

// 把推断名写入 session 记录 + best-effort 平台 rename。自动路径（stop / task.close）调用：
// rename 失败静默（不进 result.message），只落 session 记录与诊断（PRD AC25）。
// session.json 不存在时不新建（应由 session.start 创建；close 时无记录则只把名字交给调用方）。
// 返回推断名与平台 rename 结果，供调用方写进 closure evidence。
export function recordInferredSessionName(state, root = workspaceRoot(), source = "stop") {
  const sessionId = currentSessionId(root);
  const name = inferSessionName(state, root, sessionId);
  const rename = attemptPlatformRename(sessionId, name);
  const at = new Date().toISOString();
  const previous = readJsonIfExists(sessionPath(root), null);
  if (previous) {
    writeJson(sessionPath(root), {
      ...previous,
      sessionName: name,
      sessionNameInferredAt: at,
      sessionNameSource: source,
      platformRename: {
        available: rename.available,
        applied: rename.applied,
        error: rename.error || null,
        at,
      },
    });
  }
  return { name, rename };
}

// 手动 rename：显式覆盖 session 名。session.json 不存在时也建记录（显式命令应留痕）。
// 返回平台 rename 结果，供 manual 命令给显式反馈（applied / unavailable，PRD AC26）。
export function applyManualRename(name, root = workspaceRoot()) {
  const at = new Date().toISOString();
  const previous = readJsonIfExists(sessionPath(root), null);
  const base = previous || {
    sessionId: randomUUID(),
    startedAt: at,
    active: false,
    activeTaskDir: null,
    phase: null,
  };
  const rename = attemptPlatformRename(base.sessionId, name);
  writeJson(sessionPath(root), {
    ...base,
    sessionName: name,
    sessionNameInferredAt: at,
    sessionNameSource: "manual",
    platformRename: {
      available: rename.available,
      applied: rename.applied,
      error: rename.error || null,
      at,
    },
  });
  return { rename, sessionId: base.sessionId };
}
