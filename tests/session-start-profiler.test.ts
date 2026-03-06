import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PROFILER = join(ROOT, "hooks", "session-start-profiler.mjs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runProfiler(env: Record<string, string | undefined>): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const mergedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete mergedEnv[key];
      continue;
    }
    mergedEnv[key] = value;
  }

  const proc = Bun.spawn(["node", PROFILER], {
    stdout: "pipe",
    stderr: "pipe",
    env: mergedEnv,
  });

  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

function parseLikelySkills(envFileContent: string): string[] {
  const match = envFileContent.match(
    /export VERCEL_PLUGIN_LIKELY_SKILLS="([^"]*)"/,
  );
  if (!match) return [];
  return match[1].split(",").filter(Boolean);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tempDir: string;
let envFile: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "profiler-"));
  envFile = join(tempDir, "claude.env");
  writeFileSync(envFile, "", "utf-8");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session-start-profiler", () => {
  test("script exists", () => {
    expect(existsSync(PROFILER)).toBe(true);
  });

  test("exits cleanly without CLAUDE_ENV_FILE", async () => {
    const result = await runProfiler({ CLAUDE_ENV_FILE: undefined });
    expect(result.code).toBe(0);
  });

  test("writes nothing for an empty project", async () => {
    const projectDir = join(tempDir, "empty-project");
    mkdirSync(projectDir);

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const content = readFileSync(envFile, "utf-8");
    expect(content).not.toContain("VERCEL_PLUGIN_LIKELY_SKILLS");
  });

  test("detects Next.js project via next.config.ts", async () => {
    const projectDir = join(tempDir, "nextjs-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "next.config.ts"), "export default {};");
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0" } }),
    );

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("nextjs");
    expect(skills).toContain("turbopack");
  });

  test("detects Turborepo project via turbo.json", async () => {
    const projectDir = join(tempDir, "turbo-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "turbo.json"), "{}");
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ devDependencies: { turbo: "^2.0.0" } }),
    );

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("turborepo");
  });

  test("detects plain Vercel project (vercel.json only)", async () => {
    const projectDir = join(tempDir, "vercel-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "vercel.json"), "{}");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("vercel-cli");
    expect(skills).toContain("deployments-cicd");
    expect(skills).toContain("vercel-functions");
  });

  test("detects vercel.json key-specific skills (crons, rewrites)", async () => {
    const projectDir = join(tempDir, "vercel-crons");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "vercel.json"),
      JSON.stringify({
        crons: [{ path: "/api/cron", schedule: "0 * * * *" }],
        rewrites: [{ source: "/old", destination: "/new" }],
      }),
    );

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("cron-jobs");
    expect(skills).toContain("routing-middleware");
  });

  test("detects AI SDK dependencies from package.json", async () => {
    const projectDir = join(tempDir, "ai-project");
    mkdirSync(projectDir);
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        dependencies: {
          ai: "^4.0.0",
          "@ai-sdk/gateway": "^1.0.0",
          "@vercel/analytics": "^1.0.0",
        },
      }),
    );

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("ai-sdk");
    expect(skills).toContain("ai-gateway");
    expect(skills).toContain("observability");
  });

  test("detects .mcp.json for vercel-api skill", async () => {
    const projectDir = join(tempDir, "mcp-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, ".mcp.json"), "{}");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("vercel-api");
  });

  test("detects middleware.ts for routing-middleware skill", async () => {
    const projectDir = join(tempDir, "middleware-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "middleware.ts"), "export function middleware() {}");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("routing-middleware");
  });

  test("detects shadcn via components.json", async () => {
    const projectDir = join(tempDir, "shadcn-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "components.json"), "{}");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("shadcn");
  });

  test("detects .env.local for env-vars skill", async () => {
    const projectDir = join(tempDir, "env-project");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, ".env.local"), "SECRET=foo");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("env-vars");
  });

  test("handles full Next.js + Turbo + AI stack", async () => {
    const projectDir = join(tempDir, "full-stack");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "next.config.mjs"), "export default {};");
    writeFileSync(join(projectDir, "turbo.json"), "{}");
    writeFileSync(join(projectDir, "vercel.json"), JSON.stringify({ crons: [] }));
    writeFileSync(join(projectDir, ".mcp.json"), "{}");
    writeFileSync(join(projectDir, "middleware.ts"), "");
    writeFileSync(join(projectDir, ".env.local"), "");
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({
        dependencies: {
          next: "15.0.0",
          ai: "^4.0.0",
          "@vercel/blob": "^1.0.0",
          "@vercel/flags": "^1.0.0",
        },
        devDependencies: {
          turbo: "^2.0.0",
        },
      }),
    );

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));

    // Should detect all major stacks
    expect(skills).toContain("nextjs");
    expect(skills).toContain("turbopack");
    expect(skills).toContain("turborepo");
    expect(skills).toContain("vercel-cli");
    expect(skills).toContain("ai-sdk");
    expect(skills).toContain("vercel-storage");
    expect(skills).toContain("vercel-flags");
    expect(skills).toContain("vercel-api");
    expect(skills).toContain("routing-middleware");
    expect(skills).toContain("env-vars");
    expect(skills).toContain("cron-jobs");

    // Skills should be sorted
    const sorted = [...skills].sort();
    expect(skills).toEqual(sorted);
  });

  test("survives malformed package.json gracefully", async () => {
    const projectDir = join(tempDir, "bad-pkg");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "package.json"), "NOT JSON {{{");
    writeFileSync(join(projectDir, "next.config.js"), "");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    // Should still detect file markers despite bad package.json
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("nextjs");
  });

  test("survives malformed vercel.json gracefully", async () => {
    const projectDir = join(tempDir, "bad-vercel");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "vercel.json"), "NOT JSON");

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    // Should still detect vercel.json as a marker file
    const skills = parseLikelySkills(readFileSync(envFile, "utf-8"));
    expect(skills).toContain("vercel-cli");
  });

  test("output is sorted and deduplicated", async () => {
    const projectDir = join(tempDir, "dedup-project");
    mkdirSync(projectDir);
    // next.config.ts gives nextjs+turbopack, package.json also gives nextjs
    writeFileSync(join(projectDir, "next.config.ts"), "");
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ dependencies: { next: "15.0.0" } }),
    );

    const result = await runProfiler({
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PROJECT_ROOT: projectDir,
    });

    expect(result.code).toBe(0);
    const content = readFileSync(envFile, "utf-8");
    const skills = parseLikelySkills(content);

    // No duplicates
    expect(skills.length).toBe(new Set(skills).size);

    // Sorted
    expect(skills).toEqual([...skills].sort());
  });

  test("hooks.json registers profiler after seen-skills init", () => {
    const hooksJson = JSON.parse(
      readFileSync(join(ROOT, "hooks", "hooks.json"), "utf-8"),
    );
    const sessionStart = hooksJson.hooks.SessionStart[0];
    const commands = sessionStart.hooks.map(
      (h: { command: string }) => h.command,
    );

    // Profiler must come after seen-skills and before inject-claude-md
    const seenIdx = commands.findIndex((c: string) =>
      c.includes("session-start-seen-skills.sh"),
    );
    const profilerIdx = commands.findIndex((c: string) =>
      c.includes("session-start-profiler.mjs"),
    );
    const injectIdx = commands.findIndex((c: string) =>
      c.includes("inject-claude-md.sh"),
    );

    expect(seenIdx).toBeGreaterThanOrEqual(0);
    expect(profilerIdx).toBeGreaterThanOrEqual(0);
    expect(injectIdx).toBeGreaterThanOrEqual(0);
    expect(profilerIdx).toBeGreaterThan(seenIdx);
    expect(profilerIdx).toBeLessThan(injectIdx);
  });
});

// ---------------------------------------------------------------------------
// profileProject unit tests (imported directly)
// ---------------------------------------------------------------------------

describe("profileProject (unit)", () => {
  test("returns empty array for empty directory", async () => {
    // Dynamic import to test the exported function directly
    const { profileProject } = await import("../hooks/session-start-profiler.mjs");
    const projectDir = join(tempDir, "unit-empty");
    mkdirSync(projectDir);

    const result = profileProject(projectDir);
    expect(result).toEqual([]);
  });

  test("returns sorted skills for mixed project", async () => {
    const { profileProject } = await import("../hooks/session-start-profiler.mjs");
    const projectDir = join(tempDir, "unit-mixed");
    mkdirSync(projectDir);
    writeFileSync(join(projectDir, "next.config.js"), "");
    writeFileSync(join(projectDir, "turbo.json"), "{}");

    const result = profileProject(projectDir);
    expect(result).toContain("nextjs");
    expect(result).toContain("turbopack");
    expect(result).toContain("turborepo");
    expect(result).toEqual([...result].sort());
  });
});
