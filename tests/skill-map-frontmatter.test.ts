import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Import the module under test
import {
  extractFrontmatter,
  parseSkillFrontmatter,
  scanSkillsDir,
  buildSkillMap,
  validateSkillMap,
} from "../hooks/skill-map-frontmatter.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const SKILLS_DIR = join(ROOT, "skills");

/**
 * Count the number of skill directories that contain a SKILL.md file.
 * Used as the ground-truth expected count so tests don't break when
 * skills are added or removed.
 */
function countSkillDirs(): number {
  return readdirSync(SKILLS_DIR).filter((d) => {
    try {
      return existsSync(join(SKILLS_DIR, d, "SKILL.md"));
    } catch {
      return false;
    }
  }).length;
}

// ─── Migration regression: skill-map.json must not exist ─────────

describe("migration regression", () => {
  test("skill-map.json does not exist anywhere in the repo", () => {
    const legacyPaths = [
      join(ROOT, "skill-map.json"),
      join(ROOT, "hooks", "skill-map.json"),
      join(ROOT, "skills", "skill-map.json"),
    ];
    for (const p of legacyPaths) {
      expect(existsSync(p)).toBe(false);
    }
  });
});

// ─── extractFrontmatter ───────────────────────────────────────────

describe("extractFrontmatter", () => {
  test("extracts yaml and body from valid frontmatter", () => {
    const md = `---\nname: test\ndescription: hello\n---\n# Body here`;
    const result = extractFrontmatter(md);
    expect(result.yaml).toBe("name: test\ndescription: hello");
    expect(result.body).toBe("# Body here");
  });

  test("returns empty yaml when no frontmatter present", () => {
    const md = `# Just a heading\nSome content`;
    const result = extractFrontmatter(md);
    expect(result.yaml).toBe("");
    expect(result.body).toBe(md);
  });

  test("handles empty body after frontmatter", () => {
    const md = `---\nname: test\n---\n`;
    const result = extractFrontmatter(md);
    expect(result.yaml).toBe("name: test");
    expect(result.body).toBe("");
  });

  test("handles frontmatter with no trailing newline", () => {
    const md = `---\nname: test\n---`;
    const result = extractFrontmatter(md);
    expect(result.yaml).toBe("name: test");
  });

  test("handles windows-style line endings", () => {
    const md = "---\r\nname: test\r\n---\r\n# Body";
    const result = extractFrontmatter(md);
    expect(result.yaml).toBe("name: test");
    expect(result.body).toBe("# Body");
  });

  test("strips BOM and extracts frontmatter correctly", () => {
    const md = "\uFEFF---\nname: bom-test\ndescription: BOM prefixed\n---\n# Body";
    const result = extractFrontmatter(md);
    expect(result.yaml).toBe("name: bom-test\ndescription: BOM prefixed");
    expect(result.body).toBe("# Body");
  });

  test("leading whitespace before opening --- fence returns no yaml", () => {
    const md = "  ---\nname: test\n---\n# Body";
    const result = extractFrontmatter(md);
    expect(result.yaml).toBe("");
    expect(result.body).toBe(md);
  });
});

// ─── parseSkillFrontmatter ────────────────────────────────────────

describe("parseSkillFrontmatter", () => {
  test("parses name, description, and metadata", () => {
    const yamlStr = `name: nextjs\ndescription: Next.js guide\nmetadata:\n  priority: 5\n  filePattern:\n    - 'app/**'\n  bashPattern:\n    - '\\bnext\\s+dev\\b'`;
    const result = parseSkillFrontmatter(yamlStr);
    expect(result.name).toBe("nextjs");
    expect(result.description).toBe("Next.js guide");
    expect(result.metadata.priority).toBe(5);
    expect(result.metadata.filePattern).toEqual(["app/**"]);
    expect(result.metadata.bashPattern).toEqual(["\\bnext\\s+dev\\b"]);
  });

  test("returns defaults for empty string", () => {
    const result = parseSkillFrontmatter("");
    expect(result.name).toBe("");
    expect(result.description).toBe("");
    expect(result.metadata).toEqual({});
  });

  test("preserves backslash sequences in single-quoted YAML strings", () => {
    // Single-quoted YAML strings should NOT interpret \b as backspace
    const yamlStr = `name: test\nmetadata:\n  bashPattern:\n    - '\\bnpm\\s+install\\b'`;
    const result = parseSkillFrontmatter(yamlStr);
    expect(result.metadata.bashPattern[0]).toBe("\\bnpm\\s+install\\b");
  });

  test("handles missing metadata gracefully", () => {
    const yamlStr = `name: minimal\ndescription: just a name`;
    const result = parseSkillFrontmatter(yamlStr);
    expect(result.name).toBe("minimal");
    expect(result.metadata).toEqual({});
  });

  test("metadata: [] (array) is coerced to empty object", () => {
    const yamlStr = `name: arr-meta\nmetadata: []`;
    const result = parseSkillFrontmatter(yamlStr);
    expect(result.name).toBe("arr-meta");
    expect(result.metadata).toEqual({});
    expect(Array.isArray(result.metadata)).toBe(false);
  });

  test("metadata: 'bad' (string) is coerced to empty object", () => {
    const yamlStr = `name: str-meta\nmetadata: bad`;
    const result = parseSkillFrontmatter(yamlStr);
    expect(result.name).toBe("str-meta");
    expect(result.metadata).toEqual({});
    expect(typeof result.metadata).toBe("object");
  });
});

// ─── scanSkillsDir ────────────────────────────────────────────────

describe("scanSkillsDir", () => {
  test("scans actual skills directory and finds all skills", () => {
    const expected = countSkillDirs();
    const { skills } = scanSkillsDir(SKILLS_DIR);
    expect(skills.length).toBe(expected);
    // Assert on directory-based identity (canonical key), not frontmatter name
    const dirs = skills.map((s) => s.dir);
    expect(dirs).toContain("nextjs");
    expect(dirs).toContain("vercel-storage");
    expect(dirs).toContain("ai-sdk");
  });

  test("each skill has dir, name, description, and metadata", () => {
    const { skills } = scanSkillsDir(SKILLS_DIR);
    for (const skill of skills) {
      // dir is the canonical identity
      expect(typeof skill.dir).toBe("string");
      expect(skill.dir.length).toBeGreaterThan(0);
      // name is non-empty but may differ from dir
      expect(typeof skill.name).toBe("string");
      expect(skill.name.length).toBeGreaterThan(0);
      expect(typeof skill.description).toBe("string");
      expect(typeof skill.metadata).toBe("object");
    }
  });

  test("each skill has filePattern and bashPattern arrays in metadata", () => {
    const { skills } = scanSkillsDir(SKILLS_DIR);
    for (const skill of skills) {
      expect(Array.isArray(skill.metadata.filePattern)).toBe(true);
      expect(Array.isArray(skill.metadata.bashPattern)).toBe(true);
    }
  });

  test("returns empty skills and diagnostics for non-existent directory", () => {
    const { skills, diagnostics } = scanSkillsDir("/nonexistent/path");
    expect(skills).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  test("works with a temp directory containing skill files", () => {
    const tmp = join(tmpdir(), `skill-test-${Date.now()}`);
    const skillDir = join(tmp, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: my-skill\ndescription: A test skill\nmetadata:\n  priority: 3\n  filePattern:\n    - 'src/**'\n  bashPattern:\n    - '\\bmy-cmd\\b'\n---\n# My Skill`
    );

    const { skills, diagnostics } = scanSkillsDir(tmp);
    expect(skills.length).toBe(1);
    expect(skills[0].dir).toBe("my-skill");
    expect(skills[0].name).toBe("my-skill"); // frontmatter name matches dir here
    expect(skills[0].metadata.priority).toBe(3);
    expect(skills[0].metadata.filePattern).toEqual(["src/**"]);
    expect(diagnostics).toEqual([]);

    rmSync(tmp, { recursive: true, force: true });
  });

  test("skips SKILL.md with malformed YAML and populates diagnostics", () => {
    const tmp = join(tmpdir(), `skill-bad-yaml-${Date.now()}`);
    const goodDir = join(tmp, "good-skill");
    const badDir = join(tmp, "bad-skill");
    mkdirSync(goodDir, { recursive: true });
    mkdirSync(badDir, { recursive: true });

    writeFileSync(
      join(goodDir, "SKILL.md"),
      `---\nname: good-skill\ndescription: Works\nmetadata:\n  priority: 5\n  filePattern:\n    - 'src/**'\n  bashPattern: []\n---\n# Good`,
    );
    // Malformed YAML: tab indentation triggers inline parser error
    writeFileSync(
      join(badDir, "SKILL.md"),
      `---\nname: bad-skill\n\tmetadata: foo\n---\n# Bad`,
    );

    const { skills, diagnostics } = scanSkillsDir(tmp);
    // Should get only the good skill, not crash
    expect(skills.length).toBe(1);
    expect(skills[0].dir).toBe("good-skill");
    // Diagnostic should capture the bad file
    expect(diagnostics.length).toBe(1);
    expect(diagnostics[0].file).toContain("bad-skill");
    expect(diagnostics[0].file).toContain("SKILL.md");
    expect(typeof diagnostics[0].error).toBe("string");
    expect(typeof diagnostics[0].message).toBe("string");

    rmSync(tmp, { recursive: true, force: true });
  });
});

// ─── buildSkillMap ────────────────────────────────────────────────

describe("buildSkillMap", () => {
  test("produces object with skills, diagnostics, and warnings keys (no $schema)", () => {
    const map = buildSkillMap(SKILLS_DIR);
    expect(map.$schema).toBeUndefined();
    expect(typeof map.skills).toBe("object");
    expect(Array.isArray(map.diagnostics)).toBe(true);
    expect(Array.isArray(map.warnings)).toBe(true);
  });

  test("defaults priority to 5 when not specified in frontmatter", () => {
    const tmp = join(tmpdir(), `skill-default-priority-${Date.now()}`);
    const skillDir = join(tmp, "no-priority-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: no-priority-skill\ndescription: No priority set\nmetadata:\n  filePattern:\n    - 'src/**'\n  bashPattern: []\n---\n# Test`,
    );

    const map = buildSkillMap(tmp);
    expect(map.skills["no-priority-skill"]).toBeDefined();
    expect(map.skills["no-priority-skill"].priority).toBe(5);

    rmSync(tmp, { recursive: true, force: true });
  });

  test("output shape has priority, pathPatterns, and bashPatterns per skill", () => {
    const map = buildSkillMap(SKILLS_DIR);
    for (const [name, skill] of Object.entries(map.skills) as [string, any][]) {
      expect(typeof skill.priority).toBe("number");
      expect(Array.isArray(skill.pathPatterns)).toBe(true);
      expect(Array.isArray(skill.bashPatterns)).toBe(true);
    }
  });

  test("nextjs skill matches expected values from frontmatter", () => {
    const map = buildSkillMap(SKILLS_DIR);
    const nextjs = map.skills["nextjs"];
    expect(nextjs).toBeDefined();
    expect(nextjs.priority).toBe(5);
    expect(nextjs.pathPatterns).toContain("next.config.*");
    expect(nextjs.pathPatterns).toContain("app/**");
    expect(nextjs.bashPatterns.length).toBeGreaterThan(0);
  });

  test("skill count matches number of SKILL.md directories", () => {
    const expected = countSkillDirs();
    const map = buildSkillMap(SKILLS_DIR);
    const skillCount = Object.keys(map.skills).length;
    expect(skillCount).toBe(expected);
  });

  test("invariant: expected representative skills present with correct patterns", () => {
    const map = buildSkillMap(SKILLS_DIR);
    // Spot-check key skills
    expect(map.skills["nextjs"]).toBeDefined();
    expect(map.skills["vercel-cli"]).toBeDefined();
    expect(map.skills["ai-sdk"]).toBeDefined();
    expect(map.skills["vercel-storage"]).toBeDefined();

    // nextjs should have app/** and next.config.* patterns
    expect(map.skills["nextjs"].pathPatterns).toContain("app/**");
    expect(map.skills["nextjs"].pathPatterns).toContain("next.config.*");

    // vercel-cli should have a bash pattern for vercel commands
    expect(map.skills["vercel-cli"].bashPatterns.length).toBeGreaterThan(0);
  });

  test("backslash sequences preserved in bash patterns", () => {
    const map = buildSkillMap(SKILLS_DIR);
    const nextjs = map.skills["nextjs"];
    // Should contain literal \b not a backspace character
    const hasWordBoundary = nextjs.bashPatterns.some((p: string) => p.includes("\\b"));
    expect(hasWordBoundary).toBe(true);
  });

  test("coerces bare string filePattern to array with warning", () => {
    const tmp = join(tmpdir(), `skill-string-fp-${Date.now()}`);
    const skillDir = join(tmp, "bare-string-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: bare-string-skill\ndescription: Test bare string\nmetadata:\n  priority: 3\n  filePattern: 'src/**'\n  bashPattern:\n    - '\\btest\\b'\n---\n# Test`,
    );

    const map = buildSkillMap(tmp);
    const skill = map.skills["bare-string-skill"];
    expect(skill).toBeDefined();
    expect(Array.isArray(skill.pathPatterns)).toBe(true);
    expect(skill.pathPatterns).toEqual(["src/**"]);
    expect(Array.isArray(skill.bashPatterns)).toBe(true);
    // Should have a coercion warning
    expect(map.warnings.length).toBeGreaterThanOrEqual(1);
    expect(map.warnings.some((w: string) => w.includes("filePattern") && w.includes("coercing"))).toBe(true);

    rmSync(tmp, { recursive: true, force: true });
  });

  test("coerces bare string bashPattern to array with warning", () => {
    const tmp = join(tmpdir(), `skill-string-bp-${Date.now()}`);
    const skillDir = join(tmp, "bare-bash-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: bare-bash-skill\ndescription: Test bare bash string\nmetadata:\n  priority: 2\n  filePattern:\n    - 'app/**'\n  bashPattern: '\\bnpm\\b'\n---\n# Test`,
    );

    const map = buildSkillMap(tmp);
    const skill = map.skills["bare-bash-skill"];
    expect(skill).toBeDefined();
    expect(Array.isArray(skill.bashPatterns)).toBe(true);
    expect(skill.bashPatterns).toEqual(["\\bnpm\\b"]);
    expect(map.warnings.some((w: string) => w.includes("bashPattern") && w.includes("coercing"))).toBe(true);

    rmSync(tmp, { recursive: true, force: true });
  });

  test("defaults non-array non-string filePattern to empty array with warning", () => {
    const tmp = join(tmpdir(), `skill-bad-type-${Date.now()}`);
    const skillDir = join(tmp, "bad-type-skill");
    mkdirSync(skillDir, { recursive: true });
    // Use numbers for both — inline YAML parser treats bare `true` as string "true",
    // so use numbers which are reliably non-array non-string.
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: bad-type-skill\ndescription: Test bad type\nmetadata:\n  priority: 1\n  filePattern: 42\n  bashPattern: 99\n---\n# Test`,
    );

    const map = buildSkillMap(tmp);
    const skill = map.skills["bad-type-skill"];
    expect(skill).toBeDefined();
    expect(skill.pathPatterns).toEqual([]);
    expect(skill.bashPatterns).toEqual([]);
    expect(map.warnings.length).toBeGreaterThanOrEqual(2);

    rmSync(tmp, { recursive: true, force: true });
  });

  test("no warnings emitted for well-formed skills directory", () => {
    const map = buildSkillMap(SKILLS_DIR);
    expect(map.warnings).toEqual([]);
  });

  test("keys by directory name when frontmatter name differs", () => {
    const tmp = join(tmpdir(), `skill-mismatch-${Date.now()}`);
    const skillDir = join(tmp, "my-dir-name");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: different-frontmatter-name\ndescription: Mismatched\nmetadata:\n  priority: 7\n  filePattern:\n    - 'lib/**'\n  bashPattern:\n    - '\\bmy-cmd\\b'\n---\n# Test`,
    );

    const map = buildSkillMap(tmp);
    // Should be keyed by directory name, NOT frontmatter name
    expect(map.skills["my-dir-name"]).toBeDefined();
    expect(map.skills["different-frontmatter-name"]).toBeUndefined();
    expect(map.skills["my-dir-name"].priority).toBe(7);
    expect(map.skills["my-dir-name"].pathPatterns).toEqual(["lib/**"]);

    rmSync(tmp, { recursive: true, force: true });
  });

  test("duplicate frontmatter names in different dirs produce distinct keys", () => {
    const tmp = join(tmpdir(), `skill-dup-name-${Date.now()}`);
    const dir1 = join(tmp, "skill-alpha");
    const dir2 = join(tmp, "skill-beta");
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });

    const frontmatter = (pat: string) =>
      `---\nname: same-name\ndescription: Dup\nmetadata:\n  priority: 5\n  filePattern:\n    - '${pat}'\n  bashPattern: []\n---\n# Test`;

    writeFileSync(join(dir1, "SKILL.md"), frontmatter("alpha/**"));
    writeFileSync(join(dir2, "SKILL.md"), frontmatter("beta/**"));

    const map = buildSkillMap(tmp);
    // Both should exist as distinct entries keyed by dir
    expect(map.skills["skill-alpha"]).toBeDefined();
    expect(map.skills["skill-beta"]).toBeDefined();
    expect(map.skills["skill-alpha"].pathPatterns).toEqual(["alpha/**"]);
    expect(map.skills["skill-beta"].pathPatterns).toEqual(["beta/**"]);
    // No key for the shared frontmatter name
    expect(map.skills["same-name"]).toBeUndefined();

    rmSync(tmp, { recursive: true, force: true });
  });

  test("blank/missing frontmatter name falls back to directory name as key", () => {
    const tmp = join(tmpdir(), `skill-no-name-${Date.now()}`);
    const skillDir = join(tmp, "unnamed-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\ndescription: No name field\nmetadata:\n  priority: 2\n  filePattern:\n    - 'unnamed/**'\n  bashPattern: []\n---\n# Test`,
    );

    const map = buildSkillMap(tmp);
    expect(map.skills["unnamed-skill"]).toBeDefined();
    expect(map.skills["unnamed-skill"].priority).toBe(2);
    expect(map.skills["unnamed-skill"].pathPatterns).toEqual(["unnamed/**"]);

    rmSync(tmp, { recursive: true, force: true });
  });
});

// ─── Edge-case frontmatter tests (BOM, metadata types, whitespace) ─

describe("buildSkillMap — BOM and metadata edge cases", () => {
  function buildWithContent(dirName: string, content: string) {
    const tmp = join(tmpdir(), `skill-edge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const skillDir = join(tmp, dirName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), content);
    const result = buildSkillMap(tmp);
    rmSync(tmp, { recursive: true, force: true });
    return result;
  }

  test("BOM-prefixed SKILL.md is parsed correctly", () => {
    const content = "\uFEFF---\nname: bom-skill\ndescription: BOM test\nmetadata:\n  priority: 3\n  filePattern:\n    - 'src/**'\n  bashPattern: []\n---\n# BOM Skill";
    const map = buildWithContent("bom-skill", content);
    expect(map.skills["bom-skill"]).toBeDefined();
    expect(map.skills["bom-skill"].priority).toBe(3);
    expect(map.skills["bom-skill"].pathPatterns).toEqual(["src/**"]);
    expect(map.warnings).toEqual([]);
  });

  test("metadata: [] (array) defaults to empty patterns without crash", () => {
    const content = "---\nname: arr-meta\ndescription: array metadata\nmetadata: []\n---\n# Test";
    const map = buildWithContent("arr-meta", content);
    expect(map.skills["arr-meta"]).toBeDefined();
    expect(map.skills["arr-meta"].pathPatterns).toEqual([]);
    expect(map.skills["arr-meta"].bashPatterns).toEqual([]);
  });

  test("metadata: 'bad' (string) defaults to empty patterns without crash", () => {
    const content = "---\nname: str-meta\ndescription: string metadata\nmetadata: bad\n---\n# Test";
    const map = buildWithContent("str-meta", content);
    expect(map.skills["str-meta"]).toBeDefined();
    expect(map.skills["str-meta"].pathPatterns).toEqual([]);
    expect(map.skills["str-meta"].bashPatterns).toEqual([]);
  });

  test("leading whitespace before --- fence results in fallback (no frontmatter)", () => {
    const content = "  ---\nname: ws-skill\ndescription: whitespace\nmetadata:\n  filePattern:\n    - 'src/**'\n---\n# Test";
    const map = buildWithContent("ws-skill", content);
    // Leading whitespace means no frontmatter is parsed → name falls back to dir
    expect(map.skills["ws-skill"]).toBeDefined();
    // No metadata parsed, so defaults apply
    expect(map.skills["ws-skill"].pathPatterns).toEqual([]);
    expect(map.skills["ws-skill"].bashPatterns).toEqual([]);
    expect(map.skills["ws-skill"].priority).toBe(5);
  });
});

// ─── Malformed array guards (buildSkillMap) ───────────────────────

describe("buildSkillMap — malformed array entries", () => {
  function buildWithFrontmatter(metadata: string) {
    const tmp = join(tmpdir(), `skill-malformed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const skillDir = join(tmp, "test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: test-skill\ndescription: test\nmetadata:\n${metadata}\n---\n# Test`,
    );
    const result = buildSkillMap(tmp);
    rmSync(tmp, { recursive: true, force: true });
    return result;
  }

  test("filePattern: [42] filters out non-string with warning", () => {
    const map = buildWithFrontmatter("  filePattern:\n    - 42\n  bashPattern: []");
    expect(map.skills["test-skill"].pathPatterns).toEqual([]);
    expect(map.warnings.some((w: string) => w.includes("filePattern[0]") && w.includes("not a string"))).toBe(true);
  });

  test("filePattern: [null] treats bare null as string 'null' (inline parser)", () => {
    // The inline YAML parser treats bare `null` as the string "null", not JS null.
    const map = buildWithFrontmatter("  filePattern:\n    - null\n  bashPattern: []");
    expect(map.skills["test-skill"].pathPatterns).toEqual(["null"]);
    expect(map.warnings.length).toBe(0);
  });

  test("filePattern: [''] filters out empty string with warning", () => {
    const map = buildWithFrontmatter("  filePattern:\n    - ''\n  bashPattern: []");
    expect(map.skills["test-skill"].pathPatterns).toEqual([]);
    expect(map.warnings.some((w: string) => w.includes("filePattern[0]") && w.includes("empty"))).toBe(true);
  });

  test("bashPattern: [42] filters out non-string with warning", () => {
    const map = buildWithFrontmatter("  filePattern: []\n  bashPattern:\n    - 42");
    expect(map.skills["test-skill"].bashPatterns).toEqual([]);
    expect(map.warnings.some((w: string) => w.includes("bashPattern[0]") && w.includes("not a string"))).toBe(true);
  });

  test("bashPattern: [null] treats bare null as string 'null' (inline parser)", () => {
    // The inline YAML parser treats bare `null` as the string "null", not JS null.
    const map = buildWithFrontmatter("  filePattern: []\n  bashPattern:\n    - null");
    expect(map.skills["test-skill"].bashPatterns).toEqual(["null"]);
    expect(map.warnings.length).toBe(0);
  });

  test("bashPattern: [''] filters out empty string with warning", () => {
    const map = buildWithFrontmatter("  filePattern: []\n  bashPattern:\n    - ''");
    expect(map.skills["test-skill"].bashPatterns).toEqual([]);
    expect(map.warnings.some((w: string) => w.includes("bashPattern[0]") && w.includes("empty"))).toBe(true);
  });
});

// ─── buildSkillMap — warningDetails structured diagnostics ────────

describe("buildSkillMap — warningDetails structured diagnostics", () => {
  function buildWithFrontmatter(metadata: string) {
    const tmp = join(tmpdir(), `skill-wd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const skillDir = join(tmp, "test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: test-skill\ndescription: test\nmetadata:\n${metadata}\n---\n# Test`,
    );
    const result = buildSkillMap(tmp);
    rmSync(tmp, { recursive: true, force: true });
    return result;
  }

  test("warningDetails array is present and empty for well-formed skills", () => {
    const map = buildSkillMap(SKILLS_DIR);
    expect(Array.isArray(map.warningDetails)).toBe(true);
    expect(map.warningDetails).toEqual([]);
  });

  test("coercing string filePattern produces structured detail with COERCE_STRING_TO_ARRAY", () => {
    const map = buildWithFrontmatter("  filePattern: 'src/**'\n  bashPattern: []");
    expect(map.warningDetails.length).toBeGreaterThanOrEqual(1);
    const detail = map.warningDetails.find((d: any) => d.code === "COERCE_STRING_TO_ARRAY" && d.field === "filePattern");
    expect(detail).toBeDefined();
    expect(detail.skill).toBe("test-skill");
    expect(detail.valueType).toBe("string");
    expect(typeof detail.message).toBe("string");
    expect(typeof detail.hint).toBe("string");
  });

  test("non-array filePattern produces INVALID_TYPE detail", () => {
    const map = buildWithFrontmatter("  filePattern: 42\n  bashPattern: []");
    const detail = map.warningDetails.find((d: any) => d.code === "INVALID_TYPE" && d.field === "filePattern");
    expect(detail).toBeDefined();
    expect(detail.valueType).toBe("number");
  });

  test("non-string entry in filePattern produces ENTRY_NOT_STRING detail", () => {
    const map = buildWithFrontmatter("  filePattern:\n    - 42\n  bashPattern: []");
    const detail = map.warningDetails.find((d: any) => d.code === "ENTRY_NOT_STRING" && d.field === "filePattern[0]");
    expect(detail).toBeDefined();
    expect(detail.skill).toBe("test-skill");
  });

  test("empty string in bashPattern produces ENTRY_EMPTY detail", () => {
    const map = buildWithFrontmatter("  filePattern: []\n  bashPattern:\n    - ''");
    const detail = map.warningDetails.find((d: any) => d.code === "ENTRY_EMPTY" && d.field === "bashPattern[0]");
    expect(detail).toBeDefined();
  });

  test("warningDetails length matches warnings length", () => {
    const map = buildWithFrontmatter("  filePattern: 42\n  bashPattern: true");
    expect(map.warningDetails.length).toBe(map.warnings.length);
  });
});

// ─── validateSkillMap — warningDetails/errorDetails ────────────────

describe("validateSkillMap — structured errorDetails and warningDetails", () => {
  test("null input returns errorDetails with INVALID_ROOT", () => {
    const result = validateSkillMap(null);
    expect(result.ok).toBe(false);
    expect(result.errorDetails).toBeDefined();
    expect(result.errorDetails.length).toBe(1);
    expect(result.errorDetails[0].code).toBe("INVALID_ROOT");
  });

  test("missing skills key returns errorDetails with MISSING_SKILLS_KEY", () => {
    const result = validateSkillMap({});
    expect(result.ok).toBe(false);
    expect(result.errorDetails[0].code).toBe("MISSING_SKILLS_KEY");
  });

  test("unknown key produces UNKNOWN_KEY warningDetail", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, pathPatterns: [], bashPatterns: [], extraKey: true } },
    });
    expect(result.ok).toBe(true);
    const detail = result.warningDetails.find((d: any) => d.code === "UNKNOWN_KEY" && d.field === "extraKey");
    expect(detail).toBeDefined();
    expect(detail.skill).toBe("s1");
  });

  test("invalid priority produces INVALID_PRIORITY warningDetail", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: "high", pathPatterns: [], bashPatterns: [] } },
    });
    expect(result.ok).toBe(true);
    const detail = result.warningDetails.find((d: any) => d.code === "INVALID_PRIORITY");
    expect(detail).toBeDefined();
    expect(detail.skill).toBe("s1");
    expect(detail.valueType).toBe("string");
  });

  test("non-string pathPatterns entry produces ENTRY_NOT_STRING warningDetail", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, pathPatterns: [42, "valid/**"], bashPatterns: [] } },
    });
    expect(result.ok).toBe(true);
    const detail = result.warningDetails.find((d: any) => d.code === "ENTRY_NOT_STRING" && d.field === "pathPatterns[0]");
    expect(detail).toBeDefined();
  });

  test("warningDetails length matches warnings length on valid input", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: "bad", pathPatterns: [42], bashPatterns: ["", "ok"] } },
    });
    expect(result.ok).toBe(true);
    expect(result.warningDetails.length).toBe(result.warnings.length);
  });

  test("config not object produces CONFIG_NOT_OBJECT errorDetail", () => {
    const result = validateSkillMap({
      skills: { "s1": "not-an-object" },
    });
    expect(result.ok).toBe(false);
    const detail = result.errorDetails.find((d: any) => d.code === "CONFIG_NOT_OBJECT");
    expect(detail).toBeDefined();
    expect(detail.skill).toBe("s1");
  });
});

// ─── Malformed array guards (validateSkillMap) ────────────────────

describe("validateSkillMap — malformed array entries", () => {
  test("pathPatterns with non-string entry is filtered with warning", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, pathPatterns: [42, "valid/**"], bashPatterns: [] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["s1"].pathPatterns).toEqual(["valid/**"]);
    expect(result.warnings.some((w: string) => w.includes("pathPatterns[0]") && w.includes("not a string"))).toBe(true);
  });

  test("pathPatterns with empty string is filtered with warning", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, pathPatterns: ["", "valid/**"], bashPatterns: [] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["s1"].pathPatterns).toEqual(["valid/**"]);
    expect(result.warnings.some((w: string) => w.includes("pathPatterns[0]") && w.includes("empty"))).toBe(true);
  });

  test("bashPatterns with non-string entry is filtered with warning", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, pathPatterns: [], bashPatterns: [null, "\\bvalid\\b"] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["s1"].bashPatterns).toEqual(["\\bvalid\\b"]);
    expect(result.warnings.some((w: string) => w.includes("bashPatterns[0]") && w.includes("not a string"))).toBe(true);
  });

  test("bashPatterns with empty string is filtered with warning", () => {
    const result = validateSkillMap({
      skills: { "s1": { priority: 5, pathPatterns: [], bashPatterns: ["", "\\bvalid\\b"] } },
    });
    expect(result.ok).toBe(true);
    expect(result.normalizedSkillMap.skills["s1"].bashPatterns).toEqual(["\\bvalid\\b"]);
    expect(result.warnings.some((w: string) => w.includes("bashPatterns[0]") && w.includes("empty"))).toBe(true);
  });
});
