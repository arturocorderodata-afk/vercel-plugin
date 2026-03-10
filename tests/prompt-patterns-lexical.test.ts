import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { initializeLexicalIndex } from "../hooks/src/lexical-index.mts";
import {
  compilePromptSignals,
  scorePromptWithLexical,
} from "../hooks/src/prompt-patterns.mts";

describe("scorePromptWithLexical", () => {
  let previousLexicalMinScore: string | undefined;

  beforeEach(() => {
    previousLexicalMinScore = process.env.VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE;
    initializeLexicalIndex(new Map());
  });

  afterEach(() => {
    if (previousLexicalMinScore === undefined) {
      delete process.env.VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE;
    } else {
      process.env.VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE =
        previousLexicalMinScore;
    }
    initializeLexicalIndex(new Map());
  });

  test("test_scorePromptWithLexical_returns_exact_fast_path_when_threshold_met", () => {
    const compiled = compilePromptSignals({
      phrases: ["ai elements"],
      minScore: 6,
    });

    const result = scorePromptWithLexical(
      "Add AI Elements to the chat UI",
      "ai-elements",
      compiled,
      [{ skill: "ai-elements", score: 99 }],
    );

    expect(result).toEqual({
      score: 6,
      matchedPhrases: ["ai elements"],
      lexicalScore: 0,
      source: "exact",
    });
  });

  test("test_scorePromptWithLexical_prefers_provided_lexical_hit_when_exact_is_below_threshold", () => {
    const compiled = compilePromptSignals({
      phrases: ["deploy preview"],
      minScore: 6,
    });

    const result = scorePromptWithLexical(
      "ship the release",
      "vercel-deploy",
      compiled,
      [{ skill: "vercel-deploy", score: 7 }],
    );

    expect(result.matchedPhrases).toEqual([]);
    expect(result.lexicalScore).toBe(7);
    expect(result.score).toBeCloseTo(9.45, 6);
    expect(result.source).toBe("lexical");
  });

  test("test_scorePromptWithLexical_calls_searchSkills_when_hits_are_omitted", () => {
    process.env.VERCEL_PLUGIN_LEXICAL_RESULT_MIN_SCORE = "0";
    initializeLexicalIndex(
      new Map([
        [
          "vercel-deploy",
          {
            retrieval: {
              aliases: ["deploy"],
              intents: ["release"],
              entities: ["deployment"],
              examples: ["ship the release"],
            },
          },
        ],
      ]),
    );

    const compiled = compilePromptSignals({
      phrases: ["deploy preview"],
      minScore: 10,
    });

    const result = scorePromptWithLexical(
      "ship the release",
      "vercel-deploy",
      compiled,
    );

    expect(result.lexicalScore).toBeGreaterThan(0);
    expect(result.score).toBeCloseTo(result.lexicalScore * 1.35, 6);
    expect(result.source).toBe("lexical");
  });

  test("test_scorePromptWithLexical_marks_combined_when_exact_score_stays_higher", () => {
    const compiled = compilePromptSignals({
      phrases: ["ai elements"],
      minScore: 10,
    });

    const result = scorePromptWithLexical(
      "add ai elements to the chat",
      "ai-elements",
      compiled,
      [{ skill: "ai-elements", score: 4 }],
    );

    expect(result).toEqual({
      score: 6,
      matchedPhrases: ["ai elements"],
      lexicalScore: 4,
      source: "combined",
    });
  });
});
