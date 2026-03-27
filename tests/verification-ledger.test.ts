import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type VerificationBoundary,
  type VerificationObservation,
  type VerificationStory,
  type VerificationStoryKind,
  type VerificationPlan,
  appendObservation,
  derivePlan,
  serializePlanState,
  upsertStory,
  storyId,
  persistObservation,
  persistStories,
  persistPlanState,
  loadObservations,
  loadStories,
  loadPlanState,
  recordObservation,
  recordStory,
  ledgerPath,
  storiesPath,
  statePath,
} from "../hooks/src/verification-ledger.mts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const T0 = "2026-03-26T12:00:00.000Z";
const T1 = "2026-03-26T12:01:00.000Z";
const T2 = "2026-03-26T12:02:00.000Z";
const T3 = "2026-03-26T12:03:00.000Z";

function makeObs(
  id: string,
  boundary: VerificationBoundary | null,
  opts?: Partial<VerificationObservation>,
): VerificationObservation {
  return {
    id,
    timestamp: T0,
    source: "bash",
    boundary,
    route: null,
    summary: `obs-${id}`,
    ...opts,
  };
}

function makeStory(
  kind: VerificationStoryKind,
  route: string | null = null,
): VerificationStory {
  return {
    id: storyId(kind, route),
    kind,
    route,
    promptExcerpt: "test prompt",
    createdAt: T0,
    updatedAt: T0,
    requestedSkills: [],
  };
}

// Use a unique session id per test to avoid collisions
let testSessionId: string;

beforeEach(() => {
  testSessionId = `test-ledger-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
});

afterEach(() => {
  // Clean up temp files
  try {
    const dir = join(tmpdir(), `vercel-plugin-${testSessionId}-ledger`);
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

describe("verification-ledger types", () => {
  test("VerificationBoundary covers all four boundary types", () => {
    const boundaries: VerificationBoundary[] = [
      "uiRender",
      "clientRequest",
      "serverHandler",
      "environment",
    ];
    expect(boundaries).toHaveLength(4);
  });

  test("VerificationStoryKind covers all three kinds", () => {
    const kinds: VerificationStoryKind[] = [
      "flow-verification",
      "stuck-investigation",
      "browser-only",
    ];
    expect(kinds).toHaveLength(3);
  });

  test("VerificationObservation has required fields", () => {
    const obs = makeObs("obs-1", "clientRequest");
    expect(obs.id).toBe("obs-1");
    expect(obs.boundary).toBe("clientRequest");
    expect(obs.source).toBe("bash");
    expect(obs.timestamp).toBe(T0);
  });

  test("VerificationStory has required fields", () => {
    const story = makeStory("flow-verification", "/settings");
    expect(story.kind).toBe("flow-verification");
    expect(story.route).toBe("/settings");
    expect(story.id).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Append dedup
// ---------------------------------------------------------------------------

describe("appendObservation", () => {
  test("appends a new observation", () => {
    const obs = makeObs("a", "clientRequest");
    const result = appendObservation([], obs);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  test("duplicate id is a no-op", () => {
    const obs = makeObs("a", "clientRequest");
    const list = [obs];
    const result = appendObservation(list, obs);
    expect(result).toBe(list); // same reference — no change
  });

  test("different ids are both appended", () => {
    const a = makeObs("a", "clientRequest");
    const b = makeObs("b", "serverHandler");
    let list = appendObservation([], a);
    list = appendObservation(list, b);
    expect(list).toHaveLength(2);
  });

  test("does not mutate the input array", () => {
    const original = [makeObs("a", "clientRequest")];
    const copy = [...original];
    appendObservation(original, makeObs("b", "serverHandler"));
    expect(original).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// Story upsert
// ---------------------------------------------------------------------------

describe("upsertStory", () => {
  test("creates a new story when none exists", () => {
    const result = upsertStory([], "flow-verification", "/settings", "test", ["verification"], T0);
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("flow-verification");
    expect(result[0].route).toBe("/settings");
  });

  test("merges into existing story with same kind+route", () => {
    const initial = upsertStory([], "flow-verification", "/settings", "first prompt", ["skill-a"], T0);
    const result = upsertStory(initial, "flow-verification", "/settings", "second prompt", ["skill-b"], T1);
    expect(result).toHaveLength(1);
    expect(result[0].requestedSkills).toEqual(["skill-a", "skill-b"]);
    expect(result[0].updatedAt).toBe(T1);
    expect(result[0].promptExcerpt).toBe("second prompt");
  });

  test("different kind creates a separate story", () => {
    let stories = upsertStory([], "flow-verification", "/settings", "a", [], T0);
    stories = upsertStory(stories, "stuck-investigation", "/settings", "b", [], T0);
    expect(stories).toHaveLength(2);
  });

  test("different route creates a separate story", () => {
    let stories = upsertStory([], "flow-verification", "/settings", "a", [], T0);
    stories = upsertStory(stories, "flow-verification", "/dashboard", "b", [], T0);
    expect(stories).toHaveLength(2);
  });

  test("does not mutate the input array", () => {
    const original = upsertStory([], "flow-verification", "/", "x", [], T0);
    const copy = [...original];
    upsertStory(original, "flow-verification", "/", "y", [], T1);
    expect(original).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// storyId determinism
// ---------------------------------------------------------------------------

describe("storyId", () => {
  test("same kind+route produces same id", () => {
    expect(storyId("flow-verification", "/settings")).toBe(
      storyId("flow-verification", "/settings"),
    );
  });

  test("different kind produces different id", () => {
    expect(storyId("flow-verification", "/settings")).not.toBe(
      storyId("stuck-investigation", "/settings"),
    );
  });

  test("null route uses wildcard", () => {
    expect(storyId("flow-verification", null)).toBe(
      storyId("flow-verification", null),
    );
  });
});

// ---------------------------------------------------------------------------
// derivePlan
// ---------------------------------------------------------------------------

describe("derivePlan", () => {
  test("empty inputs produce empty plan", () => {
    const plan = derivePlan([], []);
    expect(plan.observations).toHaveLength(0);
    expect(plan.stories).toHaveLength(0);
    expect(plan.missingBoundaries).toHaveLength(0);
    expect(plan.primaryNextAction).toBeNull();
  });

  test("deduplicates observations by id", () => {
    const obs = makeObs("a", "clientRequest");
    const plan = derivePlan([obs, obs, obs], [makeStory("flow-verification")]);
    expect(plan.observations).toHaveLength(1);
    expect(plan.observationIds.size).toBe(1);
  });

  test("tracks satisfied boundaries", () => {
    const obs = [
      makeObs("a", "clientRequest"),
      makeObs("b", "serverHandler"),
    ];
    const plan = derivePlan(obs, [makeStory("flow-verification")]);
    expect(plan.satisfiedBoundaries.has("clientRequest")).toBe(true);
    expect(plan.satisfiedBoundaries.has("serverHandler")).toBe(true);
    expect(plan.satisfiedBoundaries.has("uiRender")).toBe(false);
  });

  test("computes missing boundaries when story exists", () => {
    const obs = [makeObs("a", "clientRequest")];
    const plan = derivePlan(obs, [makeStory("flow-verification")]);
    expect(plan.missingBoundaries).toContain("serverHandler");
    expect(plan.missingBoundaries).toContain("uiRender");
    expect(plan.missingBoundaries).toContain("environment");
    expect(plan.missingBoundaries).not.toContain("clientRequest");
  });

  test("no missing boundaries without a story", () => {
    const obs = [makeObs("a", "clientRequest")];
    const plan = derivePlan(obs, []);
    expect(plan.missingBoundaries).toHaveLength(0);
  });

  test("all boundaries satisfied yields no next action", () => {
    const obs = [
      makeObs("a", "clientRequest"),
      makeObs("b", "serverHandler"),
      makeObs("c", "uiRender"),
      makeObs("d", "environment"),
    ];
    const plan = derivePlan(obs, [makeStory("flow-verification")]);
    expect(plan.missingBoundaries).toHaveLength(0);
    expect(plan.primaryNextAction).toBeNull();
  });

  test("emits next action for first missing boundary", () => {
    const plan = derivePlan([], [makeStory("flow-verification")]);
    expect(plan.primaryNextAction).not.toBeNull();
    expect(plan.primaryNextAction!.targetBoundary).toBe("clientRequest");
  });

  test("collects recent routes from observations", () => {
    const obs = [
      makeObs("a", "clientRequest", { route: "/settings" }),
      makeObs("b", "serverHandler", { route: "/dashboard" }),
    ];
    const plan = derivePlan(obs, [makeStory("flow-verification")]);
    expect(plan.recentRoutes).toContain("/settings");
    expect(plan.recentRoutes).toContain("/dashboard");
  });

  test("suppresses uiRender action when agent-browser unavailable", () => {
    const obs = [
      makeObs("a", "clientRequest"),
      makeObs("b", "serverHandler"),
      makeObs("c", "environment"),
    ];
    const plan = derivePlan(obs, [makeStory("flow-verification")], {
      agentBrowserAvailable: false,
    });
    expect(plan.primaryNextAction).toBeNull();
    expect(plan.blockedReasons.length).toBeGreaterThan(0);
    expect(plan.blockedReasons[0]).toContain("agent-browser unavailable");
  });

  test("suppresses uiRender action when dev-server loop guard hit", () => {
    const obs = [
      makeObs("a", "clientRequest"),
      makeObs("b", "serverHandler"),
      makeObs("c", "environment"),
    ];
    const plan = derivePlan(obs, [makeStory("flow-verification")], {
      devServerLoopGuardHit: true,
    });
    expect(plan.primaryNextAction).toBeNull();
    expect(plan.blockedReasons.some((r) => r.includes("loop guard"))).toBe(true);
  });

  test("suppresses repeat of last attempted action", () => {
    const plan = derivePlan([], [makeStory("flow-verification")], {
      lastAttemptedAction: "curl http://localhost:3000/",
    });
    // clientRequest was the top priority, but it matches lastAttemptedAction
    // so it should move to the next boundary
    expect(
      plan.primaryNextAction === null ||
      plan.primaryNextAction.targetBoundary !== "clientRequest",
    ).toBe(true);
    expect(plan.blockedReasons.some((r) => r.includes("Suppressed repeat"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deterministic serialization
// ---------------------------------------------------------------------------

describe("serializePlanState", () => {
  test("same plan produces identical JSON", () => {
    const obs = [
      makeObs("b", "serverHandler", { route: "/dashboard" }),
      makeObs("a", "clientRequest", { route: "/settings" }),
    ];
    const stories = [makeStory("flow-verification", "/settings")];

    const plan1 = derivePlan(obs, stories);
    const plan2 = derivePlan(obs, stories);

    const json1 = serializePlanState(plan1);
    const json2 = serializePlanState(plan2);
    expect(json1).toBe(json2);
  });

  test("serialized state is valid JSON with version field", () => {
    const plan = derivePlan([], []);
    const json = serializePlanState(plan);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.observationIds)).toBe(true);
    expect(Array.isArray(parsed.satisfiedBoundaries)).toBe(true);
  });

  test("observation ids are sorted in serialized output", () => {
    const obs = [
      makeObs("z", "clientRequest"),
      makeObs("a", "serverHandler"),
      makeObs("m", "environment"),
    ];
    const plan = derivePlan(obs, [makeStory("flow-verification")]);
    const parsed = JSON.parse(serializePlanState(plan));
    expect(parsed.observationIds).toEqual(["a", "m", "z"]);
  });
});

// ---------------------------------------------------------------------------
// Replay determinism
// ---------------------------------------------------------------------------

describe("replay determinism", () => {
  test("replaying same ordered trace produces byte-for-byte equivalent state", () => {
    const trace: VerificationObservation[] = [
      makeObs("obs-1", "clientRequest", { route: "/settings", timestamp: T0 }),
      makeObs("obs-2", "serverHandler", { route: "/settings", timestamp: T1 }),
      makeObs("obs-3", "environment", { timestamp: T2 }),
    ];
    const stories = [makeStory("flow-verification", "/settings")];

    // Replay 1
    const plan1 = derivePlan(trace, stories);
    const state1 = serializePlanState(plan1);

    // Replay 2 (same trace)
    const plan2 = derivePlan(trace, stories);
    const state2 = serializePlanState(plan2);

    expect(state1).toBe(state2);
  });

  test("replaying trace with duplicates produces same state as without", () => {
    const obs1 = makeObs("obs-1", "clientRequest", { timestamp: T0 });
    const obs2 = makeObs("obs-2", "serverHandler", { timestamp: T1 });
    const stories = [makeStory("flow-verification")];

    const planClean = derivePlan([obs1, obs2], stories);
    const planDuped = derivePlan([obs1, obs2, obs1, obs2, obs1], stories);

    expect(serializePlanState(planClean)).toBe(serializePlanState(planDuped));
  });
});

// ---------------------------------------------------------------------------
// JSONL persistence
// ---------------------------------------------------------------------------

describe("JSONL persistence", () => {
  test("persistObservation writes JSONL line", () => {
    const obs = makeObs("persist-1", "clientRequest");
    persistObservation(testSessionId, obs);

    const content = readFileSync(ledgerPath(testSessionId), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).id).toBe("persist-1");
  });

  test("multiple observations append as separate lines", () => {
    persistObservation(testSessionId, makeObs("p-1", "clientRequest"));
    persistObservation(testSessionId, makeObs("p-2", "serverHandler"));
    persistObservation(testSessionId, makeObs("p-3", "environment"));

    const content = readFileSync(ledgerPath(testSessionId), "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  test("loadObservations reads back persisted observations", () => {
    persistObservation(testSessionId, makeObs("load-1", "clientRequest"));
    persistObservation(testSessionId, makeObs("load-2", "serverHandler"));

    const loaded = loadObservations(testSessionId);
    expect(loaded).toHaveLength(2);
    expect(loaded[0].id).toBe("load-1");
    expect(loaded[1].id).toBe("load-2");
  });

  test("loadObservations returns empty for nonexistent session", () => {
    const loaded = loadObservations("nonexistent-session-xyz");
    expect(loaded).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Stories persistence
// ---------------------------------------------------------------------------

describe("stories persistence", () => {
  test("persistStories and loadStories round-trip", () => {
    const stories = [makeStory("flow-verification", "/settings")];
    persistStories(testSessionId, stories);

    const loaded = loadStories(testSessionId);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].kind).toBe("flow-verification");
    expect(loaded[0].route).toBe("/settings");
  });

  test("loadStories returns empty for nonexistent session", () => {
    const loaded = loadStories("nonexistent-session-xyz");
    expect(loaded).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Plan state persistence
// ---------------------------------------------------------------------------

describe("plan state persistence", () => {
  test("persistPlanState and loadPlanState round-trip", () => {
    const plan = derivePlan(
      [makeObs("s-1", "clientRequest")],
      [makeStory("flow-verification")],
    );
    persistPlanState(testSessionId, plan);

    const loaded = loadPlanState(testSessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.observationIds).toContain("s-1");
    expect(loaded!.satisfiedBoundaries).toContain("clientRequest");
  });

  test("loadPlanState returns null for nonexistent session", () => {
    const loaded = loadPlanState("nonexistent-session-xyz");
    expect(loaded).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recordObservation full cycle
// ---------------------------------------------------------------------------

describe("recordObservation", () => {
  test("full cycle: append → derive → persist", () => {
    // Create a story first
    recordStory(
      testSessionId,
      "flow-verification",
      "/settings",
      "settings page loads but save fails",
      ["verification"],
    );

    // Record observations
    const plan1 = recordObservation(testSessionId, makeObs("r-1", "clientRequest", {
      route: "/settings",
      summary: "curl http://localhost:3000/settings",
    }));
    expect(plan1.observations).toHaveLength(1);
    expect(plan1.satisfiedBoundaries.has("clientRequest")).toBe(true);

    const plan2 = recordObservation(testSessionId, makeObs("r-2", "serverHandler", {
      route: "/settings",
      summary: "vercel logs",
    }));
    expect(plan2.observations).toHaveLength(2);
    expect(plan2.satisfiedBoundaries.has("serverHandler")).toBe(true);

    // Verify persisted state matches derived state
    const persistedState = loadPlanState(testSessionId);
    expect(persistedState).not.toBeNull();
    expect(persistedState!.observationIds).toContain("r-1");
    expect(persistedState!.observationIds).toContain("r-2");
  });

  test("idempotent on duplicate observation id", () => {
    recordStory(testSessionId, "flow-verification", null, "test", []);

    const obs = makeObs("dup-1", "clientRequest");
    recordObservation(testSessionId, obs);
    const plan = recordObservation(testSessionId, obs);

    // Derive deduplicates — only one observation with this id
    expect(plan.observations.filter((o) => o.id === "dup-1")).toHaveLength(1);
  });

  test("duplicate observation id does not append a second ledger line", () => {
    recordStory(testSessionId, "flow-verification", "/settings", "test", []);

    const obs = makeObs("dup-ledger-1", "clientRequest", { route: "/settings" });
    recordObservation(testSessionId, obs);
    recordObservation(testSessionId, obs);

    const content = readFileSync(ledgerPath(testSessionId), "utf-8");
    expect(content.trim().split("\n")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// recordStory full cycle
// ---------------------------------------------------------------------------

describe("recordStory", () => {
  test("creates story and derives plan", () => {
    const plan = recordStory(
      testSessionId,
      "flow-verification",
      "/settings",
      "settings page loads but save fails",
      ["verification"],
    );
    expect(plan.stories).toHaveLength(1);
    expect(plan.stories[0].kind).toBe("flow-verification");
    expect(plan.missingBoundaries).toHaveLength(4); // all boundaries missing
    expect(plan.primaryNextAction).not.toBeNull();
  });

  test("merges repeated story creation", () => {
    recordStory(testSessionId, "flow-verification", "/settings", "first", ["skill-a"]);
    const plan = recordStory(testSessionId, "flow-verification", "/settings", "second", ["skill-b"]);

    expect(plan.stories).toHaveLength(1);
    expect(plan.stories[0].requestedSkills).toContain("skill-a");
    expect(plan.stories[0].requestedSkills).toContain("skill-b");
  });
});

// ---------------------------------------------------------------------------
// Bounded reads
// ---------------------------------------------------------------------------

describe("bounded reads", () => {
  test("recent state reads only from session-specific ledger files", () => {
    // Create data in one session
    recordStory(testSessionId, "flow-verification", null, "test", []);
    recordObservation(testSessionId, makeObs("bounded-1", "clientRequest"));

    // A different session should see nothing
    const otherSession = `other-${testSessionId}`;
    const otherObs = loadObservations(otherSession);
    const otherStories = loadStories(otherSession);
    expect(otherObs).toHaveLength(0);
    expect(otherStories).toHaveLength(0);

    // Clean up other session dir (may not exist)
    try {
      rmSync(join(tmpdir(), `vercel-plugin-${otherSession}-ledger`), { recursive: true, force: true });
    } catch { /* ignore */ }
  });
});
