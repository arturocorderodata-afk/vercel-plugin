#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  const content = readFileSync(join(PLUGIN_ROOT, "vercel.md"), "utf-8");
  process.stdout.write(content);
} catch {
}
