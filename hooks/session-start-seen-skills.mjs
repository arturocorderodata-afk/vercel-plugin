#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const envFile = process.env.CLAUDE_ENV_FILE;
if (!envFile) {
  process.exit(0);
}
try {
  appendFileSync(envFile, 'export VERCEL_PLUGIN_SEEN_SKILLS=""\n');
} catch {
}
