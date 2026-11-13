(function exposeController(global) {
  function create() {
    const shadowStyleAttribute = "data-hdm-universal-shadow-style";
    const bodyStyleAttribute = "data-hdm-universal-body-style";
    const mediaSelector = 'img, video, iframe, [style*="background-image"]';
    // Mirrors styles/universal.css for content inside open shadow roots.
    const shadowMediaCSS = `@media screen {
      :where(:host-context(html.dmx-on.dmx-site-universal:not(.dmx-mode-selected))) :is(${mediaSelector}) {
        filter: invert(111%) hue-rotate(180deg) !important;
      }
      :where(:host-context(html.dmx-on.dmx-site-universal:not(.dmx-mode-selected))) [style*="background-image"] :is(${mediaSelector}),
      :host-context(html.dmx-on.dmx-site-universal:not(.dmx-mode-selected)) canvas {
        filter: none !important;
      }
      :host-context(html.dmx-on.dmx-site-universal:not(.dmx-mode-selected)) :is(:fullscreen, :modal, :popover-open):not(video):not(img):not(iframe):not(canvas):not([data-hdm-picker]) {
        filter: invert(90%) hue-rotate(180deg) !important;
      }
      :host-context(html.dmx-on.dmx-site-universal:not(.dmx-mode-selected)) :is(video, img, iframe):is(:fullscreen, :modal, :popover-open) {
        filter: none !important;
      }
      @scope (:where(:host-context(html.dmx-on.dmx-site-universal:not(.dmx-mode-selected))) :is(:fullscreen, :modal, :popover-open)) to (:fullscreen, :modal, :popover-open) {
        :scope :is(${mediaSelector}) { filter: invert(100%) hue-rotate(180deg) !important; }
        :scope [style*="background-image"] :is(${mediaSelector}) { filter: none !important; }
      }
      :host-context(html.dmx-on.dmx-site-universal:not(.dmx-mode-selected)) :is(:modal, :popover-open)::backdrop {
        filter: brightness(10%) !important;
      }
    }`;
    let enabled = false;
    let mode = "page";
    let currentSite = null, currentAccess = false, matchViewer = null;
    let revision = 0;
    let observer = null;
    let rootObserver = null;
    let backgroundObserver = null, backgroundBody = null, observedRoot = null;
    const shadowStyles = new Map();
    const exclusions = HdmRulePainter.create(() => [...shadowStyles.keys()]);
    const inclusions = HdmRulePainter.create(() => [...shadowStyles.keys()], "invert");
    let bodyStyle = null;
    let disposed = false;
    function alive() {
      let valid = false;
      try { valid = Boolean(chrome.runtime.id); } catch {}
      if (!valid && !disposed) dispose();
      return valid && !disposed;
    }
    function dispose() {
      if (disposed) return;
      disposed = true; revision++;
      matchViewer?.close();
      disable();
      try { chrome.storage?.onChanged.removeListener(onStorage); } catch {}
      try { chrome.runtime?.onMessage.removeListener(onMessage); } catch {}
      document.removeEventListener("hdm-controller-replace", onReplace);
    }
    function onReplace() { alive(); }
    document.dispatchEvent(new Event("hdm-controller-replace"));
    document.addEventListener("hdm-controller-replace", onReplace);

    function pageOrigin() {
      let url = location.href;
      if (!/^https?:$/.test(location.protocol)) {
        url = location.origin !== "null" ? location.origin : location.ancestorOrigins[0];
      }
      return HdmSites.fromUrl(url).origin;
    }

    function ensureMarkers() {
      if (!alive()) return;
      const root = document.documentElement;
      if (!enabled || !root) return;
      if (rootObserver && observedRoot !== root) {
        rootObserver.disconnect();
        rootObserver.observe(root, { attributes: true, attributeFilter: ["class"] });
        observedRoot = root;
        backgroundBody = null;
      }
      for (const name of ["dmx-site", "dmx-site-universal", "dmx-on"]) {
        if (!root.classList.contains(name)) root.classList.add(name);
      }
      if (root.classList.contains("dmx-mode-selected") !== (mode === "selected")) root.classList.toggle("dmx-mode-selected", mode === "selected");
    }

    // The provisional canvas of content/boot.js ends once this document is decided.
    const endBoot = () => {
      const root = document.documentElement;
      if (root?.classList.contains("dmx-boot")) root.classList.remove("dmx-boot");
    };

    function ensureOpaqueBackground() {
      if (mode === "selected" || window !== window.top) { bodyStyle?.remove(); bodyStyle = null; endBoot(); return; }
      if (!enabled) { endBoot(); return; }
      if (!document.body) return;
      if (backgroundBody !== document.body) {
        backgroundBody = document.body;
        backgroundObserver?.disconnect();
        backgroundObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
        backgroundObserver?.observe(backgroundBody, { attributes: true, attributeFilter: ["class", "style"] });
      }
      bodyStyle?.remove();
      const transparent = (element) => {
        const color = getComputedStyle(element).backgroundColor;
        return color === "transparent" || /(?:,|\/)\s*0(?:\.0+)?%?\s*\)$/.test(color);
      };
      // The provisional canvas must not count as the site's own background.
      endBoot();
      // Preserve the html background that normally paints through a clear body.
      if (!transparent(document.body) || !transparent(document.documentElement) ||
          getComputedStyle(document.documentElement).backgroundImage !== "none" ||
          getComputedStyle(document.body).backgroundImage !== "none") { bodyStyle = null; return; }
      if (!bodyStyle) { bodyStyle = document.createElement("style"); bodyStyle.setAttribute(bodyStyleAttribute, ""); }
      // Paint the otherwise transparent canvas, without overwriting the body's
      // later site-owned background or layout.
      bodyStyle.textContent = "@media screen { :where(html.dmx-on.dmx-site-universal:not(.dmx-mode-selected)) { background-color: #fff; } }";
      (document.head || document.documentElement).appendChild(bodyStyle);
    }

    function scan(node) {
      if (HdmSelectors.owned(node)) return;
      if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot) protect(node.shadowRoot);
      node.querySelectorAll?.("*").forEach((element) => {
        if (element.shadowRoot && !HdmSelectors.owned(element)) protect(element.shadowRoot);
      });
    }

    function protect(shadowRoot) {
      if (!enabled || HdmSelectors.owned(shadowRoot.host) || shadowStyles.has(shadowRoot)) return;
      const style = document.createElement("style");
      style.setAttribute(shadowStyleAttribute, "");
      style.textContent = shadowMediaCSS;
      shadowStyles.set(shadowRoot, style);
      shadowRoot.appendChild(style);
      observer.observe(shadowRoot, { childList: true, subtree: true });
      scan(shadowRoot);
      exclusions.schedule();
      inclusions.schedule();
    }

    function onShadow(event) {
      if (!alive() || !enabled) return;
      const host = event.composedPath()[0];
      if (host?.shadowRoot) protect(host.shadowRoot);
    }

    function enable() {
      if (enabled) { ensureMarkers(); ensureOpaqueBackground(); return; }
      enabled = true;
      observer = new MutationObserver((mutations) => {
        if (!alive()) return;
        ensureMarkers();
        if (mutations.some(mutation => !HdmSelectors.owned(mutation.target) && (
          mutation.target.nodeName === "STYLE" || [...mutation.addedNodes, ...mutation.removedNodes].some(node =>
            !HdmSelectors.owned(node) && (node.nodeName === "STYLE" || node.nodeName === "LINK" || node === document.body || node === document.documentElement))))) ensureOpaqueBackground();
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) scan(node);
          }
        }
        for (const [shadowRoot, style] of shadowStyles) {
          if (!shadowRoot.host.isConnected) {
            style.remove();
            shadowStyles.delete(shadowRoot);
          } else if (!style.isConnected) {
            shadowRoot.appendChild(style);
          }
        }
      });
      observer.observe(document, { childList: true, subtree: true });
      backgroundObserver = new MutationObserver(() => { if (alive() && enabled) ensureOpaqueBackground(); });
      backgroundObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
      ensureMarkers();
      rootObserver = new MutationObserver(ensureMarkers);
      rootObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      observedRoot = document.documentElement;
      document.addEventListener("hdm-shadow-root", onShadow);
      document.addEventListener("load", onBackgroundLoad, true);
      window.addEventListener("resize", onBackgroundResize);
      document.dispatchEvent(new Event("hdm-shadow-enable"));
      ensureOpaqueBackground();
      scan(document);
    }

    function disable() {
      exclusions.set([], false);
      inclusions.set([], false);
      enabled = false;
      observer?.disconnect();
      rootObserver?.disconnect();
      backgroundObserver?.disconnect(); backgroundObserver = null; backgroundBody = observedRoot = null;
      observer = rootObserver = null;
      document.removeEventListener("hdm-shadow-root", onShadow);
      document.removeEventListener("load", onBackgroundLoad, true);
      window.removeEventListener("resize", onBackgroundResize);
      document.dispatchEvent(new Event("hdm-shadow-disable"));
      document.documentElement?.classList.remove("dmx-on", "dmx-site-universal", "dmx-site", "dmx-mode-selected", "dmx-boot");
      for (const style of shadowStyles.values()) style.remove();
      shadowStyles.clear();
      bodyStyle?.remove();
      bodyStyle = null;
    }

    async function refresh() {
      if (!alive()) return false;
      const request = ++revision;
      try {
        const origin = pageOrigin();
        const [stored, access] = await Promise.all([
          chrome.storage.local.get({ universalSites: [] }),
          HdmRequests.send(() => chrome.runtime.sendMessage({ type: "hdm-document-access", origin }), 3000, "timeout")
        ]);
        if (!alive() || request !== revision) return false;
        const site = HdmSites.normalizeLibrary(stored.universalSites).find(site => site.origin === origin);
        currentSite = site || null; currentAccess = access?.ok === true && access.allowed === true;
        matchViewer?.close();
        const active = site?.enabled && access?.ok === true && access.allowed === true;
        mode = site?.mode || "page";
        if (active) enable();
        else disable();
        exclusions.set(site?.exclusions, Boolean(active) && mode === "page");
        inclusions.set(site?.inclusions, Boolean(active) && mode === "selected", site?.protections);
        return true;
      } catch (error) {
        if (request === revision) { currentAccess = false; matchViewer?.close(); disable(); }
        return false;
      }
    }

    function onBackgroundLoad(event) { if (alive() && enabled && event.target.nodeName === "LINK") ensureOpaqueBackground(); }
    function onBackgroundResize() { if (alive() && enabled) ensureOpaqueBackground(); }
    function onStorage(changes, area) {
      if (!alive()) return;
      if (area === "local" && changes.universalSites) refresh();
    }
    function onMessage(message, sender, sendResponse) {
      if (!alive()) return false;
      if (message?.type === "hdm-rule-show" && sender.id === chrome.runtime.id) {
        refresh().then(applied => {
          if (!applied || !currentSite || !currentAccess) throw Error("settings_changed");
          if (exclusions.isEditing?.() || inclusions.isEditing?.()) throw Error("editor_open");
          const fields = { exclusion: "exclusions", inversion: "inclusions", protection: "protections" };
          if (!Object.hasOwn(fields, message.kind)) throw Error("invalid_message");
          let rules = currentSite[fields[message.kind]], parentRule = null;
          if (message.parent) {
            if (message.kind !== "protection") throw Error("invalid_message");
            parentRule = currentSite.inclusions.find(rule => HdmRules.identity(rule) === HdmRules.identity(message.parent));
            rules = parentRule?.protections;
          }
          const rule = rules?.find(rule => HdmRules.identity(rule) === HdmRules.identity(message));
          if (!rule) throw Error("rule_not_found");
          matchViewer = HdmMatches.open(rule, { language: message.language, parentRule,
            scopes: () => [document, ...shadowStyles.keys()], onClose() { matchViewer = null; } });
          sendResponse({ ok: true });
        }).catch(error => sendResponse({ ok: false, error: error.message }));
        return true;
      }
      if (message?.type === "hdm-exclusion-pick" && sender.id === chrome.runtime.id) {
        refresh().then((applied) => {
          if (!applied) throw new Error("settings_changed");
          if (message.action || message.mode !== mode || (message.rule && mode !== "selected")) throw new Error("settings_changed");
          (mode === "selected" ? inclusions : exclusions).start(message.language, pageOrigin(), message.rule || null);
          sendResponse({ ok: true });
        }).catch(error => sendResponse({ ok: false, ...(["editor_open", "selector_unavailable"].includes(error.message) ? { error: error.message } : {}) }));
        return true;
      }
      if (message?.type !== "hdm-universal-refresh" || sender.id !== chrome.runtime.id) return false;
      if (message.origins && !message.origins.includes(pageOrigin())) return false;
      refresh().then(() => sendResponse({ enabled }));
      return true;
    }
    chrome.storage.onChanged.addListener(onStorage);
    chrome.runtime.onMessage.addListener(onMessage);

    return { refresh };
  }
  global.HdmThemeController = { create };
})(globalThis);
