import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const HOOK_SCRIPT = join(ROOT, "hooks", "pretooluse-skill-inject.mjs");
const SESSION_START_SCRIPT = join(ROOT, "hooks", "session-start-seen-skills.mjs");
const UNLIMITED_BUDGET = "999999";
let testSession: string;

beforeEach(() => {
  testSession = `timeline-${Date.now()}-${Math.random().toString(36).slice(2)}`;
});

async function runSessionStart(envFilePath: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["node", SESSION_START_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CLAUDE_ENV_FILE: envFilePath },
  });

  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { code, stdout, stderr };
}

async function runHookEnv(
  input: { tool_name: string; tool_input: Record<string, string> },
  env: Record<string, string | undefined>,
  opts?: { sessionId?: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const sid = opts?.sessionId ?? testSession;
  const payload = JSON.stringify({ ...input, session_id: sid });
  const proc = Bun.spawn(["node", HOOK_SCRIPT], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      VERCEL_PLUGIN_INJECTION_BUDGET: UNLIMITED_BUDGET,
      ...env,
    },
  });

  proc.stdin.write(payload);
  proc.stdin.end();

  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { code, stdout, stderr };
}

function readSeenSkillsExport(envFilePath: string): string {
  const content = readFileSync(envFilePath, "utf-8");
  const match = content.match(/^export VERCEL_PLUGIN_SEEN_SKILLS="([^"]*)"$/m);

  if (!match) {
    throw new Error(`Missing VERCEL_PLUGIN_SEEN_SKILLS export in ${envFilePath}: ${content}`);
  }

  return match[1];
}

function parseInjectedSkills(stdout: string): string[] {
  const parsed = JSON.parse(stdout);
  const ctx = parsed?.hookSpecificOutput?.additionalContext || "";
  const match = ctx.match(/<!-- skillInjection: (\{.*?\}) -->/);
  const si = match ? JSON.parse(match[1]) : {};
  const injectedSkills = si.injectedSkills;

  if (!Array.isArray(injectedSkills)) {
    return [];
  }

  return injectedSkills.filter((skill): skill is string => typeof skill === "string");
}

function parseDebugLines(stderr: string): Array<Record<string, unknown>> {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return { line };
      }
    });
}

describe("session timeline subagent integration", () => {
  test("session-start-seen-skills.mjs appends an empty-string seen-skills export to CLAUDE_ENV_FILE", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "session-timeline-lead-"));
    const leadEnvPath = join(tempDir, "lead.env");

    try {
      writeFileSync(leadEnvPath, "export SEEDED=1\n", "utf-8");

      const result = await runSessionStart(leadEnvPath);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");

      const content = readFileSync(leadEnvPath, "utf-8");
      expect(content).toContain('export VERCEL_PLUGIN_SEEN_SKILLS=""');
      expect(readSeenSkillsExport(leadEnvPath)).toBe("");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("lead scaffold timeline dedups in the lead session but a fresh subagent gets its own nextjs injection", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "session-timeline-subagent-"));
    const leadEnvPath = join(tempDir, "lead.env");
    const subagentEnvPath = join(tempDir, "subagent.env");

    try {
      writeFileSync(leadEnvPath, "", "utf-8");
      writeFileSync(subagentEnvPath, "", "utf-8");

      const leadSessionStart = await runSessionStart(leadEnvPath);
      expect(leadSessionStart.code).toBe(0);
      expect(readSeenSkillsExport(leadEnvPath)).toBe("");

      const leadScaffold = await runHookEnv(
        { tool_name: "Bash", tool_input: { command: "npx create-next-app@latest notion-clone --ts --app" } },
        { VERCEL_PLUGIN_SEEN_SKILLS: "", VERCEL_PLUGIN_HOOK_DEBUG: "1" },
      );

      expect(leadScaffold.code).toBe(0);
      expect(parseInjectedSkills(leadScaffold.stdout)).toContain("nextjs");

      const leadRead = await runHookEnv(
        { tool_name: "Read", tool_input: { file_path: "/Users/me/notion-clone/app/page.tsx" } },
        { VERCEL_PLUGIN_SEEN_SKILLS: "nextjs" },
      );

      expect(leadRead.code).toBe(0);
      expect(JSON.parse(leadRead.stdout)).toEqual({});

      const subagentSessionStart = await runSessionStart(subagentEnvPath);
      expect(subagentSessionStart.code).toBe(0);
      expect(readSeenSkillsExport(subagentEnvPath)).toBe("");

      // Subagent gets its own session_id, so file-based dedup starts fresh
      const subagentSession = `subagent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const subagentRead = await runHookEnv(
        { tool_name: "Read", tool_input: { file_path: "/Users/me/notion-clone/app/page.tsx" } },
        { VERCEL_PLUGIN_SEEN_SKILLS: "", VERCEL_PLUGIN_HOOK_DEBUG: "1" },
        { sessionId: subagentSession },
      );

      expect(subagentRead.code).toBe(0);
      expect(parseInjectedSkills(subagentRead.stdout)).toContain("nextjs");

      const debugLines = parseDebugLines(subagentRead.stderr);
      const dedupStrategyLine = debugLines.find((line) => line.event === "dedup-strategy");
      expect(dedupStrategyLine).toBeDefined();
      expect(dedupStrategyLine?.strategy).toBe("file");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
