import { randomUUID } from "node:crypto";
import path from "node:path";
import { readJsonIfExists, workspaceRoot, writeJson } from "./context.mjs";

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
