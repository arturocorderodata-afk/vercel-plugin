/**
 * Session-start repo profiler hook.
 *
 * Scans the current working directory for common config files and package
 * dependencies, then writes likely skill slugs into VERCEL_PLUGIN_LIKELY_SKILLS
 * in CLAUDE_ENV_FILE. This pre-primes the skill matcher so the first tool call
 * can skip cold-scanning for obvious frameworks.
 *
 * Exits silently (code 0) if CLAUDE_ENV_FILE is not set or the project root
 * cannot be determined.
 */

import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Mapping from marker file / condition to skill slugs.
 * Each entry: { file, skills } or { check(projectRoot) → string[] }
 */
const FILE_MARKERS = [
  { file: "next.config.js", skills: ["nextjs", "turbopack"] },
  { file: "next.config.mjs", skills: ["nextjs", "turbopack"] },
  { file: "next.config.ts", skills: ["nextjs", "turbopack"] },
  { file: "next.config.mts", skills: ["nextjs", "turbopack"] },
  { file: "turbo.json", skills: ["turborepo"] },
  { file: "vercel.json", skills: ["vercel-cli", "deployments-cicd", "vercel-functions"] },
  { file: ".mcp.json", skills: ["vercel-api"] },
  { file: "middleware.ts", skills: ["routing-middleware"] },
  { file: "middleware.js", skills: ["routing-middleware"] },
  { file: "components.json", skills: ["shadcn"] },
  { file: ".env.local", skills: ["env-vars"] },
];

/**
 * Dependency names in package.json → skill slugs.
 */
const PACKAGE_MARKERS = {
  "next": ["nextjs"],
  "ai": ["ai-sdk"],
  "@ai-sdk/openai": ["ai-sdk"],
  "@ai-sdk/anthropic": ["ai-sdk"],
  "@ai-sdk/gateway": ["ai-sdk", "ai-gateway"],
  "@vercel/blob": ["vercel-storage"],
  "@vercel/kv": ["vercel-storage"],
  "@vercel/postgres": ["vercel-storage"],
  "@vercel/edge-config": ["vercel-storage"],
  "@vercel/analytics": ["observability"],
  "@vercel/speed-insights": ["observability"],
  "@vercel/flags": ["vercel-flags"],
  "@vercel/workflow": ["workflow"],
  "@vercel/queue": ["vercel-queues"],
  "@vercel/sandbox": ["vercel-sandbox"],
  "@vercel/sdk": ["vercel-api"],
  "turbo": ["turborepo"],
};

/**
 * Scan a project root and return a deduplicated, sorted list of likely skill slugs.
 * @param {string} projectRoot
 * @returns {string[]}
 */
export function profileProject(projectRoot) {
  const skills = new Set();

  // 1. Check marker files
  for (const marker of FILE_MARKERS) {
    if (existsSync(join(projectRoot, marker.file))) {
      for (const s of marker.skills) skills.add(s);
    }
  }

  // 2. Check package.json dependencies
  const pkgPath = join(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const allDeps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
      };
      for (const [dep, skillSlugs] of Object.entries(PACKAGE_MARKERS)) {
        if (dep in allDeps) {
          for (const s of skillSlugs) skills.add(s);
        }
      }
    } catch {
      // Malformed package.json — skip silently
    }
  }

  // 3. Check vercel.json keys for more specific skills
  const vercelJsonPath = join(projectRoot, "vercel.json");
  if (existsSync(vercelJsonPath)) {
    try {
      const vercelConfig = JSON.parse(readFileSync(vercelJsonPath, "utf-8"));
      if (vercelConfig.crons) skills.add("cron-jobs");
      if (vercelConfig.rewrites || vercelConfig.redirects || vercelConfig.headers) {
        skills.add("routing-middleware");
      }
      if (vercelConfig.functions) skills.add("vercel-functions");
    } catch {
      // Malformed vercel.json — skip silently
    }
  }

  return [...skills].sort();
}

/**
 * Main entry point — profile the project and write env vars.
 */
function main() {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) {
    process.exit(0);
  }

  // Use CLAUDE_PROJECT_ROOT if available, otherwise cwd
  const projectRoot = process.env.CLAUDE_PROJECT_ROOT || process.cwd();

  const likelySkills = profileProject(projectRoot);

  if (likelySkills.length === 0) {
    process.exit(0);
  }

  const value = likelySkills.join(",");

  try {
    appendFileSync(envFile, `export VERCEL_PLUGIN_LIKELY_SKILLS="${value}"\n`);
  } catch {
    // Cannot write env file — exit silently
  }

  process.exit(0);
}

main();
