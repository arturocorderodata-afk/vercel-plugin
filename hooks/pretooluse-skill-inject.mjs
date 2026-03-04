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
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const MAX_SKILLS = 3;
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run() {
  // ---- Read stdin ----
  let input;
  try {
    const raw = readFileSync(0, "utf-8").trim();
    if (!raw) return "{}";
    input = JSON.parse(raw);
  } catch {
    return "{}";
  }

  const toolName = input.tool_name || "";
  const toolInput = input.tool_input || {};
  const sessionId = input.session_id || process.env.SESSION_ID || "default";

  // ---- Load skill map ----
  let skillMap;
  try {
    const mapPath = join(PLUGIN_ROOT, "hooks", "skill-map.json");
    const parsed = JSON.parse(readFileSync(mapPath, "utf-8"));
    skillMap = parsed.skills || {};
  } catch {
    return "{}";
  }

  if (typeof skillMap !== "object" || Object.keys(skillMap).length === 0) {
    return "{}";
  }

  // ---- Session dedup ----
  const dedupDir = join(tmpdir(), "vercel-plugin-hooks");
  const dedupFile = join(
    dedupDir,
    `session-${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`,
  );

  let injectedSkills;
  try {
    if (!existsSync(dedupDir)) mkdirSync(dedupDir, { recursive: true });
    injectedSkills = existsSync(dedupFile)
      ? new Set(JSON.parse(readFileSync(dedupFile, "utf-8")))
      : new Set();
  } catch {
    injectedSkills = new Set();
  }

  function persistDedup() {
    try {
      writeFileSync(dedupFile, JSON.stringify([...injectedSkills]));
    } catch {
      // best-effort
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

  // Filter out already-injected skills
  const newSkills = [...matched].filter((s) => !injectedSkills.has(s));

  if (newSkills.length === 0) return "{}";

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
    } catch {
      // skill file missing, skip
    }
  }

  if (parts.length === 0) return "{}";

  // Persist dedup state
  persistDedup();

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
