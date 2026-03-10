#!/usr/bin/env bun
/**
 * Proven sandbox eval runner — creates fresh sandboxes (no snapshots),
 * installs Claude Code + Vercel CLI + plugin, runs scenarios with
 * --dangerously-skip-permissions --debug, polls for progress, and
 * exposes port 3000 for live app verification.
 *
 * Usage:
 *   bun run .claude/skills/benchmark-sandbox/run-eval.ts [--concurrency N] [--timeout MS]
 */

import { Sandbox } from "@vercel/sandbox";
import { readdir, readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SANDBOX_HOME = "/home/vercel-sandbox";
const SANDBOX_PLUGIN_DIR = `${SANDBOX_HOME}/vercel-plugin`;
const LOCAL_PLUGIN_DIR = join(homedir(), "dev", "vercel-plugin");
const UPLOAD_DIRS = ["hooks", "skills", "generated"];
const RESULTS_DIR = join(homedir(), "dev", "vercel-plugin-testing", "sandbox-results");

const args = process.argv.slice(2);
const concurrencyArg = args.includes("--concurrency") ? parseInt(args[args.indexOf("--concurrency") + 1], 10) : 5;
const timeoutArg = args.includes("--timeout") ? parseInt(args[args.indexOf("--timeout") + 1], 10) : 1_800_000; // 30 min default
const CONCURRENCY = Math.min(Math.max(concurrencyArg, 1), 10);
const TIMEOUT_MS = timeoutArg;

// ---------------------------------------------------------------------------
// 5 Creative Scenarios — each builds a different app
// ---------------------------------------------------------------------------

interface Scenario {
  slug: string;
  prompt: string;
  expectedSkills: string[];
}

const SCENARIOS: Scenario[] = [
  {
    slug: "astral-birth-chart",
    prompt: "Build a Next.js app that generates personalized astrology birth charts. Use AI SDK to interpret planetary positions and generate readings. Use Satori to render beautiful OG image cards for each chart. Use shadcn/ui for the interface with a dark cosmic theme. After building, start the dev server on port 3000.",
    expectedSkills: ["ai-sdk", "satori", "shadcn", "nextjs"],
  },
  {
    slug: "debate-arena",
    prompt: "Build a Next.js app where two AI models debate each other on user-chosen topics. Use the AI SDK Chat completions with streaming. Use Vercel feature flags to control which models are available. Add middleware for geo-routing to show different default topics by region. Use shadcn/ui components. After building, start the dev server on port 3000.",
    expectedSkills: ["ai-sdk", "chat-sdk", "vercel-flags", "routing-middleware", "nextjs"],
  },
  {
    slug: "dungeon-master",
    prompt: "Build a Next.js turn-based AI RPG dungeon master. Use AI SDK for generating encounters and story. Use Vercel KV (runtime cache) for session state persistence between turns. Add a cron job API route that generates daily challenge dungeons. Use shadcn/ui for the game interface. After building, start the dev server on port 3000.",
    expectedSkills: ["ai-sdk", "runtime-cache", "cron-jobs", "nextjs", "shadcn"],
  },
  {
    slug: "recipe-generator",
    prompt: "Build a Next.js AI recipe generator. Users upload photos of ingredients, AI identifies them and suggests recipes. Use AI SDK for the generation, Vercel Blob for image storage, and SWR for client-side data fetching with optimistic updates. Use shadcn/ui. After building, start the dev server on port 3000.",
    expectedSkills: ["ai-sdk", "vercel-storage", "swr", "nextjs", "shadcn"],
  },
  {
    slug: "deploy-dashboard",
    prompt: "Build a Next.js deployment monitoring dashboard. Use the Vercel API to list recent deployments and their status. Add observability with structured logging. Use edge runtime for the API routes. Use shadcn/ui for the dashboard layout with charts. After building, start the dev server on port 3000.",
    expectedSkills: ["vercel-api", "observability", "edge-runtime", "nextjs", "shadcn"],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function elapsed(start: number): string {
  return `${((performance.now() - start) / 1000).toFixed(0)}s`;
}

function resolveApiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    return execSync('security find-generic-password -a "$USER" -s "ANTHROPIC_AUTH_TOKEN" -w', {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
  } catch {}
  console.error("Missing ANTHROPIC_API_KEY (or Keychain ANTHROPIC_AUTH_TOKEN)");
  process.exit(1);
}

function resolveVercelToken(): string | undefined {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;
  try {
    const authFile = join(homedir(), ".local/share/com.vercel.cli/auth.json");
    return JSON.parse(require("fs").readFileSync(authFile, "utf-8")).token;
  } catch {}
  return undefined;
}

async function collectPluginFiles(): Promise<Array<{ path: string; content: Buffer }>> {
  const files: Array<{ path: string; content: Buffer }> = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(join(LOCAL_PLUGIN_DIR, dir), { withFileTypes: true });
    for (const entry of entries) {
      const relPath = join(dir, entry.name);
      const fullPath = join(LOCAL_PLUGIN_DIR, relPath);
      if (entry.isDirectory()) {
        if (["node_modules", ".git", "src", ".claude", "tests", "scripts", ".playground"].includes(entry.name)) continue;
        await walk(relPath);
      } else if (entry.isFile()) {
        if (entry.name.endsWith(".mts") || entry.name.endsWith(".test.ts")) continue;
        const s = await stat(fullPath);
        if (s.size > 200_000) continue;
        files.push({ path: join(SANDBOX_PLUGIN_DIR, relPath), content: await readFile(fullPath) });
      }
    }
  }
  for (const dir of UPLOAD_DIRS) await walk(dir);
  for (const f of ["hooks/hooks.json", "package.json"]) {
    try { files.push({ path: join(SANDBOX_PLUGIN_DIR, f), content: await readFile(join(LOCAL_PLUGIN_DIR, f)) }); } catch {}
  }
  return files;
}

async function sh(sandbox: any, cmd: string): Promise<string> {
  try {
    const r = await sandbox.runCommand("sh", ["-c", cmd]);
    return (await r.stdout()).trim();
  } catch {
    return "(cmd failed)";
  }
}

// ---------------------------------------------------------------------------
// Per-scenario runner
// ---------------------------------------------------------------------------

interface ScenarioResult {
  slug: string;
  sandboxId: string;
  success: boolean;
  durationMs: number;
  claimedSkills: string[];
  expectedSkills: string[];
  projectFiles: string[];
  appUrl?: string;
  error?: string;
  pollHistory: Array<{ elapsed: string; skills: string[]; files: number }>;
}

async function runScenario(
  scenario: Scenario,
  apiKey: string,
  baseUrl: string,
  vercelToken: string | undefined,
  pluginFiles: Array<{ path: string; content: Buffer }>,
): Promise<ScenarioResult> {
  const t0 = performance.now();
  const projectDir = `${SANDBOX_HOME}/${scenario.slug}`;
  const pollHistory: ScenarioResult["pollHistory"] = [];
  let sandbox: InstanceType<typeof Sandbox> | undefined;

  try {
    // 1. Create fresh sandbox (no snapshot — nothing persists)
    console.log(`  [${scenario.slug}] Creating sandbox...`);
    sandbox = await Sandbox.create({
      runtime: "node24",
      ports: [3000],
      env: {
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_BASE_URL: baseUrl,
        VERCEL_PLUGIN_LOG_LEVEL: "trace",
        ...(vercelToken ? { VERCEL_TOKEN: vercelToken } : {}),
      },
      timeout: TIMEOUT_MS + 120_000, // sandbox lives 2 min longer than claude session
    });
    let appUrl: string | undefined;
    try { appUrl = sandbox.domain(3000); } catch {}
    console.log(`  [${scenario.slug}] Sandbox ${sandbox.sandboxId}${appUrl ? ` | ${appUrl}` : ""} (${elapsed(t0)})`);

    // 2. Install Claude Code + Vercel CLI
    await sandbox.runCommand("sh", ["-c", "npm install -g @anthropic-ai/claude-code vercel"]);
    const claudeBin = await sh(sandbox, "which claude");
    console.log(`  [${scenario.slug}] Claude at ${claudeBin} (${elapsed(t0)})`);

    // 3. Vercel CLI auth
    if (vercelToken) {
      await sandbox.writeFiles([{
        path: `${SANDBOX_HOME}/.local/share/com.vercel.cli/auth.json`,
        content: Buffer.from(JSON.stringify({ token: vercelToken })),
      }]);
    }

    // 4. Project setup
    await sandbox.runCommand("sh", ["-c", `mkdir -p ${projectDir} && cd ${projectDir} && npm init -y`]);

    // 5. Upload plugin + install via add-plugin
    await sandbox.writeFiles(pluginFiles);
    const addPlugin = await sh(sandbox, `cd ${projectDir} && npx -y add-plugin ${SANDBOX_PLUGIN_DIR} -s project -y --target claude-code 2>&1 | tail -3`);
    console.log(`  [${scenario.slug}] Plugin: ${addPlugin.split("\n").pop()} (${elapsed(t0)})`);

    // 6. Write prompt and launch Claude Code
    await sandbox.writeFiles([{ path: "/tmp/prompt.txt", content: Buffer.from(scenario.prompt) }]);
    const settingsPath = `${projectDir}/.claude/settings.json`;
    const cmd = `cd ${projectDir} && ${claudeBin} --dangerously-skip-permissions --debug --settings ${settingsPath} "$(cat /tmp/prompt.txt)"`;

    console.log(`  [${scenario.slug}] Session started (${elapsed(t0)})`);

    const sessionPromise = sandbox.runCommand("sh", ["-c", cmd], { signal: AbortSignal.timeout(TIMEOUT_MS) });

    // 7. Poll for progress every 20s
    const pollInterval = setInterval(async () => {
      try {
        const skills = (await sh(sandbox!, "ls /tmp/vercel-plugin-*-seen-skills.d/ 2>/dev/null")).split("\n").filter(Boolean);
        const fileCount = parseInt(await sh(sandbox!, `find ${projectDir} -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' -not -path '*/.claude/*' -newer /tmp/prompt.txt -type f 2>/dev/null | wc -l`), 10) || 0;
        pollHistory.push({ elapsed: elapsed(t0), skills, files: fileCount });

        const port3000 = await sh(sandbox!, "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000 2>/dev/null || echo 'down'");
        // Try to get public URL once port 3000 is up
        if (!appUrl && port3000 !== "000down" && port3000 !== "down") {
          try { appUrl = sandbox!.domain(3000); } catch {}
        }
        const skillStr = skills.length > 0 ? skills.join(", ") : "(none)";
        console.log(`  [${scenario.slug}] ${elapsed(t0)} | skills: ${skillStr} | files: ${fileCount} | :3000=${port3000}${appUrl ? ` | ${appUrl}` : ""}`);
      } catch {}
    }, 20_000);

    // 8. Wait for session
    let sessionExit = -1;
    let sessionOut = "";
    try {
      const result = await sessionPromise;
      clearInterval(pollInterval);
      sessionOut = (await result.stdout()).trim();
      sessionExit = (result as any).exitCode ?? 0;
    } catch (e: any) {
      clearInterval(pollInterval);
      if (e.message?.includes("timed out") || e.message?.includes("abort")) {
        console.log(`  [${scenario.slug}] Session timed out at ${elapsed(t0)}`);
        sessionExit = 124;
      } else {
        throw e;
      }
    }

    // 9. Extract final artifacts (appUrl already captured at sandbox creation)
    const claimedSkills = (await sh(sandbox, "ls /tmp/vercel-plugin-*-seen-skills.d/ 2>/dev/null")).split("\n").filter(Boolean);
    const projectFilesList = (await sh(sandbox, `find ${projectDir} -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.next/*' -not -path '*/.claude/*' -type f 2>/dev/null | head -40`)).split("\n").filter(Boolean);

    console.log(`  [${scenario.slug}] DONE (${elapsed(t0)}) | exit=${sessionExit} | skills=${claimedSkills.length} | files=${projectFilesList.length}${appUrl ? ` | url=${appUrl}` : ""}`);

    return {
      slug: scenario.slug,
      sandboxId: sandbox.sandboxId,
      success: sessionExit === 0,
      durationMs: performance.now() - t0,
      claimedSkills,
      expectedSkills: scenario.expectedSkills,
      projectFiles: projectFilesList,
      appUrl,
      pollHistory,
    };
  } catch (err: any) {
    console.error(`  [${scenario.slug}] ERROR: ${err.message?.slice(0, 200)}`);
    return {
      slug: scenario.slug,
      sandboxId: sandbox?.sandboxId ?? "unknown",
      success: false,
      durationMs: performance.now() - t0,
      claimedSkills: [],
      expectedSkills: scenario.expectedSkills,
      projectFiles: [],
      error: err.message?.slice(0, 400),
      pollHistory,
    };
  } finally {
    if (sandbox) {
      try { await sandbox.stop(); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const t0 = performance.now();
  const runId = `eval-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const resultsPath = join(RESULTS_DIR, runId);
  await mkdir(resultsPath, { recursive: true });

  console.log("=== Sandbox Eval Runner ===");
  console.log(`Scenarios: ${SCENARIOS.length}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Timeout: ${TIMEOUT_MS / 1000}s per scenario`);
  console.log(`Results: ${resultsPath}\n`);

  const apiKey = resolveApiKey();
  const baseUrl = "https://ai-gateway.vercel.sh";
  const vercelToken = resolveVercelToken();

  // Pre-collect plugin files once (shared across all scenarios)
  console.log("Collecting plugin files...");
  const pluginFiles = await collectPluginFiles();
  console.log(`  ${pluginFiles.length} files (${(pluginFiles.reduce((a, f) => a + f.content.length, 0) / 1024).toFixed(0)}KB)\n`);

  // Run scenarios in parallel with worker pool
  const queue = [...SCENARIOS];
  const results: ScenarioResult[] = [];

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const scenario = queue.shift()!;
      console.log(`\n--- ${scenario.slug} ---`);
      const result = await runScenario(scenario, apiKey, baseUrl, vercelToken, pluginFiles);
      results.push(result);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, SCENARIOS.length) }, () => worker());
  await Promise.all(workers);

  // Save results
  await writeFile(join(resultsPath, "results.json"), JSON.stringify({ runId, results, totalMs: performance.now() - t0 }, null, 2));

  // Print summary
  console.log("\n\n=== SUMMARY ===");
  console.log(`${"Slug".padEnd(24)} ${"Status".padEnd(8)} ${"Skills".padEnd(40)} ${"Files".padEnd(6)} Duration`);
  console.log("-".repeat(100));
  for (const r of results) {
    const status = r.success ? "OK" : r.error?.includes("timed") ? "TMOUT" : "FAIL";
    console.log(`${r.slug.padEnd(24)} ${status.padEnd(8)} ${r.claimedSkills.join(", ").padEnd(40).slice(0, 40)} ${String(r.projectFiles.length).padEnd(6)} ${(r.durationMs / 1000).toFixed(0)}s`);
  }

  const passed = results.filter(r => r.success).length;
  const withSkills = results.filter(r => r.claimedSkills.length > 0).length;
  console.log(`\n${passed}/${results.length} succeeded | ${withSkills}/${results.length} had skills injected`);
  console.log(`Total: ${elapsed(t0)}`);
  console.log(`Results: ${resultsPath}`);

  // Print app URLs
  const appsWithUrls = results.filter(r => r.appUrl);
  if (appsWithUrls.length > 0) {
    console.log("\n=== APP URLs ===");
    for (const r of appsWithUrls) {
      console.log(`  ${r.slug}: ${r.appUrl}`);
    }
  }

  // Print expected vs actual skills
  console.log("\n=== SKILL COVERAGE ===");
  for (const r of results) {
    const expected = new Set(r.expectedSkills);
    const actual = new Set(r.claimedSkills);
    const hit = [...expected].filter(s => actual.has(s));
    const miss = [...expected].filter(s => !actual.has(s));
    const extra = [...actual].filter(s => !expected.has(s));
    console.log(`  ${r.slug}: ${hit.length}/${expected.size} expected | +${extra.length} bonus | -${miss.length} missing`);
    if (miss.length) console.log(`    missing: ${miss.join(", ")}`);
    if (extra.length) console.log(`    bonus: ${extra.join(", ")}`);
  }

  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => { console.error("Fatal:", e); process.exit(2); });
