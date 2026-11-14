(function exposePicker(global) {
  const { resolveRules } = HdmSelectors;
  const ruleKey = HdmRules.identity;
  function open(renderer, { invert, language, origin, initialRule }) {
    let closed = false, saving = false;
    const draft = HdmPickerDraft.create({ invert, initialRule, rules: () => renderer.snapshot().rules });
    function paint() {
      if (!closed) renderer.preview(draft.snapshot().preview);
    }
    const groupOutlines = [];
    const exceptionOutlines = [];
    let listSignature = "", legacySignature = "", lastGeometryBlocked = false, lastWarning = null;
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
      if (saving) return;
      draft.reconcile();
      const state = draft.snapshot(), saved = state.save;
      if (!state.target || state.choosingException) return;
      const feedback = renderer.snapshot();
      if (feedback.legacyCoversRoot) {
        status.textContent = text.legacyConflict;
        return;
      }
      if (feedback.coveringRule) {
        status.textContent = text.coveringConflict.replace("{block}", () => feedback.coveringRule);
        return;
      }
      if (invert && renderer.blocked(state.roots)) {
        status.textContent = text.unsafe;
        return;
      }
      if (!saved.rule || !resolveRules([saved.rule]).length) {
        status.textContent = text.unavailable;
        return;
      }
      saving = true;
      draw();
      status.textContent = text.saving;
      try {
        await HdmRequests.send(
          () => chrome.runtime.sendMessage({
            type: invert ? "hdm-inversion-save" : "hdm-exclusion-add",
            origin,
            rule: saved.rule,
            ...(invert && saved.original ? { previousRule: saved.original } : {}),
            ...(invert && saved.removeLegacyProtections.length ? { removeLegacyProtections: saved.removeLegacyProtections } : {}),
          }),
          10000,
          "timeout",
        );
        if (!closed) close(saved);
      } catch (error) {
        if (!closed) {
          saving = false;
          refresh();
          status.textContent = error.message === "timeout" ? text.timeout
            : error.message === "too_many_rules" ? text.limit
            : ["rule_conflict", "settings_changed"].includes(error.message) ? text.conflict : text.failed;
        }
      }
    }
    function applyResult(result) {
      if (result.status) status.textContent = text[result.status];
      if (result.paint) paint();
      if (result.paint || result.changed || result.status) refresh();
    }
    function refresh() {
      if (closed) return;
      if (!saving) {
        const result = draft.reconcile();
        if (result.status) status.textContent = text[result.status];
        if (result.paint) queueMicrotask(paint);
      }
      draw(draft.snapshot());
    }
    function beginException(index = -1) {
      if (saving || !draft.snapshot().parentRule) return;
      applyResult(draft.beginException(index));
      panel.focus({ preventScroll: true });
    }
    function finishException(apply) {
      if (saving) return;
      const state = draft.snapshot(), feedback = renderer.snapshot();
      if (apply && (renderer.blocked(state.roots) || feedback.legacyCoversRoot || feedback.coveringRule)) return;
      const result = draft.finishException(apply);
      applyResult(result);
      if (result.accepted) addException.focus({ preventScroll: true });
    }
    function chooseScope(all) {
      if (!saving) applyResult(draft.scope(all));
    }
    function draw(state = draft.snapshot()) {
      if (closed) return;
      const {
        target, locked, matchAll, choosingException, exceptionIndex, parentRule,
        exceptions: draftExceptions, roots, groupRule, groupMatches: matches,
        selectedMatches: previewMatches, historyLength, canGrow,
      } = state;
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
      const countText = text.matches + previewMatches.length;
      if (matchCount.textContent !== countText) matchCount.textContent = countText;
      if (invert && parentRule && !saving) {
        const coveringMessage = renderer.snapshot().coveringRule
          ? text.coveringConflict.replace("{block}", () => renderer.snapshot().coveringRule)
          : null;
        const warning = !roots.length
          ? text.rootMissing
          : renderer.snapshot().legacyCoversRoot
            ? text.legacyConflict
            : coveringMessage || (renderer.blocked(roots) ? text.unsafe : null);
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
        !roots.length ||
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
        Boolean(renderer.blocked(roots));
      save.hidden = choosingException;
      save.disabled =
        !locked ||
        !previewMatches.length ||
        saving ||
        renderer.snapshot().legacyCoversRoot ||
        Boolean(renderer.snapshot().coveringRule) ||
        Boolean(invert && renderer.blocked(roots));
      larger.disabled = !canGrow || saving;
      smaller.disabled = !historyLength || saving;
      cancel.disabled = saving;
      lastGeometryBlocked = Boolean(invert && parentRule && renderer.blocked(roots));
      drawExceptions(state);
      drawLegacy(state);
    }
    function drawLegacy({ parentRule, choosingException, legacyRemoved }) {
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
            applyResult(draft.removeLegacy(rule));
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
    function drawExceptions(state) {
      if (!invert) return;
      const { roots: parents, exceptions: draftExceptions, choosingException, exceptionMatches } = state;
      const activeExceptions = exceptionMatches.flat();
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
      const counts = exceptionMatches.map(matches => matches.length);
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
            applyResult(draft.removeException(index));
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
      if (!saving) applyResult(draft.resize(up));
    }
    function move(event) {
      if (own(event)) return;
      const state = draft.selection();
      if (state.locked || state.awaitingRoot) return;
      applyResult(draft.hover(hit(event)));
    }
    function click(event) {
      if (own(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!saving) applyResult(draft.select(hit(event)));
    }
    function block(event) {
      if (own(event)) return;
      const state = draft.selection();
      if (!state.target && !state.locked && !state.awaitingRoot) applyResult(draft.pointer(hit(event)));
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    function close(saved) {
      if (closed) return;
      closed = true;
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
        if (!saving) draft.selection().choosingException ? finishException(false) : close();
      },
      onClose: close,
      refresh,
    });
    const { own, hit } = input;
    const editor = {
      close,
      refresh,
      focus() {
        panel.focus({ preventScroll: true });
      },
      geometry() {
        const blocked = Boolean(invert && renderer.blocked(draft.roots()));
        if (blocked !== lastGeometryBlocked) refresh();
      },
    };
    if (invert && initialRule) {
      status.textContent = text.chosen;
      paint();
    }
    refresh();

    return editor;
  }
  global.HdmPicker = { open };
})(globalThis);
