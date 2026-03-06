#!/usr/bin/env bun
/**
 * Build-time script that generates a static skill manifest from SKILL.md
 * frontmatter. The PreToolUse hook reads this manifest instead of scanning
 * and parsing every SKILL.md on each invocation.
 *
 * Usage:  bun run scripts/build-manifest.ts
 *         node scripts/build-manifest.ts   (also works via bun shim)
 */

import { resolve, join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

// Import the canonical skill-map builder (ESM)
import { buildSkillMap, validateSkillMap } from "../hooks/skill-map-frontmatter.mjs";

const ROOT = resolve(import.meta.dir, "..");
const SKILLS_DIR = join(ROOT, "skills");
const OUT_DIR = join(ROOT, "generated");
const OUT_FILE = join(OUT_DIR, "skill-manifest.json");

const built = buildSkillMap(SKILLS_DIR);

if (built.diagnostics?.length) {
  for (const d of built.diagnostics) {
    console.error(`[warn] ${d.file}: ${d.message}`);
  }
}

const validation = validateSkillMap(built);

if (!validation.ok) {
  console.error("[error] Skill map validation failed:");
  for (const e of validation.errors) console.error(`  - ${e}`);
  process.exit(1);
}

if (validation.warnings?.length) {
  for (const w of validation.warnings) {
    console.warn(`[warn] ${w}`);
  }
}

// Augment each skill entry with its bodyPath (relative to plugin root)
const skills: Record<string, any> = {};
for (const [slug, config] of Object.entries(validation.normalizedSkillMap.skills)) {
  skills[slug] = {
    ...config,
    bodyPath: `skills/${slug}/SKILL.md`,
  };
}

const manifest = {
  generatedAt: new Date().toISOString(),
  skills,
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(manifest, null, 2) + "\n");

const count = Object.keys(manifest.skills).length;
console.log(`✓ Wrote ${count} skills to ${OUT_FILE}`);
