(function exposePickerInput(global) {
  function connect({
    host,
    panel,
    shadow,
    onMove,
    onClick,
    onPointer,
    onResize,
    onEscape,
    onClose,
    refresh,
  }) {
    const own = (event) => event.composedPath().includes(panel);
    function elementAtPoint(event) {
      host.style.setProperty("pointer-events", "none", "important");
      try {
        let element = document.elementFromPoint(event.clientX, event.clientY);
        while (element?.shadowRoot) {
          const child = element.shadowRoot.elementFromPoint(event.clientX, event.clientY);
          if (!child || child === element) break;
          element = child;
        }
        return element;
      } finally {
        host.style.setProperty("pointer-events", "auto", "important");
      }
    }
    function hit(event) {
      const element = elementAtPoint(event);
      return HdmSelectors.allowed(element) ? element : null;
    }
    function wheel(event) {
      event.stopImmediatePropagation();
      if (own(event) || event.ctrlKey) return;
      event.preventDefault();
      const element = elementAtPoint(event);
      const line = parseFloat(element && getComputedStyle(element).lineHeight) || 16;
      const unit = event.deltaMode === 1 ? line : event.deltaMode === 2 ? innerHeight : 1;
      let x = event.deltaX * unit,
        y = event.deltaY * unit;
      if (event.shiftKey && !x) {
        x = y;
        y = 0;
      }
      for (let node = element; node && (x || y); node = HdmSelectors.composedParent(node)) {
        if (node === document.scrollingElement) break;
        const css = getComputedStyle(node);
        const horizontal = /auto|scroll|overlay/.test(css.overflowX),
          vertical = /auto|scroll|overlay/.test(css.overflowY);
        const left = node.scrollLeft,
          top = node.scrollTop;
        node.scrollBy({ left: horizontal ? x : 0, top: vertical ? y : 0, behavior: "instant" });
        x -= node.scrollLeft - left;
        y -= node.scrollTop - top;
        if (horizontal && css.overscrollBehaviorX !== "auto") x = 0;
        if (vertical && css.overscrollBehaviorY !== "auto") y = 0;
      }
      if (x || y) window.scrollBy({ left: x, top: y, behavior: "instant" });
      refresh();
    }
    function key(event) {
      event.stopImmediatePropagation();
      if (event.key === "Tab") {
        const controls = [
          ...panel.querySelectorAll(
            'button:not(:disabled), summary, input:not(:disabled), select:not(:disabled), ' +
              'textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
          ),
        ].filter((element) => element.getClientRects().length);
        const index = controls.indexOf(shadow.activeElement);
        const next =
          index < 0
            ? event.shiftKey
              ? controls.length - 1
              : 0
            : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        event.preventDefault();
        event.stopImmediatePropagation();
        controls[next]?.focus();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onEscape();
      }
      if (["ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        onResize(event.key === "ArrowUp");
      }
    }
    const stopKey = (event) => event.stopImmediatePropagation();
    function onVisibility() {
      if (!host.matches(":popover-open")) onClose();
    }
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("mousedown", onPointer, true);
    document.addEventListener("pointerup", onPointer, true);
    document.addEventListener("mouseup", onPointer, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("keyup", stopKey, true);
    document.addEventListener("keypress", stopKey, true);
    document.addEventListener("wheel", wheel, { capture: true, passive: false });
    window.addEventListener("scroll", refresh, true);
    window.addEventListener("resize", refresh);
    const lifetime = new MutationObserver(() => {
      if (!host.isConnected) onClose();
    });
    host.addEventListener("toggle", onVisibility);
    const lifetimeScopes = new Set([document]);
    for (let node = host; node; node = HdmSelectors.parent(node)) lifetimeScopes.add(node.getRootNode());
    for (const scope of lifetimeScopes) lifetime.observe(scope, { childList: true, subtree: true });
    function disconnect() {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("mousedown", onPointer, true);
      document.removeEventListener("pointerup", onPointer, true);
      document.removeEventListener("mouseup", onPointer, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("keyup", stopKey, true);
      document.removeEventListener("keypress", stopKey, true);
      document.removeEventListener("wheel", wheel, true);
      host.removeEventListener("toggle", onVisibility);
      lifetime.disconnect();
      window.removeEventListener("scroll", refresh, true);
      window.removeEventListener("resize", refresh);
    }
    return { hit, own, disconnect };
  }
  global.HdmPickerInput = { connect };
})(globalThis);
