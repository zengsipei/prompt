#!/usr/bin/env node
import { writeGeneratedHookArtifacts } from "../core/hook-config-generator.mjs";

const generated = writeGeneratedHookArtifacts();

process.stdout.write(`Generated ${generated.length} hook config files:\n`);
for (const filePath of generated) {
  process.stdout.write(`- ${filePath}\n`);
}
