// hooks/src/routing-policy-compiler.mts
import {
  derivePolicyBoost
} from "./routing-policy.mjs";
import { createLogger } from "./logger.mjs";
function boostForAction(rec) {
  switch (rec.action) {
    case "promote":
      return 8;
    case "demote":
      return -2;
    case "investigate":
      return 0;
  }
}
function compilePolicyPatch(policy, report) {
  const log = createLogger();
  log.summary("policy_compiler_start", {
    sessionId: report.sessionId,
    recommendationCount: report.recommendations.length
  });
  const entries = [];
  for (const rec of report.recommendations) {
    const bucket = policy.scenarios[rec.scenario] ?? {};
    const stats = bucket[rec.skill];
    const currentBoost = derivePolicyBoost(stats);
    const proposedBoost = boostForAction(rec);
    const delta = proposedBoost - currentBoost;
    if (delta !== 0 || rec.action === "investigate") {
      const action = rec.action === "investigate" ? "investigate" : delta > 0 ? "promote" : delta < 0 ? "demote" : "no-op";
      const entry = {
        scenario: rec.scenario,
        skill: rec.skill,
        action,
        currentBoost,
        proposedBoost,
        delta,
        confidence: rec.confidence,
        reason: rec.reason
      };
      entries.push(entry);
      log.debug("policy_patch_entry", {
        scenario: rec.scenario,
        skill: rec.skill,
        action,
        currentBoost,
        proposedBoost,
        delta
      });
    } else {
      log.debug("policy_patch_no_op", {
        scenario: rec.scenario,
        skill: rec.skill,
        currentBoost,
        proposedBoost,
        reason: "boost already aligned"
      });
    }
  }
  entries.sort(
    (a, b) => a.scenario.localeCompare(b.scenario) || a.skill.localeCompare(b.skill)
  );
  log.summary("policy_compiler_complete", {
    sessionId: report.sessionId,
    patchCount: entries.length,
    promotes: entries.filter((e) => e.action === "promote").length,
    demotes: entries.filter((e) => e.action === "demote").length,
    investigates: entries.filter((e) => e.action === "investigate").length,
    noOps: entries.filter((e) => e.action === "no-op").length
  });
  return {
    version: 1,
    sessionId: report.sessionId,
    patchCount: entries.length,
    entries
  };
}
function applyPolicyPatch(patch, now) {
  const log = createLogger();
  const timestamp = now ?? (/* @__PURE__ */ new Date()).toISOString();
  const rules = [];
  for (const entry of patch.entries) {
    if (entry.action === "investigate" || entry.action === "no-op") {
      log.debug("policy_apply_skip", {
        scenario: entry.scenario,
        skill: entry.skill,
        action: entry.action,
        reason: "non-actionable"
      });
      continue;
    }
    rules.push({
      scenario: entry.scenario,
      skill: entry.skill,
      action: entry.action,
      boost: entry.proposedBoost,
      confidence: entry.confidence,
      reason: entry.reason
    });
    log.summary("policy_apply_entry", {
      scenario: entry.scenario,
      skill: entry.skill,
      action: entry.action,
      proposedBoost: entry.proposedBoost,
      delta: entry.delta
    });
  }
  log.summary("policy_apply_complete", {
    sessionId: patch.sessionId,
    applied: rules.length,
    total: patch.entries.length
  });
  return {
    version: 1,
    sessionId: patch.sessionId,
    promotedAt: timestamp,
    applied: rules.length,
    rules
  };
}
export {
  applyPolicyPatch,
  compilePolicyPatch
};
