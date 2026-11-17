(function exposeCutouts(global) {
  if (global.HdmCutouts) return;
  const NS = "http://www.w3.org/2000/svg";
  const MARKER = "data-hdm-cutout", PROPERTY = "--hdm-cutout-filter";
  let sequence = 0;
  const instance = [...crypto.getRandomValues(new Uint32Array(2))].map(value => value.toString(36)).join("");
  const { composedParent: parent } = HdmSelectors;

  function create() {
    const entries = new Map(), definitions = new Map();
    let blockedCount = 0;
    let lastPlan = null, lastInput = null;

    function svgElement(name, attributes = {}) {
      const element = document.createElementNS(NS, name);
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
      element.style.setProperty("color-interpolation-filters", "sRGB", "important");
      return element;
    }

    function definitionsFor(scope) {
      let svg = definitions.get(scope);
      if (!svg) {
        svg = svgElement("svg", { "aria-hidden": "true", focusable: "false", "data-hdm-filter-resources": "" });
        for (const [key, value] of Object.entries({ position: "fixed", left: "0", top: "0", width: "0", height: "0",
          display: "block", overflow: "hidden", "pointer-events": "none", visibility: "hidden" })) {
          svg.style.setProperty(key, value, "important");
        }
        definitions.set(scope, svg);
      }
      if (!svg.isConnected) (scope === document ? document.documentElement : scope).appendChild(svg);
      return svg;
    }

    function release(owner, entry) {
      entry.filter?.remove();
      if (owner.getAttribute(MARKER) === entry.marker) {
        if (entry.previousMarker === null) owner.removeAttribute(MARKER);
        else owner.setAttribute(MARKER, entry.previousMarker);
      }
      if (owner.style.getPropertyValue(PROPERTY) === entry.value) {
        if (entry.previousValue) owner.style.setProperty(PROPERTY, entry.previousValue, entry.previousPriority);
        else owner.style.removeProperty(PROPERTY);
      }
      entries.delete(owner);
    }

    function pruneDefinitions() {
      const used = new Set([...entries.values()].filter(entry => entry.filter).map(entry => entry.scope));
      for (const [scope, svg] of definitions) if (!used.has(scope)) { svg.remove(); definitions.delete(scope); }
    }

    function apply(owner, scope, amount, rects, blocked) {
      let entry = entries.get(owner);
      if (!entry) {
        entry = { previousMarker: owner.getAttribute(MARKER), previousValue: owner.style.getPropertyValue(PROPERTY),
          previousPriority: owner.style.getPropertyPriority(PROPERTY), marker: null, value: null, filter: null, signature: null };
        entries.set(owner, entry);
      }
      const signature = JSON.stringify([amount, blocked, rects]);
      const rebuild = entry.scope !== scope || entry.amount !== amount || entry.blocked !== blocked ||
        (!blocked && (!entry.filter?.isConnected || entry.floods.length !== rects.length));
      if (rebuild) {
        entry.filter?.remove(); entry.filter = null;
        entry.floods = [];
        if (!blocked) {
          const id = `hdm-cutout-${instance}-${++sequence}`;
          const filter = svgElement("filter", { id, filterUnits: "objectBoundingBox", primitiveUnits: "objectBoundingBox",
            x: "-100%", y: "-100%", width: "300%", height: "300%" });
          const transfer = svgElement("feComponentTransfer", { in: "SourceGraphic", result: "inverted" });
          for (const channel of ["R", "G", "B"]) transfer.appendChild(svgElement(`feFunc${channel}`, {
            type: "linear", slope: amount === 100 ? -1 : -0.8, intercept: amount === 100 ? 1 : 0.9
          }));
          filter.appendChild(transfer);
          filter.appendChild(svgElement("feColorMatrix", { in: "inverted", type: "hueRotate", values: 180, result: "changed" }));
          const merge = svgElement("feMerge", { result: "mask" });
          rects.forEach((rect, index) => {
            const name = `area-${index}`;
            const flood = svgElement("feFlood", { x: rect[0], y: rect[1], width: rect[2], height: rect[3], result: name });
            flood.style.setProperty("flood-color", "white", "important");
            flood.style.setProperty("flood-opacity", "1", "important");
            entry.floods.push(flood);
            filter.appendChild(flood); merge.appendChild(svgElement("feMergeNode", { in: name }));
          });
          filter.appendChild(merge);
          filter.appendChild(svgElement("feComposite", { in: "SourceGraphic", in2: "mask", operator: "in", result: "original" }));
          filter.appendChild(svgElement("feComposite", { in: "changed", in2: "mask", operator: "out", result: "outside" }));
          filter.appendChild(svgElement("feComposite", { in: "original", in2: "outside", operator: "arithmetic", k1: 0, k2: 1, k3: 1, k4: 0 }));
          definitionsFor(scope).appendChild(filter);
          entry.filter = filter;
        } else entry.value = "opacity(1)";
      } else if (!blocked && entry.signature !== signature) {
        rects.forEach((rect, index) => {
          const flood = entry.floods[index];
          ["x", "y", "width", "height"].forEach((name, coordinate) => {
            const value = String(rect[coordinate]);
            if (flood.getAttribute(name) !== value) flood.setAttribute(name, value);
          });
        });
      }
      entry.scope = scope; entry.signature = signature; entry.amount = amount; entry.blocked = blocked;
      if (!blocked && (rebuild || entry.documentURL !== document.URL)) {
        entry.documentURL = document.URL;
        entry.value = `url(${JSON.stringify(new URL(`#${entry.filter.id}`, document.URL).href)})`;
      }
      entry.marker = blocked ? "blocked" : "mask";
      if (owner.getAttribute(MARKER) !== entry.marker) owner.setAttribute(MARKER, entry.marker);
      if (owner.style.getPropertyValue(PROPERTY) !== entry.value || owner.style.getPropertyPriority(PROPERTY) !== "important") {
        owner.style.setProperty(PROPERTY, entry.value, "important");
      }
    }

    function clear() {
      lastPlan = lastInput = null;
      for (const [owner, entry] of entries) release(owner, entry);
      pruneDefinitions(); blockedCount = 0;
    }

    function paint(owners, protections, suspend = false, boundaries = new Set()) {
      lastPlan = HdmCutoutGeometry.plan(owners, protections, suspend, boundaries);
      lastInput = [owners, protections, suspend, boundaries];
      const { updates, trackGeometry } = lastPlan;
      blockedCount = 0;
      for (const [owner, { amount, rects, blocked }] of updates) {
        if (blocked) blockedCount++;
        apply(owner, owner.getRootNode(), amount, rects, blocked);
      }
      for (const [owner, entry] of entries) if (!updates.has(owner)) release(owner, entry);
      pruneDefinitions();
      return trackGeometry;
    }

    function updateGeometry() {
      if (!lastPlan?.trackGeometry) return false;
      const damaged = [...entries].some(([owner, entry]) =>
        (entry.filter && !entry.filter.isConnected) || owner.getAttribute(MARKER) !== entry.marker ||
        owner.style.getPropertyValue(PROPERTY) !== entry.value || owner.style.getPropertyPriority(PROPERTY) !== "important");
      return damaged || lastPlan.changed() ? paint(...lastInput) : true;
    }

    function blocked(roots) {
      if (roots === undefined) return blockedCount > 0;
      const selected = new Set(roots);
      if (!selected.size) return false;
      const ancestors = new Set();
      for (const root of selected) for (let node = root; node; node = parent(node)) ancestors.add(node);
      for (const [owner, entry] of entries) {
        if (!entry.blocked) continue;
        if (ancestors.has(owner)) return true;
        for (let node = owner; node; node = parent(node)) if (selected.has(node)) return true;
      }
      return false;
    }

    return { paint, updateGeometry, clear, blocked };
  }

  global.HdmCutouts = { create };
})(globalThis);
