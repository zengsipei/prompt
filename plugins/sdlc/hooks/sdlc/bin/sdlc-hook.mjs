#!/usr/bin/env node
import { runManual } from "../adapters/manual.mjs";

try {
  runManual();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
