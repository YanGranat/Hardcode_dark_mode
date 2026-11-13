(function exposeRulePainter(global) {
  const media = 'img, video, iframe, [style*="background-image"]';
  const { parent, composedParent, resolveRule, resolveRules, inside } = HdmSelectors;
  const ruleKey = HdmRules.identity;
  function create(getShadowRoots, kind = "exclude") {
    const invert = kind === "invert";
    const attribute = invert ? "data-hdm-inverted" : "data-hdm-excluded";
    let rules = [], protections = [], active = false, preview = null, editorDraft = null, picker = null, frame = 0;
    let geometryFrame = 0, owners = new Map(), protectedTargets = [], suspendProtection = false, geometryNeeded = false, legacyCoversRoot = false, coveringRule = null;
    let boundaries = new Set();
    const toggleScopes = new WeakSet(), toggleEvents = ["beforetoggle", "toggle"];
    const cutouts = invert ? HdmCutouts.create() : null;
    const marked = new Set(), styles = new Map();
    const mediaMarked = new Set(), fullscreenMarked = new Set();
    let observedScopes = new Set();
    let usesClasses = true, usesIds = true;
    const observer = new MutationObserver(mutations => {
      if (mutations.some(mutation => !(mutation.attributeName === "class" && !usesClasses) &&
          !(mutation.attributeName === "id" && !usesIds) && !HdmSelectors.owned(mutation.target) &&
          !(mutation.type === "childList" && [...mutation.addedNodes, ...mutation.removedNodes].every(HdmSelectors.owned)) &&
          (mutation.attributeName !== "style" ||
          backgroundChanged(mutation)))) schedule();
    });
    function backgroundChanged(mutation) {
      const style = document.createElement("span").style;
      style.cssText = mutation.oldValue || "";
      return style.backgroundImage !== mutation.target.style.backgroundImage;
    }
    function branchSources(roots) {
      const sources = new Set(roots);
      const within = element => {
        for (let node = element; node; node = composedParent(node)) if (roots.has(node)) return true;
        return false;
      };
      for (const scope of getShadowRoots()) if (within(scope.host)) sources.add(scope);
      for (const source of sources) {
        const slots = [...source.querySelectorAll("slot")];
        if (source.localName === "slot") slots.push(source);
        for (const slot of slots) for (const element of slot.assignedElements({ flatten: true })) sources.add(element);
      }
      return sources;
    }
    function updateMarker(nodes, next, name) {
      for (const node of nodes) if (!next.has(node)) { node.removeAttribute(name); nodes.delete(node); }
      for (const [node, value] of next) {
        if (node.getAttribute(name) !== value) node.setAttribute(name, value);
        nodes.add(node);
      }
    }
    function paintInclusions(roots, scopes, protectedSet) {
      const protectedMedia = new Map(), fullscreen = new Map();
      if (invert) {
        let fullscreenElement = document.fullscreenElement;
        while (fullscreenElement?.shadowRoot?.fullscreenElement) fullscreenElement = fullscreenElement.shadowRoot.fullscreenElement;
        // Modal dialogs and open popovers also render in the top layer, outside the
        // filter of the block that contains them.
        const topLayer = new Set(fullscreenElement ? [fullscreenElement] : []);
        for (const scope of scopes) {
          if (!HdmSelectors.owned(scope) && scope.matches?.(":modal, :popover-open")) topLayer.add(scope);
          for (const element of scope.querySelectorAll(":modal, :popover-open")) if (!HdmSelectors.owned(element)) topLayer.add(element);
        }
        for (const element of topLayer) for (let node = element; node; node = composedParent(node)) {
          if (protectedSet.has(node)) break;
          if (roots.has(node)) {
            fullscreen.set(element, element !== node && element.matches("img,video,iframe") ? "original" : "invert");
            break;
          }
        }
        const candidates = new Set();
        for (const scope of scopes) {
          if (scope.matches?.(media)) candidates.add(scope);
          for (const element of scope.querySelectorAll(media)) candidates.add(element);
        }
        for (const element of candidates) {
          if (roots.has(element)) continue;
          let nested = false;
          for (let node = element; node; node = composedParent(node)) {
            if (protectedSet.has(node)) break;
            if (node === element) continue;
            // Fullscreen escapes filters above its top-layer boundary.
            if (roots.has(node) || fullscreen.has(node)) { protectedMedia.set(element, nested ? "inside" : "root"); break; }
            if (node.matches(media)) nested = true;
          }
        }
      }
      updateMarker(mediaMarked, protectedMedia, "data-hdm-invert-media");
      updateMarker(fullscreenMarked, fullscreen, "data-hdm-invert-fullscreen");
      boundaries = new Set(fullscreen.keys());
      owners = new Map([...roots].map(element => [element, 90]));
      for (const [element, value] of protectedMedia) if (value === "root") owners.set(element, 100);
      for (const [element, value] of fullscreen) {
        if (value === "invert") owners.set(element, 90);
        else owners.delete(element);
      }
    }
    function trackGeometry() {
      if (!invert || geometryFrame || !active || !geometryNeeded || document.hidden) return;
      geometryFrame = requestAnimationFrame(() => {
        geometryFrame = 0;
        geometryNeeded = cutouts.paint(owners, protectedTargets, suspendProtection, boundaries) === true;
        picker?.geometry();
        trackGeometry();
      });
    }
    function schedule() {
      if (!frame && active && (rules.length || preview || editorDraft)) frame = requestAnimationFrame(() => { frame = 0; paint(); });
    }
    function paint() {
      const effective = active ? rules.filter(rule => rule.enabled !== false && (!editorDraft?.original || ruleKey(rule) !== ruleKey(editorDraft.original))) : [];
      if (active && editorDraft?.rule && editorDraft.rule.enabled !== false) effective.push(editorDraft.rule);
      const paths = [...effective, ...protections, ...effective.flatMap(rule => rule.protections || []), ...(preview ? [preview] : [])]
        .flatMap(rule => [...rule.path || [], ...rule.fallbackPath || []]);
      // Attribute names may contain CSS escapes, comments or namespace prefixes.
      usesClasses = paths.some(selector => /[.\[\\]/.test(selector));
      usesIds = paths.some(selector => /[#:\[\\]/.test(selector));
      const targets = resolveRules(effective);
      protectedTargets = [];
      suspendProtection = false;
      const removedLegacy = new Set((editorDraft?.removeLegacyProtections || []).map(rule => JSON.stringify(rule)));
      if (active && invert) for (const rule of protections.filter(rule => rule.enabled !== false && !removedLegacy.has(JSON.stringify(rule)))) {
        if (rule.matchAll) {
          const result = HdmSelectors.resolveGroupResult(rule);
          suspendProtection ||= result.overflow;
          protectedTargets.push(...result.elements);
        } else {
          const target = resolveRule(rule);
          if (target) protectedTargets.push(target);
        }
      }
      legacyCoversRoot = false;
      if (invert && editorDraft?.rule) for (const root of resolveRules([editorDraft.rule])) {
        for (let node = root; node; node = composedParent(node)) if (protectedTargets.includes(node)) { legacyCoversRoot = true; break; }
      }
      coveringRule = null;
      const draftRoots = editorDraft?.rule ? resolveRules([editorDraft.rule]) : [];
      if (active && invert) for (const rule of effective) {
        const parentRoots = resolveRules([rule]);
        for (const protection of (rule.protections || []).filter(rule => rule.enabled !== false)) {
          const result = protection.matchAll ? HdmSelectors.resolveGroupResult(protection)
            : { elements: [resolveRule(protection)].filter(Boolean), overflow: false };
          if (parentRoots.length) suspendProtection ||= result.overflow;
          const matched = result.elements.filter(element => !parentRoots.includes(element) && inside(element, parentRoots));
          protectedTargets.push(...matched);
          if (editorDraft && ruleKey(rule) !== ruleKey(editorDraft.rule) && draftRoots.some(root => matched.some(element => element === root || inside(root, [element])))) coveringRule = HdmRules.displayLabel(rule);
        }
      }
      if (active && preview && preview.enabled !== false) targets.push(...resolveRules([preview]));
      const protectedSet = new Set(protectedTargets);
      const candidates = new Set(targets);
      const roots = new Set(targets.filter(element => {
        const ancestor = invert ? composedParent : parent;
        if (invert) for (let node = element; node; node = composedParent(node)) if (protectedSet.has(node)) return false;
        for (let node = ancestor(element); node; node = ancestor(node)) if (candidates.has(node)) return false;
        return true;
      }));
      for (const element of marked) if (!roots.has(element)) { element.removeAttribute(attribute); marked.delete(element); }
      for (const element of roots) {
        let covered = false;
        if (!invert) for (let node = parent(element); node; node = parent(node)) if (node.matches(media)) covered = true;
        const value = covered ? "inside" : "root";
        if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
        marked.add(element);
      }
      const sources = invert ? branchSources(roots) : new Set(roots.size ? [document, ...getShadowRoots()] : []);
      const scopes = invert ? new Set([...sources].map(source => source.getRootNode())) : sources;
      paintInclusions(roots, sources, protectedSet);
      geometryNeeded = cutouts?.paint(owners, protectedTargets, suspendProtection, boundaries) === true;
      if (geometryFrame) { cancelAnimationFrame(geometryFrame); geometryFrame = 0; }
      trackGeometry();
      for (const [scope, style] of styles) if (!scopes.has(scope)) { style.remove(); styles.delete(scope); }
      const watching = new Set(active && (rules.length || preview || editorDraft) ? [document, ...getShadowRoots()] : []);
      if (watching.size !== observedScopes.size || [...watching].some(scope => !observedScopes.has(scope))) {
        observer.disconnect();
        observedScopes = watching;
        for (const scope of watching) {
          observer.observe(scope, { childList: true, subtree: true, attributes: true, attributeOldValue: invert,
            attributeFilter: invert ? ["id", "class", "style", "slot", "name", "open"] : ["id", "class"] });
          // Popover events do not leave their shadow tree, so each one is watched itself.
          if (invert && scope !== document && !toggleScopes.has(scope)) {
            toggleScopes.add(scope);
            for (const type of toggleEvents) scope.addEventListener(type, schedule, true);
          }
        }
      }
      for (const scope of scopes) {
        if (styles.get(scope)?.isConnected) continue;
        const style = document.createElement("style");
        style.setAttribute("data-hdm-rule-style", "");
        const rootSelector = invert ? "html.dmx-on.dmx-site-universal.dmx-mode-selected" : "html.dmx-on.dmx-site-universal:not(.dmx-mode-selected)";
        const prefix = scope === document ? rootSelector : `:host-context(${rootSelector})`;
        style.textContent = invert ? `@media screen {
          ${prefix} [${attribute}="root"] { filter: invert(90%) hue-rotate(180deg) !important; }
          ${prefix} [data-hdm-invert-media="root"] { filter: invert(100%) hue-rotate(180deg) !important; }
          ${prefix} [data-hdm-invert-media="inside"],
          ${prefix} [data-hdm-invert-fullscreen="original"] { filter: none !important; }
          ${prefix} [data-hdm-invert-fullscreen="invert"] { filter: invert(90%) hue-rotate(180deg) !important; }
          ${prefix} [data-hdm-invert-fullscreen="invert"]::backdrop { filter: brightness(10%) !important; }
          ${prefix} [data-hdm-cutout="mask"] { filter: var(--hdm-cutout-filter) !important; }
          ${prefix} [data-hdm-cutout="blocked"] { filter: var(--hdm-cutout-filter) !important; }
        }` : `@media screen {
          ${prefix} [${attribute}="root"] { filter: invert(100%) hue-rotate(180deg) !important; }
          ${prefix} [${attribute}="root"] :is(${media}) { filter: none !important; }
          ${prefix} [${attribute}="root"]:is(:fullscreen, :modal, :popover-open),
          ${prefix} [${attribute}="root"] :is(:modal, :popover-open) { filter: none !important; }
          ${prefix} [${attribute}="root"]::backdrop,
          ${prefix} [${attribute}="root"] :is(:modal, :popover-open)::backdrop { filter: none !important; }
          ${scope === document ? "html:not(*)" : prefix + `:host-context([${attribute}="root"])`} :is(${media}, :modal, :popover-open) { filter: none !important; }
          ${scope === document ? "html:not(*)" : prefix + `:host-context([${attribute}="root"])`} :is(:modal, :popover-open)::backdrop { filter: none !important; }
        }`;
        (scope === document ? document.head || document.documentElement : scope).appendChild(style);
        styles.set(scope, style);
      }
      picker?.refresh();
    }
    function set(next, enabled, nextProtections = []) {
      rules = invert ? HdmRules.normalizeInclusions(next) : HdmRules.normalizeExclusions(next);
      protections = HdmRules.normalizeExclusions(nextProtections);
      active = enabled;
      if (invert) {
        document.removeEventListener("fullscreenchange", schedule);
        document.removeEventListener("visibilitychange", trackGeometry);
        // Popovers open without an attribute change; these events do not bubble.
        for (const type of toggleEvents) document.removeEventListener(type, schedule, true);
        if (active) document.addEventListener("fullscreenchange", schedule);
        if (active) document.addEventListener("visibilitychange", trackGeometry);
        if (active) for (const type of toggleEvents) document.addEventListener(type, schedule, true);
        if (!active) for (const scope of getShadowRoots()) {
          if (!toggleScopes.delete(scope)) continue;
          for (const type of toggleEvents) scope.removeEventListener(type, schedule, true);
        }
      }
      if (!active) picker?.close();
      paint();
    }
    const renderer = {
      set, schedule, refresh: paint, isEditing: () => Boolean(picker),
      snapshot() { return { rules, protections, legacyCoversRoot, coveringRule }; },
      blocked(roots) { return Boolean(cutouts?.blocked(roots)); },
      preview(value) { preview = value?.exclusion || null; editorDraft = value?.draft || null; paint(); },
      endEdit(saved) {
        // The stored library arrives through a later storage read. Showing the saved
        // rule at once keeps the block from flashing back to its old colors meanwhile.
        if (saved && active) {
          const [rule] = invert ? HdmRules.normalizeInclusions([saved.rule]) : HdmRules.normalizeExclusions([saved.rule]);
          const replaced = saved.original ? ruleKey(saved.original) : rule && ruleKey(rule);
          if (rule) rules = rules.some(existing => ruleKey(existing) === replaced)
            ? rules.map(existing => ruleKey(existing) === replaced ? rule : existing)
            : [...rules.filter(existing => ruleKey(existing) !== ruleKey(rule)), rule];
          const removed = new Set((saved.removeLegacyProtections || []).map(ruleKey));
          if (removed.size) protections = protections.filter(existing => !removed.has(ruleKey(existing)));
        }
        picker = null; preview = null; editorDraft = null; paint();
      },
      start(language, origin, initialRule = null) {
        if (!active) throw new Error("site_paused");
        if (invert && picker) { picker.focus(); throw Error("editor_open"); }
        if (initialRule) {
          const normalized = HdmRules.normalizeInclusions([initialRule])[0];
          const existing = normalized && rules.find(rule => ruleKey(rule) === ruleKey(normalized));
          if (!invert || !existing || JSON.stringify(existing) !== JSON.stringify(normalized)) throw Error("settings_changed");
          initialRule = existing;
        }
        picker?.close();
        picker = HdmPicker.open(renderer, { invert, language, origin, initialRule });
      }
    };
    return renderer;
  }
  global.HdmRulePainter = { create };
})(globalThis);
