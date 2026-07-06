import path from "node:path";
import { currentStatePath, readJsonIfExists, workspaceRoot, writeJson } from "./context.mjs";
import { phaseCompletion, pendingConfirmations } from "./artifacts.mjs";
import { currentSessionId, sessionPath } from "./session.mjs";
// 关闭原因：completed 为成功收尾；canceled/wontfix/superseded 为非成功收尾（需 close note）。
export const CLOSE_REASONS = ["completed", "canceled", "wontfix", "superseded"];
export const SUCCESSFUL_CLOSE_REASON = "completed";
// 成功完成所需的阶段证据：design/implement/test 同时齐备。
export const SUCCESS_EVIDENCE_PHASES = ["design", "implement", "test"];

// 成功完成所需证据是否齐全：design/implement/test 证据齐备且无未处理待确认。
// 这是「由完成证据驱动、与当前 phase 字符串无关」的判定（PRD AC：phase 即便不是 test，
// 只要证据齐全也算可成功收尾）。manual 的 task.close --reason completed 与 session.stop
// 的自动收尾共用此判定，确保两条路径同源、不漂移。
//
// 刻意不在此处计入 debug 激活态——completed 关闭与 stop auto-close 对 active debug 的处理不同
//（前者硬拦要求先 debug.close，后者只提示并放弃自动关闭），由各自调用方按场景处理。
export function completionEvidenceReady(state, root = workspaceRoot(), precomputed = {}) {
  if (!state?.activeTaskDir) {
    return { ready: false, missing: SUCCESS_EVIDENCE_PHASES.slice(), completion: {}, pending: [] };
  }

  const completion = precomputed.completion || phaseCompletion(state, root);
  const pending = precomputed.pending || pendingConfirmations(state, root);
  const missing = SUCCESS_EVIDENCE_PHASES.filter((phase) => !completion[phase]);

  return {
    ready: missing.length === 0 && pending.length === 0,
    missing,
    completion,
    pending,
  };
}

// close 核心：写最终关闭证据（onlyAI/closure.json）+ 把生命周期推入 closed 终端态。
// manual 的 closeTask 与 session.stop 的 auto-close fallback 共用同一核心，确保 auto-close
// 写入与显式 completed close 完全一致的关闭证据——仅 closeTrigger / note 区分来源（PRD AC5）。
//
// trigger："manual"（显式 task.close）或 "session.stop"（stop 兜底自动关闭）。
// 调用方负责在调用前完成各自的校验（reason 合法性、证据齐全、debug 处理等）；
// 本函数只负责「写证据 + 转 closed」这段无分支的状态变更。
export function performClose(state, root = workspaceRoot(), options = {}) {
  const { reason, note = "", completion, pending, trigger = "manual", sessionName = null } = options;

  const closedAt = new Date().toISOString();
  const sessionRecord = readJsonIfExists(sessionPath(root), null);
  const sessionId = sessionRecord?.sessionId || currentSessionId(root) || null;
  // session name：调用方可传 stop-time / task.close 推断名覆盖（无 session.start 时 sessionRecord
  // 不存在，靠调用方透传）；否则回退到 session 记录里的名。best-effort，未知仍记 null。
  const resolvedSessionName = sessionName || sessionRecord?.sessionName || sessionRecord?.name || null;
  const completed = reason === SUCCESSFUL_CLOSE_REASON;
  // 关闭时 debug 是否仍激活——非成功关闭允许带 active debug 关闭，但须把这一事实记进最终证据。
  const debugActiveAtClose = Boolean(state.debugActive);
  const autoClosed = trigger === "session.stop";
  const taskDir = state.activeTaskDir;
  const diagnosticsRef = "docs/_sdlc/session-diagnostics.json";
  const closureRelPath = `${taskDir}/onlyAI/closure.json`;
  const resolvedCompletion = completion || phaseCompletion(state, root);
  const resolvedPending = pending || pendingConfirmations(state, root);

  // 最终关闭证据：写进被关闭任务目录内，关闭后可独立审计而无需回读整个会话。
  const closureEvidence = {
    taskDir,
    closedAt,
    reason,
    note,
    completed,
    completion: resolvedCompletion,
    debugActiveAtClose,
    pendingConfirmations: resolvedPending.map((item) => item.name),
    // 来源标记：区分显式 task.close 与 session.stop 兜底自动关闭（AC5 的 reason/note 区分）。
    closeTrigger: trigger,
    autoClosed,
    sessionId,
    sessionName,
    diagnostics: diagnosticsRef,
  };
  writeJson(path.join(root, taskDir, "onlyAI", "closure.json"), closureEvidence);

  // 转入 closed 终端态：清空 activeTaskDir，previous task 仅经显式 lastTask 字段保留，
  // 杜绝把已关闭任务当成活动任务（PRD 核心风险）。保留全局配置（mode/strict/profile…）。
  const nextState = { ...state };
  delete nextState.compactSummary;
  // 任务关闭即清除 debug 激活态（debugActiveAtClose 已固化进证据/lastTask，事实不丢失）。
  delete nextState.debugActive;
  delete nextState.debugActivatedAt;
  delete nextState.debugSessionId;
  nextState.phase = "closed";
  nextState.activeTaskDir = null;
  nextState.lastTask = {
    dir: taskDir,
    closedAt,
    reason,
    note,
    completed,
    completion: resolvedCompletion,
    debugActiveAtClose,
    closeTrigger: trigger,
    autoClosed,
    sessionId,
    sessionName,
    closureEvidence: closureRelPath,
  };
  writeJson(currentStatePath(root), nextState);

  return { closureEvidence, nextState, closureRelPath, completed, taskDir, reason, autoClosed };
}
