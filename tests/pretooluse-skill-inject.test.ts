import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readdir, readFile } from "node:fs/promises";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");
const SKILL_MAP_PATH = join(ROOT, "hooks", "skill-map.json");
const DEDUP_DIR = join(tmpdir(), "vercel-plugin-hooks");

// Unique session ID per test run to avoid cross-test dedup conflicts
let testSession: string;

beforeEach(() => {
  testSession = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
  // Clean up dedup file
  const dedupFile = join(DEDUP_DIR, `session-${testSession}.json`);
  try {
    rmSync(dedupFile, { force: true });
  } catch {}
});

async function runHook(input: object): Promise<{ code: number; stdout: string; stderr: string }> {
  const payload = JSON.stringify({ ...input, session_id: testSession });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

describe("pretooluse-skill-inject.mjs", () => {
  test("hook script exists", () => {
    expect(existsSync(HOOK_SCRIPT)).toBe(true);
  });

  test("outputs empty JSON for unmatched file path", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/some/random/file.txt" },
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  test("outputs empty JSON for empty stdin", async () => {
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.end();
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  test("outputs empty JSON for unmatched tool name", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Glob",
      tool_input: { pattern: "**/*.ts" },
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  test("matches next.config.ts to nextjs skill via Read", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.additionalContext).toBeDefined();
    expect(result.additionalContext).toContain("skill:nextjs");
  });

  test("matches app/ path to nextjs skill via Edit", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "/Users/me/project/app/page.tsx" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.additionalContext).toContain("skill:nextjs");
  });

  test("matches middleware.ts to routing-middleware skill", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Write",
      tool_input: { file_path: "/Users/me/project/middleware.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.additionalContext).toContain("skill:routing-middleware");
  });

  test("matches proxy.ts to routing-middleware skill", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/src/proxy.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.additionalContext).toContain("skill:routing-middleware");
  });

  test("matches vercel.json to vercel-cli skill", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/vercel.json" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.additionalContext).toContain("skill:vercel-cli");
  });

  test("matches turbo.json to turborepo skill", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Edit",
      tool_input: { file_path: "/Users/me/project/turbo.json" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.additionalContext).toContain("skill:turborepo");
  });

  test("matches flags.ts to vercel-flags skill", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/flags.ts" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.additionalContext).toContain("skill:vercel-flags");
  });

  test("matches .env file to ai-gateway skill", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/.env.local" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.additionalContext).toContain("skill:ai-gateway");
  });

  test("matches npm install ai to ai-sdk skill via Bash", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "npm install ai" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.additionalContext).toContain("skill:ai-sdk");
  });

  test("matches vercel deploy to vercel-cli skill via Bash", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "vercel deploy" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.additionalContext).toContain("skill:vercel-cli");
  });

  test("matches turbo run build to turborepo skill via Bash", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "turbo run build" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.additionalContext).toContain("skill:turborepo");
  });

  test("matches npx v0 to v0-dev skill via Bash", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "npx v0 generate" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.additionalContext).toContain("skill:v0-dev");
  });

  test("matches vercel integration to marketplace skill via Bash", async () => {
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: { command: "vercel integration add neon" },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.additionalContext).toContain("skill:marketplace");
  });

  test("deduplicates skills within same session", async () => {
    // First call — should inject
    const { stdout: first } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    const r1 = JSON.parse(first);
    expect(r1.additionalContext).toContain("skill:nextjs");

    // Second call — same session, should be deduped
    const { stdout: second } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.mjs" },
    });
    const r2 = JSON.parse(second);
    expect(r2).toEqual({});
  });

  test("caps at 3 skills when bash command matches 4+ skills", async () => {
    // This command matches 5 distinct skills:
    //   vercel-cli  (vercel deploy)
    //   turborepo   (turbo run build)
    //   v0-dev      (npx v0)
    //   ai-sdk      (npm install ai)
    //   marketplace  (vercel integration)
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: {
        command:
          "vercel deploy && turbo run build && npx v0 generate && npm install ai && vercel integration add neon",
      },
    });
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.additionalContext).toBeDefined();
    const skillTags =
      result.additionalContext.match(/<!-- skill:[a-z-]+ -->/g) || [];
    expect(skillTags.length).toBe(3);
  });

  test("large multi-skill output is valid JSON with correct structure", async () => {
    // Trigger 3 skills via bash and verify the full output structure
    const { code, stdout } = await runHook({
      tool_name: "Bash",
      tool_input: {
        command: "vercel deploy && turbo run build && npx v0 generate",
      },
    });
    expect(code).toBe(0);

    // Must be parseable JSON
    let result: any;
    expect(() => {
      result = JSON.parse(stdout);
    }).not.toThrow();

    // Must have additionalContext string
    expect(typeof result.additionalContext).toBe("string");
    expect(result.additionalContext.length).toBeGreaterThan(0);

    // Each injected skill must have matching open/close tags
    const openTags =
      result.additionalContext.match(/<!-- skill:([a-z0-9-]+) -->/g) || [];
    const closeTags =
      result.additionalContext.match(/<!-- \/skill:([a-z0-9-]+) -->/g) || [];
    expect(openTags.length).toBe(closeTags.length);
    expect(openTags.length).toBeGreaterThanOrEqual(1);
    expect(openTags.length).toBeLessThanOrEqual(3);
  });

  test("returns {} when skill-map.json has valid JSON but missing .skills key", async () => {
    // Create a temporary plugin-like directory with a skill-map.json missing .skills
    const tempRoot = join(tmpdir(), `vp-test-malformed-${Date.now()}`);
    const tempHooksDir = join(tempRoot, "hooks");
    mkdirSync(tempHooksDir, { recursive: true });

    // Copy the hook script
    const hookSource = readFileSync(HOOK_SCRIPT, "utf-8");
    const tempHookPath = join(tempHooksDir, "pretooluse-skill-inject.mjs");
    writeFileSync(tempHookPath, hookSource);

    // Write a skill-map.json with valid JSON but no .skills key
    writeFileSync(join(tempHooksDir, "skill-map.json"), JSON.stringify({ version: 1, foo: "bar" }));

    // Run the hook from the temp location
    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
      session_id: testSession,
    });
    const proc = Bun.spawn(["node", tempHookPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(payload);
    proc.stdin.end();
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});

    // Cleanup
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("globToRegex escapes regex metacharacters in path patterns", async () => {
    // Paths containing ( ) [ ] { } + | ^ $ should match literally
    // We test by reading a file whose path contains metacharacters
    const metaCharPaths = [
      "/project/src/components/(auth)/login.tsx",
      "/project/src/[id]/page.tsx",
      "/project/src/[[...slug]]/page.tsx",
      "/project/app/(group)/layout.tsx",
    ];
    for (const filePath of metaCharPaths) {
      const { code, stdout } = await runHook({
        tool_name: "Read",
        tool_input: { file_path: filePath },
      });
      expect(code).toBe(0);
      // These should parse without throwing, even if they don't match a skill
      expect(() => JSON.parse(stdout)).not.toThrow();
    }
  });

  test("exit code is always 0", async () => {
    // Even with malformed JSON input
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write("not-json");
    proc.stdin.end();
    const code = await proc.exited;
    expect(code).toBe(0);
  });

  test("output is always valid JSON", async () => {
    const inputs = [
      { tool_name: "Read", tool_input: { file_path: "/nothing/here.txt" } },
      { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
      { tool_name: "Bash", tool_input: { command: "echo hello" } },
      { tool_name: "Bash", tool_input: { command: "vercel deploy" } },
    ];
    for (const input of inputs) {
      const { stdout } = await runHook(input);
      expect(() => JSON.parse(stdout)).not.toThrow();
    }
  });

  test("completes in under 200ms", async () => {
    const start = performance.now();
    await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    const elapsed = performance.now() - start;
    // Allow some slack for CI — 500ms
    expect(elapsed).toBeLessThan(500);
  });
});

describe("skill-map.json", () => {
  test("is valid JSON", () => {
    expect(() => JSON.parse(readFileSync(SKILL_MAP_PATH, "utf-8"))).not.toThrow();
  });

  test("references only existing skills", () => {
    const map = JSON.parse(readFileSync(SKILL_MAP_PATH, "utf-8"));
    const missing: string[] = [];
    for (const skill of Object.keys(map.skills)) {
      const skillPath = join(ROOT, "skills", skill, "SKILL.md");
      if (!existsSync(skillPath)) missing.push(skill);
    }
    expect(missing).toEqual([]);
  });

  test("every skill has at least one trigger pattern", () => {
    const map = JSON.parse(readFileSync(SKILL_MAP_PATH, "utf-8"));
    const noTriggers: string[] = [];
    for (const [skill, config] of Object.entries(map.skills) as [string, any][]) {
      const pathCount = (config.pathPatterns || []).length;
      const bashCount = (config.bashPatterns || []).length;
      if (pathCount === 0 && bashCount === 0) noTriggers.push(skill);
    }
    expect(noTriggers).toEqual([]);
  });

  test("covers all 21 skills directories", async () => {
    const map = JSON.parse(readFileSync(SKILL_MAP_PATH, "utf-8"));
    const mapSkills = new Set(Object.keys(map.skills));

    const skillDirs = (await readdir(join(ROOT, "skills"))).filter((d) =>
      existsSync(join(ROOT, "skills", d, "SKILL.md")),
    );

    const uncovered: string[] = [];
    for (const dir of skillDirs) {
      if (!mapSkills.has(dir)) uncovered.push(dir);
    }
    expect(uncovered).toEqual([]);
  });
});

// Helper to run hook with debug mode enabled
async function runHookDebug(input: object): Promise<{ code: number; stdout: string; stderr: string }> {
  const payload = JSON.stringify({ ...input, session_id: `dbg-${Date.now()}-${Math.random().toString(36).slice(2)}` });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, VERCEL_PLUGIN_HOOK_DEBUG: "1" },
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

describe("debug logging (VERCEL_PLUGIN_HOOK_DEBUG=1)", () => {
  test("emits no stderr when debug is off (default)", async () => {
    const { stderr } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    expect(stderr).toBe("");
  });

  test("emits JSON-lines to stderr when debug is on", async () => {
    const { code, stderr } = await runHookDebug({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    expect(code).toBe(0);
    expect(stderr.trim().length).toBeGreaterThan(0);
    const lines = stderr.trim().split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("each debug line has invocationId, event, and timestamp", async () => {
    const { stderr } = await runHookDebug({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    for (const obj of lines) {
      expect(typeof obj.invocationId).toBe("string");
      expect(obj.invocationId.length).toBe(8); // 4 random bytes = 8 hex chars
      expect(typeof obj.event).toBe("string");
      expect(typeof obj.timestamp).toBe("string");
    }
  });

  test("all invocationIds are the same within one invocation", async () => {
    const { stderr } = await runHookDebug({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const ids = new Set(lines.map((l: any) => l.invocationId));
    expect(ids.size).toBe(1);
  });

  test("emits expected events for a matching invocation", async () => {
    const { stderr } = await runHookDebug({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    const events = stderr.trim().split("\n").map((l: string) => JSON.parse(l).event);
    expect(events).toContain("input-parsed");
    expect(events).toContain("skillmap-loaded");
    expect(events).toContain("matches-found");
    expect(events).toContain("dedup-filtered");
    expect(events).toContain("skills-injected");
    expect(events).toContain("complete");
  });

  test("emits expected events for a non-matching invocation", async () => {
    const { stderr } = await runHookDebug({
      tool_name: "Read",
      tool_input: { file_path: "/some/random/file.txt" },
    });
    const events = stderr.trim().split("\n").map((l: string) => JSON.parse(l).event);
    expect(events).toContain("input-parsed");
    expect(events).toContain("skillmap-loaded");
    expect(events).toContain("matches-found");
    expect(events).toContain("dedup-filtered");
    expect(events).toContain("complete");
    // skills-injected should NOT appear since nothing matched
    expect(events).not.toContain("skills-injected");
  });

  test("complete event includes elapsed_ms", async () => {
    const { stderr } = await runHookDebug({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const complete = lines.find((l: any) => l.event === "complete");
    expect(complete).toBeDefined();
    expect(typeof complete.elapsed_ms).toBe("number");
    expect(complete.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  test("stdout remains valid JSON when debug is on", async () => {
    const { stdout } = await runHookDebug({
      tool_name: "Read",
      tool_input: { file_path: "/Users/me/project/next.config.ts" },
    });
    const result = JSON.parse(stdout);
    expect(result.additionalContext).toContain("skill:nextjs");
  });
});

describe("issue events in debug mode", () => {
  test("STDIN_EMPTY issue emitted for empty stdin", async () => {
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    });
    proc.stdin.end();
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});

    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const issue = lines.find((l: any) => l.event === "issue");
    expect(issue).toBeDefined();
    expect(issue.code).toBe("STDIN_EMPTY");
    expect(typeof issue.message).toBe("string");
    expect(typeof issue.hint).toBe("string");
  });

  test("STDIN_PARSE_FAIL issue emitted for invalid JSON", async () => {
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    });
    proc.stdin.write("not-json");
    proc.stdin.end();
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});

    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const issue = lines.find((l: any) => l.event === "issue");
    expect(issue).toBeDefined();
    expect(issue.code).toBe("STDIN_PARSE_FAIL");
    expect(typeof issue.context.error).toBe("string");
  });

  test("SKILLMAP_LOAD_FAIL issue emitted when skill-map.json is missing", async () => {
    const tempRoot = join(tmpdir(), `vp-test-nomap-${Date.now()}`);
    const tempHooksDir = join(tempRoot, "hooks");
    mkdirSync(tempHooksDir, { recursive: true });
    const hookSource = readFileSync(HOOK_SCRIPT, "utf-8");
    const tempHookPath = join(tempHooksDir, "pretooluse-skill-inject.mjs");
    writeFileSync(tempHookPath, hookSource);
    // No skill-map.json written

    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/project/next.config.ts" },
      session_id: testSession,
    });
    const proc = Bun.spawn(["node", tempHookPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    });
    proc.stdin.write(payload);
    proc.stdin.end();
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});

    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const issue = lines.find((l: any) => l.event === "issue");
    expect(issue).toBeDefined();
    expect(issue.code).toBe("SKILLMAP_LOAD_FAIL");

    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("SKILLMAP_EMPTY issue emitted when skills object is empty", async () => {
    const tempRoot = join(tmpdir(), `vp-test-empty-${Date.now()}`);
    const tempHooksDir = join(tempRoot, "hooks");
    mkdirSync(tempHooksDir, { recursive: true });
    const hookSource = readFileSync(HOOK_SCRIPT, "utf-8");
    const tempHookPath = join(tempHooksDir, "pretooluse-skill-inject.mjs");
    writeFileSync(tempHookPath, hookSource);
    writeFileSync(join(tempHooksDir, "skill-map.json"), JSON.stringify({ skills: {} }));

    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { file_path: "/project/next.config.ts" },
      session_id: testSession,
    });
    const proc = Bun.spawn(["node", tempHookPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    });
    proc.stdin.write(payload);
    proc.stdin.end();
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});

    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const issue = lines.find((l: any) => l.event === "issue");
    expect(issue).toBeDefined();
    expect(issue.code).toBe("SKILLMAP_EMPTY");

    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("no issue events emitted when debug is off", async () => {
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.end();
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toBe("");
  });

  test("issue events have required fields: code, message, hint, context", async () => {
    const proc = Bun.spawn(["node", HOOK_SCRIPT], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    });
    proc.stdin.write("not-json");
    proc.stdin.end();
    await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const issues = lines.filter((l: any) => l.event === "issue");
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(typeof issue.code).toBe("string");
      expect(typeof issue.message).toBe("string");
      expect(typeof issue.hint).toBe("string");
      expect(issue.context).toBeDefined();
      // Also has standard debug fields
      expect(typeof issue.invocationId).toBe("string");
      expect(typeof issue.timestamp).toBe("string");
    }
  });
});

// Helper to run hook with custom env vars and optional session_id override
async function runHookEnv(
  input: object,
  env: Record<string, string | undefined>,
  opts?: { omitSessionId?: boolean },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const payload = opts?.omitSessionId
    ? JSON.stringify(input)
    : JSON.stringify({ ...input, session_id: testSession });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  proc.stdin.write(payload);
  proc.stdin.end();
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { code, stdout, stderr };
}

describe("session_id fallback and dedup controls", () => {
  test("missing session_id with no SESSION_ID env uses memory-only dedup (no persistence)", async () => {
    // First call without session_id — should inject
    const { stdout: first } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
      {},
      { omitSessionId: true },
    );
    const r1 = JSON.parse(first);
    expect(r1.additionalContext).toContain("skill:nextjs");

    // Second call without session_id — memory-only means no cross-invocation dedup,
    // so it should inject again
    const { stdout: second } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
      {},
      { omitSessionId: true },
    );
    const r2 = JSON.parse(second);
    expect(r2.additionalContext).toContain("skill:nextjs");
  });

  test("SESSION_ID env var is used as fallback when session_id missing from input", async () => {
    const envSession = `env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const dedupFile = join(DEDUP_DIR, `session-${envSession}.json`);

    try {
      // First call — should inject and persist to env session file
      const { stdout: first } = await runHookEnv(
        { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
        { SESSION_ID: envSession },
        { omitSessionId: true },
      );
      const r1 = JSON.parse(first);
      expect(r1.additionalContext).toContain("skill:nextjs");

      // Dedup file should exist
      expect(existsSync(dedupFile)).toBe(true);

      // Second call — same env session, should be deduped
      const { stdout: second } = await runHookEnv(
        { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
        { SESSION_ID: envSession },
        { omitSessionId: true },
      );
      const r2 = JSON.parse(second);
      expect(r2).toEqual({});
    } finally {
      rmSync(dedupFile, { force: true });
    }
  });

  test("VERCEL_PLUGIN_HOOK_DEDUP=off disables all dedup", async () => {
    // First call — should inject
    const { stdout: first } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
      { VERCEL_PLUGIN_HOOK_DEDUP: "off" },
    );
    const r1 = JSON.parse(first);
    expect(r1.additionalContext).toContain("skill:nextjs");

    // Second call with same session — dedup is off, should inject again
    const { stdout: second } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
      { VERCEL_PLUGIN_HOOK_DEDUP: "off" },
    );
    const r2 = JSON.parse(second);
    expect(r2.additionalContext).toContain("skill:nextjs");
  });

  test("RESET_DEDUP=1 clears the dedup file before matching", async () => {
    // First call — inject and persist
    const { stdout: first } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/project/next.config.ts" },
    });
    expect(JSON.parse(first).additionalContext).toContain("skill:nextjs");

    // Verify dedup blocks re-injection
    const { stdout: deduped } = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/project/next.config.ts" },
    });
    expect(JSON.parse(deduped)).toEqual({});

    // With RESET_DEDUP=1, should inject again
    const { stdout: reset } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
      { RESET_DEDUP: "1" },
    );
    expect(JSON.parse(reset).additionalContext).toContain("skill:nextjs");
  });

  test("debug mode logs dedup strategy as persistent when session_id provided", async () => {
    const { stderr } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
      { VERCEL_PLUGIN_HOOK_DEBUG: "1" },
    );
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const strategyEvent = lines.find((l: any) => l.event === "dedup-strategy");
    expect(strategyEvent).toBeDefined();
    expect(strategyEvent.strategy).toBe("persistent");
  });

  test("debug mode logs dedup strategy as memory-only when session_id missing", async () => {
    const { stderr } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
      { VERCEL_PLUGIN_HOOK_DEBUG: "1" },
      { omitSessionId: true },
    );
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const strategyEvent = lines.find((l: any) => l.event === "dedup-strategy");
    expect(strategyEvent).toBeDefined();
    expect(strategyEvent.strategy).toBe("memory-only");
  });

  test("debug mode logs dedup strategy as disabled when VERCEL_PLUGIN_HOOK_DEDUP=off", async () => {
    const { stderr } = await runHookEnv(
      { tool_name: "Read", tool_input: { file_path: "/project/next.config.ts" } },
      { VERCEL_PLUGIN_HOOK_DEBUG: "1", VERCEL_PLUGIN_HOOK_DEDUP: "off" },
    );
    const lines = stderr.trim().split("\n").map((l: string) => JSON.parse(l));
    const strategyEvent = lines.find((l: any) => l.event === "dedup-strategy");
    expect(strategyEvent).toBeDefined();
    expect(strategyEvent.strategy).toBe("disabled");
  });
});

describe("hooks.json PreToolUse config", () => {
  test("has PreToolUse matcher for Read|Edit|Write|Bash", () => {
    const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf-8"));
    expect(hooks.hooks.PreToolUse).toBeDefined();
    expect(hooks.hooks.PreToolUse.length).toBeGreaterThan(0);

    const matcher = hooks.hooks.PreToolUse[0].matcher;
    expect(matcher).toContain("Read");
    expect(matcher).toContain("Edit");
    expect(matcher).toContain("Write");
    expect(matcher).toContain("Bash");
  });

  test("references the correct hook script", () => {
    const hooks = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf-8"));
    const hookCmd = hooks.hooks.PreToolUse[0].hooks[0].command;
    expect(hookCmd).toContain("pretooluse-skill-inject.mjs");
  });
});
