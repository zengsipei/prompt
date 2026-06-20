import path from "node:path";
import { block } from "./result.mjs";

// 内置红线：破坏性操作恒 block，优先级最高，不随 profile 浮动。
// 与“项目声明的前置门禁”互补——这里是所有项目共有的底线，那里是项目自己 opt-in 的硬约束。

const PROTECTED_CONFIG = new Set(["package.json", "tsconfig.json"]);
const PROTECTED_CONFIG_IN_COMMAND = /\b(package\.json|tsconfig(\.[^.\s/]+)?\.json)\b/iu;
const REMOVE_COMMAND = /\b(rm|del|Remove-Item)\b/iu;
// DROP TABLE/DATABASE/SCHEMA、DROP COLUMN、ALTER COLUMN —— 数据库破坏性变更。
const SQL_DESTRUCTIVE = /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|DROP\s+COLUMN|ALTER\s+COLUMN)\b/iu;
// git push 到主分支。
const GIT_PUSH_MAIN = /\bgit\s+push\b[^\n]*?\b(main|master)\b/iu;

function isProtectedConfig(target) {
  const base = path.posix.basename(String(target || ""));
  return PROTECTED_CONFIG.has(base) || /^tsconfig\.[^.\s/]+\.json$/u.test(base);
}

// 命中红线返回 block 结果，否则返回 null。
export function detectRedline(event) {
  const action = event?.action;
  const paths = Array.isArray(event?.targetPaths) ? event.targetPaths : [];
  const command = typeof event?.command === "string" ? event.command : "";

  // 1) 删除核心配置文件——文件删除工具，或 rm/del/Remove-Item 命令。
  if (action === "fs.delete") {
    const hit = paths.filter(isProtectedConfig);
    if (hit.length > 0) {
      return redline(`禁止删除核心配置文件：${hit.join(", ")}。如确需变更请改为编辑并向用户单独确认。`);
    }
  }
  if (action === "command.exec" && REMOVE_COMMAND.test(command)) {
    if (paths.some(isProtectedConfig) || PROTECTED_CONFIG_IN_COMMAND.test(command)) {
      return redline("禁止用命令删除核心配置文件（package.json / tsconfig.json）。");
    }
  }

  // 2) 数据库破坏性变更。
  if (action === "command.exec" && SQL_DESTRUCTIVE.test(command)) {
    return redline("数据库破坏性变更（DROP / ALTER COLUMN）必须先暂停并取得用户确认。");
  }

  // 3) push 主分支。
  if (action === "command.exec" && GIT_PUSH_MAIN.test(command)) {
    return redline("禁止直接 git push 到主分支（main / master），需用户明确授权。");
  }

  return null;
}

function redline(message) {
  return block(`[红线] ${message}`, { redline: true });
}
