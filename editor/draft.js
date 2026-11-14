(function exposePickerDraft(global) {
  const { allowed, parent, selectionFor, ruleFor, resolveRules, inside } = HdmSelectors;
  const identity = HdmRules.identity;

  function create({ invert, rules, initialRule = null }) {
    let target = null, locked = false, matchAll = false, selectedRule = null;
    let choosingException = false, exceptionIndex = -1, awaitingRoot = false;
    let parentRule = null, parentTarget = null, originalRule = null, pagePreview = null;
    let exceptions = [], legacyRemoved = [], adopted = false, borrowed = new Set(), dirty = false;
    const history = [];
    const roots = () => parentRule ? resolveRules([parentRule]) : [];
    const matchesInside = (rule, parents = roots()) => rule
      ? resolveRules([rule]).filter(element => !parents.includes(element) && inside(element, parents)) : [];
    const explicitEdit = () => Boolean(originalRule && !adopted);
    const ownDraft = () => dirty && Boolean(originalRule || exceptions.length || legacyRemoved.length);
    const canGrow = () => Boolean(target && allowed(parent(target)) &&
      (!choosingException || inside(parent(target), roots())));

    function touch() {
      dirty = true;
      adopted = false;
      borrowed = new Set();
    }

    function existingRule(rule) {
      const saved = rules();
      const exact = saved.find(existing => identity(existing) === identity(rule));
      if (exact || rule.matchAll) return exact || null;
      const aliases = saved.filter(existing => !existing.matchAll && resolveRules([existing])[0] === target);
      if (aliases.length > 1) throw Error("rule_conflict");
      return aliases[0] || null;
    }

    function loadParent(rule, node, existing = null) {
      const metadata = existing || ((originalRule || dirty) ? parentRule : null);
      parentRule = { ...rule };
      if (metadata?.name) parentRule.name = metadata.name;
      if (metadata?.enabled === false) parentRule.enabled = false;
      delete parentRule.protections;
      parentTarget = target = node;
      selectedRule = parentRule;
      locked = true;
      matchAll = rule.matchAll === true;
      if (existing) {
        originalRule = HdmRules.normalizeInclusions([existing])[0];
        exceptions = HdmRules.normalizeExclusions(existing.protections);
      }
    }

    function updateSelection() {
      if (!locked) return {};
      let existing = null, status;
      try {
        selectedRule = matchAll ? HdmSelectors.groupRuleFor(target) : ruleFor(target);
        if (choosingException && exceptionIndex >= 0) {
          const metadata = exceptions[exceptionIndex];
          if (metadata?.name) selectedRule.name = metadata.name;
          if (metadata?.enabled === false) selectedRule.enabled = false;
        }
        if (!choosingException) existing = existingRule(selectedRule);
      } catch (error) {
        selectedRule = null;
        status = error.message === "rule_conflict" ? "conflict" : "unavailable";
      }
      if (invert) {
        if (!choosingException && selectedRule) {
          // Untouched adopted rules lend their exceptions only while that rule remains selected.
          if (adopted && identity(selectedRule) !== identity(originalRule)) {
            originalRule = null;
            adopted = false;
            exceptions = exceptions.filter(rule => !borrowed.has(identity(rule)));
            borrowed = new Set();
          }
          const adoptedRule = !originalRule && !exceptions.length ? existing : null;
          loadParent(selectedRule, target, adoptedRule);
          if (adoptedRule) {
            adopted = true;
            borrowed = new Set(exceptions.map(identity));
          }
        }
      } else pagePreview = existing || selectedRule;
      return { status: selectedRule ? choosingException ? "exceptionChosen" : "chosen" : status, paint: true };
    }

    function selection(element) {
      if (!element) return { target: null, history: [] };
      const next = selectionFor(element);
      if (!choosingException || inside(next.target, roots())) return next;
      return inside(element, roots()) ? { target: element, history: [] } : { target: null, history: [] };
    }

    function hover(element) {
      if (locked || awaitingRoot || element === target) return {};
      const next = selection(element);
      if (next.target === target && next.history.length === history.length &&
          next.history.every((node, index) => node === history[index])) return {};
      target = next.target;
      history.splice(0, history.length, ...next.history);
      return { changed: true, status: choosingException && !target ? "insideOnly" : null };
    }

    function pointer(element) {
      if (target || locked || awaitingRoot) return {};
      const next = selection(element);
      target = next.target;
      history.splice(0, history.length, ...next.history);
      return { changed: true };
    }

    function select(element) {
      if (awaitingRoot) return {};
      if (locked) {
        if (!choosingException && invert && (explicitEdit() || ownDraft())) return {};
        const next = selection(element);
        if (!next.target || next.target === target) return {};
        target = next.target;
        history.splice(0, history.length, ...next.history);
        matchAll = false;
      } else if (!target?.isConnected) return {};
      locked = true;
      return updateSelection();
    }

    function resize(up) {
      if (up && canGrow()) {
        history.push(target);
        target = parent(target);
      } else if (!up && history.length) target = history.pop();
      return locked ? updateSelection() : { changed: true };
    }

    function scope(all) {
      if (!locked) return {};
      matchAll = all;
      return updateSelection();
    }

    function beginException(index = -1) {
      if (!parentRule) return {};
      awaitingRoot = false;
      choosingException = true;
      exceptionIndex = index;
      selectedRule = index >= 0 ? exceptions[index] : null;
      target = selectedRule ? matchesInside(selectedRule)[0] || null : null;
      locked = Boolean(target);
      matchAll = selectedRule?.matchAll === true;
      history.length = 0;
      return { status: locked ? "exceptionChosen" : "exceptionHint", paint: true };
    }

    function finishException(apply) {
      if (apply) {
        if (!selectedRule || !matchesInside(selectedRule).length) return { accepted: false };
        const next = [...exceptions];
        if (exceptionIndex >= 0) next[exceptionIndex] = selectedRule;
        else if (!next.some(rule => identity(rule) === identity(selectedRule))) next.push(selectedRule);
        if (next.length > HdmRules.MAX_RULES) return { accepted: false, status: "limit" };
        exceptions = HdmRules.normalizeExclusions(next);
        touch();
      }
      choosingException = false;
      exceptionIndex = -1;
      target = roots()[0] || parentTarget;
      selectedRule = parentRule;
      matchAll = parentRule?.matchAll === true;
      locked = Boolean(target?.isConnected);
      history.length = 0;
      return { accepted: true, status: "chosen", paint: true };
    }

    function removeException(index) {
      exceptions = exceptions.filter((_, existing) => existing !== index);
      touch();
      return { paint: true };
    }

    function removeLegacy(rule) {
      legacyRemoved = legacyRemoved.filter(existing => identity(existing) !== identity(rule));
      legacyRemoved.push(rule);
      touch();
      return { paint: true };
    }

    function reconcile() {
      if (invert && !choosingException && parentRule) {
        awaitingRoot = false;
        if (!locked || !target?.isConnected) {
          const restored = roots()[0], keep = explicitEdit() || ownDraft();
          if (restored || keep || !target?.isConnected) {
            target = parentTarget = restored || null;
            selectedRule = parentRule;
            matchAll = parentRule.matchAll === true;
            locked = Boolean(restored);
            history.length = 0;
          }
          awaitingRoot = !restored && keep;
        }
      }
      if (target && !target.isConnected) {
        target = selectedRule ? (choosingException ? matchesInside(selectedRule) : resolveRules([selectedRule]))[0] || null : null;
        history.length = 0;
        if (!target) {
          locked = false;
          selectedRule = pagePreview = null;
          return { status: choosingException ? "exceptionHint" : "hint", paint: true };
        }
      }
      return {};
    }

    function snapshot() {
      const parents = roots();
      const selectedMatches = locked && selectedRule
        ? choosingException ? matchesInside(selectedRule, parents) : resolveRules([selectedRule]) : [];
      let groupRule = locked && matchAll ? selectedRule : null;
      if (target && !groupRule) try { groupRule = HdmSelectors.groupRuleFor(target); } catch {}
      const groupMatches = matchAll && groupRule
        ? choosingException ? matchesInside(groupRule, parents) : resolveRules([groupRule]) : [];
      const next = exceptions.filter((_, index) => !choosingException || index !== exceptionIndex);
      if (choosingException && locked && selectedRule && selectedMatches.length) next.push(selectedRule);
      const draft = invert && parentRule ? {
        original: originalRule, rule: { ...parentRule, protections: next }, removeLegacyProtections: legacyRemoved,
      } : null;
      return {
        target, locked, matchAll, selectedRule, choosingException, exceptionIndex, awaitingRoot,
        parentRule, originalRule, exceptions, legacyRemoved, historyLength: history.length, canGrow: canGrow(),
        roots: parents, selectedMatches, groupRule, groupMatches,
        exceptionMatches: exceptions.map(rule => matchesInside(rule, parents)),
        preview: { exclusion: invert ? null : pagePreview, draft },
        save: { rule: invert ? draft?.rule : pagePreview, original: invert ? originalRule : null,
          removeLegacyProtections: invert ? legacyRemoved : [] },
      };
    }

    if (invert && initialRule) {
      const node = resolveRules([initialRule])[0];
      if (!node) throw Error("selector_unavailable");
      loadParent(initialRule, node, initialRule);
    }
    return {
      snapshot, roots,
      selection: () => ({ target, locked, awaitingRoot, choosingException }),
      reconcile, hover, pointer, select, resize, scope, beginException, finishException, removeException, removeLegacy,
    };
  }
  global.HdmPickerDraft = { create };
})(globalThis);
