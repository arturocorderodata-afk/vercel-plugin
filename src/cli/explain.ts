/**
 * `vercel-plugin explain` — show which skills match a given file or command,
 * with priority scores, match reasons, and collision detection.
 *
 * Usage:
 *   vercel-plugin explain <file-or-command> [--json] [--project <path>]
 *   vercel-plugin explain middleware.ts
 *   vercel-plugin explain "vercel deploy --prod"
 *   vercel-plugin explain vercel.json --json
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  compileSkillPatterns,
  matchPathWithReason,
  matchBashWithReason,
  rankEntries,
} from "../../hooks/patterns.mjs";
import {
  buildSkillMap,
  validateSkillMap,
  scanSkillsDir,
} from "../../hooks/skill-map-frontmatter.mjs";
import {
  resolveVercelJsonSkills,
  isVercelJsonPath,
  VERCEL_JSON_SKILLS,
} from "../../hooks/vercel-config.mjs";

const MAX_SKILLS = 3;

export interface ExplainMatch {
  skill: string;
  priority: number;
  effectivePriority: number;
  matchedPattern: string;
  matchType: "file:full" | "file:basename" | "file:suffix" | "bash:full";
  injected: boolean;
  capped: boolean;
}

export interface ExplainCollision {
  skills: string[];
  reason: string;
}

export interface ExplainResult {
  target: string;
  targetType: "file" | "bash";
  matches: ExplainMatch[];
  collisions: ExplainCollision[];
  injectedCount: number;
  cappedCount: number;
  skillCount: number;
}

// ---------------------------------------------------------------------------
// Pattern matching — delegated to ../../hooks/patterns.mjs
// (compileSkillPatterns, matchPathWithReason, matchBashWithReason, rankEntries)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Detect whether target looks like a bash command vs a file path
// ---------------------------------------------------------------------------

function detectTargetType(target: string): "file" | "bash" {
  // If it contains spaces and starts with a known CLI tool, treat as bash
  if (/\s/.test(target) && /^(vercel|npm|npx|bun|pnpm|yarn|node|git)\b/.test(target)) {
    return "bash";
  }
  // If it looks like a flag-bearing command
  if (/\s--?\w/.test(target)) return "bash";
  // Default: file path
  return "file";
}

// ---------------------------------------------------------------------------
// Core explain logic
// ---------------------------------------------------------------------------

export function explain(target: string, projectRoot: string): ExplainResult {
  const skillsDir = join(projectRoot, "skills");
  const manifestPath = join(projectRoot, "generated", "skill-manifest.json");

  // Load skill map (prefer manifest, fall back to live scan)
  let skillMap: Record<string, { priority: number; pathPatterns: string[]; bashPatterns: string[] }>;

  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    skillMap = manifest.skills;
  } else {
    const built = buildSkillMap(skillsDir);
    const validation = validateSkillMap(built);
    if (!validation.ok) {
      throw new Error(`Skill map validation failed: ${validation.errors.join(", ")}`);
    }
    skillMap = validation.normalizedSkillMap.skills;
  }

  const targetType = detectTargetType(target);

  // Compile patterns using the shared engine
  const compiled = compileSkillPatterns(skillMap);

  // Match
  const matchedEntries: Array<{
    skill: string;
    priority: number;
    effectivePriority: number;
    pattern: string;
    matchType: string;
  }> = [];

  for (const entry of compiled) {
    let reason: { pattern: string; matchType: string } | null = null;

    if (targetType === "file") {
      reason = matchPathWithReason(target, entry.pathRegexes, entry.pathPatterns);
    } else {
      reason = matchBashWithReason(target, entry.bashRegexes, entry.bashPatterns);
    }

    if (reason) {
      matchedEntries.push({
        skill: entry.skill,
        priority: entry.priority,
        effectivePriority: entry.priority,
        pattern: reason.pattern,
        matchType: reason.matchType,
      });
    }
  }

  // vercel.json key-aware routing adjustments
  if (targetType === "file" && isVercelJsonPath(target)) {
    // Try to resolve from the project if an absolute path, otherwise try project root
    const resolvedPath = target.startsWith("/") ? target : join(projectRoot, target);
    const resolved = existsSync(resolvedPath) ? resolveVercelJsonSkills(resolvedPath) : null;

    if (resolved && resolved.relevantSkills.size > 0) {
      for (const entry of matchedEntries) {
        if (!VERCEL_JSON_SKILLS.has(entry.skill)) continue;
        if (resolved.relevantSkills.has(entry.skill)) {
          entry.effectivePriority = entry.priority + 10;
        } else {
          entry.effectivePriority = entry.priority - 10;
        }
      }
    }
  }

  // Sort by effectivePriority DESC, then skill name ASC
  const rankedEntries = rankEntries(matchedEntries);

  // Build result with injection/cap tracking
  const matches: ExplainMatch[] = rankedEntries.map((entry, idx) => ({
    skill: entry.skill,
    priority: entry.priority,
    effectivePriority: entry.effectivePriority,
    matchedPattern: entry.pattern,
    matchType: (targetType === "file" ? `file:${entry.matchType}` : `bash:${entry.matchType}`) as ExplainMatch["matchType"],
    injected: idx < MAX_SKILLS,
    capped: idx >= MAX_SKILLS,
  }));

  // Detect collisions: skills at same priority competing for injection slots
  const collisions: ExplainCollision[] = [];
  const byPriority = new Map<number, string[]>();
  for (const m of rankedEntries) {
    const p = m.effectivePriority;
    if (!byPriority.has(p)) byPriority.set(p, []);
    byPriority.get(p)!.push(m.skill);
  }
  for (const [priority, skills] of byPriority) {
    if (skills.length > 1) {
      collisions.push({
        skills,
        reason: `${skills.length} skills share effective priority ${priority}; tie-broken alphabetically`,
      });
    }
  }

  return {
    target,
    targetType,
    matches,
    collisions,
    injectedCount: matches.filter((m) => m.injected).length,
    cappedCount: matches.filter((m) => m.capped).length,
    skillCount: Object.keys(skillMap).length,
  };
}

// ---------------------------------------------------------------------------
// Pretty-print for human-readable output
// ---------------------------------------------------------------------------

export function formatExplainResult(result: ExplainResult): string {
  const lines: string[] = [];

  lines.push(`Target: ${result.target} (${result.targetType})`);
  lines.push(`Skills in manifest: ${result.skillCount}`);
  lines.push("");

  if (result.matches.length === 0) {
    lines.push("No skills matched.");
    return lines.join("\n");
  }

  lines.push(`Matched: ${result.matches.length} skill(s)`);
  lines.push(`Injected: ${result.injectedCount} | Capped: ${result.cappedCount}`);
  lines.push("");

  for (const m of result.matches) {
    const status = m.injected ? "INJECT" : "CAPPED";
    const priStr = m.effectivePriority !== m.priority
      ? `${m.effectivePriority} (base ${m.priority})`
      : `${m.priority}`;
    lines.push(`  [${status}] ${m.skill}`);
    lines.push(`          priority: ${priStr}`);
    lines.push(`          pattern:  ${m.matchedPattern} (${m.matchType})`);
  }

  if (result.collisions.length > 0) {
    lines.push("");
    lines.push("Collisions:");
    for (const c of result.collisions) {
      lines.push(`  - ${c.skills.join(", ")}: ${c.reason}`);
    }
  }

  return lines.join("\n");
}
