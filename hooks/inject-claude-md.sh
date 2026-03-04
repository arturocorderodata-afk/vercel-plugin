#!/bin/bash
# SessionStart hook: inject vercel.md as additional context
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cat "${PLUGIN_ROOT}/vercel.md" 2>/dev/null
exit 0
