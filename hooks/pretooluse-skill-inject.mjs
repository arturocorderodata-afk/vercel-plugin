#!/usr/bin/env node
/**
 * PreToolUse hook: injects relevant SKILL.md content as additionalContext
 * when Claude reads/edits/writes files or runs bash commands that match
 * skill-map patterns.
 *
 * Input: JSON on stdin with tool_name, tool_input, session_id
 * Output: JSON on stdout with { hookSpecificOutput: { additionalContext: "..." } } or {}
 *
 * Caps at 3 skills per invocation. Deduplicates per session.
 *
 * Log levels (VERCEL_PLUGIN_LOG_LEVEL): off | summary | debug | trace
 * Legacy: VERCEL_PLUGIN_DEBUG=1 / VERCEL_PLUGIN_HOOK_DEBUG=1 → debug level
 */

import { readFileSync, realpathSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSkillMap, validateSkillMap } from "./skill-map-frontmatter.mjs";
import { globToRegex, parseSeenSkills, appendSeenSkill, compileSkillPatterns, matchPathWithReason, matchBashWithReason, rankEntries } from "./patterns.mjs";
import { resolveVercelJsonSkills, isVercelJsonPath, VERCEL_JSON_SKILLS } from "./vercel-config.mjs";
import { createLogger } from "./logger.mjs";

const MAX_SKILLS = 3;
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Logger (replaces boolean DEBUG flag)
// ---------------------------------------------------------------------------

const log = createLogger();

/** @returns {string} comma-delimited seen skills from env, or "" */
function getSeenSkillsEnv() {
  return typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string"
    ? process.env.VERCEL_PLUGIN_SEEN_SKILLS
    : "";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function run() {
  const timing = {};
  const tPhase = log.active ? log.now() : 0;

  // ---- Read stdin ----
  let input;
  try {
    const raw = readFileSync(0, "utf-8").trim();
    if (!raw) {
      log.issue("STDIN_EMPTY", "No data received on stdin", "Ensure the hook receives JSON on stdin with tool_name, tool_input, session_id", {});
      log.complete("stdin_empty");
      return "{}";
    }
    if (log.active) timing.stdin_parse = Math.round(log.now() - tPhase);
    input = JSON.parse(raw);
  } catch (err) {
    log.issue("STDIN_PARSE_FAIL", "Failed to parse stdin as JSON", "Verify stdin contains valid JSON with tool_name, tool_input, session_id fields", { error: String(err) });
    log.complete("stdin_parse_fail");
    return "{}";
  }

  if (log.active && !timing.stdin_parse) timing.stdin_parse = Math.round(log.now() - tPhase);

  const toolName = input.tool_name || "";
  const toolInput = input.tool_input || {};
  // sessionId is retained for debug metadata only.
  const sessionId = input.session_id || process.env.SESSION_ID || null;

  // Determine tool target for metadata
  const toolTarget = toolName === "Bash"
    ? (toolInput.command || "")
    : (toolInput.file_path || "");

  log.debug("input-parsed", { toolName, sessionId });

  // Emit redacted tool target in debug mode
  log.debug("tool-target", { toolName, target: redactCommand(toolTarget) });

  // ---- Load skill map (prefer static manifest, fall back to live scan) ----
  let tSkillmap = log.active ? log.now() : 0;
  let skillMap;
  const manifestPath = join(PLUGIN_ROOT, "generated", "skill-manifest.json");
  let usedManifest = false;

  try {
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (manifest && manifest.skills && typeof manifest.skills === "object") {
        skillMap = manifest.skills;
        usedManifest = true;
        log.debug("manifest-loaded", { path: manifestPath, generatedAt: manifest.generatedAt });
      }
    }
  } catch (err) {
    log.debug("manifest-load-fail", { error: String(err) });
    // Fall through to live scan
  }

  if (!usedManifest) {
    try {
      const skillsDir = join(PLUGIN_ROOT, "skills");
      const built = buildSkillMap(skillsDir);

      // Surface diagnostics from malformed SKILL.md files
      if (built.diagnostics && built.diagnostics.length > 0) {
        for (const d of built.diagnostics) {
          log.issue("SKILLMD_PARSE_FAIL", `Failed to parse SKILL.md: ${d.message}`, `Fix YAML frontmatter in ${d.file}`, { file: d.file, error: d.error });
        }
      }

      // Emit debug warnings for type coercion in buildSkillMap
      if (built.warnings && built.warnings.length > 0) {
        for (const w of built.warnings) {
          log.debug("skillmap-coercion-warning", { warning: w });
        }
      }

      // Validate and normalize the skill map to prevent .map() crashes on bad types
      const validation = validateSkillMap(built);
      if (!validation.ok) {
        log.issue("SKILLMAP_VALIDATE_FAIL", "Skill map validation failed after build", "Check SKILL.md frontmatter types: filePattern and bashPattern must be arrays", { errors: validation.errors });
        log.complete("skillmap_fail");
        return "{}";
      }
      if (validation.warnings && validation.warnings.length > 0) {
        for (const w of validation.warnings) {
          log.debug("skillmap-validation-warning", { warning: w });
        }
      }
      skillMap = validation.normalizedSkillMap.skills;
    } catch (err) {
      log.issue("SKILLMAP_LOAD_FAIL", "Failed to build skill map from SKILL.md frontmatter", "Check that skills/*/SKILL.md files exist and contain valid YAML frontmatter with metadata.filePattern", { error: String(err) });
      log.complete("skillmap_fail");
      return "{}";
    }
  }
  if (log.active) timing.skillmap_load = Math.round(log.now() - tSkillmap);

  if (typeof skillMap !== "object" || Object.keys(skillMap).length === 0) {
    log.issue("SKILLMAP_EMPTY", "Skill map is empty or has no skills", "Ensure skills/*/SKILL.md files have YAML frontmatter with metadata.filePattern or metadata.bashPattern", { type: typeof skillMap });
    log.complete("skillmap_fail");
    return "{}";
  }

  const skillCount = Object.keys(skillMap).length;
  log.debug("skillmap-loaded", { skillCount });

  // ---- Precompile regex patterns once ----
  const compiledSkills = compileSkillPatterns(skillMap, {
    onPathGlobError(skill, p, err) {
      log.issue("PATH_GLOB_INVALID", `Invalid glob pattern in skill "${skill}": ${p}`, `Fix or remove the invalid filePattern in skills/${skill}/SKILL.md frontmatter`, { skill, pattern: p, error: String(err) });
    },
    onBashRegexError(skill, p, err) {
      log.issue("BASH_REGEX_INVALID", `Invalid bash regex pattern in skill "${skill}": ${p}`, `Fix or remove the invalid bashPattern in skills/${skill}/SKILL.md frontmatter`, { skill, pattern: p, error: String(err) });
    },
  });

  // ---- Session dedup (env-var based) ----
  const dedupOff = process.env.VERCEL_PLUGIN_HOOK_DEDUP === "off";
  const seenEnv = getSeenSkillsEnv();
  const hasEnvDedup = !dedupOff && typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string";
  const dedupStrategy = dedupOff ? "disabled" : hasEnvDedup ? "env-var" : "memory-only";

  log.debug("dedup-strategy", { strategy: dedupStrategy, sessionId, seenEnv });

  let injectedSkills = hasEnvDedup ? parseSeenSkills(seenEnv) : new Set();

  // ---- Determine matched skills (using precompiled regexes) ----
  let tMatch = log.active ? log.now() : 0;
  const matchedEntries = [];
  const matchReasons = {};

  const supportedTools = ["Read", "Edit", "Write", "Bash"];
  if (!supportedTools.includes(toolName)) {
    log.complete("tool_unsupported");
    return "{}";
  }

  if (["Read", "Edit", "Write"].includes(toolName)) {
    const filePath = toolInput.file_path || "";
    for (const entry of compiledSkills) {
      // Trace: log per-pattern evaluation
      log.trace("pattern-eval-start", { skill: entry.skill, target: filePath, patternCount: entry.pathPatterns.length });
      const reason = matchPathWithReason(filePath, entry.pathRegexes, entry.pathPatterns);
      log.trace("pattern-eval-result", { skill: entry.skill, matched: !!reason, reason: reason || null });
      if (reason) {
        matchedEntries.push(entry);
        matchReasons[entry.skill] = reason;
      }
    }
  } else if (toolName === "Bash") {
    const command = toolInput.command || "";
    for (const entry of compiledSkills) {
      log.trace("pattern-eval-start", { skill: entry.skill, target: redactCommand(command), patternCount: entry.bashPatterns.length });
      const reason = matchBashWithReason(command, entry.bashRegexes, entry.bashPatterns);
      log.trace("pattern-eval-result", { skill: entry.skill, matched: !!reason, reason: reason || null });
      if (reason) {
        matchedEntries.push(entry);
        matchReasons[entry.skill] = reason;
      }
    }
  }
  if (log.active) timing.match = Math.round(log.now() - tMatch);

  const matched = new Set(matchedEntries.map((e) => e.skill));
  log.debug("matches-found", { matched: [...matched], reasons: matchReasons });

  // Filter out already-injected skills (when dedup is disabled, injectedSkills is always empty)
  let newEntries = dedupOff
    ? matchedEntries
    : matchedEntries.filter((e) => !injectedSkills.has(e.skill));

  // ---- vercel.json key-aware routing ----
  // When the target is a vercel.json file, read its keys and boost skills
  // whose domain matches the file's content.  Skills that only matched
  // because of a generic "vercel.json" glob but have no relevant keys in
  // the file are deprioritized (priority reduced by 10).
  let vercelJsonRouting = null;
  if (["Read", "Edit", "Write"].includes(toolName)) {
    const filePath = toolInput.file_path || "";
    if (isVercelJsonPath(filePath)) {
      const resolved = resolveVercelJsonSkills(filePath);
      if (resolved) {
        vercelJsonRouting = resolved;
        log.debug("vercel-json-routing", {
          keys: resolved.keys,
          relevantSkills: [...resolved.relevantSkills],
        });
        for (const entry of newEntries) {
          if (!VERCEL_JSON_SKILLS.has(entry.skill)) continue;
          if (resolved.relevantSkills.size === 0) continue; // no mappable keys — keep default priorities
          if (resolved.relevantSkills.has(entry.skill)) {
            // Boost: add 10 to ensure key-relevant skills win over generic ones
            entry.effectivePriority = entry.priority + 10;
          } else {
            // Deprioritize: reduce by 10 so key-irrelevant skills sort last
            entry.effectivePriority = entry.priority - 10;
          }
        }
      }
    }
  }

  // Sort by effectivePriority (if set) or priority DESC, then skill name ASC
  newEntries = rankEntries(newEntries);

  const newSkills = newEntries.map((e) => e.skill);

  log.debug("dedup-filtered", {
    newSkills,
    previouslyInjected: [...injectedSkills],
  });

  if (newSkills.length === 0) {
    if (log.active) {
      timing.skill_read = 0;
      timing.total = log.elapsed();
    }
    const reason = matched.size === 0 ? "no_matches" : "all_deduped";
    log.complete(reason, {
      matchedCount: matched.size,
      dedupedCount: matched.size - newSkills.length,
    }, log.active ? timing : null);
    return "{}";
  }

  // Cap at MAX_SKILLS
  const toInject = newSkills.slice(0, MAX_SKILLS);

  // Emit cap observability when skills were dropped
  if (newEntries.length > MAX_SKILLS) {
    const selected = newEntries.slice(0, MAX_SKILLS).map((e) => ({ skill: e.skill, priority: e.priority }));
    const dropped = newEntries.slice(MAX_SKILLS).map((e) => ({ skill: e.skill, priority: e.priority }));
    log.debug("cap-applied", { max: MAX_SKILLS, totalMatched: newEntries.length, selected, dropped });
  }

  // ---- Load SKILL.md files and build output ----
  let tSkillRead = log.active ? log.now() : 0;
  const parts = [];
  for (const skill of toInject) {
    const skillPath = join(PLUGIN_ROOT, "skills", skill, "SKILL.md");
    try {
      const content = readFileSync(skillPath, "utf-8");
      parts.push(
        `<!-- skill:${skill} -->\n${content}\n<!-- /skill:${skill} -->`,
      );
      injectedSkills.add(skill);
      if (hasEnvDedup) {
        process.env.VERCEL_PLUGIN_SEEN_SKILLS = appendSeenSkill(
          process.env.VERCEL_PLUGIN_SEEN_SKILLS, skill
        );
      }
    } catch (err) {
      log.issue("SKILL_FILE_MISSING", `SKILL.md not found for skill "${skill}"`, `Create skills/${skill}/SKILL.md with valid frontmatter`, { skillPath, error: String(err) });
    }
  }

  if (log.active) timing.skill_read = Math.round(log.now() - tSkillRead);

  log.debug("skills-injected", { injected: toInject, totalParts: parts.length });

  if (parts.length === 0) {
    if (log.active) timing.total = log.elapsed();
    log.complete("no_matches", {
      matchedCount: matched.size,
      dedupedCount: matchedEntries.length - newEntries.length,
      cappedCount: newEntries.length > MAX_SKILLS ? newEntries.length - MAX_SKILLS : 0,
    }, log.active ? timing : null);
    return "{}";
  }

  if (log.active) timing.total = log.elapsed();
  const cappedCount = newEntries.length > MAX_SKILLS ? newEntries.length - MAX_SKILLS : 0;
  log.complete("injected", {
    matchedCount: matched.size,
    injectedCount: parts.length,
    dedupedCount: matchedEntries.length - newEntries.length,
    cappedCount,
  }, log.active ? timing : null);

  // Build skillInjection metadata
  const droppedByCap = newEntries.length > MAX_SKILLS
    ? newEntries.slice(MAX_SKILLS).map((e) => e.skill)
    : [];

  const skillInjection = {
    version: SKILL_INJECTION_VERSION,
    toolName,
    toolTarget: toolName === "Bash" ? redactCommand(toolTarget) : toolTarget,
    matchedSkills: [...matched],
    injectedSkills: toInject,
    droppedByCap,
  };

  return JSON.stringify({
    hookSpecificOutput: {
      additionalContext: parts.join("\n\n"),
      skillInjection,
    },
  });
}

// ---------------------------------------------------------------------------
// Redaction helper
// ---------------------------------------------------------------------------

const REDACT_MAX = 200;
const REDACT_PATTERNS = [
  // ENV_VAR_TOKEN=value, MY_KEY=value, SECRET=value (env-style, may be prefixed)
  /\b\w*(TOKEN|KEY|SECRET)=\S+/gi,
  // --token value, --password value, --api-key value
  /--(token|password|api-key)\s+\S+/gi,
];

/**
 * Truncate a command string to REDACT_MAX chars and mask sensitive values.
 * Only intended for debug logging — never mutates the actual command.
 */
export function redactCommand(command) {
  if (typeof command !== "string") return "";
  let redacted = command;
  for (const re of REDACT_PATTERNS) {
    // Reset lastIndex for global regexes
    re.lastIndex = 0;
    redacted = redacted.replace(re, (match, key) => {
      if (match.startsWith("--")) {
        // --flag value → --flag [REDACTED]
        const flag = match.split(/\s+/)[0];
        return `${flag} [REDACTED]`;
      }
      // VERCEL_TOKEN=value → VERCEL_TOKEN=[REDACTED] (preserve full key name)
      const eqIdx = match.indexOf("=");
      const fullKey = match.slice(0, eqIdx);
      return `${fullKey}=[REDACTED]`;
    });
  }
  if (redacted.length > REDACT_MAX) {
    redacted = redacted.slice(0, REDACT_MAX) + "…[truncated]";
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// Metadata version
// ---------------------------------------------------------------------------

const SKILL_INJECTION_VERSION = 1;

// ---------------------------------------------------------------------------
// Matching helpers — delegated to ./patterns.mjs
// (compileSkillPatterns, matchPathWithReason, matchBashWithReason, rankEntries)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Execute and write result (only when run directly, not when imported)
// ---------------------------------------------------------------------------

/** Detect whether this module is the main entry point (ESM equivalent of require.main === module). */
function isMainModule() {
  try {
    const scriptPath = realpathSync(resolve(process.argv[1] || ""));
    const modulePath = realpathSync(fileURLToPath(import.meta.url));
    return scriptPath === modulePath;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.stdout.write(run());
}

export { run, validateSkillMap };
