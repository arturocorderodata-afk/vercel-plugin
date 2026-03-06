import { basename } from "node:path";
function globToRegex(pattern) {
  if (typeof pattern !== "string") {
    throw new TypeError(`globToRegex: expected string, got ${typeof pattern}`);
  }
  if (pattern === "") {
    throw new Error("globToRegex: pattern must not be empty");
  }
  let re = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i += 2;
        if (pattern[i] === "/") {
          re += "(?:[^/]+/)*";
          i++;
        } else {
          re += ".*";
        }
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (".()+[]{}|^$\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
    i++;
  }
  re += "$";
  return new RegExp(re);
}
function parseSeenSkills(envValue) {
  if (typeof envValue !== "string" || envValue.trim() === "") {
    return /* @__PURE__ */ new Set();
  }
  const seen = /* @__PURE__ */ new Set();
  for (const part of envValue.split(",")) {
    const skill = part.trim();
    if (skill !== "") {
      seen.add(skill);
    }
  }
  return seen;
}
function appendSeenSkill(envValue, skill) {
  if (typeof skill !== "string" || skill.trim() === "") return envValue || "";
  const current = typeof envValue === "string" ? envValue.trim() : "";
  return current === "" ? skill : `${current},${skill}`;
}
function compileSkillPatterns(skillMap, callbacks) {
  const cb = callbacks || {};
  return Object.entries(skillMap).map(([skill, config]) => ({
    skill,
    priority: typeof config.priority === "number" ? config.priority : 0,
    pathPatterns: config.pathPatterns || [],
    pathRegexes: (config.pathPatterns || []).map((p) => {
      try {
        return globToRegex(p);
      } catch (err) {
        if (cb.onPathGlobError) cb.onPathGlobError(skill, p, err);
        return null;
      }
    }).filter(Boolean),
    bashPatterns: config.bashPatterns || [],
    bashRegexes: (config.bashPatterns || []).map((p) => {
      try {
        return new RegExp(p);
      } catch (err) {
        if (cb.onBashRegexError) cb.onBashRegexError(skill, p, err);
        return null;
      }
    }).filter(Boolean),
    importPatterns: config.importPatterns || [],
    importRegexes: (config.importPatterns || []).map((p) => {
      try {
        return importPatternToRegex(p);
      } catch (err) {
        if (cb.onImportPatternError) cb.onImportPatternError(skill, p, err);
        return null;
      }
    }).filter(Boolean)
  }));
}
function importPatternToRegex(pattern) {
  if (typeof pattern !== "string") {
    throw new TypeError(`importPatternToRegex: expected string, got ${typeof pattern}`);
  }
  if (pattern === "") {
    throw new Error("importPatternToRegex: pattern must not be empty");
  }
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, `[^'"]*`);
  return new RegExp(`(?:from\\s+|require\\s*\\(\\s*|import\\s*\\(\\s*)['"]${escaped}(?:/[^'"]*)?['"]`, "m");
}
function matchImportWithReason(content, regexes, patterns) {
  if (!content || regexes.length === 0) return null;
  for (let idx = 0; idx < regexes.length; idx++) {
    if (regexes[idx].test(content)) {
      return { pattern: patterns[idx], matchType: "import" };
    }
  }
  return null;
}
function matchPathWithReason(filePath, regexes, patterns) {
  if (!filePath || regexes.length === 0) return null;
  const normalized = filePath.replace(/\\/g, "/");
  for (let idx = 0; idx < regexes.length; idx++) {
    const regex = regexes[idx];
    const pattern = patterns[idx];
    if (regex.test(normalized)) return { pattern, matchType: "full" };
    const base = basename(normalized);
    if (regex.test(base)) return { pattern, matchType: "basename" };
    const segments = normalized.split("/");
    for (let i = 1; i < segments.length; i++) {
      const suffix = segments.slice(-i).join("/");
      if (regex.test(suffix)) return { pattern, matchType: "suffix" };
    }
  }
  return null;
}
function matchBashWithReason(command, regexes, patterns) {
  if (!command || regexes.length === 0) return null;
  for (let idx = 0; idx < regexes.length; idx++) {
    if (regexes[idx].test(command)) return { pattern: patterns[idx], matchType: "full" };
  }
  return null;
}
function parseLikelySkills(envValue) {
  return parseSeenSkills(envValue);
}
function rankEntries(entries) {
  return entries.slice().sort((a, b) => {
    const aPri = typeof a.effectivePriority === "number" ? a.effectivePriority : a.priority;
    const bPri = typeof b.effectivePriority === "number" ? b.effectivePriority : b.priority;
    return bPri - aPri || a.skill.localeCompare(b.skill);
  });
}
export {
  appendSeenSkill,
  compileSkillPatterns,
  globToRegex,
  importPatternToRegex,
  matchBashWithReason,
  matchImportWithReason,
  matchPathWithReason,
  parseLikelySkills,
  parseSeenSkills,
  rankEntries
};
