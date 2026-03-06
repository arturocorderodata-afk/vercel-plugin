/**
 * Typed re-exports of the structured logger from hooks/logger.mjs.
 *
 * The canonical implementation lives in logger.mjs (plain ESM, Node-compatible)
 * so the PreToolUse hook can import it under plain Node. This module provides
 * TypeScript types for consumers that run under Bun/tsc.
 */

export {
  resolveLogLevel,
  createLogger,
  LEVELS,
  LEVEL_INDEX,
} from "../../hooks/logger.mjs";

// ---------------------------------------------------------------------------
// Type declarations
// ---------------------------------------------------------------------------

export type LogLevel = "off" | "summary" | "debug" | "trace";

export interface LoggerOptions {
  level?: LogLevel;
}

export interface Logger {
  level: LogLevel;
  active: boolean;
  t0: number;
  now: () => number;
  elapsed(): number;

  /** Emit a structured issue event (summary+). */
  issue(code: string, message: string, hint: string, context: Record<string, unknown>): void;
  /** Emit the single completion event (summary+). */
  complete(
    reason: string,
    counts?: {
      matchedCount?: number;
      injectedCount?: number;
      dedupedCount?: number;
      cappedCount?: number;
    },
    timing?: Record<string, number> | null,
  ): void;
  /** Emit a debug-level event. */
  debug(event: string, data: Record<string, unknown>): void;
  /** Emit a trace-level event. */
  trace(event: string, data: Record<string, unknown>): void;
  /** Check if a given level is enabled. */
  isEnabled(minLevel: LogLevel): boolean;
}
