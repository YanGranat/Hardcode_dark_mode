(function exposePickerView(global) {
  function create({ invert, language, actions }) {
    const ru = language === "ru";
    const text = ru
      ? {
          title: "Исключить элемент",
          hint: "Нажмите на нужный элемент страницы.",
          chosen: "Проверьте цвета и сохраните исключение.",
          larger: "Крупнее",
          smaller: "Меньше",
          largerHint: "Выбрать весь блок (стрелка вверх)",
          smallerHint: "Вернуться к меньшему элементу (стрелка вниз)",
          move: "Переместить панель вниз",
          moveUp: "Переместить панель вверх",
          save: "Сохранить",
          cancel: "Отмена",
          failed: "Не удалось сохранить. Попробуйте ещё раз.",
          unavailable: "Выберите другой элемент.",
          saving: "Сохранение…",
          limit: "Слишком много исключений. Удалите ненужные в попапе.",
          timeout: "Ответ не получен. Исключение могло сохраниться — проверьте в попапе.",
        }
      : {
          title: "Exclude element",
          hint: "Click the element you want to keep unchanged.",
          chosen: "Check the colors, then save the exclusion.",
          larger: "Larger",
          smaller: "Smaller",
          largerHint: "Select the whole block (up arrow)",
          smallerHint: "Return to the smaller element (down arrow)",
          move: "Move toolbar to bottom",
          moveUp: "Move toolbar to top",
          save: "Save",
          cancel: "Cancel",
          failed: "Could not save. Try again.",
          unavailable: "Choose another element.",
          saving: "Saving…",
          limit: "Too many exclusions. Remove unused entries in the popup.",
          timeout: "No response. The exclusion may have been saved; check the popup.",
        };
    if (invert)
      Object.assign(
        text,
        ru
          ? {
              title: "Настроить блок",
              hint: "Нажмите на блок, который нужно затемнить.",
              chosen: "Проверьте результат и сохраните правило.",
              limit: "Слишком много правил. Удалите ненужные в попапе.",
              timeout: "Ответ не получен. Правило могло сохраниться — проверьте в попапе.",
            }
          : {
              title: "Configure block",
              hint: "Click the block you want to darken.",
              chosen: "Check the result, then save the rule.",
              limit: "Too many rules. Remove unused entries in the popup.",
              timeout: "No response. The rule may have been saved; check the popup.",
            },
      );
    Object.assign(
      text,
      ru
        ? {
            one: "Этот элемент",
            similar: "Похожие элементы",
            scope: "К чему применить правило",
            noGroup: "Не удалось выделить безопасную группу. Выберите другой блок.",
            matches: "Совпадений: ",
            containerGroup: "Элементы того же типа внутри таких же контейнеров, включая появившиеся позже.",
            unsafe:
              "Для этого выделения не удалось сохранить исходные цвета. Измените границы блока или исключения.",
            addException: "Добавить исключение",
            applyException: "Добавить",
            updateException: "Применить",
            back: "Назад",
            exceptionTitle: "Исключение внутри блока",
            exceptionHint: "Нажмите на элемент внутри выбранного блока.",
            exceptionChosen: "Проверьте исключение и добавьте его к блоку.",
            exceptionList: "Исключения",
            rootLabel: "Блок: ",
            insideOnly: "Выберите элемент внутри блока. Сам блок и его предков исключить нельзя.",
            conflict:
              "Правило уже существует или его настройки изменились. Откройте сохранённый блок заново.",
            removeException: "Убрать исключение",
            editException: "Изменить исключение",
            emptyExceptions: "Исключений пока нет.",
            rootMissing: "Блок временно не найден. Черновик не потерян.",
            legacyTitle: "Старые исключения сайта",
            legacyHint:
              "Удаление этих исключений повлияет на весь сайт. Изменения применятся после сохранения.",
            legacyConflict:
              "Старое исключение сайта отключает инверсию всего блока. Удалите его в списке ниже.",
            removeLegacy: "Удалить старое исключение сайта",
            coveringConflict:
              "Этот блок исключён правилом «{block}». Измените исключения того блока в списке.",
          }
        : {
            one: "This element",
            similar: "Similar elements",
            scope: "Apply the rule to",
            noGroup: "No safe group is available. Choose another block.",
            matches: "Matches: ",
            containerGroup:
              "Elements of the same type inside matching containers, including future elements.",
            unsafe:
              "Original colors could not be preserved for this selection. Adjust the block or exception boundaries.",
            addException: "Add exception",
            applyException: "Add",
            updateException: "Apply",
            back: "Back",
            exceptionTitle: "Exception inside block",
            exceptionHint: "Click an element inside the selected block.",
            exceptionChosen: "Check the exception, then add it to the block.",
            exceptionList: "Exceptions",
            rootLabel: "Block: ",
            insideOnly:
              "Choose an element inside the block. The block itself and its ancestors cannot be excluded.",
            conflict: "The rule already exists or has changed. Reopen the saved block.",
            removeException: "Remove exception",
            editException: "Edit exception",
            emptyExceptions: "No exceptions yet.",
            rootMissing: "The block is temporarily missing. Your draft is retained.",
            legacyTitle: "Old site exceptions",
            legacyHint: "Removing these exceptions affects the whole site. Changes apply when you save.",
            legacyConflict: "An old site exception disables this entire block. Remove it in the list below.",
            removeLegacy: "Remove old site exception",
            coveringConflict: "This block is excluded by {block}. Edit that block's exceptions in the list.",
          },
    );
    const host = document.createElement("div");
    host.setAttribute("data-hdm-picker", "");
    host.setAttribute("popover", "manual");
    host.style.cssText = `
      all:initial!important;position:fixed!important;inset:0!important;margin:0!important;
      border:0!important;padding:0!important;width:auto!important;height:auto!important;
      max-width:none!important;max-height:none!important;background:transparent!important;
      overflow:visible!important;pointer-events:auto!important;z-index:2147483647!important;
    `;
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      :host { color-scheme: dark; }
      * { box-sizing:border-box; }
      [hidden] { display:none !important; }
      .outline { position:fixed;border:2px solid #61c7ff;background:#61c7ff18;pointer-events:none; }
      .panel { position:fixed;top:12px;left:50%;transform:translateX(-50%);width:420px;max-width:calc(100% - 24px);
        max-height:calc(100vh - 24px);overflow:auto;padding:12px 16px 16px;background:#101621;color:#e9eff7;
        overscroll-behavior:contain;
        border:1px solid #263148;border-radius:16px;font:13px/1.5 "Segoe UI",system-ui,sans-serif;
        pointer-events:auto;filter:none;box-shadow:0 12px 32px #0006; }
      .header { display:flex;align-items:center;gap:8px; }
      .title { margin:0;flex:1;min-width:0;font-size:14px;font-weight:600; }
      .tools { display:flex;gap:4px; }
      .status { margin:4px 0 14px;color:#9fb0c7;font-size:12px;overflow-wrap:anywhere; }
      .scope-controls { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px;padding:3px;
        margin:0 0 12px;border:1px solid #263148;border-radius:10px;background:#0f1622; }
      .scope-controls button { min-height:30px;padding:4px 6px;border:0;border-radius:6px;background:transparent;font-weight:400;color:#9fb0c7; }
      .scope-controls button[aria-pressed="true"] { background:#1b2333;color:#e9eff7; }
      .scope-controls button:focus-visible { outline-offset:-2px; }
      .match-count { margin:0 0 10px;color:#9fb0c7;font-size:12px; }
      .root-context { margin:0 0 10px;padding:8px 10px;background:#1b2333;border:1px solid #263148;border-radius:8px;color:#9fb0c7;overflow-wrap:anywhere; }
      .exceptions { margin:12px 0;border-top:1px solid #263148;padding-top:12px; }
      .exceptions-title { margin:0 0 6px;font-size:12px;font-weight:600;color:#9fb0c7; }
      .exception-list { display:grid;gap:4px;max-height:128px;overflow:auto;scrollbar-width:thin;scrollbar-color:#44546b #101621; }
      .exception-row { display:flex;gap:8px;align-items:center;min-width:0; }
      .exception-name { flex:1;min-width:0;justify-content:flex-start;text-align:left;overflow-wrap:anywhere;font-weight:400; }
      .exception-empty { margin-bottom:8px;font-size:12px;color:#9fb0c7; }
      .add-exception { width:100%;margin-top:8px;color:#5dd9c1; }
      .back { margin-right:auto; }
      .outline.exception-outline { border-color:#5dd9c1;background:transparent; }
      .buttons { display:flex;align-items:center;gap:12px;flex-wrap:wrap; }
      .size-controls { display:flex;gap:4px; }
      button { display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;
        padding:0 10px;font:600 12px/1.3 "Segoe UI",system-ui,sans-serif;background:#1b2333;color:#e9eff7;
        border:1px solid #263148;border-radius:8px;cursor:pointer;transition:background .15s,color .15s; }
      button:hover:not(:disabled) { background:#2b374e; }
      button:focus-visible { outline:2px solid #7aa2ff;outline-offset:2px; }
      button:disabled { color:#77869b;cursor:default; }
      button svg { width:16px;height:16px;flex:none; }
      .icon-button { width:32px;min-height:32px;padding:0;border-color:transparent;background:transparent;color:#9fb0c7; }
      .save { margin-left:auto;min-width:96px;background:#7aa2ff;color:#0c1118;border-color:transparent; }
      .save:hover:not(:disabled) { background:#94b4ff; }
      .save:disabled { background:#253247;color:#92a2b9; }
      @media (max-width:360px) { .buttons { gap:8px; } .save { flex:1;min-width:80px; } }
      @media (prefers-reduced-motion:reduce) { button { transition:none; } }
      @media (forced-colors:active) { .panel { filter:none; } button:disabled { color:GrayText; } }
    `;
    const outline = document.createElement("div");
    outline.className = "outline";
    outline.hidden = true;
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.tabIndex = -1;
    let previousFocus = document.activeElement;
    while (previousFocus?.shadowRoot?.activeElement) previousFocus = previousFocus.shadowRoot.activeElement;
    panel.setAttribute("aria-labelledby", "picker-title");
    panel.setAttribute("aria-describedby", "picker-status");
    const header = document.createElement("div");
    header.className = "header";
    const title = document.createElement("h2");
    title.className = "title";
    title.id = "picker-title";
    title.textContent = text.title;
    const tools = document.createElement("div");
    tools.className = "tools";
    const status = document.createElement("div");
    status.className = "status";
    status.id = "picker-status";
    status.textContent = text.hint;
    status.setAttribute("role", "status");
    const buttons = document.createElement("div");
    buttons.className = "buttons";
    const sizes = document.createElement("div");
    sizes.className = "size-controls";
    function button(name, action, container = buttons, path) {
      const element = document.createElement("button");
      element.type = "button";
      element.dataset.action = name;
      if (path) {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        const shape = document.createElementNS(svg.namespaceURI, "path");
        for (const [key, value] of Object.entries({
          d: path,
          fill: "none",
          stroke: "currentColor",
          "stroke-width": "1.8",
          "stroke-linecap": "round",
          "stroke-linejoin": "round",
        }))
          shape.setAttribute(key, value);
        svg.append(shape);
        element.append(svg);
      }
      if (container === tools) {
        element.className = "icon-button";
        element.setAttribute("aria-label", text[name]);
        element.title = text[name];
      } else element.append(document.createTextNode(text[name]));
      element.addEventListener("click", action);
      container.appendChild(element);
      return element;
    }
    const larger = button(
      "larger",
      () => actions.resize(true),
      sizes,
      "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5",
    );
    larger.title = text.largerHint;
    const smaller = button(
      "smaller",
      () => actions.resize(false),
      sizes,
      "M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5",
    );
    smaller.title = text.smallerHint;
    buttons.append(sizes);
    const scopeControls = document.createElement("div");
    scopeControls.className = "scope-controls";
    scopeControls.setAttribute("role", "group");
    scopeControls.setAttribute("aria-label", text.scope);
    const one = button("one", () => actions.chooseScope(false), scopeControls);
    const similar = button("similar", () => actions.chooseScope(true), scopeControls);
    one.disabled = similar.disabled = true;
    const matchCount = document.createElement("div");
    matchCount.className = "match-count";
    matchCount.hidden = true;
    matchCount.setAttribute("aria-live", "polite");
    const rootContext = document.createElement("div");
    rootContext.className = "root-context";
    rootContext.hidden = true;
    const exceptionsSection = document.createElement("section");
    exceptionsSection.className = "exceptions";
    exceptionsSection.hidden = true;
    const exceptionsTitle = document.createElement("h3");
    exceptionsTitle.className = "exceptions-title";
    exceptionsTitle.textContent = text.exceptionList;
    const exceptionList = document.createElement("div");
    exceptionList.className = "exception-list";
    const emptyExceptions = document.createElement("div");
    emptyExceptions.className = "exception-empty";
    emptyExceptions.textContent = text.emptyExceptions;
    const addException = button("addException", () => actions.beginException(), exceptionsSection);
    addException.className = "add-exception";
    exceptionsSection.prepend(exceptionsTitle, exceptionList, emptyExceptions);
    const legacySection = document.createElement("details");
    legacySection.hidden = true;
    const legacyTitle = document.createElement("summary");
    legacyTitle.textContent = text.legacyTitle;
    const legacyHint = document.createElement("div");
    legacyHint.className = "status";
    legacyHint.textContent = text.legacyHint;
    const legacyList = document.createElement("div");
    legacyList.className = "exception-list";
    legacySection.append(legacyTitle, legacyHint, legacyList);
    const back = button("back", () => actions.finishException(false));
    back.className = "back";
    back.hidden = true;
    const applyException = button("applyException", () => actions.finishException(true));
    applyException.className = "save";
    applyException.hidden = true;
    const save = button("save", actions.save);
    save.className = "save";
    save.disabled = larger.disabled = smaller.disabled = true;
    const relocate = button(
      "move",
      () => {
        const bottom = panel.style.bottom === "12px";
        panel.style.top = bottom ? "12px" : "auto";
        panel.style.bottom = bottom ? "auto" : "12px";
        relocate.title = bottom ? text.move : text.moveUp;
        relocate.setAttribute("aria-label", relocate.title);
      },
      tools,
      "M8 8l4-4 4 4M12 4v16m-4-4 4 4 4-4",
    );
    const cancel = button("cancel", actions.cancel, tools, "m6 6 12 12M18 6 6 18");
    cancel.title = `${text.cancel} (Esc)`;
    header.append(title, tools);
    panel.append(
      header,
      status,
      rootContext,
      scopeControls,
      matchCount,
      exceptionsSection,
      legacySection,
      buttons,
    );
    shadow.append(style, outline, panel);
    function mount() {
      // A popover escapes page filters; inside the active modal it also stays non-inert.
      let modal = previousFocus;
      while (modal && !modal.matches?.(":modal")) modal = HdmSelectors.parent(modal);
      modal ||= [...document.querySelectorAll(":modal")].at(-1);
      (modal || document.documentElement).appendChild(host);
      host.showPopover();
      panel.focus({ preventScroll: true });
    }
    return {
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
      mount,
    };
  }
  global.HdmPickerView = { create };
})(globalThis);
