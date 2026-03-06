/**
 * Typed re-exports of the shared match/rank engine from hooks/patterns.mjs.
 *
 * The canonical implementation lives in patterns.mjs (plain ESM, Node-compatible)
 * so the PreToolUse hook can import it under plain Node. This module provides
 * TypeScript types for consumers that run under Bun/tsc.
 */

export {
  compileSkillPatterns,
  matchPathWithReason,
  matchBashWithReason,
  rankEntries,
} from "../../hooks/patterns.mjs";

// ---------------------------------------------------------------------------
// Type declarations for the shared engine
// ---------------------------------------------------------------------------

export interface CompileCallbacks {
  onPathGlobError?: (skill: string, pattern: string, err: Error) => void;
  onBashRegexError?: (skill: string, pattern: string, err: Error) => void;
}

export interface SkillMapEntry {
  priority: number;
  pathPatterns: string[];
  bashPatterns: string[];
}

export interface CompiledSkillEntry {
  skill: string;
  priority: number;
  pathPatterns: string[];
  pathRegexes: RegExp[];
  bashPatterns: string[];
  bashRegexes: RegExp[];
  effectivePriority?: number;
}

export interface MatchReason {
  pattern: string;
  matchType: "full" | "basename" | "suffix";
}
