---
name: benchmark-sandbox
description: Run vercel-plugin eval scenarios in Vercel Sandboxes instead of local WezTerm panels. Provisions ephemeral microVMs with Claude Code + plugin pre-installed, runs benchmark prompts, extracts hook artifacts, and produces coverage reports.
---

# Benchmark Sandbox — Remote Eval via Vercel Sandboxes

Run benchmark scenarios inside Vercel Sandboxes — ephemeral Firecracker microVMs with node24. Each sandbox gets a fresh Claude Code + Vercel CLI install, the local vercel-plugin uploaded, and runs a Claude Code session with `--dangerously-skip-permissions --debug`.

**Proven working** on 2026-03-09: 5 sandboxes running in parallel, 10+ skills injected per scenario, hooks firing (PreToolUse, PostToolUse, SessionEnd), full Next.js apps built, completed in 5 minutes.

## Proven Working Script

Use `run-eval.ts` — the proven eval runner:

```bash
# Run 5 creative scenarios in parallel (default)
bun run .claude/skills/benchmark-sandbox/run-eval.ts

# Custom concurrency and timeout
bun run .claude/skills/benchmark-sandbox/run-eval.ts --concurrency 3 --timeout 600000
```

## Critical Sandbox Environment Facts

| Property | Value |
|----------|-------|
| Home directory | `/home/vercel-sandbox` (NOT `/home/user`) |
| User | `vercel-sandbox` (NOT `root`) |
| Claude binary | `/home/vercel-sandbox/.global/npm/bin/claude` |
| PATH (via sh -c) | Includes `~/.global/npm/bin` — claude findable by name |
| Port exposure | `sandbox.domain(3000)` → `https://subdomain.vercel.run` |
| Snapshot persistence | **NOTHING survives snapshot restore** — no npm packages, no files, nothing |

### Key Discoveries (Hard-Won)

1. **No snapshots**: Global npm packages and ALL filesystem changes are lost on snapshot restore. Create fresh sandboxes every time.
2. **Plugin install**: Use `npx add-plugin <path> -s project -y --target claude-code` — works because claude is in PATH after `npm install -g`.
3. **File uploads**: Use `sandbox.writeFiles([{ path, content: Buffer }])` — NOT runCommand heredocs.
4. **Claude flags**: Always use `--dangerously-skip-permissions --debug`. The `--debug` flag writes to `~/.claude/debug/`.
5. **Auth**: API key from macOS Keychain (`ANTHROPIC_AUTH_TOKEN`), Vercel token from `~/.local/share/com.vercel.cli/auth.json`.
6. **OIDC for sandbox SDK**: Run `npx vercel link --scope vercel-labs -y` + `npx vercel env pull` once before first use.

## When to Use This vs benchmark-agents

| | benchmark-agents (WezTerm) | benchmark-sandbox |
|---|---|---|
| **Environment** | Local macOS terminal panes | Remote Vercel Sandboxes (Amazon Linux) |
| **Parallelism** | Limited by local resources | Up to 10 (Hobby) or 2,000 (Pro) concurrent |
| **Session type** | Interactive TTY via `/bin/zsh -ic` | `script -qec` PTY wrapper inside sandbox |
| **Artifact access** | Direct filesystem (`~/.claude/debug/`) | `sandbox.readFile()` before shutdown |
| **Best for** | Manual eval + iteration loop | Automated parallel coverage runs |

## How It Works

1. **Create fresh sandbox**: `Sandbox.create({ runtime: "node24", env: { ANTHROPIC_API_KEY, ... } })` — no snapshot
2. **Install tools**: `npm install -g @anthropic-ai/claude-code vercel` (~20s per sandbox)
3. **Auth Vercel CLI**: Write token to `~/.local/share/com.vercel.cli/auth.json`
4. **Upload plugin**: `sandbox.writeFiles()` for 80 plugin files, then `npx add-plugin`
5. **Run Claude Code**: `claude --dangerously-skip-permissions --debug --settings <path> "<prompt>"`
6. **Monitor**: Poll every 20s for skill claims, debug logs, project files
7. **Extract artifacts**: Pull claim dirs, seen-skills, debug logs, project tree before stop

## DO NOT (Hard Rules)

Same rules as `benchmark-agents`, plus sandbox-specific:

- **DO NOT** use `claude --print` or `-p` flag — hooks don't fire without tool-calling sessions
- **DO NOT** skip the PTY wrapper (`script -qec`) — hooks require TTY-like context
- **DO NOT** let sandboxes run without extracting artifacts — ephemeral filesystem is lost on stop
- **DO NOT** pass API keys via `writeFiles()` — use `Sandbox.create({ env: { ... } })`
- **DO NOT** exceed 45 min on Hobby tier — use Pro for full suite runs
- **DO NOT** duplicate scenario prompts — import from `scripts/benchmark-runner.ts`

## Prerequisites

```bash
# One-time setup: link project for OIDC sandbox auth
npx vercel link --scope vercel-labs -y
npx vercel env pull .env.local

# Auth (auto-resolved from macOS Keychain + Vercel CLI auth):
# - ANTHROPIC_API_KEY: from Keychain "ANTHROPIC_AUTH_TOKEN" or env var
# - VERCEL_TOKEN: from ~/.local/share/com.vercel.cli/auth.json or env var
# - ANTHROPIC_BASE_URL: defaults to https://ai-gateway.vercel.sh
```

## Commands

### Run eval (proven approach — no snapshots)

```bash
# Run 5 creative scenarios in parallel (default)
bun run .claude/skills/benchmark-sandbox/run-eval.ts

# Custom concurrency (max 10)
bun run .claude/skills/benchmark-sandbox/run-eval.ts --concurrency 3

# Longer timeout (default 480s = 8 min)
bun run .claude/skills/benchmark-sandbox/run-eval.ts --timeout 600000
```

### Legacy runner (uses snapshots — less reliable)

```bash
bun run .claude/skills/benchmark-sandbox/sandbox-runner.ts --quick
```

## Sandbox Session Flow (Per Scenario)

```
Sandbox.create({ runtime: "node24", env: { ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, VERCEL_PLUGIN_LOG_LEVEL: "trace" } })
  │
  ├─ npm install -g @anthropic-ai/claude-code vercel     (~20s)
  ├─ Write Vercel CLI auth token to ~/.local/share/com.vercel.cli/auth.json
  ├─ mkdir -p /home/vercel-sandbox/<slug> && npm init -y
  ├─ sandbox.writeFiles() → /home/vercel-sandbox/vercel-plugin/  (80 files, ~945KB)
  ├─ npx add-plugin /home/vercel-sandbox/vercel-plugin -s project -y --target claude-code
  │
  ├─ sandbox.writeFiles() → /tmp/prompt.txt
  ├─ claude --dangerously-skip-permissions --debug --settings <path> "$(cat /tmp/prompt.txt)"
  │   (with AbortSignal.timeout(480_000))
  │
  ├─ Poll every 20s:
  │   ├─ ls /tmp/vercel-plugin-*-seen-skills.d/     (claimed skills)
  │   ├─ cat /tmp/vercel-plugin-*-seen-skills.txt    (seen skills snapshot)
  │   ├─ find ~/.claude/debug -type f                (debug log count)
  │   └─ find <project> -newer /tmp/prompt.txt       (new project files)
  │
  ├─ Extract final artifacts (skills, files, debug logs)
  └─ sandbox.stop()
```

## Monitoring While Running

The orchestrator prints live status. For manual checks on a running sandbox:

```typescript
// List claimed skills
const claims = await sandbox.runCommand("sh", ["-c",
  "ls /tmp/vercel-plugin-*-seen-skills.d/ 2>/dev/null"
]);

// Check hook firing count
const hooks = await sandbox.runCommand("sh", ["-c",
  "find /home/vercel-sandbox/.claude/debug -name '*.txt' -exec grep -c 'executePreToolHooks' {} +"
]);
```

## Artifact Export Layout

Results are written to `~/dev/vercel-plugin-testing/sandbox-results/<run-id>/`:

```
<run-id>/
  run-manifest.json          # Run metadata, snapshot ID, timing
  <slug>/
    claude-output.txt        # Session stdout
    stderr-trace.txt         # Session stderr (hook traces)
    claim-dir/               # Copied from /tmp/vercel-plugin-*-seen-skills.d/
    seen-skills.txt           # From /tmp/vercel-plugin-*-seen-skills.txt
    debug-logs/              # From /home/vercel-sandbox/.claude/debug/
    project-tree.txt         # find output of generated project
    run-meta.json            # Per-scenario timing, exit code, method
```

## Coverage Report Format

`sandbox-analyze.ts` produces the same report structure as benchmark-agents:

1. **Session index** — slug, sandbox ID, skills claimed, duration, exit status
2. **Hook coverage matrix** — which hooks fired per scenario (from debug logs)
3. **Skill injection table** — which of the 43 skills were injected across all scenarios
4. **Expected vs actual** — compare `expectedSkills` from scenario definitions
5. **Failures** — timeouts, crash logs, missing artifacts

## Complexity Tiers

Same as `benchmark-agents`:

### Tier 1 — Core AI (`--quick`, ~10 min with 3 parallel sandboxes)
Scenarios 01, 04, 09 — AI SDK, Gateway, Sandbox, AI Elements.

### Tier 2 — Durable Agents (~15 min with 4 parallel)
Scenarios 02, 03, 06, 10 — Workflow DevKit, multi-step durability.

### Tier 3 — Platform Integration (~15 min with 5 parallel)
Scenarios 05, 07, 08, 11, 12 — Chat SDK, Queues, Flags, Firewall.

### Full Suite (~20 min with 6 parallel sandboxes)
All 12 scenarios. Requires Pro tier for >45 min total sandbox time.

## Known Limitations

1. **PTY wrapper required**: `script -qec` is needed for hooks to fire. If unavailable, session falls back to direct invocation (hooks may not fire).
2. **Hobby tier timeout**: 45 min max per sandbox. Tier 2/3 scenarios may need Pro. Sandbox-level timeout is set to 900s (15 min) via `Sandbox.create({ timeout })`.
3. **No live browser verification**: `agent-browser` doesn't work inside sandboxes. Code quality checks only.
4. **Artifact window**: Must extract before `sandbox.stop()` — filesystem is ephemeral.
5. **Amazon Linux paths**: Sandbox default user is `vercel-sandbox` (home at `/home/vercel-sandbox/`). Debug logs are at `/home/vercel-sandbox/.claude/debug/`, not `/root/.claude/debug/`.
6. **`--dangerously-skip-permissions` parity**: The sandbox runner uses `--dangerously-skip-permissions` to avoid interactive permission prompts in headless sandboxes. `benchmark-agents` (WezTerm) does **not** use this flag — it runs with normal permission flow via interactive TTY. This means sandbox evals may exercise different code paths (e.g., tools that would be denied by the user in interactive mode will auto-approve in sandbox). Keep this in mind when comparing coverage results between the two runners.
7. **`runCommand` timeout**: The `@vercel/sandbox` SDK's `runCommand` does not accept a `timeout` option — use `{ signal: AbortSignal.timeout(ms) }` instead. Passing `{ timeout }` is silently ignored.
