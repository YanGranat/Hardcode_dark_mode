(function exposePicker(global) {
  const { allowed, parent, selectionFor, ruleFor, resolveRules, inside } = HdmSelectors;
  const ruleKey = HdmRules.identity;
  function open(renderer, { invert, language, origin, initialRule }) {
    let preview = null,
      editorDraft = null,
      closed = false;
    function paint() {
      if (!closed) renderer.preview({ exclusion: preview, draft: editorDraft });
    }
    let target = null,
      locked = false,
      saving = false,
      matchAll = false;
    let choosingException = false,
      exceptionIndex = -1,
      parentRule = null,
      parentTarget = null,
      originalRule = null;
    let draftExceptions = [],
      selectedRule = null,
      listSignature = "",
      legacySignature = "",
      legacyRemoved = [],
      lastGeometryBlocked = false,
      lastWarning = null;
    // "adopted": a saved rule picked up only because the selection happened to match
    // it. Unlike a rule opened from the popup, it must not be overwritten once the
    // selection moves on; "borrowed" are the exceptions that came with it.
    let adopted = false,
      borrowed = new Set(),
      awaitingRoot = false,
      dirty = false;
    const explicitEdit = () => Boolean(originalRule && !adopted);
    const ownDraft = () => dirty && Boolean(originalRule || draftExceptions.length || legacyRemoved.length);
    // Changing anything in a draft makes it the user's own work, adopted rule included.
    const touch = () => {
      dirty = true;
      adopted = false;
      borrowed = new Set();
    };
    const groupOutlines = [];
    const exceptionOutlines = [];
    const history = [];
    const view = HdmPickerView.create({
      invert,
      language,
      actions: {
        resize,
        chooseScope,
        beginException,
        finishException,
        save: saveRule,
        cancel() {
          if (!saving) close();
        },
      },
    });
    const {
      text,
      host,
      shadow,
      panel,
      outline,
      title,
      status,
      larger,
      smaller,
      one,
      similar,
      matchCount,
      rootContext,
      exceptionsSection,
      exceptionList,
      emptyExceptions,
      addException,
      legacySection,
      legacyList,
      back,
      applyException,
      save,
      cancel,
      button,
      previousFocus,
    } = view;
    view.mount();
    async function saveRule() {
      if (!target || saving || choosingException) return;
      if (renderer.snapshot().legacyCoversRoot) {
        status.textContent = text.legacyConflict;
        return;
      }
      if (renderer.snapshot().coveringRule) {
        status.textContent = text.coveringConflict.replace("{block}", () => renderer.snapshot().coveringRule);
        return;
      }
      if (invert && renderer.blocked(parentRoots())) {
        status.textContent = text.unsafe;
        return;
      }
      let rule;
      try {
        rule = invert ? { ...parentRule, protections: draftExceptions } : preview;
        if (!rule || !resolveRules([rule]).length) throw Error("selector_unavailable");
      } catch {
        status.textContent = text.unavailable;
        return;
      }
      saving = true;
      draw();
      status.textContent = text.saving;
      try {
        await HdmRequests.send(
          () =>
            chrome.runtime.sendMessage({
              type: invert ? "hdm-inversion-save" : "hdm-exclusion-add",
              origin,
              rule,
              ...(invert && originalRule ? { previousRule: originalRule } : {}),
              ...(invert && legacyRemoved.length ? { removeLegacyProtections: legacyRemoved } : {}),
            }),
          10000,
          "timeout",
        );
        if (!closed)
          close({
            rule,
            original: invert ? originalRule : null,
            removeLegacyProtections: invert ? legacyRemoved : [],
          });
      } catch (error) {
        if (!closed) {
          saving = false;
          draw();
          status.textContent =
            error.message === "timeout"
              ? text.timeout
              : error.message === "too_many_rules"
                ? text.limit
                : ["rule_conflict", "settings_changed"].includes(error.message)
                  ? text.conflict
                  : text.failed;
        }
      }
    }
    function currentRule() {
      return matchAll ? HdmSelectors.groupRuleFor(target) : ruleFor(target);
    }
    function existingRule(rule) {
      const saved = renderer.snapshot().rules;
      const exact = saved.find((existing) => ruleKey(existing) === ruleKey(rule));
      if (exact || rule.matchAll) return exact || null;
      const aliases = saved.filter(
        (existing) => !existing.matchAll && resolveRules([existing])[0] === target,
      );
      if (aliases.length > 1) throw Error("rule_conflict");
      return aliases[0] || null;
    }
    function parentRoots() {
      return parentRule ? resolveRules([parentRule]) : [];
    }
    function exceptionMatches(rule) {
      const roots = parentRoots();
      return rule
        ? resolveRules([rule]).filter((element) => !roots.includes(element) && inside(element, roots))
        : [];
    }
    function refreshDraft() {
      if (!invert) return;
      const next = draftExceptions.filter((_, index) => !choosingException || index !== exceptionIndex);
      if (choosingException && locked && selectedRule && exceptionMatches(selectedRule).length)
        next.push(selectedRule);
      editorDraft = parentRule
        ? {
            original: originalRule,
            rule: { ...parentRule, protections: next },
            removeLegacyProtections: legacyRemoved,
          }
        : null;
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
        draftExceptions = HdmRules.normalizeExclusions(existing.protections);
      }
      refreshDraft();
    }
    function beginException(index = -1) {
      if (saving || !parentRule) return;
      awaitingRoot = false;
      choosingException = true;
      exceptionIndex = index;
      selectedRule = index >= 0 ? draftExceptions[index] : null;
      target = selectedRule ? exceptionMatches(selectedRule)[0] || null : null;
      locked = Boolean(target);
      matchAll = selectedRule?.matchAll === true;
      history.length = 0;
      refreshDraft();
      paint();
      status.textContent = locked ? text.exceptionChosen : text.exceptionHint;
      draw();
      panel.focus({ preventScroll: true });
    }
    function finishException(apply) {
      if (saving) return;
      if (apply) {
        if (
          !selectedRule ||
          !exceptionMatches(selectedRule).length ||
          renderer.blocked(parentRoots()) ||
          renderer.snapshot().legacyCoversRoot ||
          renderer.snapshot().coveringRule
        )
          return;
        const next = [...draftExceptions];
        if (exceptionIndex >= 0) next[exceptionIndex] = selectedRule;
        else if (!next.some((rule) => ruleKey(rule) === ruleKey(selectedRule))) next.push(selectedRule);
        if (next.length > HdmRules.MAX_RULES) {
          status.textContent = text.limit;
          return;
        }
        draftExceptions = HdmRules.normalizeExclusions(next);
        touch();
      }
      choosingException = false;
      exceptionIndex = -1;
      target = parentRoots()[0] || parentTarget;
      selectedRule = parentRule;
      matchAll = parentRule?.matchAll === true;
      locked = Boolean(target?.isConnected);
      history.length = 0;
      refreshDraft();
      paint();
      status.textContent = text.chosen;
      draw();
      addException.focus({ preventScroll: true });
    }
    function updatePreview() {
      if (!locked) return;
      let existing = null;
      try {
        selectedRule = currentRule();
        if (choosingException && exceptionIndex >= 0) {
          const metadata = draftExceptions[exceptionIndex];
          if (metadata?.name) selectedRule.name = metadata.name;
          if (metadata?.enabled === false) selectedRule.enabled = false;
        }
        if (!choosingException) existing = existingRule(selectedRule);
      } catch (error) {
        selectedRule = null;
        status.textContent = error.message === "rule_conflict" ? text.conflict : text.unavailable;
      }
      if (invert) {
        if (!choosingException && selectedRule) {
          if (adopted && ruleKey(selectedRule) !== ruleKey(originalRule)) {
            originalRule = null;
            adopted = false;
            draftExceptions = draftExceptions.filter((rule) => !borrowed.has(ruleKey(rule)));
            borrowed = new Set();
          }
          const adoptedRule = !originalRule && !draftExceptions.length ? existing : null;
          loadParent(selectedRule, target, adoptedRule);
          if (adoptedRule) {
            adopted = true;
            borrowed = new Set(draftExceptions.map(ruleKey));
          }
        }
        refreshDraft();
      } else preview = existing || selectedRule;
      if (selectedRule) status.textContent = choosingException ? text.exceptionChosen : text.chosen;
      paint();
    }
    function chooseScope(all) {
      if (!locked || saving) return;
      matchAll = all;
      updatePreview();
      draw();
    }
    function draw() {
      if (closed) return;
      if (invert && !choosingException && parentRule && !saving) {
        awaitingRoot = false;
        if (!locked || !target?.isConnected) {
          const restored = resolveRules([parentRule])[0];
          // While a saved rule or a changed draft waits for its block to return,
          // pointer selection stays off: it would retarget it to an unrelated element.
          const keep = explicitEdit() || ownDraft();
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
      if (target && !target.isConnected && !saving) {
        target = selectedRule
          ? (choosingException ? exceptionMatches(selectedRule) : resolveRules([selectedRule]))[0] || null
          : null;
        history.length = 0;
        if (!target) {
          locked = false;
          selectedRule = null;
          preview = null;
          status.textContent = choosingException ? text.exceptionHint : text.hint;
          refreshDraft();
          queueMicrotask(paint);
        }
      }
      if (target?.isConnected) {
        const rect = target.getBoundingClientRect();
        outline.hidden = false;
        outline.style.background = locked ? "transparent" : "";
        Object.assign(outline.style, {
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        });
      } else outline.hidden = true;
      let groupRule = locked && matchAll ? selectedRule : null;
      if (target && !groupRule)
        try {
          groupRule = HdmSelectors.groupRuleFor(target);
        } catch {
          /* Exact selection remains available. */
        }
      const matches =
        matchAll && groupRule
          ? choosingException
            ? exceptionMatches(groupRule)
            : HdmSelectors.resolveRules([groupRule])
          : [];
      while (groupOutlines.length > matches.length) groupOutlines.pop().remove();
      for (const [index, element] of matches.entries()) {
        const box = groupOutlines[index] || document.createElement("div");
        if (!groupOutlines[index]) {
          box.style.background = "transparent";
          shadow.insertBefore(box, panel);
          groupOutlines.push(box);
        }
        const nextClass = choosingException ? "outline exception-outline" : "outline";
        if (box.className !== nextClass) box.className = nextClass;
        const rect = element.getBoundingClientRect();
        Object.assign(box.style, {
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        });
      }
      if (matchAll) outline.hidden = true;
      one.disabled = !locked || saving;
      similar.disabled = !locked || !groupRule || saving;
      similar.title = groupRule
        ? groupRule.path.some((part) => part.includes(" > "))
          ? text.containerGroup
          : ""
        : text.noGroup;
      one.setAttribute("aria-pressed", String(!matchAll));
      similar.setAttribute("aria-pressed", String(matchAll));
      matchCount.hidden = !locked;
      const previewMatches =
        locked && selectedRule
          ? choosingException
            ? exceptionMatches(selectedRule)
            : resolveRules([selectedRule])
          : [];
      const countText = text.matches + previewMatches.length;
      if (matchCount.textContent !== countText) matchCount.textContent = countText;
      if (invert && parentRule && !saving) {
        const coveringMessage = renderer.snapshot().coveringRule
          ? text.coveringConflict.replace("{block}", () => renderer.snapshot().coveringRule)
          : null;
        const warning = !parentRoots().length
          ? text.rootMissing
          : renderer.snapshot().legacyCoversRoot
            ? text.legacyConflict
            : coveringMessage || (renderer.blocked(parentRoots()) ? text.unsafe : null);
        if (warning && status.textContent !== warning) status.textContent = warning;
        else if (!warning && lastWarning && status.textContent === lastWarning) {
          status.textContent = choosingException
            ? locked
              ? text.exceptionChosen
              : text.exceptionHint
            : text.chosen;
        }
        lastWarning = warning;
      }
      const outlineClass = choosingException ? "outline exception-outline" : "outline";
      if (outline.className !== outlineClass) outline.className = outlineClass;
      const titleText = choosingException ? text.exceptionTitle : text.title;
      if (title.textContent !== titleText) title.textContent = titleText;
      rootContext.hidden = !invert || !parentRule;
      const contextText = text.rootLabel + (parentRule ? HdmRules.displayLabel(parentRule) : "");
      if (rootContext.textContent !== contextText) rootContext.textContent = contextText;
      exceptionsSection.hidden = !invert || !parentRule || choosingException;
      addException.disabled =
        saving ||
        renderer.snapshot().legacyCoversRoot ||
        Boolean(renderer.snapshot().coveringRule) ||
        !parentRoots().length ||
        draftExceptions.length >= HdmRules.MAX_RULES;
      back.hidden = applyException.hidden = !choosingException;
      back.disabled = saving;
      const applyText = exceptionIndex >= 0 ? text.updateException : text.applyException;
      if (applyException.textContent !== applyText) applyException.textContent = applyText;
      applyException.disabled =
        !locked ||
        !previewMatches.length ||
        saving ||
        renderer.snapshot().legacyCoversRoot ||
        Boolean(renderer.snapshot().coveringRule) ||
        Boolean(renderer.blocked(parentRoots()));
      save.hidden = choosingException;
      save.disabled =
        !locked ||
        !previewMatches.length ||
        saving ||
        renderer.snapshot().legacyCoversRoot ||
        Boolean(renderer.snapshot().coveringRule) ||
        Boolean(invert && renderer.blocked(parentRoots()));
      larger.disabled =
        !target ||
        !allowed(parent(target)) ||
        (choosingException && !inside(parent(target), parentRoots())) ||
        saving;
      smaller.disabled = !history.length || saving;
      cancel.disabled = saving;
      lastGeometryBlocked = Boolean(invert && parentRule && renderer.blocked(parentRoots()));
      drawExceptions();
      drawLegacy();
    }
    function drawLegacy() {
      legacySection.hidden =
        !invert || !parentRule || choosingException || !renderer.snapshot().protections.length;
      if (renderer.snapshot().legacyCoversRoot && !legacySection.open) legacySection.open = true;
      const removed = new Set(legacyRemoved.map((rule) => JSON.stringify(rule)));
      const remaining = renderer.snapshot().protections.filter((rule) => !removed.has(JSON.stringify(rule)));
      const signature = JSON.stringify([remaining, saving]);
      if (signature === legacySignature) return;
      legacySignature = signature;
      const restoreFocus = preserveListFocus(legacyList);
      legacyList.replaceChildren();
      for (const rule of remaining) {
        const row = document.createElement("div");
        row.className = "exception-row";
        row.dataset.rule = ruleKey(rule);
        const label = document.createElement("span");
        label.className = "exception-name";
        label.textContent = HdmRules.displayLabel(rule);
        const remove = button(
          "removeLegacy",
          () => {
            if (saving) return;
            legacyRemoved = legacyRemoved.filter((existing) => ruleKey(existing) !== ruleKey(rule));
            legacyRemoved.push(rule);
            touch();
            refreshDraft();
            paint();
          },
          row,
          "M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5",
        );
        remove.className = "icon-button";
        remove.replaceChildren(remove.querySelector("svg"));
        remove.title = text.removeLegacy;
        remove.setAttribute("aria-label", text.removeLegacy);
        remove.disabled = saving;
        row.prepend(label);
        legacyList.append(row);
      }
      restoreFocus();
    }
    function preserveListFocus(list) {
      const active = shadow.activeElement;
      if (!list.contains(active)) return () => {};
      const key = active.closest("[data-rule]")?.dataset.rule,
        action = active.dataset.action;
      const index = [...list.children].indexOf(active.closest("[data-rule]")),
        top = list.scrollTop;
      return () => {
        const row =
          [...list.children].find((row) => row.dataset.rule === key) ||
          list.children[Math.min(index, list.children.length - 1)];
        const next = row?.querySelector(`[data-action="${action}"]`);
        if (next && !next.disabled && next.getClientRects().length) next.focus({ preventScroll: true });
        else if (addException.getClientRects().length && !addException.disabled)
          addException.focus({ preventScroll: true });
        list.scrollTop = top;
      };
    }
    function drawExceptions() {
      if (!invert) return;
      const parents = parentRoots();
      const activeExceptions = draftExceptions.flatMap((rule) => exceptionMatches(rule));
      const rectangles = [...new Set([...(choosingException ? parents : []), ...activeExceptions])];
      while (exceptionOutlines.length > rectangles.length) exceptionOutlines.pop().remove();
      for (const [index, element] of rectangles.entries()) {
        const box = exceptionOutlines[index] || document.createElement("div");
        if (!exceptionOutlines[index]) {
          box.style.background = "transparent";
          shadow.insertBefore(box, panel);
          exceptionOutlines.push(box);
        }
        const nextClass = parents.includes(element) ? "outline" : "outline exception-outline";
        if (box.className !== nextClass) box.className = nextClass;
        const rect = element.getBoundingClientRect();
        Object.assign(box.style, {
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        });
      }
      const counts = draftExceptions.map((rule) => exceptionMatches(rule).length);
      const signature = JSON.stringify([draftExceptions, counts, saving]);
      if (signature === listSignature) return;
      listSignature = signature;
      const restoreFocus = preserveListFocus(exceptionList);
      exceptionList.replaceChildren();
      emptyExceptions.hidden = Boolean(draftExceptions.length);
      for (const [index, rule] of draftExceptions.entries()) {
        const row = document.createElement("div");
        row.className = "exception-row";
        row.dataset.rule = ruleKey(rule);
        const edit = button("editException", () => beginException(index), row);
        edit.className = "exception-name";
        edit.textContent = `${HdmRules.displayLabel(rule)} (${counts[index]})`;
        edit.title = text.editException;
        edit.disabled = saving;
        const remove = button(
          "removeException",
          () => {
            if (saving) return;
            draftExceptions.splice(index, 1);
            touch();
            refreshDraft();
            paint();
          },
          row,
          "M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5",
        );
        remove.className = "icon-button";
        remove.replaceChildren(remove.querySelector("svg"));
        remove.title = text.removeException;
        remove.setAttribute("aria-label", text.removeException);
        remove.disabled = saving;
        exceptionList.append(row);
      }
      restoreFocus();
    }
    function resize(up) {
      if (saving) return;
      if (
        up &&
        target &&
        allowed(parent(target)) &&
        (!choosingException || inside(parent(target), parentRoots()))
      ) {
        history.push(target);
        target = parent(target);
      } else if (!up && history.length) target = history.pop();
      if (locked) updatePreview();
      draw();
    }
    function pickSelection(element) {
      if (!element) return { target: null, history: [] };
      const selection = selectionFor(element);
      if (!choosingException || inside(selection.target, parentRoots())) return selection;
      return inside(element, parentRoots())
        ? { target: element, history: [] }
        : { target: null, history: [] };
    }
    function move(event) {
      if (locked || awaitingRoot || own(event)) return;
      const element = hit(event);
      if (element !== target) {
        const selection = pickSelection(element);
        if (choosingException && !selection.target && status.textContent !== text.insideOnly)
          status.textContent = text.insideOnly;
        if (
          selection.target === target &&
          selection.history.length === history.length &&
          selection.history.every((node, index) => node === history[index])
        )
          return;
        target = selection.target;
        history.splice(0, history.length, ...selection.history);
        if (choosingException && !target && status.textContent !== text.insideOnly)
          status.textContent = text.insideOnly;
        draw();
      }
    }
    function click(event) {
      if (own(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (saving || awaitingRoot) return;
      if (locked) {
        // A second click corrects a misplaced first one. It is ignored where it would
        // silently move a saved rule or collected exceptions to another element.
        if (!choosingException && invert && (explicitEdit() || ownDraft())) return;
        const selection = pickSelection(hit(event));
        if (!selection.target || selection.target === target) return;
        target = selection.target;
        history.splice(0, history.length, ...selection.history);
        matchAll = false;
      } else if (!target?.isConnected) return;
      locked = true;
      updatePreview();
      draw();
    }
    function block(event) {
      if (!own(event)) {
        if (!target && !locked && !awaitingRoot) {
          const element = hit(event);
          if (element) {
            const selection = pickSelection(element);
            target = selection.target;
            history.splice(0, history.length, ...selection.history);
          }
          draw();
        }
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }
    function close(saved) {
      if (closed) return;
      closed = true;
      preview = editorDraft = null;
      input.disconnect();
      host.remove();
      renderer.endEdit(saved?.rule ? saved : undefined);
      if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
    }
    const input = HdmPickerInput.connect({
      host,
      panel,
      shadow,
      onMove: move,
      onClick: click,
      onPointer: block,
      onResize: resize,
      onEscape() {
        if (!saving) choosingException ? finishException(false) : close();
      },
      onClose: close,
      refresh: draw,
    });
    const { own, hit } = input;
    const editor = {
      close,
      refresh: draw,
      focus() {
        panel.focus({ preventScroll: true });
      },
      geometry() {
        const blocked = Boolean(invert && parentRule && renderer.blocked(parentRoots()));
        if (blocked !== lastGeometryBlocked) draw();
      },
    };
    if (invert && initialRule) {
      const node = resolveRules([initialRule])[0];
      if (!node) {
        close();
        throw Error("selector_unavailable");
      }
      loadParent(initialRule, node, initialRule);
      status.textContent = text.chosen;
      paint();
    }
    draw();

    return editor;
  }
  global.HdmPicker = { open };
})(globalThis);
