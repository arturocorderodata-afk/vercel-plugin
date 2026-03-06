#!/usr/bin/env node
/**
 * PreToolUse hook: injects relevant SKILL.md content as additionalContext
 * when Claude reads/edits/writes files or runs bash commands that match
 * skill-map patterns.
 *
 * Input: JSON on stdin with tool_name, tool_input, session_id
 * Output: JSON on stdout with { hookSpecificOutput: { additionalContext: "..." } } or {}
 *
 * Injects skills in priority order until byte budget (default 12KB) is exhausted,
 * with a hard ceiling of 3 skills. Deduplicates per session.
 *
 * Log levels (VERCEL_PLUGIN_LOG_LEVEL): off | summary | debug | trace
 * Legacy: VERCEL_PLUGIN_DEBUG=1 / VERCEL_PLUGIN_HOOK_DEBUG=1 → debug level
 *
 * Pipeline stages (each independently importable and testable):
 *   parseInput → loadSkills → matchSkills → deduplicateSkills → injectSkills → formatOutput
 */

import { readFileSync, realpathSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSkillMap, validateSkillMap } from "./skill-map-frontmatter.mjs";
import { globToRegex, parseSeenSkills, appendSeenSkill, compileSkillPatterns, matchPathWithReason, matchBashWithReason, rankEntries } from "./patterns.mjs";
import { resolveVercelJsonSkills, isVercelJsonPath, VERCEL_JSON_SKILLS } from "./vercel-config.mjs";
import { createLogger } from "./logger.mjs";

const MAX_SKILLS = 3;
const DEFAULT_INJECTION_BUDGET_BYTES = 12_000;
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUPPORTED_TOOLS = ["Read", "Edit", "Write", "Bash"];

/** Resolve the injection byte budget from env or default. */
function getInjectionBudget() {
  const envVal = process.env.VERCEL_PLUGIN_INJECTION_BUDGET;
  if (envVal != null && envVal !== "") {
    const parsed = parseInt(envVal, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_INJECTION_BUDGET_BYTES;
}

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
// Pipeline stage 1: parseInput
// ---------------------------------------------------------------------------

/**
 * Parse raw stdin JSON into a normalized input descriptor.
 * @param {string} raw - Raw stdin content
 * @param {object} [logger] - Logger instance (defaults to module-level log)
 * @returns {{ toolName: string, toolInput: object, sessionId: string|null, toolTarget: string } | null}
 *   Returns null if input is empty or unparseable.
 */
export function parseInput(raw, logger) {
  const l = logger || log;
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    l.issue("STDIN_EMPTY", "No data received on stdin", "Ensure the hook receives JSON on stdin with tool_name, tool_input, session_id", {});
    l.complete("stdin_empty");
    return null;
  }

  let input;
  try {
    input = JSON.parse(trimmed);
  } catch (err) {
    l.issue("STDIN_PARSE_FAIL", "Failed to parse stdin as JSON", "Verify stdin contains valid JSON with tool_name, tool_input, session_id fields", { error: String(err) });
    l.complete("stdin_parse_fail");
    return null;
  }

  const toolName = input.tool_name || "";
  const toolInput = input.tool_input || {};
  const sessionId = input.session_id || process.env.SESSION_ID || null;
  const toolTarget = toolName === "Bash"
    ? (toolInput.command || "")
    : (toolInput.file_path || "");

  l.debug("input-parsed", { toolName, sessionId });
  l.debug("tool-target", { toolName, target: redactCommand(toolTarget) });

  return { toolName, toolInput, sessionId, toolTarget };
}

// ---------------------------------------------------------------------------
// Pipeline stage 2: loadSkills
// ---------------------------------------------------------------------------

/**
 * Load the skill map from the static manifest or live SKILL.md scan.
 * @param {string} [pluginRoot] - Plugin root directory (defaults to PLUGIN_ROOT)
 * @param {object} [logger] - Logger instance
 * @returns {{ skillMap: object, compiledSkills: Array, usedManifest: boolean } | null}
 *   Returns null if the skill map cannot be loaded or is empty.
 */
export function loadSkills(pluginRoot, logger) {
  const root = pluginRoot || PLUGIN_ROOT;
  const l = logger || log;
  let skillMap;
  const manifestPath = join(root, "generated", "skill-manifest.json");
  let usedManifest = false;

  try {
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (manifest && manifest.skills && typeof manifest.skills === "object") {
        skillMap = manifest.skills;
        usedManifest = true;
        l.debug("manifest-loaded", { path: manifestPath, generatedAt: manifest.generatedAt });
      }
    }
  } catch (err) {
    l.debug("manifest-load-fail", { error: String(err) });
    // Fall through to live scan
  }

  if (!usedManifest) {
    try {
      const skillsDir = join(root, "skills");
      const built = buildSkillMap(skillsDir);

      if (built.diagnostics && built.diagnostics.length > 0) {
        for (const d of built.diagnostics) {
          l.issue("SKILLMD_PARSE_FAIL", `Failed to parse SKILL.md: ${d.message}`, `Fix YAML frontmatter in ${d.file}`, { file: d.file, error: d.error });
        }
      }

      if (built.warnings && built.warnings.length > 0) {
        for (const w of built.warnings) {
          l.debug("skillmap-coercion-warning", { warning: w });
        }
      }

      const validation = validateSkillMap(built);
      if (!validation.ok) {
        l.issue("SKILLMAP_VALIDATE_FAIL", "Skill map validation failed after build", "Check SKILL.md frontmatter types: pathPatterns and bashPatterns must be arrays", { errors: validation.errors });
        l.complete("skillmap_fail");
        return null;
      }
      if (validation.warnings && validation.warnings.length > 0) {
        for (const w of validation.warnings) {
          l.debug("skillmap-validation-warning", { warning: w });
        }
      }
      skillMap = validation.normalizedSkillMap.skills;
    } catch (err) {
      l.issue("SKILLMAP_LOAD_FAIL", "Failed to build skill map from SKILL.md frontmatter", "Check that skills/*/SKILL.md files exist and contain valid YAML frontmatter with metadata.pathPatterns", { error: String(err) });
      l.complete("skillmap_fail");
      return null;
    }
  }

  if (typeof skillMap !== "object" || Object.keys(skillMap).length === 0) {
    l.issue("SKILLMAP_EMPTY", "Skill map is empty or has no skills", "Ensure skills/*/SKILL.md files have YAML frontmatter with metadata.pathPatterns or metadata.bashPatterns", { type: typeof skillMap });
    l.complete("skillmap_fail");
    return null;
  }

  const skillCount = Object.keys(skillMap).length;
  l.debug("skillmap-loaded", { skillCount });

  const compiledSkills = compileSkillPatterns(skillMap, {
    onPathGlobError(skill, p, err) {
      l.issue("PATH_GLOB_INVALID", `Invalid glob pattern in skill "${skill}": ${p}`, `Fix or remove the invalid pathPatterns entry in skills/${skill}/SKILL.md frontmatter`, { skill, pattern: p, error: String(err) });
    },
    onBashRegexError(skill, p, err) {
      l.issue("BASH_REGEX_INVALID", `Invalid bash regex pattern in skill "${skill}": ${p}`, `Fix or remove the invalid bashPatterns entry in skills/${skill}/SKILL.md frontmatter`, { skill, pattern: p, error: String(err) });
    },
  });

  return { skillMap, compiledSkills, usedManifest };
}

// ---------------------------------------------------------------------------
// Pipeline stage 3: matchSkills
// ---------------------------------------------------------------------------

/**
 * Match a tool call against compiled skill patterns.
 * @param {string} toolName - The tool being invoked (Read, Edit, Write, Bash)
 * @param {object} toolInput - The tool's input object
 * @param {Array} compiledSkills - Output of compileSkillPatterns()
 * @param {object} [logger] - Logger instance
 * @returns {{ matchedEntries: Array, matchReasons: object, matched: Set } | null}
 *   Returns null if the tool is not supported.
 */
export function matchSkills(toolName, toolInput, compiledSkills, logger) {
  const l = logger || log;

  if (!SUPPORTED_TOOLS.includes(toolName)) {
    l.complete("tool_unsupported");
    return null;
  }

  const matchedEntries = [];
  const matchReasons = {};

  if (["Read", "Edit", "Write"].includes(toolName)) {
    const filePath = toolInput.file_path || "";
    for (const entry of compiledSkills) {
      l.trace("pattern-eval-start", { skill: entry.skill, target: filePath, patternCount: entry.pathPatterns.length });
      const reason = matchPathWithReason(filePath, entry.pathRegexes, entry.pathPatterns);
      l.trace("pattern-eval-result", { skill: entry.skill, matched: !!reason, reason: reason || null });
      if (reason) {
        matchedEntries.push(entry);
        matchReasons[entry.skill] = reason;
      }
    }
  } else if (toolName === "Bash") {
    const command = toolInput.command || "";
    for (const entry of compiledSkills) {
      l.trace("pattern-eval-start", { skill: entry.skill, target: redactCommand(command), patternCount: entry.bashPatterns.length });
      const reason = matchBashWithReason(command, entry.bashRegexes, entry.bashPatterns);
      l.trace("pattern-eval-result", { skill: entry.skill, matched: !!reason, reason: reason || null });
      if (reason) {
        matchedEntries.push(entry);
        matchReasons[entry.skill] = reason;
      }
    }
  }

  const matched = new Set(matchedEntries.map((e) => e.skill));
  l.debug("matches-found", { matched: [...matched], reasons: matchReasons });

  return { matchedEntries, matchReasons, matched };
}

// ---------------------------------------------------------------------------
// Pipeline stage 4: deduplicateSkills
// ---------------------------------------------------------------------------

/**
 * Filter already-seen skills, apply vercel.json key-aware routing, rank, and cap.
 * @param {object} params
 * @param {Array} params.matchedEntries - Raw matched entries from matchSkills
 * @param {Set} params.matched - Set of all matched skill names
 * @param {string} params.toolName - Tool being invoked
 * @param {object} params.toolInput - Tool input object
 * @param {Set} params.injectedSkills - Already-injected skill names
 * @param {boolean} params.dedupOff - Whether dedup is disabled
 * @param {number} [params.maxSkills] - Hard ceiling (defaults to MAX_SKILLS)
 * @param {object} [logger] - Logger instance
 * @returns {{ newEntries: Array, rankedSkills: string[], vercelJsonRouting: object|null }}
 */
export function deduplicateSkills({ matchedEntries, matched, toolName, toolInput, injectedSkills, dedupOff, maxSkills }, logger) {
  const l = logger || log;
  const cap = maxSkills ?? MAX_SKILLS;

  // Filter out already-injected skills
  let newEntries = dedupOff
    ? matchedEntries
    : matchedEntries.filter((e) => !injectedSkills.has(e.skill));

  // vercel.json key-aware routing
  let vercelJsonRouting = null;
  if (["Read", "Edit", "Write"].includes(toolName)) {
    const filePath = toolInput.file_path || "";
    if (isVercelJsonPath(filePath)) {
      const resolved = resolveVercelJsonSkills(filePath);
      if (resolved) {
        vercelJsonRouting = resolved;
        l.debug("vercel-json-routing", {
          keys: resolved.keys,
          relevantSkills: [...resolved.relevantSkills],
        });
        for (const entry of newEntries) {
          if (!VERCEL_JSON_SKILLS.has(entry.skill)) continue;
          if (resolved.relevantSkills.size === 0) continue;
          if (resolved.relevantSkills.has(entry.skill)) {
            entry.effectivePriority = entry.priority + 10;
          } else {
            entry.effectivePriority = entry.priority - 10;
          }
        }
      }
    }
  }

  // Sort by effectivePriority (if set) or priority DESC, then skill name ASC
  newEntries = rankEntries(newEntries);

  const rankedSkills = newEntries.map((e) => e.skill);

  l.debug("dedup-filtered", {
    rankedSkills,
    previouslyInjected: [...injectedSkills],
  });

  return { newEntries, rankedSkills, vercelJsonRouting };
}

// ---------------------------------------------------------------------------
// Pipeline stage 5: injectSkills
// ---------------------------------------------------------------------------

/**
 * Load SKILL.md files for the ranked skills, enforcing byte budget and MAX_SKILLS ceiling.
 * Skills are loaded in priority order until the next would exceed the budget or the ceiling.
 * @param {string[]} rankedSkills - Skill slugs in priority order (all candidates)
 * @param {object} [options]
 * @param {string} [options.pluginRoot] - Plugin root directory
 * @param {boolean} [options.hasEnvDedup] - Whether env-var dedup is active
 * @param {Set} [options.injectedSkills] - Mutable set to track injected skills
 * @param {number} [options.budgetBytes] - Injection byte budget (defaults to getInjectionBudget())
 * @param {number} [options.maxSkills] - Hard ceiling on skill count (defaults to MAX_SKILLS)
 * @param {object} [options.logger] - Logger instance
 * @returns {{ parts: string[], loaded: string[], droppedByCap: string[], droppedByBudget: string[] }}
 */
export function injectSkills(rankedSkills, options) {
  const { pluginRoot, hasEnvDedup, injectedSkills, budgetBytes, maxSkills, logger } = options || {};
  const root = pluginRoot || PLUGIN_ROOT;
  const l = logger || log;
  const budget = budgetBytes ?? getInjectionBudget();
  const ceiling = maxSkills ?? MAX_SKILLS;
  const parts = [];
  const loaded = [];
  const droppedByCap = [];
  const droppedByBudget = [];
  let usedBytes = 0;

  for (const skill of rankedSkills) {
    // Hard ceiling check
    if (loaded.length >= ceiling) {
      droppedByCap.push(skill);
      continue;
    }

    const skillPath = join(root, "skills", skill, "SKILL.md");
    let content;
    try {
      content = readFileSync(skillPath, "utf-8");
    } catch (err) {
      l.issue("SKILL_FILE_MISSING", `SKILL.md not found for skill "${skill}"`, `Create skills/${skill}/SKILL.md with valid frontmatter`, { skillPath, error: String(err) });
      continue;
    }

    const wrapped = `<!-- skill:${skill} -->\n${content}\n<!-- /skill:${skill} -->`;
    const byteLen = Buffer.byteLength(wrapped, "utf-8");

    // Budget check: always allow the first skill, then enforce budget
    if (loaded.length > 0 && usedBytes + byteLen > budget) {
      droppedByBudget.push(skill);
      continue;
    }

    parts.push(wrapped);
    loaded.push(skill);
    usedBytes += byteLen;
    if (injectedSkills) injectedSkills.add(skill);
    if (hasEnvDedup) {
      process.env.VERCEL_PLUGIN_SEEN_SKILLS = appendSeenSkill(
        process.env.VERCEL_PLUGIN_SEEN_SKILLS, skill
      );
    }
  }

  if (droppedByCap.length > 0 || droppedByBudget.length > 0) {
    l.debug("cap-applied", {
      max: ceiling,
      budgetBytes: budget,
      usedBytes,
      totalCandidates: rankedSkills.length,
      selected: loaded.map((s) => ({ skill: s })),
      droppedByCap,
      droppedByBudget,
    });
  }

  l.debug("skills-injected", { injected: loaded, totalParts: parts.length, usedBytes, budgetBytes: budget });

  return { parts, loaded, droppedByCap, droppedByBudget };
}

// ---------------------------------------------------------------------------
// Pipeline stage 6: formatOutput
// ---------------------------------------------------------------------------

/**
 * Build the final JSON output string from injection results.
 * @param {object} params
 * @param {string[]} params.parts - Injected skill content blocks
 * @param {Set} params.matched - All matched skill names
 * @param {string[]} params.toInject - Skills selected for injection
 * @param {string[]} params.droppedByCap - Skills dropped by hard ceiling
 * @param {string[]} params.droppedByBudget - Skills dropped by byte budget
 * @param {string} params.toolName - Tool being invoked
 * @param {string} params.toolTarget - Tool target (file path or command)
 * @returns {string} JSON string to write to stdout
 */
export function formatOutput({ parts, matched, injectedSkills, droppedByCap, droppedByBudget, toolName, toolTarget }) {
  if (parts.length === 0) {
    return "{}";
  }

  const skillInjection = {
    version: SKILL_INJECTION_VERSION,
    toolName,
    toolTarget: toolName === "Bash" ? redactCommand(toolTarget) : toolTarget,
    matchedSkills: [...matched],
    injectedSkills,
    droppedByCap,
    droppedByBudget: droppedByBudget || [],
  };

  return JSON.stringify({
    hookSpecificOutput: {
      additionalContext: parts.join("\n\n"),
      skillInjection,
    },
  });
}

// ---------------------------------------------------------------------------
// Orchestrator: run() delegates to the pipeline stages
// ---------------------------------------------------------------------------

function run() {
  const timing = {};
  const tPhase = log.active ? log.now() : 0;

  // Stage 1: parseInput
  const raw = readFileSync(0, "utf-8");
  const parsed = parseInput(raw, log);
  if (!parsed) return "{}";
  if (log.active) timing.stdin_parse = Math.round(log.now() - tPhase);

  const { toolName, toolInput, sessionId, toolTarget } = parsed;

  // Stage 2: loadSkills
  let tSkillmap = log.active ? log.now() : 0;
  const skills = loadSkills(PLUGIN_ROOT, log);
  if (!skills) return "{}";
  if (log.active) timing.skillmap_load = Math.round(log.now() - tSkillmap);

  const { compiledSkills } = skills;

  // Session dedup state
  const dedupOff = process.env.VERCEL_PLUGIN_HOOK_DEDUP === "off";
  const seenEnv = getSeenSkillsEnv();
  const hasEnvDedup = !dedupOff && typeof process.env.VERCEL_PLUGIN_SEEN_SKILLS === "string";
  const dedupStrategy = dedupOff ? "disabled" : hasEnvDedup ? "env-var" : "memory-only";

  log.debug("dedup-strategy", { strategy: dedupStrategy, sessionId, seenEnv });

  let injectedSkills = hasEnvDedup ? parseSeenSkills(seenEnv) : new Set();

  // Stage 3: matchSkills
  let tMatch = log.active ? log.now() : 0;
  const matchResult = matchSkills(toolName, toolInput, compiledSkills, log);
  if (!matchResult) return "{}";
  if (log.active) timing.match = Math.round(log.now() - tMatch);

  const { matchedEntries, matched } = matchResult;

  // Stage 4: deduplicateSkills
  const dedupResult = deduplicateSkills({
    matchedEntries,
    matched,
    toolName,
    toolInput,
    injectedSkills,
    dedupOff,
  }, log);

  const { newEntries, rankedSkills } = dedupResult;

  if (rankedSkills.length === 0) {
    if (log.active) {
      timing.skill_read = 0;
      timing.total = log.elapsed();
    }
    const reason = matched.size === 0 ? "no_matches" : "all_deduped";
    log.complete(reason, {
      matchedCount: matched.size,
      dedupedCount: matched.size - rankedSkills.length,
    }, log.active ? timing : null);
    return "{}";
  }

  // Stage 5: injectSkills (enforces byte budget + MAX_SKILLS ceiling)
  let tSkillRead = log.active ? log.now() : 0;
  const { parts, loaded, droppedByCap, droppedByBudget } = injectSkills(rankedSkills, {
    pluginRoot: PLUGIN_ROOT,
    hasEnvDedup,
    injectedSkills,
    logger: log,
  });
  if (log.active) timing.skill_read = Math.round(log.now() - tSkillRead);

  if (parts.length === 0) {
    if (log.active) timing.total = log.elapsed();
    log.complete("no_matches", {
      matchedCount: matched.size,
      dedupedCount: matchedEntries.length - newEntries.length,
      cappedCount: droppedByCap.length + droppedByBudget.length,
    }, log.active ? timing : null);
    return "{}";
  }

  if (log.active) timing.total = log.elapsed();
  const cappedCount = droppedByCap.length + droppedByBudget.length;
  log.complete("injected", {
    matchedCount: matched.size,
    injectedCount: parts.length,
    dedupedCount: matchedEntries.length - newEntries.length,
    cappedCount,
  }, log.active ? timing : null);

  // Stage 6: formatOutput
  return formatOutput({ parts, matched, injectedSkills: loaded, droppedByCap, droppedByBudget, toolName, toolTarget });
}

// ---------------------------------------------------------------------------
// Redaction helper
// ---------------------------------------------------------------------------

const REDACT_MAX = 200;

// Pattern descriptors: each has a regex and a replacer function.
// Order matters — more specific patterns (URL query params, connection strings,
// JSON values) must run before the broad env-var pattern.
const REDACT_RULES = [
  {
    // Connection strings: scheme://user:password@host
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^:/?#\s]+:[^@\s]+@[^\s]+/gi,
    fn: (match) => match.replace(/:\/\/[^:/?#\s]+:[^@\s]+@/, "://[REDACTED]@"),
  },
  {
    // URL query params with sensitive keys: ?token=xxx, &key=xxx, &secret=xxx, &password=xxx
    re: /([?&])(token|key|secret|password|credential|auth|api_key|apiKey)=[^&\s]*/gi,
    fn: (match) => {
      const eqIdx = match.indexOf("=");
      return `${match.slice(0, eqIdx)}=[REDACTED]`;
    },
  },
  {
    // JSON-style secret values: "secret": "val", "password": "val", "token": "val", etc.
    re: /"(token|key|secret|password|credential|api_key|apiKey|auth)":\s*"[^"]*"/gi,
    fn: (match) => {
      const colonIdx = match.indexOf(":");
      return `${match.slice(0, colonIdx)}: "[REDACTED]"`;
    },
  },
  {
    // Cookie headers: Cookie: key=value; key2=value2
    re: /\b(Cookie|Set-Cookie):\s*\S[^\r\n]*/gi,
    fn: (match) => `${match.split(":")[0]}: [REDACTED]`,
  },
  {
    // Bearer / token authorization headers: "Bearer xxx", "token xxx" (case-insensitive)
    re: /\b(Bearer|token)\s+[A-Za-z0-9_\-.+/=]{8,}\b/gi,
    fn: (match) => `${match.split(/\s+/)[0]} [REDACTED]`,
  },
  {
    // --token value, --password value, --api-key value, --secret value, --auth value
    re: /--(token|password|api-key|secret|auth|credential)\s+\S+/gi,
    fn: (match) => `${match.split(/\s+/)[0]} [REDACTED]`,
  },
  {
    // ENV_VAR_TOKEN=value, MY_KEY=value, SECRET=value, PASSWORD=value (env-style, may be prefixed)
    // Matches keys that contain a sensitive word anywhere (e.g. MY_SECRET_VALUE=...)
    // [^\s&] prevents consuming URL query-param delimiters
    re: /\b\w*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)\w*=[^\s&]+/gi,
    fn: (match) => {
      const eqIdx = match.indexOf("=");
      return `${match.slice(0, eqIdx)}=[REDACTED]`;
    },
  },
];

/**
 * Truncate a command string to REDACT_MAX chars and mask sensitive values.
 * Only intended for debug logging — never mutates the actual command.
 */
export function redactCommand(command) {
  if (typeof command !== "string") return "";
  let redacted = command;
  for (const { re, fn } of REDACT_RULES) {
    re.lastIndex = 0;
    redacted = redacted.replace(re, fn);
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
