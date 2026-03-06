import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const HOOKS_JSON = join(ROOT, "hooks", "hooks.json");
const SCRIPT = join(ROOT, "hooks", "session-start-seen-skills.sh");

async function runSessionStart(env: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> {
  const mergedEnv: Record<string, string> = { ...(process.env as Record<string, string>) };

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete mergedEnv[key];
      continue;
    }
    mergedEnv[key] = value;
  }

  const proc = Bun.spawn(["bash", SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    env: mergedEnv,
  });

  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  return { code, stdout, stderr };
}

async function resolveSeenSkillsPath(envFile: string): Promise<string> {
  const proc = Bun.spawn(
    ["bash", "-lc", 'source "$TARGET_ENV_FILE"; printf "%s" "${VERCEL_PLUGIN_SEEN_SKILLS:-}"'],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...(process.env as Record<string, string>),
        TARGET_ENV_FILE: envFile,
      },
    },
  );

  await proc.exited;
  return (await new Response(proc.stdout).text()).trim();
}

describe("session-start-seen-skills hook", () => {
  test("test_script_exists", () => {
    expect(existsSync(SCRIPT)).toBe(true);
  });

  test("test_hooks_json_places_session_start_script_before_inject", () => {
    const hooks = JSON.parse(readFileSync(HOOKS_JSON, "utf-8"));
    const sessionStart = hooks.hooks.SessionStart[0];

    expect(sessionStart.matcher).toBe("startup|resume|clear|compact");
    expect(sessionStart.hooks[0].type).toBe("command");
    expect(sessionStart.hooks[0].command).toBe(
      'bash "${CLAUDE_PLUGIN_ROOT}/hooks/session-start-seen-skills.sh"',
    );
    expect(sessionStart.hooks[1].type).toBe("command");
    expect(sessionStart.hooks[1].command).toBe(
      'bash "${CLAUDE_PLUGIN_ROOT}/hooks/inject-claude-md.sh"',
    );
  });

  test("test_session_start_appends_seen_skills_export_when_env_file_seeded", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "session-start-seen-skills-"));
    const envFile = join(tempDir, "claude.env");

    try {
      writeFileSync(envFile, "export SEEDED=1\n", "utf-8");

      const result = await runSessionStart({ CLAUDE_ENV_FILE: envFile });
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");

      const content = readFileSync(envFile, "utf-8");
      expect(content).toContain("export SEEDED=1\n");
      expect(content).toMatch(/export VERCEL_PLUGIN_SEEN_SKILLS=.*/);

      const seenSkillsPath = await resolveSeenSkillsPath(envFile);
      expect(seenSkillsPath.length).toBeGreaterThan(0);
      expect(existsSync(seenSkillsPath)).toBe(true);
      expect(basename(seenSkillsPath)).toMatch(/^vercel-plugin-seen-.*\.txt$/);

      rmSync(seenSkillsPath, { force: true });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("test_session_start_exits_cleanly_without_claude_env_file", async () => {
    const result = await runSessionStart({ CLAUDE_ENV_FILE: undefined });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
