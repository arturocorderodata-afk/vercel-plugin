/**
 * Shared pattern utilities for converting glob patterns to RegExp,
 * plus the canonical match/rank engine used by both the PreToolUse hook
 * and the CLI explain command.
 */

import { basename } from "node:path";

/**
 * Convert a simple glob pattern to a regex.
 * Supports *, **, and ? wildcards.
 * Double-star-slash requires slash boundaries — matches zero or more path segments.
 */
export function globToRegex(pattern) {
  if (typeof pattern !== "string") {
    throw new TypeError(`globToRegex: expected string, got ${typeof pattern}`);
  }
  if (pattern === "") {
    throw new Error("globToRegex: pattern must not be empty");
  }
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches zero or more path segments with slash boundaries
        i += 2;
        if (pattern[i] === "/") {
          // **/ → zero or more complete path segments (each ending in /)
          re += "(?:[^/]+/)*";
          i++;
        } else {
          // trailing ** (no slash after) → match rest of path
          re += ".*";
        }
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

/**
 * Parse comma-delimited seen-skill slugs from env var into a Set.
 */
export function parseSeenSkills(envValue) {
  if (typeof envValue !== "string" || envValue.trim() === "") {
    return new Set();
  }
  const seen = new Set();
  for (const part of envValue.split(",")) {
    const skill = part.trim();
    if (skill !== "") {
      seen.add(skill);
    }
  }
  return seen;
}

/**
 * Return updated comma-delimited string with a new skill appended.
 */
export function appendSeenSkill(envValue, skill) {
  if (typeof skill !== "string" || skill.trim() === "") return envValue || "";
  const current = typeof envValue === "string" ? envValue.trim() : "";
  return current === "" ? skill : `${current},${skill}`;
}

// ---------------------------------------------------------------------------
// Match engine — shared by pretooluse hook and CLI explain
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} SkillEntry
 * Canonical skill-map entry shape. The only recognized pattern keys are
 * `pathPatterns` (glob strings), `bashPatterns` (regex strings), and
 * `importPatterns` (package name strings matched against file imports).
 * Deprecated aliases `filePattern` / `bashPattern` are normalized to
 * canonical names by the compat shim in `buildSkillMap()`.
 * @property {number} priority  — Higher wins during ranking (default 5).
 * @property {string[]} pathPatterns — Glob patterns matched against file paths.
 * @property {string[]} bashPatterns — Regex patterns matched against bash commands.
 * @property {string[]} importPatterns — Package names matched against file imports/requires.
 */

/**
 * @typedef {Object} CompiledSkillEntry
 * Runtime form of a SkillEntry with precompiled regexes.
 * @property {string} skill
 * @property {number} priority
 * @property {string[]} pathPatterns
 * @property {RegExp[]} pathRegexes
 * @property {string[]} bashPatterns
 * @property {RegExp[]} bashRegexes
 * @property {string[]} importPatterns
 * @property {RegExp[]} importRegexes
 * @property {number} [effectivePriority] — Set by vercel.json key-aware routing.
 */

/**
 * Compile a skill map into entries with precompiled regexes.
 * @param {Record<string, SkillEntry>} skillMap
 * @param {{ onPathGlobError?: (skill: string, pattern: string, err: Error) => void, onBashRegexError?: (skill: string, pattern: string, err: Error) => void }} [callbacks]
 * @returns {CompiledSkillEntry[]}
 */
export function compileSkillPatterns(skillMap, callbacks) {
  const cb = callbacks || {};
  return Object.entries(skillMap).map(([skill, config]) => ({
    skill,
    priority: typeof config.priority === "number" ? config.priority : 0,
    pathPatterns: config.pathPatterns || [],
    pathRegexes: (config.pathPatterns || []).map((p) => {
      try { return globToRegex(p); } catch (err) {
        if (cb.onPathGlobError) cb.onPathGlobError(skill, p, err);
        return null;
      }
    }).filter(Boolean),
    bashPatterns: config.bashPatterns || [],
    bashRegexes: (config.bashPatterns || []).map((p) => {
      try { return new RegExp(p); } catch (err) {
        if (cb.onBashRegexError) cb.onBashRegexError(skill, p, err);
        return null;
      }
    }).filter(Boolean),
    importPatterns: config.importPatterns || [],
    importRegexes: (config.importPatterns || []).map((p) => {
      try { return importPatternToRegex(p); } catch (err) {
        if (cb.onImportPatternError) cb.onImportPatternError(skill, p, err);
        return null;
      }
    }).filter(Boolean),
  }));
}

/**
 * Convert an import pattern (package name, possibly with wildcard) to a regex
 * that matches ESM import/require statements in file content.
 * Supports patterns like "ai", "@ai-sdk/*", "@vercel/oidc".
 * The wildcard * matches any sub-path segment.
 * @param {string} pattern  Package name or scoped package pattern
 * @returns {RegExp}
 */
export function importPatternToRegex(pattern) {
  if (typeof pattern !== "string") {
    throw new TypeError(`importPatternToRegex: expected string, got ${typeof pattern}`);
  }
  if (pattern === "") {
    throw new Error("importPatternToRegex: pattern must not be empty");
  }
  // Escape regex metacharacters, then replace * with [^'"]*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^'\"]*");
  // Match: import ... from 'pattern' | require('pattern') | import('pattern')
  // Also matches sub-paths like '@ai-sdk/gateway/foo'
  return new RegExp(`(?:from\\s+|require\\s*\\(\\s*|import\\s*\\(\\s*)['"]${escaped}(?:/[^'"]*)?['"]`, "m");
}

/**
 * Match file content against precompiled import regexes, returning the first
 * matching pattern and match type, or null.
 * @param {string} content  File content to search for imports
 * @param {RegExp[]} regexes  Precompiled import regexes
 * @param {string[]} patterns  Original import pattern strings
 * @returns {{ pattern: string, matchType: string } | null}
 */
export function matchImportWithReason(content, regexes, patterns) {
  if (!content || regexes.length === 0) return null;
  for (let idx = 0; idx < regexes.length; idx++) {
    if (regexes[idx].test(content)) {
      return { pattern: patterns[idx], matchType: "import" };
    }
  }
  return null;
}

/**
 * Match a file path against precompiled path regexes, returning the first
 * matching pattern and match type, or null.
 */
export function matchPathWithReason(filePath, regexes, patterns) {
  if (!filePath || regexes.length === 0) return null;

  const normalized = filePath.replace(/\\/g, "/");

  for (let idx = 0; idx < regexes.length; idx++) {
    const regex = regexes[idx];
    const pattern = patterns[idx];

    if (regex.test(normalized)) return { pattern, matchType: "full" };

    const base = basename(normalized);
    if (regex.test(base)) return { pattern, matchType: "basename" };

    const segments = normalized.split("/");
    for (let i = 1; i < segments.length; i++) {
      const suffix = segments.slice(-i).join("/");
      if (regex.test(suffix)) return { pattern, matchType: "suffix" };
    }
  }
  return null;
}

/**
 * Match a bash command against precompiled bash regexes, returning the first
 * matching pattern and match type, or null.
 */
export function matchBashWithReason(command, regexes, patterns) {
  if (!command || regexes.length === 0) return null;
  for (let idx = 0; idx < regexes.length; idx++) {
    if (regexes[idx].test(command)) return { pattern: patterns[idx], matchType: "full" };
  }
  return null;
}

/**
 * Sort compiled skill entries by effectivePriority (if set) or priority DESC,
 * then skill name ASC.
 */
export function rankEntries(entries) {
  return entries.slice().sort((a, b) => {
    const aPri = typeof a.effectivePriority === "number" ? a.effectivePriority : a.priority;
    const bPri = typeof b.effectivePriority === "number" ? b.effectivePriority : b.priority;
    return (bPri - aPri) || a.skill.localeCompare(b.skill);
  });
}
