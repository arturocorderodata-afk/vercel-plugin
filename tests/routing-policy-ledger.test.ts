import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  projectPolicyPath,
  sessionExposurePath,
  loadProjectRoutingPolicy,
  saveProjectRoutingPolicy,
  appendSkillExposure,
  loadSessionExposures,
  resolveBoundaryOutcome,
  finalizeStaleExposures,
  type SkillExposure,
} from "../hooks/src/routing-policy-ledger.mts";
import { createEmptyRoutingPolicy } from "../hooks/src/routing-policy.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PROJECT = "/tmp/test-project-routing-policy-ledger";
const TEST_SESSION = "test-session-rpl-" + Date.now();

const T0 = "2026-03-27T04:00:00.000Z";
const T1 = "2026-03-27T04:01:00.000Z";
const T2 = "2026-03-27T04:02:00.000Z";
const T3 = "2026-03-27T04:03:00.000Z";
const T4 = "2026-03-27T04:04:00.000Z";

function makeExposure(overrides: Partial<SkillExposure> = {}): SkillExposure {
  return {
    id: `${TEST_SESSION}:test-skill:${Date.now()}`,
    sessionId: TEST_SESSION,
    projectRoot: TEST_PROJECT,
    storyId: "story-1",
    storyKind: "flow-verification",
    route: "/dashboard",
    hook: "PreToolUse",
    toolName: "Bash",
    skill: "agent-browser-verify",
    targetBoundary: "uiRender",
    createdAt: T0,
    resolvedAt: null,
    outcome: "pending",
    ...overrides,
  };
}

function cleanupFiles() {
  const policyPath = projectPolicyPath(TEST_PROJECT);
  const exposurePath = sessionExposurePath(TEST_SESSION);
  try { unlinkSync(policyPath); } catch {}
  try { unlinkSync(exposurePath); } catch {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("routing-policy-ledger", () => {
  beforeEach(cleanupFiles);
  afterEach(cleanupFiles);

  describe("projectPolicyPath", () => {
    test("uses sha256 of projectRoot in tmpdir", () => {
      const path = projectPolicyPath(TEST_PROJECT);
      const hash = createHash("sha256").update(TEST_PROJECT).digest("hex");
      expect(path).toBe(`${tmpdir()}/vercel-plugin-routing-policy-${hash}.json`);
    });

    test("different projects produce different paths", () => {
      const p1 = projectPolicyPath("/project-a");
      const p2 = projectPolicyPath("/project-b");
      expect(p1).not.toBe(p2);
    });
  });

  describe("sessionExposurePath", () => {
    test("uses sessionId in tmpdir for safe IDs", () => {
      const path = sessionExposurePath(TEST_SESSION);
      expect(path).toBe(`${tmpdir()}/vercel-plugin-${TEST_SESSION}-routing-exposures.jsonl`);
    });

    test("hashes unsafe session IDs containing / or :", () => {
      const unsafeId = "abc/def:ghi";
      const path = sessionExposurePath(unsafeId);
      const hash = createHash("sha256").update(unsafeId).digest("hex");
      expect(path).toBe(`${tmpdir()}/vercel-plugin-${hash}-routing-exposures.jsonl`);
      expect(path).not.toContain("abc/def:ghi");
      // The only slashes should be from the tmpdir prefix
      const segment = path.replace(`${tmpdir()}/`, "");
      expect(segment).not.toContain("/");
      expect(segment).not.toContain(":");
    });
  });

  describe("loadProjectRoutingPolicy / saveProjectRoutingPolicy", () => {
    test("returns empty policy when no file exists", () => {
      const policy = loadProjectRoutingPolicy(TEST_PROJECT);
      expect(policy.version).toBe(1);
      expect(policy.scenarios).toEqual({});
    });

    test("round-trips a policy through save/load", () => {
      const policy = createEmptyRoutingPolicy();
      policy.scenarios["PreToolUse|flow-verification|uiRender|Bash"] = {
        "agent-browser-verify": {
          exposures: 5,
          wins: 4,
          directiveWins: 3,
          staleMisses: 1,
          lastUpdatedAt: T0,
        },
      };

      saveProjectRoutingPolicy(TEST_PROJECT, policy);
      const loaded = loadProjectRoutingPolicy(TEST_PROJECT);

      expect(loaded.version).toBe(1);
      expect(loaded.scenarios["PreToolUse|flow-verification|uiRender|Bash"]["agent-browser-verify"]).toEqual({
        exposures: 5,
        wins: 4,
        directiveWins: 3,
        staleMisses: 1,
        lastUpdatedAt: T0,
      });
    });

    test("returns empty policy for corrupt file", () => {
      const path = projectPolicyPath(TEST_PROJECT);
      writeFileSync(path, "not-json");
      const policy = loadProjectRoutingPolicy(TEST_PROJECT);
      expect(policy.version).toBe(1);
      expect(policy.scenarios).toEqual({});
    });
  });

  describe("appendSkillExposure / loadSessionExposures", () => {
    test("appends and loads exposures from JSONL", () => {
      const e1 = makeExposure({ id: "e1", createdAt: T0 });
      const e2 = makeExposure({ id: "e2", skill: "vercel-deploy", createdAt: T1 });

      appendSkillExposure(e1);
      appendSkillExposure(e2);

      const loaded = loadSessionExposures(TEST_SESSION);
      expect(loaded).toHaveLength(2);
      expect(loaded[0].id).toBe("e1");
      expect(loaded[1].id).toBe("e2");
      expect(loaded[1].skill).toBe("vercel-deploy");

      const policy = loadProjectRoutingPolicy(TEST_PROJECT);
      const scenario = policy.scenarios["PreToolUse|flow-verification|uiRender|Bash"];
      expect(scenario?.["agent-browser-verify"]?.exposures).toBe(1);
      expect(scenario?.["vercel-deploy"]?.exposures).toBe(1);
    });

    test("returns empty array for nonexistent session", () => {
      const loaded = loadSessionExposures("no-such-session");
      expect(loaded).toEqual([]);
    });
  });

  describe("resolveBoundaryOutcome", () => {
    test("resolves pending exposures matching boundary as win", () => {
      appendSkillExposure(makeExposure({ id: "e1", createdAt: T0 }));
      appendSkillExposure(makeExposure({ id: "e2", createdAt: T1 }));

      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        now: T2,
      });

      expect(resolved).toHaveLength(2);
      expect(resolved[0].outcome).toBe("win");
      expect(resolved[0].resolvedAt).toBe(T2);
      expect(resolved[1].outcome).toBe("win");

      // Verify ledger is updated
      const reloaded = loadSessionExposures(TEST_SESSION);
      expect(reloaded.every((e) => e.outcome === "win")).toBe(true);
    });

    test("resolves as directive-win when matchedSuggestedAction is true", () => {
      appendSkillExposure(makeExposure({ id: "e1", createdAt: T0 }));

      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: true,
        now: T2,
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0].outcome).toBe("directive-win");
    });

    test("does not resolve exposures with different boundary", () => {
      appendSkillExposure(makeExposure({
        id: "e1",
        targetBoundary: "clientRequest",
        createdAt: T0,
      }));

      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        now: T2,
      });

      expect(resolved).toHaveLength(0);

      const reloaded = loadSessionExposures(TEST_SESSION);
      expect(reloaded[0].outcome).toBe("pending");
    });

    test("does not re-resolve already resolved exposures", () => {
      appendSkillExposure(makeExposure({
        id: "e1",
        outcome: "win",
        resolvedAt: T1,
        createdAt: T0,
      }));

      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        now: T2,
      });

      expect(resolved).toHaveLength(0);
    });

    test("updates project policy with resolved outcomes", () => {
      appendSkillExposure(makeExposure({ id: "e1", createdAt: T0 }));

      resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: true,
        now: T2,
      });

      const policy = loadProjectRoutingPolicy(TEST_PROJECT);
      const stats = policy.scenarios["PreToolUse|flow-verification|uiRender|Bash"]?.["agent-browser-verify"];
      expect(stats).toBeDefined();
      expect(stats!.exposures).toBe(1);
      expect(stats!.wins).toBe(1);
      expect(stats!.directiveWins).toBe(1);
    });

    test("returns empty array when no pending exposures exist", () => {
      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        now: T2,
      });

      expect(resolved).toEqual([]);
    });
  });

  describe("finalizeStaleExposures", () => {
    test("converts remaining pending exposures to stale-miss", () => {
      appendSkillExposure(makeExposure({ id: "e1", createdAt: T0 }));
      appendSkillExposure(makeExposure({
        id: "e2",
        targetBoundary: "clientRequest",
        createdAt: T1,
      }));

      const stale = finalizeStaleExposures(TEST_SESSION, T3);

      expect(stale).toHaveLength(2);
      expect(stale[0].outcome).toBe("stale-miss");
      expect(stale[0].resolvedAt).toBe(T3);
      expect(stale[1].outcome).toBe("stale-miss");

      // Verify ledger
      const reloaded = loadSessionExposures(TEST_SESSION);
      expect(reloaded.every((e) => e.outcome === "stale-miss")).toBe(true);
    });

    test("does not finalize already resolved exposures", () => {
      appendSkillExposure(makeExposure({
        id: "e1",
        outcome: "win",
        resolvedAt: T1,
        createdAt: T0,
      }));
      appendSkillExposure(makeExposure({
        id: "e2",
        createdAt: T1,
      }));

      const stale = finalizeStaleExposures(TEST_SESSION, T3);

      expect(stale).toHaveLength(1);
      expect(stale[0].id).toBe("e2");

      const reloaded = loadSessionExposures(TEST_SESSION);
      expect(reloaded[0].outcome).toBe("win");
      expect(reloaded[1].outcome).toBe("stale-miss");
    });

    test("updates project policy with stale-miss outcomes", () => {
      appendSkillExposure(makeExposure({ id: "e1", createdAt: T0 }));

      finalizeStaleExposures(TEST_SESSION, T3);

      const policy = loadProjectRoutingPolicy(TEST_PROJECT);
      const stats = policy.scenarios["PreToolUse|flow-verification|uiRender|Bash"]?.["agent-browser-verify"];
      expect(stats).toBeDefined();
      expect(stats!.exposures).toBe(1);
      expect(stats!.staleMisses).toBe(1);
      expect(stats!.wins).toBe(0);
    });

    test("returns empty array when no pending exposures exist", () => {
      const stale = finalizeStaleExposures(TEST_SESSION, T3);
      expect(stale).toEqual([]);
    });
  });

  describe("story/route-scoped resolution", () => {
    test("resolves only exposures matching the observed storyId", () => {
      appendSkillExposure(makeExposure({
        id: "story1-e1",
        storyId: "story-1",
        route: "/settings",
        createdAt: T0,
      }));
      appendSkillExposure(makeExposure({
        id: "story2-e1",
        storyId: "story-2",
        route: "/dashboard",
        createdAt: T1,
      }));

      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        now: T2,
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe("story1-e1");
      expect(resolved[0].outcome).toBe("win");

      // story-2 exposure remains pending
      const all = loadSessionExposures(TEST_SESSION);
      const story2 = all.find((e) => e.id === "story2-e1");
      expect(story2!.outcome).toBe("pending");
    });

    test("resolves only exposures matching the observed route", () => {
      appendSkillExposure(makeExposure({
        id: "settings-e1",
        storyId: "story-1",
        route: "/settings",
        createdAt: T0,
      }));
      appendSkillExposure(makeExposure({
        id: "dashboard-e1",
        storyId: "story-1",
        route: "/dashboard",
        createdAt: T1,
      }));

      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        route: "/settings",
        now: T2,
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe("settings-e1");

      const all = loadSessionExposures(TEST_SESSION);
      expect(all.find((e) => e.id === "dashboard-e1")!.outcome).toBe("pending");
    });

    test("resolves only exposures matching both storyId and route", () => {
      appendSkillExposure(makeExposure({
        id: "match-e1",
        storyId: "story-1",
        route: "/settings",
        createdAt: T0,
      }));
      appendSkillExposure(makeExposure({
        id: "wrong-story",
        storyId: "story-2",
        route: "/settings",
        createdAt: T1,
      }));
      appendSkillExposure(makeExposure({
        id: "wrong-route",
        storyId: "story-1",
        route: "/dashboard",
        createdAt: T2,
      }));

      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        storyId: "story-1",
        route: "/settings",
        now: T3,
      });

      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe("match-e1");

      const all = loadSessionExposures(TEST_SESSION);
      expect(all.find((e) => e.id === "wrong-story")!.outcome).toBe("pending");
      expect(all.find((e) => e.id === "wrong-route")!.outcome).toBe("pending");
    });

    test("null storyId/route resolves all matching boundary exposures (backward compat)", () => {
      appendSkillExposure(makeExposure({
        id: "any-story-e1",
        storyId: "story-1",
        route: "/settings",
        createdAt: T0,
      }));
      appendSkillExposure(makeExposure({
        id: "any-story-e2",
        storyId: "story-2",
        route: "/dashboard",
        createdAt: T1,
      }));

      const resolved = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        now: T2,
      });

      // Without storyId/route filter, both resolve
      expect(resolved).toHaveLength(2);
    });
  });

  describe("unsafe session ID round-trip", () => {
    const UNSAFE_SESSION = "abc/def:ghi";

    afterEach(() => {
      try { unlinkSync(sessionExposurePath(UNSAFE_SESSION)); } catch {}
      try { unlinkSync(projectPolicyPath(TEST_PROJECT)); } catch {}
    });

    test("append, load, resolve, and finalize all work with unsafe session IDs", () => {
      const e1 = makeExposure({
        id: "unsafe-e1",
        sessionId: UNSAFE_SESSION,
        targetBoundary: "clientRequest",
        createdAt: T0,
      });
      const e2 = makeExposure({
        id: "unsafe-e2",
        sessionId: UNSAFE_SESSION,
        targetBoundary: "uiRender",
        createdAt: T1,
      });

      // Append should not throw
      appendSkillExposure(e1);
      appendSkillExposure(e2);

      // Load should return both
      const loaded = loadSessionExposures(UNSAFE_SESSION);
      expect(loaded).toHaveLength(2);

      // Resolve clientRequest
      const resolved = resolveBoundaryOutcome({
        sessionId: UNSAFE_SESSION,
        boundary: "clientRequest",
        matchedSuggestedAction: false,
        now: T2,
      });
      expect(resolved).toHaveLength(1);
      expect(resolved[0].id).toBe("unsafe-e1");

      // Finalize remaining
      const stale = finalizeStaleExposures(UNSAFE_SESSION, T3);
      expect(stale).toHaveLength(1);
      expect(stale[0].id).toBe("unsafe-e2");
      expect(stale[0].outcome).toBe("stale-miss");

      // Verify the file path doesn't contain unsafe characters
      const path = sessionExposurePath(UNSAFE_SESSION);
      const segment = path.replace(`${tmpdir()}/`, "");
      expect(segment).not.toContain("/");
      expect(segment).not.toContain(":");
    });
  });

  describe("idempotency", () => {
    test("resolveBoundaryOutcome is safe to call twice", () => {
      appendSkillExposure(makeExposure({ id: "e1", createdAt: T0 }));

      resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        now: T2,
      });

      // Second call should find no pending exposures
      const second = resolveBoundaryOutcome({
        sessionId: TEST_SESSION,
        boundary: "uiRender",
        matchedSuggestedAction: false,
        now: T3,
      });

      expect(second).toHaveLength(0);

      // Policy should still have exactly 1 win
      const policy = loadProjectRoutingPolicy(TEST_PROJECT);
      const stats = policy.scenarios["PreToolUse|flow-verification|uiRender|Bash"]?.["agent-browser-verify"];
      expect(stats!.wins).toBe(1);
    });

    test("finalizeStaleExposures is safe to call twice", () => {
      appendSkillExposure(makeExposure({ id: "e1", createdAt: T0 }));

      finalizeStaleExposures(TEST_SESSION, T2);
      const second = finalizeStaleExposures(TEST_SESSION, T3);

      expect(second).toHaveLength(0);
    });
  });
});
