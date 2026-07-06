import { loadRegistry } from "./registry.mjs";
import { phaseCompletion, pendingConfirmations, phasePreconditionsUnmet } from "./artifacts.mjs";
import { effectiveAutoAdvance, validateAutoAdvanceOrder } from "./registry.mjs";

// auto.advance 严格推进闸门与查找辅助。
//
// 设计要点（见 issue #17）：
// - auto-advance 是 registry-gated 能力：默认关闭，只有有效 registry 显式 enabled:true 才真实推进阶段。
// - 推进使用专门的严格闸门，而非仅依赖 status.blockingReasons：即便 status 显示“无阻塞”，
//   只要未满足“当前阶段完成 / 无待确认 / 目标前置满足”等前置，也拒绝自动推进。
// - debug 默认不在自动顺序内（debug 是显式例外流程），只有项目显式把 debug 写进 autoAdvance.order 才可经自动路径进入。
// - 每次尝试（成功或拒绝）都写审计事件到 hook-events.ndjson，由调用方（adapters/manual.mjs）负责落盘。

// 给定状态与有效 registry，返回 autoAdvance.order 中当前阶段的下一阶段；不存在返回 null。
export function autoAdvanceNextPhase(state, registry) {
  const { order } = effectiveAutoAdvance(registry);
  const index = order.indexOf(state?.phase);
  if (index < 0 || index >= order.length - 1) {
    return null;
  }
  return order[index + 1];
}

// 便捷封装：直接从 root 读取 registry。供 status / nextAction 等调用。
export function autoAdvanceNextPhaseFromState(state, root) {
  return autoAdvanceNextPhase(state, loadRegistry(root));
}

// 严格推进闸门（AC #6）。返回结构化判定：
//   { allowed: true,  target }                                 —— 可推进到 target
//   { allowed: false, configError }                            —— registry 配置非法（AC #3）
//   { allowed: false, reason, unmet? }                         —— 正常拒绝（未启用 / 阶段不在顺序 / 未完成 / 有待确认 / 目标前置未满足 / 已是末阶段）
// 该判定同时被 auto.advance 命令与 status.nextAction 复用，确保“能否自动推进”只有一个真相来源。
export function evaluateAutoAdvanceGate(state, root) {
  const registry = loadRegistry(root);
  const configError = validateAutoAdvanceOrder(effectiveAutoAdvance(registry).order);
  if (configError) {
    return { allowed: false, configError };
  }

  const { enabled, order } = effectiveAutoAdvance(registry);
  if (!enabled) {
    return { allowed: false, reason: "auto-advance 未启用（registry.autoAdvance.enabled=false）。" };
  }

  const current = state?.phase;
  const index = order.indexOf(current);
  if (index < 0) {
    return {
      allowed: false,
      reason: `当前阶段 ${current} 不在 auto-advance 顺序 ${order.join(" → ")} 内，无法自动推进。`,
    };
  }

  const completion = phaseCompletion(state, root);
  if (!completion[current]) {
    return { allowed: false, reason: `当前阶段 ${current} 尚未完成，不满足自动推进条件。` };
  }

  const pending = pendingConfirmations(state, root);
  if (pending.length > 0) {
    return {
      allowed: false,
      reason: `存在未处理待确认：${pending.map((item) => item.name).join(", ")}，无法自动推进。`,
    };
  }

  const target = order[index + 1];
  if (!target) {
    return {
      allowed: false,
      reason: `${current} 已是 auto-advance 顺序的最后一阶段，无下一阶段可推进。`,
    };
  }

  const unmet = phasePreconditionsUnmet(state, root, target);
  if (unmet.length > 0) {
    return {
      allowed: false,
      reason: `目标阶段 ${target} 的前置门禁未满足，无法自动推进。`,
      unmet: unmet.map((item) => item.step || item.enforcement || "precondition"),
    };
  }

  return { allowed: true, target };
}

// 供 status.nextAction 使用：auto-advance 是否已“可立即执行”（AC #9）。
// 与严格闸门同源，只是不返回拒绝原因；配置非法时不算“适用”。
export function isAutoAdvanceApplicable(state, root) {
  if (!state?.activeTaskDir) {
    return false;
  }
  const gate = evaluateAutoAdvanceGate(state, root);
  return gate.allowed;
}
