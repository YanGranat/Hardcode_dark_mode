(function exposeRules(global) {
  const MAX_RULES = 100, MAX_PATH_DEPTH = 8, MAX_SELECTOR_LENGTH = 2048;
  const identity = rule => JSON.stringify([rule.path, rule.matchAll === true]);
  function displayLabel(rule) {
    if (rule.name) return rule.name;
    const label = String(rule.label || "");
    const path = rule.path || [];
    const selector = path.at(-1) || "";
    const tagOnly = /^[a-z][a-z0-9-]*$/.test(label) &&
      new RegExp(`(?:^|[\\s>+~])${label}(?:[.#[:\\s>+~]|$)`).test(selector);
    if (label && label !== "Element" && !tagOnly) return label;
    const context = path.join(" / ") || label || "Element";
    return context.length > 120 ? `${context.slice(0, 40)}…${context.slice(-79)}` : context;
  }
  const validPath = path => Array.isArray(path) && path.length > 0 && path.length <= MAX_PATH_DEPTH &&
    path.every(part => typeof part === "string" && part.length > 0 && part.length <= MAX_SELECTOR_LENGTH);

  function normalizeExclusions(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    return value.filter(rule => {
      if (!rule || !validPath(rule.path)) return false;
      const key = identity(rule);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, MAX_RULES).map(rule => ({
      path: [...rule.path], label: String(rule.label || "Element").slice(0, 80),
      ...(typeof rule.name === "string" && rule.name.trim() ? { name: rule.name.trim().slice(0, 80) } : {}),
      ...(rule.enabled === false ? { enabled: false } : {}),
      ...(rule.matchAll === true ? { matchAll: true } : {}),
      ...(validPath(rule.fallbackPath) ? { fallbackPath: [...rule.fallbackPath] } : {})
    }));
  }

  function normalizeInclusions(value) {
    const rules = normalizeExclusions(value);
    if (!rules.length) return rules;
    const originals = new Map();
    for (const rule of value) {
      if (!rule || !validPath(rule.path)) continue;
      const key = identity(rule);
      if (!originals.has(key)) originals.set(key, rule);
    }
    return rules.map(rule => {
      const original = originals.get(identity(rule));
      return {
        ...rule,
        ...(Array.isArray(original.protections) ? { protections: normalizeExclusions(original.protections) } : {})
      };
    });
  }


  function validRule(rule) {
    return rule && typeof rule === "object" && !Array.isArray(rule) &&
      normalizeExclusions([rule]).length === 1 &&
      (rule.fallbackPath === undefined || normalizeExclusions([{ path: rule.fallbackPath }]).length === 1) &&
      (rule.name === undefined || (typeof rule.name === "string" && rule.name.length <= 80)) &&
      (rule.enabled === undefined || typeof rule.enabled === "boolean") &&
      (rule.matchAll === undefined || typeof rule.matchAll === "boolean");
  }

  function validateInclusion(value) {
    if (!validRule(value)) throw new Error("invalid_rule");
    if (value.protections !== undefined) {
      if (!Array.isArray(value.protections)) throw new Error("invalid_rule");
      if (value.protections.length > MAX_RULES) throw new Error("too_many_rules");
      if (!Array.from(value.protections).every(rule => validRule(rule) && rule.protections === undefined)) throw new Error("invalid_rule");
    }
    return normalizeInclusions([value])[0];
  }

  function validateLegacyRemovals(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("invalid_rule");
    if (value.length > MAX_RULES) throw new Error("too_many_rules");
    return Array.from(value, rule => {
      if (!validRule(rule) || rule.protections !== undefined) throw new Error("invalid_rule");
      return normalizeExclusions([rule])[0];
    });
  }

  function updateMetadata(rule, changes) {
    if (!changes || typeof changes !== "object" || Array.isArray(changes) ||
        !Object.keys(changes).length || Object.keys(changes).some(key => !["name", "enabled"].includes(key))) throw Error("invalid_message");
    const result = { ...rule };
    if (Object.hasOwn(changes, "name")) {
      if (typeof changes.name !== "string" || changes.name.length > 80) throw Error("invalid_message");
      if (changes.name.trim()) result.name = changes.name.trim();
      else delete result.name;
    }
    if (Object.hasOwn(changes, "enabled")) {
      if (typeof changes.enabled !== "boolean") throw Error("invalid_message");
      if (changes.enabled) delete result.enabled;
      else result.enabled = false;
    }
    return result;
  }


  global.HdmRules = { MAX_RULES, MAX_PATH_DEPTH, normalizeExclusions, normalizeInclusions, identity, displayLabel, updateMetadata, validateInclusion, validateLegacyRemovals };
})(globalThis);
