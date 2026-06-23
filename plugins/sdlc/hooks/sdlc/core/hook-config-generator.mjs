import fs from "node:fs";
import path from "node:path";
import { RUNTIME_ROOT } from "./runtime.mjs";

export const GENERATE_HOOK_CONFIGS_COMMAND = "node hooks/sdlc/bin/generate-hook-configs.mjs";

const OUTPUTS = {
  codexPlugin: "hooks/codex-hooks.json",
  claudeCodePlugin: "hooks/claude-hooks.json",
  codexManual: "hooks/sdlc/manifests/codex.config.example.toml",
  claudeCodeManual: "hooks/sdlc/manifests/claude.settings.example.json",
};

export function hookManifestPath(root = RUNTIME_ROOT) {
  return path.join(root, "hooks", "sdlc", "manifests", "sdlc-hooks.json");
}

export function readHookManifest(root = RUNTIME_ROOT) {
  return JSON.parse(fs.readFileSync(hookManifestPath(root), "utf8"));
}

export function generatedHookArtifacts(manifest = readHookManifest()) {
  const enabledEvents = activeEvents(manifest);
  return new Map([
    [OUTPUTS.codexPlugin, `${stableJson(pluginHooks(enabledEvents, "codex", "PLUGIN_ROOT"))}\n`],
    [OUTPUTS.claudeCodePlugin, `${stableJson(pluginHooks(enabledEvents, "claudeCode", "CLAUDE_PLUGIN_ROOT"))}\n`],
    [OUTPUTS.codexManual, manualCodexConfig(enabledEvents)],
    [OUTPUTS.claudeCodeManual, `${stableJson(manualClaudeCodeSettings(enabledEvents))}\n`],
  ]);
}

export function writeGeneratedHookArtifacts(root = RUNTIME_ROOT) {
  const artifacts = generatedHookArtifacts(readHookManifest(root));
  for (const [relativePath, content] of artifacts) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
  }
  return [...artifacts.keys()];
}

export function checkGeneratedHookArtifacts(root = RUNTIME_ROOT) {
  const artifacts = generatedHookArtifacts(readHookManifest(root));
  const drift = [];

  for (const [relativePath, expected] of artifacts) {
    const filePath = path.join(root, relativePath);
    const actual = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
    if (actual !== expected) {
      drift.push(relativePath);
    }
  }

  return drift;
}

function activeEvents(manifest) {
  const events = Array.isArray(manifest.events) ? manifest.events : [];
  return events.filter((event) => event.enabled === true && event.implemented === true);
}

function pluginHooks(events, platform, rootEnvName) {
  const hooks = {};

  for (const event of events) {
    const platformEvent = event.platforms?.[platform];
    if (!platformEvent?.pluginEvent) {
      continue;
    }

    const command = `node "\${${rootEnvName}}/hooks/sdlc/bin/plugin-hook.mjs" ${platformEvent.pluginEvent}`;
    const hook = {
      type: "command",
      command,
    };

    if (typeof event.statusMessage === "string" && event.statusMessage.length > 0) {
      hook.statusMessage = event.statusMessage;
    }

    hooks[platformEvent.pluginEvent] = [
      {
        matcher: matcherPattern(platformEvent.matcher),
        hooks: [hook],
      },
    ];
  }

  return { hooks };
}

function manualClaudeCodeSettings(events) {
  const hooks = {};

  for (const event of events) {
    const platformEvent = event.platforms?.claudeCode;
    if (!platformEvent?.manualEvent) {
      continue;
    }

    hooks[platformEvent.manualEvent] = [
      {
        matcher: matcherPattern(platformEvent.matcher),
        hooks: [
          {
            type: "command",
            command: `node <RUNTIME_ROOT>/hooks/sdlc/bin/claude-hook.mjs ${platformEvent.manualEvent}`,
          },
        ],
      },
    ];
  }

  return { hooks };
}

function manualCodexConfig(events) {
  const lines = [
    "# Generated from hooks/sdlc/manifests/sdlc-hooks.json.",
    `# Regenerate with: ${GENERATE_HOOK_CONFIGS_COMMAND}`,
    "# Copy these entries into the user Codex config that your Codex version loads.",
    "# Replace <RUNTIME_ROOT> with the absolute path to the user-level runtime.",
    "# Projects do not need to copy hooks/sdlc; they only store docs/_sdlc state.",
    "#",
    `# Codex event names used here: ${events.map((event) => event.platforms?.codex?.manualEvent).filter(Boolean).join(", ")}.`,
    "",
    "[hooks]",
  ];

  for (const event of events) {
    const platformEvent = event.platforms?.codex;
    if (!platformEvent?.manualEvent) {
      continue;
    }

    lines.push(`${platformEvent.manualEvent} = [`);
    lines.push(
      `  { command = "${tomlString(`node <RUNTIME_ROOT>/hooks/sdlc/bin/codex-hook.mjs ${platformEvent.manualEvent}`)}" }`,
    );
    lines.push("]");
  }

  return `${lines.join("\n")}\n`;
}

function matcherPattern(matcher) {
  if (!matcher || matcher.strategy === "all") {
    return "";
  }
  return typeof matcher.pattern === "string" ? matcher.pattern : "";
}

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

function tomlString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
