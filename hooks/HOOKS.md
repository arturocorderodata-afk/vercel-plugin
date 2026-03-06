# Skill-Map Maintainer Guide

This document covers everything needed to add, modify, or debug skill mappings
using SKILL.md frontmatter without reading the hook source code.

## How the Hook Works (30-second overview)

SessionStart and PreToolUse run in sequence:

1. SessionStart appends `export VERCEL_PLUGIN_SEEN_SKILLS=""` to `CLAUDE_ENV_FILE`
2. PreToolUse parses SKILL.md frontmatter from each `skills/<name>/SKILL.md`
3. PreToolUse matches the tool target (file path or bash command) against every skill's patterns
4. PreToolUse sorts matches by **priority DESC**, then **skill name ASC** (deterministic)
5. PreToolUse caps at **3 skills** per invocation
6. PreToolUse reads each matched skill's `skills/<name>/SKILL.md` and injects it as `additionalContext`
7. PreToolUse reads and appends `VERCEL_PLUGIN_SEEN_SKILLS` for dedup, so a skill is only injected once per process unless dedup is disabled

## Subagents and dedup state

`VERCEL_PLUGIN_SEEN_SKILLS` is a comma-delimited environment variable, not a temp file.

Each Agent subagent runs as a separate process, so PreToolUse runs independently for the lead agent and each subagent. A fresh subagent should get its own skill injections even if the lead agent already injected the same skills.

If a subagent explicitly inherits a non-empty `VERCEL_PLUGIN_SEEN_SKILLS`, dedup applies inside that subagent using the inherited slug list. This behavior is intentional because each independent worker should receive its own relevant skill context.

---

## Skill Frontmatter Schema

Each `skills/<name>/SKILL.md` contains YAML frontmatter with metadata:

```yaml
---
metadata:
  pathPatterns:
    - "lib/my-feature/**"
  bashPatterns:
    - "\\bmy-tool\\s+run\\b"
  priority: 6
---
```

| Field          | Type       | Default | Description                                              |
|----------------|------------|---------|----------------------------------------------------------|
| `priority`     | `number`   | `5`     | Higher = injected first when multiple skills match        |
| `pathPatterns`  | `string[]` | `[]`    | Glob patterns matched against Read/Edit/Write file paths  |
| `bashPatterns`  | `string[]` | `[]`    | Regex patterns matched against Bash tool commands         |

> **Migration note:** The deprecated names `filePattern` and `bashPattern` (singular) are still accepted but will emit a warning. Rename them to the canonical plural forms.

---

### Metadata Version

The hook emits a `skillInjection` metadata block (currently **version 1**) alongside
`additionalContext`. The schema:

```jsonc
{
  "version": 1,
  "toolName": "Read",           // which tool triggered the match
  "toolTarget": "src/app/...",  // file path or bash command
  "matchedSkills": ["nextjs"],  // all skills that matched (before cap)
  "injectedSkills": ["nextjs"], // skills actually injected (after cap + dedup)
  "droppedByCap": []            // skills matched but dropped by the 3-skill cap
}
```

---

## Choosing a Priority

Priority determines which skills get injected when more than 3 match.

| Range | Use For                           | Examples                                    |
|-------|-----------------------------------|---------------------------------------------|
| 8     | Domain-specific, high-signal      | `ai-sdk`, `vercel-functions`                |
| 7     | Important integrations            | `ai-gateway`, `vercel-storage`, `vercel-api`, `env-vars` |
| 6     | Feature-area skills               | `routing-middleware`, `vercel-flags`, `cron-jobs`, `observability`, `deployments-cicd` |
| 5     | Framework / broad matching        | `nextjs`, `turborepo`, `shadcn`, `v0-dev`   |
| 4     | CLI tools, low-specificity        | `vercel-cli`, `turbopack`, `json-render`    |
| 3     | Rare / niche                      | `marketplace`                               |

**Rules of thumb:**

- If the skill covers a narrow, well-defined API surface, use **7-8**.
- If the skill covers a broad framework or many file types, use **5-6**.
- If the skill is a fallback or rarely triggered, use **3-4**.
- When two skills share the same path (e.g., `vercel.json` triggers both `cron-jobs` and `vercel-functions`), the higher-priority skill is injected first.
- **Tie-breaking is alphabetical by skill name** — so same-priority skills produce deterministic ordering across platforms.

---

## Glob Syntax for `pathPatterns`

Patterns use a simplified glob syntax (not full minimatch):

| Pattern     | Meaning                                        | Example Match                |
|-------------|------------------------------------------------|------------------------------|
| `*`         | Any characters except `/`                      | `next.config.*` matches `next.config.js`, `next.config.mjs` |
| `**`        | Zero or more path segments (must use `**/`)    | `app/**/route.*` matches `app/api/users/route.ts` |
| `?`         | Any single character except `/`                | `middleware.?s` matches `middleware.ts`, `middleware.js` |
| Literal     | Exact match                                    | `vercel.json` matches only `vercel.json` |

### Matching behavior

Paths are matched three ways (first match wins):

1. **Full path** — the glob is tested against the entire file path
2. **Basename** — the glob is tested against just the filename
3. **Suffix segments** — progressively longer path suffixes are tested

This means `vercel.json` will match `/Users/me/project/vercel.json` via basename,
and `app/**/route.*` will match `/Users/me/project/app/api/route.ts` via suffix.

### Examples

```yaml
# Match all files in app/ and nested subdirectories
pathPatterns:
  - "app/**"

# Match route handlers at any depth under app/
  - "app/**/route.*"

# Match Next.js config regardless of extension
  - "next.config.*"

# Match monorepo apps
  - "apps/*/vercel.json"
  - "apps/*/src/app/**"
```

---

## Regex Syntax for `bashPatterns`

Patterns are standard JavaScript `RegExp` strings (no delimiters, no flags).
They are tested against the full bash command string.

### Examples

```yaml
# Match "next dev", "next build", "next start", "next lint"
bashPatterns:
  - "\\bnext\\s+(dev|build|start|lint)\\b"

# Match package install commands for a specific package
  - "\\bnpm\\s+(install|i|add)\\s+[^\\n]*@vercel/blob\\b"

# Match the vercel CLI as a standalone command
  - "^\\s*vercel(?:\\s|$)"
```

**Tips:**
- Use `\\b` for word boundaries to avoid false positives
- Use `\\s+` instead of literal spaces for robustness
- Invalid regex patterns are silently skipped with an `issue` event in debug mode

---

## Adding a New Skill (Step-by-Step)

1. **Create the skill content:** `skills/<name>/SKILL.md`
2. **Add frontmatter** at the top of the SKILL.md:
   ```yaml
   ---
   metadata:
     pathPatterns:
       - "lib/my-feature/**"
     bashPatterns:
       - "\\bmy-tool\\s+run\\b"
     priority: 6
   ---
   ```
3. **Pick a priority** using the table above.
4. **Run the tests:** `bun test`
5. **Verify debug output** (optional): `VERCEL_PLUGIN_DEBUG=1` — see below.

---

## Debugging with `VERCEL_PLUGIN_DEBUG=1`

Set either environment variable to enable JSON-lines debug output on stderr:

```bash
VERCEL_PLUGIN_DEBUG=1
# or
VERCEL_PLUGIN_HOOK_DEBUG=1
```

### Debug events emitted

| Event               | When                                        | Key fields                                      |
|---------------------|---------------------------------------------|-------------------------------------------------|
| `input-parsed`      | After reading stdin                         | `toolName`, `sessionId`                         |
| `tool-target`       | After parsing tool target (redacted)        | `toolName`, `target`                            |
| `skillmap-loaded`   | After building skill map from frontmatter   | `skillCount`                                    |
| `matches-found`     | After pattern matching                      | `matched[]`, `reasons{}`                        |
| `dedup-strategy`    | After choosing dedup mode                   | `strategy` (`env-var`|`memory-only`|`disabled`) |
| `dedup-filtered`    | After filtering already-injected skills     | `rankedSkills[]`, `previouslyInjected[]`             |
| `cap-applied`       | When matches exceed MAX_SKILLS (3)          | `selected[]`, `dropped[]`                       |
| `skills-injected`   | After reading SKILL.md files                | `injected[]`, `totalParts`                      |
| `complete`          | At the end of every invocation              | `result`, `elapsed_ms`, `timing_ms`             |
| `issue`             | On any warning or error                     | `code`, `message`, `hint`                       |

Dedup strategies are `env-var`, `memory-only`, and `disabled`.

### Issue codes

| Code                  | Meaning                                   |
|-----------------------|-------------------------------------------|
| `STDIN_EMPTY`           | No data on stdin                          |
| `STDIN_PARSE_FAIL`     | stdin is not valid JSON                   |
| `SKILLMAP_LOAD_FAIL`   | SKILL.md frontmatter scan failed          |
| `SKILLMAP_VALIDATE_FAIL` | Skill map validation failed after build |
| `SKILLMAP_EMPTY`       | No skills found with frontmatter          |
| `SKILL_FILE_MISSING`   | `skills/<name>/SKILL.md` not found        |
| `PATH_GLOB_INVALID`    | A pathPatterns entry is not a valid glob   |
| `BASH_REGEX_INVALID`   | A bashPatterns entry is not valid regex    |

### Redaction behavior

When debug mode logs bash commands (the `tool-target` event), sensitive values
are automatically masked:

- Environment-style secrets: `MY_TOKEN=abc123` becomes `TOKEN=[REDACTED]`
- Flag-style secrets: `--password abc` becomes `--password [REDACTED]`
- Patterns matched: `TOKEN=`, `KEY=`, `SECRET=`, `--token`, `--password`, `--api-key`
- Commands longer than 200 characters are truncated with `…[truncated]`

Redaction only applies to debug logs — actual tool commands are never modified.

---

## Other Environment Variables

| Variable                          | Effect                                                        |
|-----------------------------------|---------------------------------------------------------------|
| `VERCEL_PLUGIN_SEEN_SKILLS`      | Comma-delimited slug list initialized by SessionStart via `CLAUDE_ENV_FILE` |
| `VERCEL_PLUGIN_HOOK_DEDUP=off`   | Disable dedup (every match re-injects)                        |
