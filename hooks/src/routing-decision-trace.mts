/**
 * Routing Decision Flight Recorder: append-only JSONL trace of every routing
 * decision (skill injection, prompt scoring, verification closure).
 *
 * Persistence contract:
 * - Trace dir: `<tmpdir>/vercel-plugin-<safeSession>-trace/`
 * - Trace file: `<traceDir>/routing-decision-trace.jsonl`
 *
 * Each routing event appends one JSON object per line. Reads return all traces
 * in append order. Missing files return `[]` without throwing.
 *
 * v1 — covers PreToolUse, UserPromptSubmit, and PostToolUse hooks.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Safe session-id segment (mirrors routing-policy-ledger.mts)
// ---------------------------------------------------------------------------

const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

function safeSessionSegment(sessionId: string | null): string {
  if (!sessionId) return "no-session";
  if (SAFE_SESSION_ID_RE.test(sessionId)) return sessionId;
  return createHash("sha256").update(sessionId).digest("hex");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DecisionHook = "PreToolUse" | "UserPromptSubmit" | "PostToolUse";

export interface RankedSkillTrace {
  skill: string;
  basePriority: number;
  effectivePriority: number;
  pattern: { type: string; value: string } | null;
  profilerBoost: number;
  policyBoost: number;
  policyReason: string | null;
  summaryOnly: boolean;
  synthetic: boolean;
  droppedReason:
    | "deduped"
    | "cap_exceeded"
    | "budget_exhausted"
    | "concurrent_claim"
    | null;
}

export interface RoutingDecisionTrace {
  version: 1;
  decisionId: string;
  sessionId: string | null;
  hook: DecisionHook;
  toolName: string;
  toolTarget: string;
  timestamp: string;
  primaryStory: {
    id: string | null;
    kind: string | null;
    route: string | null;
    targetBoundary: string | null;
  };
  policyScenario: string | null;
  matchedSkills: string[];
  injectedSkills: string[];
  skippedReasons: string[];
  ranked: RankedSkillTrace[];
  verification: {
    verificationId: string | null;
    observedBoundary: string | null;
    matchedSuggestedAction: boolean | null;
  } | null;
}

// ---------------------------------------------------------------------------
// Path helpers (exported for testing)
// ---------------------------------------------------------------------------

export function traceDir(sessionId: string | null): string {
  return join(
    tmpdir(),
    `vercel-plugin-${safeSessionSegment(sessionId)}-trace`,
  );
}

export function tracePath(sessionId: string | null): string {
  return join(traceDir(sessionId), "routing-decision-trace.jsonl");
}

// ---------------------------------------------------------------------------
// Decision ID — deterministic for identical causal inputs
// ---------------------------------------------------------------------------

export function createDecisionId(input: {
  hook: DecisionHook;
  sessionId: string | null;
  toolName: string;
  toolTarget: string;
  timestamp?: string;
}): string {
  const timestamp = input.timestamp ?? new Date().toISOString();
  return createHash("sha256")
    .update(
      [
        input.hook,
        input.sessionId ?? "",
        input.toolName,
        input.toolTarget,
        timestamp,
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// Append (write) — one JSONL line per decision
// ---------------------------------------------------------------------------

export function appendRoutingDecisionTrace(
  trace: RoutingDecisionTrace,
): void {
  mkdirSync(traceDir(trace.sessionId), { recursive: true });
  appendFileSync(
    tracePath(trace.sessionId),
    JSON.stringify(trace) + "\n",
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// Read — returns all traces in append order, [] on missing file
// ---------------------------------------------------------------------------

export function readRoutingDecisionTrace(
  sessionId: string | null,
): RoutingDecisionTrace[] {
  try {
    const content = readFileSync(tracePath(sessionId), "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as RoutingDecisionTrace);
  } catch {
    return [];
  }
}
