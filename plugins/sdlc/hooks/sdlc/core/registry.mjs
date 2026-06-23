import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonIfExists } from "./context.mjs";

// 内置默认 registry 路径（相对本文件）。
const DEFAULT_REGISTRY_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "registry",
  "default.json",
);

const EMPTY_REGISTRY = { steps: {}, phasePreconditions: {}, order: [] };

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

// 给 `registry show` 用的有效流程快照。
export function effectiveFlow(registry) {
  return {
    order: registry?.order || [],
    steps: registry?.steps || {},
    phasePreconditions: registry?.phasePreconditions || {},
  };
}
