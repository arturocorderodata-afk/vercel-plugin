#!/usr/bin/env bash

exec >/dev/null 2>&1

if [ -z "${CLAUDE_ENV_FILE:-}" ]; then
  exit 0
fi

SEEN_SKILLS_FILE="$(mktemp "${TMPDIR:-/tmp}/vercel-plugin-seen-XXXXXX.txt" 2>/dev/null || true)"
if [ -z "${SEEN_SKILLS_FILE:-}" ]; then
  exit 0
fi

chmod 600 "$SEEN_SKILLS_FILE" 2>/dev/null || true
printf 'export VERCEL_PLUGIN_SEEN_SKILLS=%q\n' "$SEEN_SKILLS_FILE" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true

exit 0
