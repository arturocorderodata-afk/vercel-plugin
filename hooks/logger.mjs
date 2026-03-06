/**
 * Structured log-level system for hook output.
 *
 * Levels (ascending verbosity):
 *   off     — no output (default, preserves existing behavior)
 *   summary — outcome + latency + issues only
 *   debug   — adds match reasons, dedup info, skill map stats
 *   trace   — adds per-pattern evaluation details
 *
 * Env vars (checked in order):
 *   VERCEL_PLUGIN_LOG_LEVEL  — explicit level name
 *   VERCEL_PLUGIN_DEBUG=1    — legacy, maps to "debug"
 *   VERCEL_PLUGIN_HOOK_DEBUG=1 — legacy, maps to "debug"
 */

import { randomBytes } from "node:crypto";

const LEVELS = /** @type {const} */ (["off", "summary", "debug", "trace"]);
const LEVEL_INDEX = /** @type {Record<string, number>} */ ({
  off: 0,
  summary: 1,
  debug: 2,
  trace: 3,
});

/**
 * Resolve the active log level from environment variables.
 * @returns {"off" | "summary" | "debug" | "trace"}
 */
export function resolveLogLevel() {
  const explicit = (process.env.VERCEL_PLUGIN_LOG_LEVEL || "").toLowerCase().trim();
  if (explicit && LEVEL_INDEX[explicit] !== undefined) {
    return explicit;
  }
  // Legacy boolean flags → debug
  if (
    process.env.VERCEL_PLUGIN_DEBUG === "1" ||
    process.env.VERCEL_PLUGIN_HOOK_DEBUG === "1"
  ) {
    return "debug";
  }
  return "off";
}

/**
 * Create a logger instance bound to a specific invocation.
 * @param {object} [opts]
 * @param {"off" | "summary" | "debug" | "trace"} [opts.level] — override resolved level
 * @returns {Logger}
 */
export function createLogger(opts) {
  const level = (opts && opts.level) || resolveLogLevel();
  const rank = LEVEL_INDEX[level] || 0;
  const active = rank > 0;
  const invocationId = active ? randomBytes(4).toString("hex") : "";

  const safeNow =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? () => performance.now()
      : () => Date.now();
  const t0 = active ? safeNow() : 0;

  /**
   * Write a JSON-lines event to stderr if the current level is >= minLevel.
   * @param {"summary" | "debug" | "trace"} minLevel
   * @param {string} event
   * @param {Record<string, unknown>} data
   */
  function emit(minLevel, event, data) {
    if (rank < LEVEL_INDEX[minLevel]) return;
    const line = JSON.stringify({
      invocationId,
      event,
      timestamp: new Date().toISOString(),
      ...data,
    });
    process.stderr.write(line + "\n");
  }

  return {
    /** The resolved log level name */
    level,
    /** Whether any output will be emitted (level > off) */
    active,
    /** Monotonic timer start */
    t0,
    /** Monotonic now */
    now: safeNow,
    /** Elapsed ms since logger creation */
    elapsed() {
      return Math.round(safeNow() - t0);
    },

    // -- summary-level (outcome, latency, issues) --

    /** Emit a structured issue event (summary+). */
    issue(code, message, hint, context) {
      emit("summary", "issue", { code, message, hint, context });
    },

    /** Emit the single completion event (summary+). */
    complete(reason, counts, timing) {
      const {
        matchedCount = 0,
        injectedCount = 0,
        dedupedCount = 0,
        cappedCount = 0,
      } = counts || {};
      emit("summary", "complete", {
        reason,
        matchedCount,
        injectedCount,
        dedupedCount,
        cappedCount,
        elapsed_ms: Math.round(safeNow() - t0),
        ...(timing ? { timing_ms: timing } : {}),
      });
    },

    // -- debug-level (match reasons, dedup, skill map) --

    /** Emit a debug-level event. */
    debug(event, data) {
      emit("debug", event, data);
    },

    // -- trace-level (per-pattern evaluation) --

    /** Emit a trace-level event. */
    trace(event, data) {
      emit("trace", event, data);
    },

    /** Check if a given level is enabled. */
    isEnabled(minLevel) {
      return rank >= (LEVEL_INDEX[minLevel] || 0);
    },
  };
}

/** @typedef {ReturnType<typeof createLogger>} Logger */

export { LEVELS, LEVEL_INDEX };
