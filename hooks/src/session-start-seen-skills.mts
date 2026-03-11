#!/usr/bin/env node
/**
 * SessionStart hook: initialize the seen-skills dedup state.
 * Claude Code now relies on the claim-dir/session-file dedup flow, so this hook
 * is a no-op on that platform.
 * Cursor returns `{ env: { VERCEL_PLUGIN_SEEN_SKILLS: "" } }` on stdout.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatOutput,
  type HookPlatform,
} from "./compat.mjs";

interface SessionStartSeenSkillsInput {
  session_id?: string;
  conversation_id?: string;
  cursor_version?: string;
  [key: string]: unknown;
}

export function parseSessionStartSeenSkillsInput(raw: string): SessionStartSeenSkillsInput | null {
  try {
    if (!raw.trim()) return null;
    return JSON.parse(raw) as SessionStartSeenSkillsInput;
  } catch {
    return null;
  }
}

export function detectSessionStartSeenSkillsPlatform(
  input: SessionStartSeenSkillsInput | null,
  _env: NodeJS.ProcessEnv = process.env,
): HookPlatform {
  if (input && ("conversation_id" in input || "cursor_version" in input)) {
    return "cursor";
  }

  return "claude-code";
}

export function formatSessionStartSeenSkillsCursorOutput(): string {
  return JSON.stringify(formatOutput("cursor", {
    env: {
      VERCEL_PLUGIN_SEEN_SKILLS: "",
    },
  }));
}

function main(): void {
  const input = parseSessionStartSeenSkillsInput(readFileSync(0, "utf8"));
  const platform = detectSessionStartSeenSkillsPlatform(input);

  if (platform === "cursor") {
    process.stdout.write(formatSessionStartSeenSkillsCursorOutput());
    return;
  }
}

const SESSION_START_SEEN_SKILLS_ENTRYPOINT = fileURLToPath(import.meta.url);
const isSessionStartSeenSkillsEntrypoint = process.argv[1]
  ? resolve(process.argv[1]) === SESSION_START_SEEN_SKILLS_ENTRYPOINT
  : false;

if (isSessionStartSeenSkillsEntrypoint) {
  main();
}
