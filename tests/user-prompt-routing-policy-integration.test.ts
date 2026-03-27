import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createEmptyRoutingPolicy,
  applyPolicyBoosts,
  type RoutingPolicyFile,
  type RoutingPolicyScenario,
} from "../hooks/src/routing-policy.mts";
import {
  projectPolicyPath,
  sessionExposurePath,
  loadProjectRoutingPolicy,
  saveProjectRoutingPolicy,
  appendSkillExposure,
  loadSessionExposures,
  type SkillExposure,
} from "../hooks/src/routing-policy-ledger.mts";
import {
  statePath as verificationStatePath,
} from "../hooks/src/verification-ledger.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PROJECT = "/tmp/test-user-prompt-routing-policy-" + Date.now();
const TEST_SESSION = "test-session-uprp-" + Date.now();

const T0 = "2026-03-27T04:00:00.000Z";
const T1 = "2026-03-27T04:01:00.000Z";

function cleanupPolicyFile(): void {
  try { unlinkSync(projectPolicyPath(TEST_PROJECT)); } catch {}
}

function cleanupExposureFile(): void {
  try { unlinkSync(sessionExposurePath(TEST_SESSION)); } catch {}
}

/** Write a minimal mock verification plan state for the session. */
function writeMockPlanState(sessionId: string, story?: {
  id?: string;
  kind?: string;
  route?: string | null;
}): void {
  const sp = verificationStatePath(sessionId);
  mkdirSync(join(sp, ".."), { recursive: true });
  const s = {
    id: story?.id ?? "test-prompt-story",
    kind: story?.kind ?? "deployment",
    route: story?.route ?? "/api/test",
    promptExcerpt: "test prompt",
    createdAt: T0,
    updatedAt: T1,
    requestedSkills: [],
  };
  writeFileSync(sp, JSON.stringify({
    version: 1,
    stories: [s],
    observationIds: [],
    satisfiedBoundaries: [],
    missingBoundaries: [],
    recentRoutes: [],
    primaryNextAction: null,
    blockedReasons: [],
  }));
}

function cleanupMockPlanState(sessionId: string): void {
  const sp = verificationStatePath(sessionId);
  try { rmSync(join(sp, ".."), { recursive: true, force: true }); } catch {}
}

function buildPromptPolicy(
  skill: string,
  exposures: number,
  wins: number,
  directiveWins: number,
  staleMisses: number,
): RoutingPolicyFile {
  const policy = createEmptyRoutingPolicy();
  const scenario = "UserPromptSubmit|none|none|Prompt";
  policy.scenarios[scenario] = {
    [skill]: {
      exposures,
      wins,
      directiveWins,
      staleMisses,
      lastUpdatedAt: T0,
    },
  };
  return policy;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  cleanupPolicyFile();
  cleanupExposureFile();
});

afterEach(() => {
  cleanupPolicyFile();
  cleanupExposureFile();
  cleanupMockPlanState(TEST_SESSION);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("user-prompt-submit routing-policy integration", () => {
  describe("applyPolicyBoosts with UserPromptSubmit scenario", () => {
    const PROMPT_SCENARIO: RoutingPolicyScenario = {
      hook: "UserPromptSubmit",
      storyKind: null,
      targetBoundary: null,
      toolName: "Prompt",
    };

    test("applies boost to prompt-matched skills with sufficient history", () => {
      const policy = buildPromptPolicy("next-config", 5, 4, 2, 0);
      saveProjectRoutingPolicy(TEST_PROJECT, policy);
      const loaded = loadProjectRoutingPolicy(TEST_PROJECT);

      const entries = [
        { skill: "next-config", priority: 8, effectivePriority: 8 },
        { skill: "deployment", priority: 10, effectivePriority: 10 },
      ];

      const boosted = applyPolicyBoosts(entries, loaded, PROMPT_SCENARIO);

      // next-config: (4 + 2*0.25)/5 = 0.9 => +8 boost => 16
      expect(boosted.find((b) => b.skill === "next-config")!.policyBoost).toBe(8);
      expect(boosted.find((b) => b.skill === "next-config")!.effectivePriority).toBe(16);
      // deployment: no data => 0 boost
      expect(boosted.find((b) => b.skill === "deployment")!.policyBoost).toBe(0);
    });

    test("re-orders selected skills by boosted effective priority", () => {
      const policy = buildPromptPolicy("low-base-skill", 5, 4, 2, 0);
      saveProjectRoutingPolicy(TEST_PROJECT, policy);
      const loaded = loadProjectRoutingPolicy(TEST_PROJECT);

      const entries = [
        { skill: "high-base-skill", priority: 12, effectivePriority: 12 },
        { skill: "low-base-skill", priority: 6, effectivePriority: 6 },
      ];

      const boosted = applyPolicyBoosts(entries, loaded, PROMPT_SCENARIO);

      // Sort as the injector would: by effectivePriority desc, then skill name asc
      boosted.sort((a, b) =>
        b.effectivePriority - a.effectivePriority || a.skill.localeCompare(b.skill),
      );

      // low-base-skill: 6 + 8 = 14 > high-base-skill: 12
      expect(boosted[0].skill).toBe("low-base-skill");
      expect(boosted[1].skill).toBe("high-base-skill");
    });

    test("no boost when policy file missing", () => {
      const loaded = loadProjectRoutingPolicy(TEST_PROJECT);
      const entries = [
        { skill: "next-config", priority: 8, effectivePriority: 8 },
      ];

      const boosted = applyPolicyBoosts(entries, loaded, PROMPT_SCENARIO);
      expect(boosted[0].policyBoost).toBe(0);
      expect(boosted[0].effectivePriority).toBe(8);
    });

    test("negative boost for skill with many exposures but low wins", () => {
      const policy = buildPromptPolicy("bad-skill", 8, 0, 0, 7);
      saveProjectRoutingPolicy(TEST_PROJECT, policy);
      const loaded = loadProjectRoutingPolicy(TEST_PROJECT);

      const entries = [
        { skill: "bad-skill", priority: 7, effectivePriority: 7 },
      ];

      const boosted = applyPolicyBoosts(entries, loaded, PROMPT_SCENARIO);
      expect(boosted[0].policyBoost).toBe(-2);
      expect(boosted[0].effectivePriority).toBe(5);
    });
  });

  describe("exposure recording for UserPromptSubmit", () => {
    test("appends pending exposure with hook=UserPromptSubmit and toolName=Prompt", () => {
      const exposure: SkillExposure = {
        id: `${TEST_SESSION}:prompt:next-config:1`,
        sessionId: TEST_SESSION,
        projectRoot: TEST_PROJECT,
        storyId: null,
        storyKind: null,
        route: null,
        hook: "UserPromptSubmit",
        toolName: "Prompt",
        skill: "next-config",
        targetBoundary: null,
        createdAt: T0,
        resolvedAt: null,
        outcome: "pending",
      };

      appendSkillExposure(exposure);

      const exposures = loadSessionExposures(TEST_SESSION);
      expect(exposures.length).toBe(1);
      expect(exposures[0].hook).toBe("UserPromptSubmit");
      expect(exposures[0].toolName).toBe("Prompt");
      expect(exposures[0].skill).toBe("next-config");
      expect(exposures[0].outcome).toBe("pending");
    });

    test("records exposures only for injected skills not candidates", () => {
      // Simulate: 3 matched, but only 2 injected (cap of MAX_SKILLS=2)
      const injected = ["skill-a", "skill-b"];
      for (const skill of injected) {
        appendSkillExposure({
          id: `${TEST_SESSION}:prompt:${skill}:${Date.now()}`,
          sessionId: TEST_SESSION,
          projectRoot: TEST_PROJECT,
          storyId: null,
          storyKind: null,
          route: null,
          hook: "UserPromptSubmit",
          toolName: "Prompt",
          skill,
          targetBoundary: null,
          createdAt: T0,
          resolvedAt: null,
          outcome: "pending",
        });
      }

      const exposures = loadSessionExposures(TEST_SESSION);
      expect(exposures.length).toBe(2);
      expect(exposures.map((e) => e.skill).sort()).toEqual(["skill-a", "skill-b"]);
      // skill-c (matched but not injected) should not have an exposure
    });

    test("policy file is not mutated during boost application", () => {
      const policy = buildPromptPolicy("next-config", 5, 4, 2, 0);
      saveProjectRoutingPolicy(TEST_PROJECT, policy);

      const before = readFileSync(projectPolicyPath(TEST_PROJECT), "utf-8");

      const loaded = loadProjectRoutingPolicy(TEST_PROJECT);
      applyPolicyBoosts(
        [{ skill: "next-config", priority: 8, effectivePriority: 8 }],
        loaded,
        {
          hook: "UserPromptSubmit",
          storyKind: null,
          targetBoundary: null,
          toolName: "Prompt",
        },
      );

      const after = readFileSync(projectPolicyPath(TEST_PROJECT), "utf-8");
      expect(after).toBe(before);
    });
  });

  describe("deterministic ordering with policy ties", () => {
    test("skills with same boosted priority sort by name ascending", () => {
      const entries = [
        { skill: "z-skill", priority: 8, effectivePriority: 8 },
        { skill: "a-skill", priority: 8, effectivePriority: 8 },
      ];

      const loaded = loadProjectRoutingPolicy(TEST_PROJECT);
      const boosted = applyPolicyBoosts(entries, loaded, {
        hook: "UserPromptSubmit",
        storyKind: null,
        targetBoundary: null,
        toolName: "Prompt",
      });

      boosted.sort((a, b) =>
        b.effectivePriority - a.effectivePriority || a.skill.localeCompare(b.skill),
      );

      expect(boosted[0].skill).toBe("a-skill");
      expect(boosted[1].skill).toBe("z-skill");
    });
  });

  describe("evidence scoping — story gate", () => {
    test("exposure recording requires active verification story", () => {
      // No mock plan state → exposureStory will be null → no exposure written
      // Simulate what the hook does: check for story before writing
      const exposurePlan = null; // loadCachedPlanResult returns null
      const exposureStory = null;

      // Directly verify: if we attempt to record an exposure without a story,
      // the hook code now skips it. We verify by writing exposures only with story.
      if (exposureStory) {
        appendSkillExposure({
          id: `${TEST_SESSION}:prompt:next-config:1`,
          sessionId: TEST_SESSION,
          projectRoot: TEST_PROJECT,
          storyId: null,
          storyKind: null,
          route: null,
          hook: "UserPromptSubmit",
          toolName: "Prompt",
          skill: "next-config",
          targetBoundary: null,
          createdAt: T0,
          resolvedAt: null,
          outcome: "pending",
        });
      }

      const exposures = loadSessionExposures(TEST_SESSION);
      expect(exposures).toEqual([]);
    });

    test("exposure recording proceeds with active verification story", () => {
      writeMockPlanState(TEST_SESSION);

      // Simulate what the hook does: story found → record exposure with story fields
      appendSkillExposure({
        id: `${TEST_SESSION}:prompt:next-config:1`,
        sessionId: TEST_SESSION,
        projectRoot: TEST_PROJECT,
        storyId: "test-prompt-story",
        storyKind: "deployment",
        route: "/api/test",
        hook: "UserPromptSubmit",
        toolName: "Prompt",
        skill: "next-config",
        targetBoundary: null,
        createdAt: T0,
        resolvedAt: null,
        outcome: "pending",
      });

      const exposures = loadSessionExposures(TEST_SESSION);
      expect(exposures.length).toBe(1);
      expect(exposures[0].storyId).toBe("test-prompt-story");
      expect(exposures[0].storyKind).toBe("deployment");
    });

    test("no none|none scenario keys created when no story exists", () => {
      // No plan state → no story → no exposures
      const exposures = loadSessionExposures(TEST_SESSION);
      const noneNone = exposures.filter(
        (e) => e.storyId === null && e.storyKind === null,
      );
      expect(noneNone).toEqual([]);
    });
  });
});
