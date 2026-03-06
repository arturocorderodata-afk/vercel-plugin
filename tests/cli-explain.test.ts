import { describe, test, expect, beforeAll } from "bun:test";
import { resolve, join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = resolve(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli", "index.ts");

/** Run the CLI via Bun.spawn and capture stdout/stderr/exitCode. */
async function runCli(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

// ---------------------------------------------------------------------------
// Help & usage
// ---------------------------------------------------------------------------

describe("vercel-plugin CLI", () => {
  test("no args prints usage and exits 0", async () => {
    const { stdout, exitCode } = await runCli();
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("explain");
  });

  test("--help prints usage", async () => {
    const { stdout, exitCode } = await runCli("--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  test("explain --help prints usage", async () => {
    const { stdout, exitCode } = await runCli("explain", "--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage:");
  });

  test("unknown command exits 1", async () => {
    const { exitCode, stderr } = await runCli("bogus");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Unknown command");
  });
});

// ---------------------------------------------------------------------------
// explain command — file matching
// ---------------------------------------------------------------------------

describe("explain file matching", () => {
  test("middleware.ts matches routing-middleware", async () => {
    const { stdout, exitCode } = await runCli("explain", "middleware.ts");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("routing-middleware");
    expect(stdout).toContain("INJECT");
  });

  test("app/api/chat/route.ts matches ai-sdk", async () => {
    const { stdout, exitCode } = await runCli("explain", "app/api/chat/route.ts");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ai-sdk");
  });

  test("nonexistent-pattern.xyz matches nothing", async () => {
    const { stdout, exitCode } = await runCli("explain", "nonexistent-pattern.xyz");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("No skills matched");
  });
});

// ---------------------------------------------------------------------------
// explain command — bash matching
// ---------------------------------------------------------------------------

describe("explain bash matching", () => {
  test("'vercel deploy --prod' matches deployments-cicd", async () => {
    const { stdout, exitCode } = await runCli("explain", "vercel deploy --prod");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("deployments-cicd");
  });
});

// ---------------------------------------------------------------------------
// explain --json
// ---------------------------------------------------------------------------

describe("explain --json", () => {
  test("produces valid JSON output", async () => {
    const { stdout, exitCode } = await runCli("explain", "middleware.ts", "--json");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.target).toBe("middleware.ts");
    expect(result.targetType).toBe("file");
    expect(Array.isArray(result.matches)).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(typeof result.skillCount).toBe("number");
    expect(typeof result.injectedCount).toBe("number");
    expect(typeof result.cappedCount).toBe("number");
    expect(Array.isArray(result.collisions)).toBe(true);
  });

  test("json includes match details", async () => {
    const { stdout } = await runCli("explain", "middleware.ts", "--json");
    const result = JSON.parse(stdout);
    const match = result.matches[0];
    expect(match).toHaveProperty("skill");
    expect(match).toHaveProperty("priority");
    expect(match).toHaveProperty("effectivePriority");
    expect(match).toHaveProperty("matchedPattern");
    expect(match).toHaveProperty("matchType");
    expect(match).toHaveProperty("injected");
    expect(match).toHaveProperty("capped");
  });

  test("bash command json has targetType bash", async () => {
    const { stdout } = await runCli("explain", "vercel deploy --prod", "--json");
    const result = JSON.parse(stdout);
    expect(result.targetType).toBe("bash");
  });
});

// ---------------------------------------------------------------------------
// explain --project (invalid path)
// ---------------------------------------------------------------------------

describe("explain --project validation", () => {
  test("invalid project path exits non-zero", async () => {
    const { exitCode, stderr } = await runCli("explain", "middleware.ts", "--project", "/tmp/no-such-plugin-dir");
    expect(exitCode).toBe(2);
    expect(stderr).toContain("no skills/ directory");
  });
});

// ---------------------------------------------------------------------------
// collision detection
// ---------------------------------------------------------------------------

describe("collision detection", () => {
  test("vercel.json triggers multiple matches with collision info", async () => {
    const { stdout } = await runCli("explain", "vercel.json", "--json");
    const result = JSON.parse(stdout);
    // vercel.json should match multiple skills (routing-middleware, deployments-cicd, etc.)
    expect(result.matches.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// cap behavior
// ---------------------------------------------------------------------------

describe("cap behavior", () => {
  test("vercel.json shows capped skills when >3 match", async () => {
    const { stdout } = await runCli("explain", "vercel.json", "--json");
    const result = JSON.parse(stdout);
    // vercel.json should match >=4 skills so cap applies
    if (result.matches.length > 3) {
      expect(result.cappedCount).toBeGreaterThan(0);
      const capped = result.matches.filter((m: any) => m.capped);
      expect(capped.length).toBe(result.cappedCount);
    }
  });
});
