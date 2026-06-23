import fs from "node:fs";
import path from "node:path";
import { normalizeRelativePath, workspaceRoot } from "../core/context.mjs";

export async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

export function parseArgs(argv) {
  const result = {
    _: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      result._.push(item);
      continue;
    }

    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }

    result[key] = next;
    index += 1;
  }

  return result;
}

export function extractPatchPaths(patchText, root = workspaceRoot()) {
  if (!patchText || typeof patchText !== "string") {
    return [];
  }

  const paths = new Set();
  const patterns = [
    /^diff --git a\/(.+?) b\/(.+)$/gmu,
    /^\+\+\+ b\/(.+)$/gmu,
    /^--- a\/(.+)$/gmu,
    /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu,
  ];

  for (const pattern of patterns) {
    for (const match of patchText.matchAll(pattern)) {
      const value = match[2] || match[1];
      if (value && value !== "/dev/null") {
        paths.add(normalizeRelativePath(value, root));
      }
    }
  }

  return [...paths].filter(Boolean);
}

export function inferCommandPaths(command, root = workspaceRoot()) {
  if (!command || typeof command !== "string") {
    return [];
  }

  const paths = new Set();
  const quoted = command.matchAll(/['"]([^'"]+\.[A-Za-z0-9_-]+)['"]/gu);
  for (const match of quoted) {
    paths.add(normalizeRelativePath(match[1], root));
  }

  const redirections = command.matchAll(/>{1,2}\s*([^\s;&|]+)/gu);
  for (const match of redirections) {
    paths.add(normalizeRelativePath(match[1], root));
  }

  return [...paths].filter(Boolean);
}

export function inferToolAction(toolName, input = {}) {
  const name = String(toolName || "").toLowerCase();

  if (["edit", "multiedit", "apply_patch", "fs.edit"].includes(name)) {
    return "fs.edit";
  }

  if (["write", "writefile", "create_file", "update_file", "fs.write", "fs/writefile"].includes(name)) {
    return "fs.write";
  }

  if (["delete_file", "remove", "fs.delete", "fs/remove"].includes(name)) {
    return "fs.delete";
  }

  if (["bash", "shell", "shell_command", "command.exec", "command/exec"].includes(name)) {
    return "command.exec";
  }

  if (input.command) {
    return "command.exec";
  }

  return "tool.other";
}

export function inferTargetPaths(toolName, input = {}, root = workspaceRoot()) {
  const paths = new Set();

  for (const key of ["path", "file_path", "filePath", "target", "targetPath"]) {
    if (typeof input[key] === "string") {
      paths.add(normalizeRelativePath(input[key], root));
    }
  }

  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (typeof edit?.path === "string") {
        paths.add(normalizeRelativePath(edit.path, root));
      }
      if (typeof edit?.file_path === "string") {
        paths.add(normalizeRelativePath(edit.file_path, root));
      }
    }
  }

  for (const pathFromPatch of extractPatchPaths(input.patch || input.diff || input.content || "", root)) {
    paths.add(pathFromPatch);
  }

  if (input.command) {
    for (const pathFromCommand of inferCommandPaths(input.command, root)) {
      paths.add(pathFromCommand);
    }
  }

  return [...paths].filter(Boolean);
}

export function inferToolSuccess(payload = {}) {
  for (const key of ["success", "ok"]) {
    if (typeof payload[key] === "boolean") {
      return payload[key];
    }
  }

  if (payload.is_error === true || payload.isError === true) {
    return false;
  }

  const response = payload.tool_response || payload.toolResponse || payload.response || payload.result || {};
  if (response && typeof response === "object") {
    for (const key of ["success", "ok"]) {
      if (typeof response[key] === "boolean") {
        return response[key];
      }
    }

    if (response.is_error === true || response.isError === true || response.error) {
      return false;
    }
  }

  if (payload.error || payload.exception) {
    return false;
  }

  if (typeof payload.exit_code === "number") {
    return payload.exit_code === 0;
  }

  if (typeof payload.exitCode === "number") {
    return payload.exitCode === 0;
  }

  return true;
}

export function inferToolFailureReason(payload = {}) {
  const response = payload.tool_response || payload.toolResponse || payload.response || payload.result || {};
  const value =
    payload.error ||
    payload.exception ||
    payload.reason ||
    payload.message ||
    response?.error ||
    response?.reason ||
    response?.message;

  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (value && typeof value === "object" && typeof value.message === "string") {
    return value.message.trim();
  }

  return "";
}

export function ensureExecutablePath(filePath) {
  try {
    fs.chmodSync(filePath, 0o755);
  } catch {
    // Windows does not need POSIX executable bits.
  }
}

export function scriptRoot(importMetaUrl) {
  return path.dirname(new URL(importMetaUrl).pathname);
}
