#!/usr/bin/env node
/**
 * PreToolUse hook: injects relevant SKILL.md content as additionalContext
 * when Claude reads/edits/writes files or runs bash commands that match
 * skill-map patterns.
 *
 * Input: JSON on stdin with tool_name, tool_input, session_id
 * Output: JSON on stdout with { additionalContext: "..." } or {}
 *
 * Caps at 3 skills per invocation. Deduplicates per session.
 *
 * Debug: Set VERCEL_PLUGIN_HOOK_DEBUG=1 to emit JSON-lines debug events to stderr.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const MAX_SKILLS = 3;
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Debug logging (stderr-only, JSON-lines)
// ---------------------------------------------------------------------------

const DEBUG = process.env.VERCEL_PLUGIN_HOOK_DEBUG === "1";
const invocationId = DEBUG ? randomBytes(4).toString("hex") : "";
const t0 = DEBUG ? performance.now() : 0;

function dbg(event, data) {
  if (!DEBUG) return;
  const line = JSON.stringify({
    invocationId,
    event,
    timestamp: new Date().toISOString(),
    ...data,
  });
  process.stderr.write(line + "\n");
}

/**
 * Emit a structured issue event in debug mode.
 * Issue codes: STDIN_EMPTY, STDIN_PARSE_FAIL, SKILLMAP_LOAD_FAIL,
 *   SKILLMAP_EMPTY, DEDUP_READ_FAIL, SKILL_FILE_MISSING, DEDUP_WRITE_FAIL
 */
function emitIssue(code, message, hint, context) {
  dbg("issue", { code, message, hint, context });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run() {
  // ---- Read stdin ----
  let input;
  try {
    const raw = readFileSync(0, "utf-8").trim();
    if (!raw) {
      emitIssue("STDIN_EMPTY", "No data received on stdin", "Ensure the hook receives JSON on stdin with tool_name, tool_input, session_id", {});
      return "{}";
    }
    input = JSON.parse(raw);
  } catch (err) {
    emitIssue("STDIN_PARSE_FAIL", "Failed to parse stdin as JSON", "Verify stdin contains valid JSON with tool_name, tool_input, session_id fields", { error: String(err) });
    return "{}";
  }

  const toolName = input.tool_name || "";
  const toolInput = input.tool_input || {};
  // When session_id is missing and SESSION_ID env is unset, use null → memory-only dedup
  const sessionId = input.session_id || process.env.SESSION_ID || null;

  dbg("input-parsed", { toolName, sessionId });

  // ---- Load skill map ----
  let skillMap;
  try {
    const mapPath = join(PLUGIN_ROOT, "hooks", "skill-map.json");
    const parsed = JSON.parse(readFileSync(mapPath, "utf-8"));
    skillMap = parsed.skills || {};
  } catch (err) {
    emitIssue("SKILLMAP_LOAD_FAIL", "Failed to load or parse skill-map.json", "Check that hooks/skill-map.json exists and contains valid JSON with a .skills key", { error: String(err) });
    return "{}";
  }

  if (typeof skillMap !== "object" || Object.keys(skillMap).length === 0) {
    emitIssue("SKILLMAP_EMPTY", "Skill map is empty or has no skills", "Ensure hooks/skill-map.json has a non-empty .skills object", { type: typeof skillMap });
    return "{}";
  }

  const skillCount = Object.keys(skillMap).length;
  dbg("skillmap-loaded", { skillCount });

  // ---- Session dedup ----
  const dedupOff = process.env.VERCEL_PLUGIN_HOOK_DEDUP === "off";
  const usePersistentDedup = !dedupOff && sessionId !== null;
  const dedupStrategy = dedupOff ? "disabled" : usePersistentDedup ? "persistent" : "memory-only";

  dbg("dedup-strategy", { strategy: dedupStrategy, sessionId });

  const dedupDir = join(tmpdir(), "vercel-plugin-hooks");
  const dedupFile = usePersistentDedup
    ? join(dedupDir, `session-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`)
    : null;

  // RESET_DEDUP=1 clears the dedup file before matching
  if (process.env.RESET_DEDUP === "1" && dedupFile) {
    try {
      if (existsSync(dedupFile)) {
        writeFileSync(dedupFile, "[]");
        dbg("dedup-reset", { dedupFile });
      }
    } catch (err) {
      emitIssue("DEDUP_RESET_FAIL", "Failed to reset dedup file", "Check write permissions in tmpdir", { dedupFile, error: String(err) });
    }
  }

  let injectedSkills;
  if (dedupOff) {
    injectedSkills = new Set(); // never filters anything, never persists
  } else if (usePersistentDedup) {
    try {
      if (!existsSync(dedupDir)) mkdirSync(dedupDir, { recursive: true });
      injectedSkills = existsSync(dedupFile)
        ? new Set(JSON.parse(readFileSync(dedupFile, "utf-8")))
        : new Set();
    } catch (err) {
      emitIssue("DEDUP_READ_FAIL", "Failed to read or parse dedup state file", "Check file permissions in tmpdir; dedup will reset for this invocation", { dedupFile, error: String(err) });
      injectedSkills = new Set();
    }
  } else {
    // memory-only: fresh set each invocation, no persistence
    injectedSkills = new Set();
  }

  function persistDedup() {
    if (!usePersistentDedup || !dedupFile) return;
    try {
      writeFileSync(dedupFile, JSON.stringify([...injectedSkills]));
    } catch (err) {
      emitIssue("DEDUP_WRITE_FAIL", "Failed to persist dedup state", "Check write permissions in tmpdir; skills may re-inject next invocation", { dedupFile, error: String(err) });
    }
  }

  // ---- Determine matched skills ----
  const matched = new Set();

  if (["Read", "Edit", "Write"].includes(toolName)) {
    const filePath = toolInput.file_path || "";
    for (const [skill, config] of Object.entries(skillMap)) {
      if (matchPathPatterns(filePath, config.pathPatterns)) {
        matched.add(skill);
      }
    }
  } else if (toolName === "Bash") {
    const command = toolInput.command || "";
    for (const [skill, config] of Object.entries(skillMap)) {
      if (matchBashPatterns(command, config.bashPatterns)) {
        matched.add(skill);
      }
    }
  }

  dbg("matches-found", { matched: [...matched] });

  // Filter out already-injected skills (when dedup is disabled, injectedSkills is always empty)
  const newSkills = dedupOff
    ? [...matched]
    : [...matched].filter((s) => !injectedSkills.has(s));

  dbg("dedup-filtered", {
    newSkills,
    previouslyInjected: [...injectedSkills],
  });

  if (newSkills.length === 0) {
    dbg("complete", { result: "empty", elapsed_ms: Math.round(performance.now() - t0) });
    return "{}";
  }

  // Cap at MAX_SKILLS
  const toInject = newSkills.slice(0, MAX_SKILLS);

  // ---- Load SKILL.md files and build output ----
  const parts = [];
  for (const skill of toInject) {
    const skillPath = join(PLUGIN_ROOT, "skills", skill, "SKILL.md");
    try {
      const content = readFileSync(skillPath, "utf-8");
      parts.push(
        `<!-- skill:${skill} -->\n${content}\n<!-- /skill:${skill} -->`,
      );
      injectedSkills.add(skill);
    } catch (err) {
      emitIssue("SKILL_FILE_MISSING", `SKILL.md not found for skill "${skill}"`, `Create skills/${skill}/SKILL.md or remove "${skill}" from skill-map.json`, { skillPath, error: String(err) });
    }
  }

  dbg("skills-injected", { injected: toInject, totalParts: parts.length });

  if (parts.length === 0) {
    dbg("complete", { result: "empty", elapsed_ms: Math.round(performance.now() - t0) });
    return "{}";
  }

  // Persist dedup state
  persistDedup();

  dbg("complete", { result: "injected", skillCount: parts.length, elapsed_ms: Math.round(performance.now() - t0) });

  return JSON.stringify({ additionalContext: parts.join("\n\n") });
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

/**
 * Convert a simple glob pattern to a regex.
 * Supports *, **, and ? wildcards.
 */
function globToRegex(pattern) {
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches any path segments
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i++; // skip trailing /
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (".()+[]{}|^$\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
    i++;
  }
  re += "$";
  return new RegExp(re);
}

function matchPathPatterns(filePath, patterns) {
  if (!filePath || !patterns || patterns.length === 0) return false;

  // Normalize to forward slashes
  const normalized = filePath.replace(/\\/g, "/");

  for (const pattern of patterns) {
    const regex = globToRegex(pattern);

    // Try matching against the full path
    if (regex.test(normalized)) return true;

    // Try matching against the basename
    const base = basename(normalized);
    if (regex.test(base)) return true;

    // Try matching progressively from the end
    const segments = normalized.split("/");
    for (let i = 1; i < segments.length; i++) {
      const suffix = segments.slice(-i).join("/");
      if (regex.test(suffix)) return true;
    }
  }
  return false;
}

function matchBashPatterns(command, patterns) {
  if (!command || !patterns || patterns.length === 0) return false;
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern).test(command)) return true;
    } catch {
      // skip invalid regex
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Execute and write result
// ---------------------------------------------------------------------------

process.stdout.write(run());
