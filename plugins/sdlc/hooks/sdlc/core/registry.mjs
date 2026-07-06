import path from "node:path";
import { fileURLToPath } from "node:url";
import { PHASES, readJsonIfExists } from "./context.mjs";

// 内置默认 registry 路径（相对本文件）。
const DEFAULT_REGISTRY_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "registry",
  "default.json",
);

// auto-advance 默认配置：registry-gated，默认关闭；默认自动顺序为 design→implement→test，
// 不含 debug（debug 是显式例外流程，除非项目显式把 debug 写进 autoAdvance.order）。
export const DEFAULT_AUTO_ADVANCE = { enabled: false, order: ["design", "implement", "test"] };

const EMPTY_REGISTRY = { steps: {}, phasePreconditions: {}, order: [], autoAdvance: { ...DEFAULT_AUTO_ADVANCE } };

// 项目覆盖文件：随项目走，由 sdlc-flow 对话沉淀或手工编辑。
export function projectRegistryPath(root) {
  return path.join(root, "docs", "_sdlc", "registry.json");
}

export function loadDefaultRegistry() {
  return readJsonIfExists(DEFAULT_REGISTRY_PATH, EMPTY_REGISTRY);
}

// 有效 registry = 内置默认 深合并 项目覆盖。
export function loadRegistry(root) {
  return mergeRegistry(loadDefaultRegistry(), readJsonIfExists(projectRegistryPath(root), null));
}

// 合并语义：steps 按步骤名覆盖（项目可换某一步的工具链而不动其它）；
// phasePreconditions 按阶段覆盖（项目声明硬前置）；order 项目非空则整体替换。
function mergeRegistry(base, override) {
  const safeBase = base && typeof base === "object" ? base : EMPTY_REGISTRY;
  if (!override || typeof override !== "object") {
    return {
      steps: { ...(safeBase.steps || {}) },
      phasePreconditions: { ...(safeBase.phasePreconditions || {}) },
      order: Array.isArray(safeBase.order) ? safeBase.order : [],
    };
  }

  const baseAuto = safeBase.autoAdvance && typeof safeBase.autoAdvance === "object" ? safeBase.autoAdvance : DEFAULT_AUTO_ADVANCE;
  const overrideAuto = override.autoAdvance && typeof override.autoAdvance === "object" ? override.autoAdvance : null;

  // autoAdvance 深合并：enabled 与 order 各自独立覆盖；项目只写 enabled:true 时 order 回退到默认值
  //（AC：{ "autoAdvance": { "enabled": true } } 即启用默认自动顺序）。order 仅当为非空数组时整体替换。
  const autoAdvance = {
    enabled: overrideAuto && typeof overrideAuto.enabled === "boolean" ? overrideAuto.enabled : baseAuto.enabled === true,
    order:
      overrideAuto && Array.isArray(overrideAuto.order) && overrideAuto.order.length > 0
        ? overrideAuto.order
        : Array.isArray(baseAuto.order) && baseAuto.order.length > 0
          ? baseAuto.order
          : [...DEFAULT_AUTO_ADVANCE.order],
  };

  return {
    steps: { ...(safeBase.steps || {}), ...(override.steps || {}) },
    phasePreconditions: {
      ...(safeBase.phasePreconditions || {}),
      ...(override.phasePreconditions || {}),
    },
    order:
      Array.isArray(override.order) && override.order.length > 0
        ? override.order
        : Array.isArray(safeBase.order)
          ? safeBase.order
          : [],
    autoAdvance,
  };
}

// 解析抽象步骤为有序工具链（软推荐：phase skill 据此推荐 + 降级）。
export function resolveStep(registry, name) {
  const step = registry?.steps?.[name];
  if (!step) {
    return null;
  }
  return {
    name,
    summary: typeof step.summary === "string" ? step.summary : "",
    tools: Array.isArray(step.tools) ? step.tools : [],
  };
}

// 某阶段的项目声明硬前置门禁清单（required-evidence schema；当前支持 file evidence）。
export function registryPhasePreconditions(registry, phase) {
  const list = registry?.phasePreconditions?.[phase];
  return Array.isArray(list) ? list : [];
}

// 给 `registry show` / `status.flow` 用的有效流程快照，含 autoAdvance 有效配置（AC #10）。
export function effectiveFlow(registry) {
  return {
    order: registry?.order || [],
    steps: registry?.steps || {},
    phasePreconditions: registry?.phasePreconditions || {},
    autoAdvance: effectiveAutoAdvance(registry),
  };
}

// 有效 autoAdvance 配置：window 默认值 + 项目覆盖，order 缺失/非法时回退默认。
// 不做合法性校验（校验见 validateAutoAdvanceOrder），仅给出“尽力解析”后的有效配置。
export function effectiveAutoAdvance(registry) {
  const base = registry?.autoAdvance;
  if (!base || typeof base !== "object") {
    return { enabled: false, order: [...DEFAULT_AUTO_ADVANCE.order] };
  }
  const order =
    Array.isArray(base.order) && base.order.length > 0 ? base.order : [...DEFAULT_AUTO_ADVANCE.order];
  return { enabled: base.enabled === true, order };
}

// 校验 autoAdvance.order 合法性。返回 null 表示有效，否则返回人类可读的配置错误字符串（AC #3）。
export function validateAutoAdvanceOrder(order) {
  if (!Array.isArray(order)) {
    return `autoAdvance.order 必须是数组，当前为 ${typeof order}。`;
  }
  if (order.length === 0) {
    return "autoAdvance.order 不能为空数组。";
  }
  for (const phase of order) {
    if (typeof phase !== "string" || !PHASES.includes(phase)) {
      return `autoAdvance.order 含非法阶段 "${String(phase)}"；合法值：${PHASES.join(", ")}。`;
    }
  }
  if (new Set(order).size !== order.length) {
    return "autoAdvance.order 含重复阶段，必须唯一。";
  }
  return null;
}
