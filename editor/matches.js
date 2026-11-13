(function exposeMatches(global) {
  function open(rule, { language, parentRule, scopes, onClose }) {
    const text = language === "ru" ? {
      count: "Совпадений", rendered: "Отображается", previous: "Предыдущее", next: "Следующее", close: "Закрыть",
      moveDown: "Переместить панель вниз", moveUp: "Переместить панель вверх",
      overflow: "Слишком много совпадений. Уточните правило.", empty: "На этой странице совпадений нет."
    } : {
      count: "Matches", rendered: "Rendered", previous: "Previous", next: "Next", close: "Close",
      moveDown: "Move panel down", moveUp: "Move panel up",
      overflow: "Too many matches. Narrow the rule.", empty: "No matches on this page."
    };
    const host = document.createElement("div");
    host.setAttribute("data-hdm-picker", "matches");
    host.setAttribute("data-hdm-matches", "");
    host.setAttribute("popover", "manual");
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;margin:0!important;border:0!important;padding:0!important;background:transparent!important;width:auto!important;height:auto!important;max-width:none!important;max-height:none!important;pointer-events:none!important;overflow:visible!important;";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>
      :host{color-scheme:dark}*{box-sizing:border-box}
      .panel{position:fixed;top:12px;left:50%;transform:translateX(-50%);width:420px;max-width:calc(100% - 24px);
        background:#101621;color:#e9eff7;border:1px solid #263148;border-radius:16px;padding:16px;
        font:13px/1.5 "Segoe UI",system-ui,sans-serif;pointer-events:auto;box-shadow:0 12px 32px #0006}
      .panel:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px}
      .header{display:flex;align-items:flex-start;gap:8px;margin-bottom:6px}
      h2{flex:1;min-width:0;font-size:14px;line-height:1.4;margin:0;overflow-wrap:anywhere}p{margin:0;color:#9fb0c7;font-size:12px}
      .buttons{display:flex;gap:6px;margin-top:14px;flex-wrap:wrap}
      button{padding:8px 10px;min-height:34px;background:#1b2333;color:#e9eff7;border:1px solid #263148;
        border-radius:8px;font:600 12px "Segoe UI",system-ui,sans-serif;cursor:pointer}
      button:hover:not(:disabled){background:#2b374e}button:disabled{color:#77869b;cursor:default}
      button:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px}.close{margin-left:auto}
      .move{flex:none;width:28px;min-height:28px;padding:0;border-color:transparent;background:transparent;color:#9fb0c7}
      .move svg{width:16px;height:16px;vertical-align:middle}
      .outline{position:fixed;border:2px solid #61c7ff;pointer-events:none}.outline.current{border-color:#5dd9c1;border-width:3px}
      @media(forced-colors:active){.outline{border-color:Highlight}button:disabled{color:GrayText}}
    </style><section class="panel" role="region" tabindex="-1"><div class="header"><h2></h2></div><p role="status"></p><div class="buttons"></div></section>`;
    const panel = shadow.querySelector(".panel"), title = shadow.querySelector("h2"), status = shadow.querySelector("p");
    title.textContent = HdmRules.displayLabel(rule);
    panel.setAttribute("aria-label", title.textContent);
    const relocate = document.createElement("button"); relocate.type = "button"; relocate.className = "move";
    relocate.title = text.moveDown; relocate.setAttribute("aria-label", relocate.title);
    relocate.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8l4-4 4 4M12 4v16m-4-4 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    relocate.addEventListener("click", () => {
      const bottom = panel.style.bottom === "12px";
      panel.style.top = bottom ? "12px" : "auto"; panel.style.bottom = bottom ? "auto" : "12px";
      relocate.title = bottom ? text.moveDown : text.moveUp; relocate.setAttribute("aria-label", relocate.title);
    });
    shadow.querySelector(".header").append(relocate);
    let focus = document.activeElement;
    while (focus?.shadowRoot?.activeElement) focus = focus.shadowRoot.activeElement;
    let closed = false, frame = 0, index = 0, matches = [], rendered = [], dirty = true, overflow = false;
    const boxes = [], observed = new Set();
    const observer = new MutationObserver(records => {
      if (!host.isConnected) return close();
      if (records.some(record => !HdmSelectors.owned(record.target))) schedule();
    });
    function resolve(value) {
      return value.matchAll ? HdmSelectors.resolveGroupResult(value)
        : { elements: HdmSelectors.resolveRules([value]), overflow: false };
    }
    function observeScopes() {
      const required = new Set(scopes().filter(scope => scope === document || scope.host?.isConnected));
      for (const value of [rule, parentRule].filter(Boolean)) for (const path of [value.path, value.fallbackPath].filter(Boolean)) {
        let roots = [document], visited = 0;
        for (const selector of path.slice(0, -1)) {
          const next = [];
          for (const root of roots) {
            try {
              for (const host of root.querySelectorAll(selector)) {
                if (++visited > 500) break;
                if (host.shadowRoot && !HdmSelectors.owned(host)) { next.push(host.shadowRoot); required.add(host.shadowRoot); }
              }
            } catch { /* Invalid stored selectors resolve to no matches. */ }
          }
          roots = next;
          if (visited > 500 || !roots.length) break;
        }
      }
      if (required.size === observed.size && [...required].every(scope => observed.has(scope))) return;
      observer.disconnect(); observed.clear();
      for (const scope of required) {
        observed.add(scope); observer.observe(scope, { childList: true, subtree: true, attributes: true });
      }
    }
    function button(label, action) {
      const button = document.createElement("button"); button.type = "button";
      button.textContent = label; button.addEventListener("click", action);
      shadow.querySelector(".buttons").append(button); return button;
    }
    const previous = button(text.previous, () => locate(index - 1));
    const next = button(text.next, () => locate(index + 1));
    const dismiss = button(text.close, close); dismiss.className = "close";
    function draw() {
      cancelAnimationFrame(frame);
      frame = 0;
      if (closed || !host.isConnected) return;
      if (dirty) {
        dirty = false;
        const result = resolve(rule), parents = parentRule ? resolve(parentRule) : null;
        overflow = result.overflow || parents?.overflow;
        matches = overflow ? [] : result.elements.filter(element => !HdmSelectors.owned(element) && (!parents ||
          (!parents.elements.includes(element) && HdmSelectors.inside(element, parents.elements))));
        observeScopes();
      }
      rendered = matches.filter(element => {
        const box = element.getBoundingClientRect();
        return element.isConnected && element.getClientRects().length && box.width > 0 && box.height > 0;
      });
      index = Math.min(index, Math.max(0, rendered.length - 1));
      const message = overflow ? text.overflow : !matches.length ? text.empty
        : `${text.count}: ${matches.length} · ${text.rendered}: ${rendered.length}/${matches.length}` +
          (rendered.length ? ` · ${index + 1}/${rendered.length}` : "");
      if (status.textContent !== message) status.textContent = message;
      previous.disabled = next.disabled = rendered.length < 2;
      while (boxes.length > rendered.length) boxes.pop().remove();
      for (const [position, element] of rendered.entries()) {
        const box = boxes[position] || document.createElement("div");
        if (!boxes[position]) { boxes.push(box); shadow.prepend(box); }
        const className = position === index ? "outline current" : "outline";
        if (box.className !== className) box.className = className;
        const rect = element.getBoundingClientRect();
        for (const [key, value] of Object.entries({ left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })) {
          if (box.style[key] !== value) box.style[key] = value;
        }
      }
      if (document.visibilityState !== "hidden") frame = requestAnimationFrame(draw);
    }
    function schedule() { dirty = true; if (!closed && !frame) frame = requestAnimationFrame(draw); }
    function locate(position) {
      if (!rendered.length) return;
      index = (position + rendered.length) % rendered.length;
      rendered[index].scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" }); draw();
    }
    function key(event) { if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); close(); } }
    function visibility() { if (!host.matches(":popover-open")) close(); }
    function close() {
      if (closed) return;
      closed = true; cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule);
      document.removeEventListener("keydown", key, true); document.removeEventListener("hdm-shadow-root", schedule);
      document.removeEventListener("visibilitychange", schedule);
      host.removeEventListener("toggle", visibility); host.remove();
      if (focus?.isConnected) focus.focus?.({ preventScroll: true });
      onClose();
    }
    let modal = focus;
    while (modal && !modal.matches?.(":modal")) modal = HdmSelectors.parent(modal);
    modal ||= [...document.querySelectorAll(":modal")].at(-1);
    (modal || document.documentElement).append(host); host.showPopover();
    window.addEventListener("scroll", schedule, true); window.addEventListener("resize", schedule);
    document.addEventListener("keydown", key, true); document.addEventListener("hdm-shadow-root", schedule);
    document.addEventListener("visibilitychange", schedule);
    host.addEventListener("toggle", visibility);
    draw(); locate(0); panel.focus({ preventScroll: true });
    return { close, refresh: schedule };
  }
  global.HdmMatches = { open };
})(globalThis);
