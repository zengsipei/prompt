import path from "node:path";
import { fileURLToPath } from "node:url";
import { toPosixPath } from "./context.mjs";

// 运行时根 = 包含 hooks/、skills/ 的目录，也就是 CLI 命令里
// `node <root>/hooks/sdlc/bin/sdlc-hook.mjs` 的 <root>。
//
// 本文件位于 <root>/hooks/sdlc/core/runtime.mjs，上溯三级（core → sdlc → hooks → root）即得。
// import.meta.url 永远指向本文件在磁盘上的真实位置——无论 dev 仓内、全局安装（~/.claude）
// 还是插件目录，自解析都正确。这取代了旧的 <SDLC_RUNTIME> 字面占位符：那个占位符泄漏进
// 给 agent 看的报错与 help，agent 无从替换；自解析则在 hook 进程里直接算出可执行的真实路径。
export const RUNTIME_ROOT = toPosixPath(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
);

// CLI 入口相对运行时根的固定子路径。
export const HOOK_ENTRY = "hooks/sdlc/bin/sdlc-hook.mjs";

// 解析运行时根：默认自解析；允许显式覆盖（异常安装 / 测试夹具用）。
export function resolveRuntimeRoot(override) {
  const value = typeof override === "string" ? override.trim() : "";
  return value || RUNTIME_ROOT;
}

// 可执行命令前缀：node "<root>/hooks/sdlc/bin/sdlc-hook.mjs"
// 用于 help / 报错指引 / skill 示例，确保 agent 拿到可直接运行的真实路径（含空格也安全）。
export function hookCommand(override) {
  return `node "${resolveRuntimeRoot(override)}/${HOOK_ENTRY}"`;
}
