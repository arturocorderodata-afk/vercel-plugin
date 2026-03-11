#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatOutput
} from "./compat.mjs";
function parseSessionStartSeenSkillsInput(raw) {
  try {
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function detectSessionStartSeenSkillsPlatform(input, _env = process.env) {
  if (input && ("conversation_id" in input || "cursor_version" in input)) {
    return "cursor";
  }
  return "claude-code";
}
function formatSessionStartSeenSkillsCursorOutput() {
  return JSON.stringify(formatOutput("cursor", {
    env: {
      VERCEL_PLUGIN_SEEN_SKILLS: ""
    }
  }));
}
function main() {
  const input = parseSessionStartSeenSkillsInput(readFileSync(0, "utf8"));
  const platform = detectSessionStartSeenSkillsPlatform(input);
  if (platform === "cursor") {
    process.stdout.write(formatSessionStartSeenSkillsCursorOutput());
    return;
  }
}
const SESSION_START_SEEN_SKILLS_ENTRYPOINT = fileURLToPath(import.meta.url);
const isSessionStartSeenSkillsEntrypoint = process.argv[1] ? resolve(process.argv[1]) === SESSION_START_SEEN_SKILLS_ENTRYPOINT : false;
if (isSessionStartSeenSkillsEntrypoint) {
  main();
}
export {
  detectSessionStartSeenSkillsPlatform,
  formatSessionStartSeenSkillsCursorOutput,
  parseSessionStartSeenSkillsInput
};
