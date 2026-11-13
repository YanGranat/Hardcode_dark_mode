(function exposeSelectors(global) {
  const parent = element => element.parentElement || element.getRootNode().host || null;
  const composedParent = element => element.assignedSlot || parent(element);
  function owned(node) {
    for (let element = node?.nodeType === 1 ? node : node?.parentElement; element; element = parent(element)) {
      if (element.matches?.("[data-hdm-picker], [data-hdm-rule-style], [data-hdm-filter-resources], [data-hdm-universal-shadow-style], [data-hdm-universal-body-style]")) return true;
    }
    return false;
  }
  const allowed = element => element instanceof Element && !["HTML", "BODY", "HEAD"].includes(element.tagName);

  function selectionFor(element) {
    const history = [];
    let target = element;
    // An SVG hit can be only its background shape, with text in sibling groups.
    // Start at the nearest SVG viewport, retaining every step for Smaller.
    const viewport = element.namespaceURI === "http://www.w3.org/2000/svg" ? element.closest("svg") : null;
    if (viewport) {
      while (target !== viewport) { history.push(target); target = parent(target); }
    }
    return { target, history };
  }

  function selectorFor(element, structural = false) {
    const root = element.getRootNode();
    const unique = selector => {
      const matches = root.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === element;
    };
    if (!structural && element.id && unique(`#${CSS.escape(element.id)}`)) return `#${CSS.escape(element.id)}`;
    const classes = [...element.classList].filter(name => !/^dmx-|^hdm-/.test(name)).slice(0, 3);
    const named = CSS.escape(element.localName) + classes.map(name => `.${CSS.escape(name)}`).join("");
    if (unique(named) && (!structural || classes.length)) return named;
    let selector = "", anchored = false;
    for (let node = element; node; node = node.parentElement) {
      let part = CSS.escape(node.localName) + (structural ? [...node.classList].filter(name => !/^dmx-|^hdm-/.test(name)).slice(0, 3).map(name => `.${CSS.escape(name)}`).join("") : "");
      // Top-level children of a shadow root have siblings but no parent element.
      const container = node.parentElement || (node.parentNode?.nodeType === 11 ? node.parentNode : null);
      if (node.id && (!structural || node !== element) && (!structural || !["html", "body"].includes(node.localName))) part = `#${CSS.escape(node.id)}`;
      else if (container) {
        const siblings = [...container.children].filter(child => child.matches(part));
        if (siblings.length > 1) {
          const sameTag = [...container.children].filter(child => child.localName === node.localName);
          part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
        }
      }
      selector = part + (selector ? ` > ${selector}` : "");
      if (!["html", "body"].includes(node.localName) && /[.#]/.test(part)) anchored = true;
      if (unique(selector) && (!structural || anchored)) return selector;
    }
    if (structural) return selector;
    throw new Error("selector_unavailable");
  }

  function ruleFor(element) {
    const path = [], fallbackPath = [];
    for (let node = element; node; node = node.getRootNode().host) {
      path.unshift(selectorFor(node));
      let fallback = selectorFor(node, true);
      if (node !== element && node.id && !anchoredSelector(fallback)) fallback = `#${CSS.escape(node.id)}`;
      fallbackPath.unshift(fallback);
    }
    const rule = { path, fallbackPath, label: element.localName + (element.id ? `#${element.id}` : "") };
    if (!HdmRules.normalizeExclusions([rule]).length) throw new Error("selector_unavailable");
    return rule;
  }

  function anchoredSelector(selector) {
    return selector.split(" > ").some(part => !/^(?:html|body)(?:[.#:]|$)/.test(part) && /[.#]/.test(part));
  }

  function resolvePath(path) {
    let root = document;
    let element;
    try {
      for (let i = 0; i < path.length; i++) {
        const matches = [...root.querySelectorAll(path[i])].filter(element => !owned(element));
        if (matches.length > 1) return { conflict: true };
        if (!matches.length) return {};
        element = matches[0];
        if (i < path.length - 1) {
          root = element.shadowRoot;
          if (!root) return {};
        }
      }
    } catch { return { conflict: true }; }
    return { element: allowed(element) ? element : null };
  }

  function resolveRule(rule) {
    const primary = resolvePath(rule.path);
    if (primary.conflict) return null;
    if (primary.element) {
      // A reused ID with a different element type must not redirect a rule.
      const expected = rule.fallbackPath?.at(-1).split(" > ").at(-1);
      const tag = CSS.escape(primary.element.localName);
      if (expected && /^[^#.:[*]/.test(expected) &&
          !(expected.startsWith(tag) && (expected.length === tag.length || ".#:[".includes(expected[tag.length])))) return null;
      return primary.element;
    }
    if (!rule.fallbackPath || !rule.fallbackPath.every(anchoredSelector)) return null;
    return resolvePath(rule.fallbackPath).element || null;
  }

  const resolveRules = rules => rules.flatMap(rule => rule.matchAll
    ? resolveGroupResult(rule).elements : [resolveRule(rule)].filter(Boolean));
  function inside(element, roots) {
    for (let node = composedParent(element); node; node = composedParent(node)) if (roots.includes(node)) return true;
    return false;
  }


  const MAX_MATCHES = 500;
  const MAX_ANCESTORS = 8;

  function segmentFor(element) {
    const parts = [];
    for (let node = element, depth = 0; allowed(node) && depth <= MAX_ANCESTORS; node = node.parentElement, depth++) {
      const classes = [...node.classList].filter(name => !/^dmx-|^hdm-/.test(name)).sort();
      parts.unshift(CSS.escape(node.localName) + classes.map(name => `.${CSS.escape(name)}`).join(""));
      if (classes.length) return parts.join(" > ");
    }
    throw new Error("group_unavailable");
  }

  function groupRuleFor(element) {
    const path = [];
    for (let node = element; node; node = node.getRootNode().host) {
      if (!allowed(node) || !node.isConnected) throw new Error("group_unavailable");
      path.unshift(segmentFor(node));
      if (path.length > HdmRules.MAX_PATH_DEPTH) throw new Error("group_unavailable");
    }
    const [rule] = HdmRules.normalizeExclusions([{ path, matchAll: true, label: path.at(-1) }]);
    if (!rule) throw new Error("group_unavailable");
    if (!resolveGroupResult(rule).elements.includes(element)) throw new Error("group_unavailable");
    return rule;
  }

  function resolveGroupResult(rule) {
    const [normalized] = HdmRules.normalizeExclusions([rule]);
    if (!normalized?.matchAll) return { elements: [], overflow: false };
    let scopes = [document], total = 0;
    try {
      for (let index = 0; index < normalized.path.length; index++) {
        const matches = new Set();
        for (const scope of scopes) {
          const found = scope.querySelectorAll(normalized.path[index]);
          for (const element of found) {
            if (owned(element)) continue;
            if (++total > MAX_MATCHES) return { elements: [], overflow: true };
            if (allowed(element)) matches.add(element);
          }
        }
        if (index === normalized.path.length - 1) return { elements: [...matches], overflow: false };
        scopes = [...matches].map(element => element.shadowRoot).filter(Boolean);
        if (!scopes.length) return { elements: [], overflow: false };
      }
    } catch { return { elements: [], overflow: false }; }
    return { elements: [], overflow: false };
  }


  global.HdmSelectors = { parent, composedParent, owned, allowed, selectionFor, ruleFor, groupRuleFor, resolveRule, resolveRules, resolveGroupResult, inside };
})(globalThis);
