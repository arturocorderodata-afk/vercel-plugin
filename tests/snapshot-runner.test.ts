/**
 * Golden snapshot tests for skill injection.
 *
 * Each scenario runs the PreToolUse hook with a specific vercel.json fixture
 * and compares the `skillInjection` metadata against a stored .snap file.
 *
 * To update baselines:  bun test tests/snapshot-runner.test.ts -- --update-snapshots
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");
const SNAP_DIR = join(ROOT, "tests", "snapshots");
const FIXTURES_DIR = join(ROOT, "tests", "fixtures");

const UPDATE_SNAPSHOTS =
  process.argv.includes("--update-snapshots") ||
  process.env.UPDATE_SNAPSHOTS === "1";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run the hook and return the parsed skillInjection metadata. */
async function runHook(input: object): Promise<{
  code: number;
  skillInjection: Record<string, unknown> | null;
}> {
  const session = `snap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const payload = JSON.stringify({ ...input, session_id: session });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      VERCEL_PLUGIN_HOOK_DEDUP: "off", // disable dedup so each scenario is independent
    },
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();

  let skillInjection: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(stdout);
    skillInjection = parsed?.hookSpecificOutput?.skillInjection ?? null;
  } catch {}

  return { code, skillInjection };
}

/**
 * Normalize the skillInjection object for deterministic comparison.
 * - Removes toolTarget (contains temp paths that change per run)
 * - Sorts array fields so ordering within sets is stable
 */
function normalize(injection: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...injection };
  // toolTarget contains absolute paths that vary per machine/run
  delete clone.toolTarget;
  // Sort arrays for deterministic comparison
  for (const key of ["matchedSkills", "injectedSkills", "droppedByCap"] as const) {
    if (Array.isArray(clone[key])) {
      // injectedSkills order matters (priority), so only sort matchedSkills
      if (key === "matchedSkills") {
        clone[key] = [...(clone[key] as string[])].sort();
      }
    }
  }
  return clone;
}

/** Read a .snap file. Returns null if it doesn't exist. */
function readSnap(name: string): string | null {
  const p = join(SNAP_DIR, name);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf-8");
}

/** Write (or overwrite) a .snap file. */
function writeSnap(name: string, content: string): void {
  if (!existsSync(SNAP_DIR)) mkdirSync(SNAP_DIR, { recursive: true });
  writeFileSync(join(SNAP_DIR, name), content, "utf-8");
}

/** Assert that current output matches the stored snapshot. */
function assertSnapshot(snapName: string, actual: Record<string, unknown>) {
  const serialized = JSON.stringify(actual, null, 2) + "\n";

  if (UPDATE_SNAPSHOTS) {
    writeSnap(snapName, serialized);
    // Still pass the test when updating
    return;
  }

  const stored = readSnap(snapName);
  if (stored === null) {
    throw new Error(
      `Snapshot "${snapName}" does not exist. Run with --update-snapshots to create it.`,
    );
  }

  expect(serialized).toBe(stored);
}

// ---------------------------------------------------------------------------
// Write temp vercel.json fixtures that the hook can actually read
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  snapFile: string;
  vercelJson: object;
  toolName: string;
}

const scenarios: Scenario[] = [
  {
    name: "redirects-only",
    snapFile: "inject-redirects.snap",
    vercelJson: {
      redirects: [
        { source: "/blog/:path*", destination: "https://blog.example.com/:path*" },
      ],
    },
    toolName: "Read",
  },
  {
    name: "headers-only",
    snapFile: "inject-headers.snap",
    vercelJson: {
      headers: [
        {
          source: "/(.*)",
          headers: [
            { key: "X-Frame-Options", value: "DENY" },
            { key: "X-Content-Type-Options", value: "nosniff" },
          ],
        },
      ],
    },
    toolName: "Edit",
  },
  {
    name: "rewrites-only",
    snapFile: "inject-rewrites.snap",
    vercelJson: {
      rewrites: [
        { source: "/api/:path*", destination: "https://api.example.com/:path*" },
      ],
    },
    toolName: "Write",
  },
  {
    name: "mixed-all-keys",
    snapFile: "inject-mixed.snap",
    vercelJson: {
      redirects: [{ source: "/old", destination: "/new" }],
      headers: [
        {
          source: "/(.*)",
          headers: [{ key: "X-Frame-Options", value: "DENY" }],
        },
      ],
      rewrites: [
        { source: "/proxy/:path*", destination: "https://backend.example.com/:path*" },
      ],
      functions: { "api/**": { memory: 1024, maxDuration: 30 } },
      crons: [{ path: "/api/cron/daily", schedule: "0 8 * * *" }],
      buildCommand: "next build",
    },
    toolName: "Edit",
  },
  {
    name: "functions-only",
    snapFile: "inject-functions.snap",
    vercelJson: {
      functions: { "api/**": { memory: 1024 } },
      regions: ["iad1"],
    },
    toolName: "Read",
  },
  {
    name: "crons-only",
    snapFile: "inject-crons.snap",
    vercelJson: {
      crons: [
        { path: "/api/cron/hourly", schedule: "0 * * * *" },
        { path: "/api/cron/daily", schedule: "0 8 * * *" },
      ],
    },
    toolName: "Read",
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tempDir: string;

beforeAll(() => {
  tempDir = join(tmpdir(), `vp-snap-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});

describe("golden snapshot tests", () => {
  for (const scenario of scenarios) {
    test(`snapshot: ${scenario.name}`, async () => {
      // Write a temp vercel.json the hook can read
      const filePath = join(tempDir, `${scenario.name}-vercel.json`);
      // The hook expects the file to be named vercel.json
      const projectDir = join(tempDir, scenario.name);
      mkdirSync(projectDir, { recursive: true });
      const vercelPath = join(projectDir, "vercel.json");
      writeFileSync(vercelPath, JSON.stringify(scenario.vercelJson, null, 2), "utf-8");

      const { code, skillInjection } = await runHook({
        tool_name: scenario.toolName,
        tool_input: { file_path: vercelPath },
      });

      expect(code).toBe(0);
      expect(skillInjection).not.toBeNull();

      const normalized = normalize(skillInjection!);
      assertSnapshot(scenario.snapFile, normalized);
    });
  }

  test("snapshot update mode is off by default", () => {
    // Ensure we aren't accidentally always updating
    if (!process.argv.includes("--update-snapshots") && process.env.UPDATE_SNAPSHOTS !== "1") {
      expect(UPDATE_SNAPSHOTS).toBe(false);
    }
  });
});
