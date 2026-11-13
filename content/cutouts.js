(function exposeCutouts(global) {
  if (global.HdmCutouts) return;
  const NS = "http://www.w3.org/2000/svg";
  const MARKER = "data-hdm-cutout", PROPERTY = "--hdm-cutout-filter";
  const MAX_RECTS = 500, MAX_FILTERS = 500, MAX_OVERLAP_CHECKS = MAX_RECTS * 10;
  let sequence = 0;
  const instance = [...crypto.getRandomValues(new Uint32Array(2))].map(value => value.toString(36)).join("");
  const { composedParent: parent } = HdmSelectors;

  function create() {
    const entries = new Map(), definitions = new Map();
    let blockedCount = 0, geometryRelated = false;

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
      for (const [owner, entry] of entries) release(owner, entry);
      pruneDefinitions(); blockedCount = 0; geometryRelated = false;
    }

    // "boundaries" are top-layer elements (fullscreen, modal dialogs, open popovers).
    // They are drawn outside their DOM ancestors, so neither an ancestor's mask nor
    // its layering check may reach across one.
    function paint(owners, protections, suspend = false, boundaries = new Set()) {
      if (!owners.size || (!protections.length && !suspend)) { clear(); return false; }
      const next = new Set(), styles = new Map(), bounds = new Map(), protectedNodes = new Set(protections);
      const ownerProtections = new Map(), chains = new Map(), ownerPaths = new Map(), families = new Map();
      for (const owner of owners.keys()) {
        if (!owner.isConnected) continue;
        const path = [];
        for (let node = owner; node; node = parent(node)) { path.push(node); if (boundaries.has(node)) break; }
        ownerPaths.set(owner, new Set(path));
        const outer = path.filter(node => owners.has(node)).at(-1);
        if (!families.has(outer)) families.set(outer, { owners: [], protections: [] });
        families.get(outer).owners.push(owner);
      }
      for (const protection of protectedNodes) {
        if (!protection.isConnected) continue;
        const chain = [];
        for (let node = protection; node; node = parent(node)) {
          chain.push(node);
          if (owners.has(node)) {
            if (!ownerProtections.has(node)) ownerProtections.set(node, []);
            ownerProtections.get(node).push(protection);
          }
          if (boundaries.has(node)) break;
        }
        chains.set(protection, chain);
        const outer = chain.filter(node => owners.has(node)).at(-1);
        if (families.has(outer)) families.get(outer).protections.push(protection);
      }
      let rectBudget = MAX_RECTS, filterBudget = MAX_FILTERS;
      blockedCount = 0; geometryRelated = false;
      const style = node => {
        if (!styles.has(node)) styles.set(node, getComputedStyle(node));
        return styles.get(node);
      };
      const rect = node => {
        if (!bounds.has(node)) bounds.set(node, node.getBoundingClientRect());
        return bounds.get(node);
      };
      const validRect = value => [value.left, value.top, value.right, value.bottom, value.width, value.height].every(Number.isFinite) && value.width > 0 && value.height > 0;
      const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      // Untransformed HTML paint bounds and filter primitives share a CSS-pixel
      // raster grid. Device-pixel rounding can move the mask inside its target.
      const rasterAligned = node => {
        const css = style(node);
        return node.namespaceURI !== NS &&
          ["transform", "translate", "scale", "rotate", "perspective"].every(key => !css[key] || css[key] === "none") &&
          (!css.zoom || css.zoom === "normal" || Number(css.zoom) === 1);
      };
      const supported = node => {
        const css = style(node);
        if (css.perspective && css.perspective !== "none") return false;
        if (css.rotate && css.rotate !== "none" && Number.parseFloat(css.rotate.split(/\s+/).at(-1)) !== 0) return false;
        if (css.scale && css.scale !== "none") {
          const scales = css.scale.split(/\s+/).map(Number);
          if (scales.some(value => !Number.isFinite(value) || value <= 0) || (scales.length === 3 && scales[2] !== 1)) return false;
        }
        if (css.transform && css.transform !== "none") {
          try {
            const matrix = new DOMMatrixReadOnly(css.transform);
            if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) return false;
          } catch { return false; }
        }
        return true;
      };
      // A sibling counter-filter can alter pixels before an ancestor copies
      // SourceGraphic. Do not promise original colors for that layering case. The
      // conflict stays within its family: filters nested under one outermost block
      // cannot affect the pixels of an unrelated block.
      const layered = new Set(), familyOf = new Map();
      for (const family of families.values()) for (const owner of family.owners) familyOf.set(owner, family);
      let layeringBlocked = false, overlapChecks = 0;
      if (!suspend && protectedNodes.size <= MAX_RECTS) {
        overlap: for (const family of families.values()) {
          conflict: for (const protection of family.protections) {
            const ancestors = new Set(chains.get(protection)), area = rect(protection);
            if (!validRect(area)) continue;
            for (const owner of family.owners) {
              if (ancestors.has(owner) || ownerPaths.get(owner).has(protection)) continue;
              if (++overlapChecks > MAX_OVERLAP_CHECKS) { layeringBlocked = true; break overlap; }
              const ownerBox = rect(owner);
              if (validRect(ownerBox) && intersects(area, ownerBox)) { layered.add(family); break conflict; }
            }
          }
        }
      }
      geometryRelated = layeringBlocked || layered.size > 0;
      for (const [owner, amount] of owners) {
        if (!owner.isConnected) continue;
        let blocked = suspend || layeringBlocked || layered.has(familyOf.get(owner)) || protectedNodes.size > MAX_RECTS || ![90, 100].includes(amount);
        for (const node of ownerPaths.get(owner)) if (protectedNodes.has(node)) { blocked = true; break; }
        const related = ownerProtections.get(owner) || [];
        if (!blocked && !related.length) continue;
        if (!blocked) geometryRelated = true;
        const box = rect(owner);
        if (!validRect(box)) continue;
        const rects = [];
        for (const protection of related) {
          if (blocked) break;
          if (protection === owner) { blocked = true; break; }
          const region = rect(protection);
          if (!validRect(region) || !intersects(box, region)) continue;
          const ancestry = chains.get(protection);
          for (const node of ancestry) if (!supported(node)) { blocked = true; break; }
          if (blocked) break;
          let left = region.left, right = region.right, top = region.top, bottom = region.bottom;
          for (const node of ancestry.slice(1, ancestry.indexOf(owner) + 1)) {
            const css = style(node), clipX = css.overflowX && css.overflowX !== "visible", clipY = css.overflowY && css.overflowY !== "visible";
            if (!clipX && !clipY) continue;
            const clip = rect(node);
            if (!validRect(clip)) { blocked = true; break; }
            let clipLeft = clip.left, clipRight = clip.right, clipTop = clip.top, clipBottom = clip.bottom;
            if (node.namespaceURI === NS && node.localName === "svg" && !node.ownerSVGElement) {
              // Outermost SVG has a CSS viewport but no HTMLElement offset metrics.
              // Nested SVG bounds describe graphics, not necessarily its viewport.
              // Borders/padding need a separate content-box mapping; do not guess.
              if (["borderLeftWidth", "borderRightWidth", "borderTopWidth", "borderBottomWidth",
                "paddingLeft", "paddingRight", "paddingTop", "paddingBottom"].some(key => Number.parseFloat(css[key]) > 0)) {
                blocked = true; break;
              }
            } else {
              if (!node.offsetWidth || !node.offsetHeight) { blocked = true; break; }
              const scaleX = clip.width / node.offsetWidth, scaleY = clip.height / node.offsetHeight;
              clipLeft += node.clientLeft * scaleX; clipRight = clip.left + (node.clientLeft + node.clientWidth) * scaleX;
              clipTop += node.clientTop * scaleY; clipBottom = clip.top + (node.clientTop + node.clientHeight) * scaleY;
            }
            if (clipX) { left = Math.max(left, clipLeft); right = Math.min(right, clipRight); }
            if (clipY) { top = Math.max(top, clipTop); bottom = Math.min(bottom, clipBottom); }
          }
          if (blocked) break;
          if (right <= left || bottom <= top) continue;
          // A visible overflowing protected surface must not be inverted outside
          // the owner's border box merely because its mask would be truncated.
          if (left < box.left || right > box.right || top < box.top || bottom > box.bottom) { blocked = true; break; }
          left = Math.max(left, box.left); right = Math.min(right, box.right);
          top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom);
          if (right <= left || bottom <= top) continue;
          let originX = box.left, originY = box.top;
          if (ancestry.every(rasterAligned)) {
            // Only this shared grid can be quantized without shrinking original
            // pixels. Transformed and vector branches keep geometric coordinates.
            originX = Math.round(originX); originY = Math.round(originY);
            left = Math.round(left); right = Math.round(right); top = Math.round(top); bottom = Math.round(bottom);
            if (right <= left || bottom <= top) continue;
          }
          rects.push([(left - originX) / box.width, (top - originY) / box.height, (right - left) / box.width, (bottom - top) / box.height]);
        }
        if (!blocked && !rects.length) continue;
        if (rects.length > rectBudget || filterBudget <= 0) blocked = true;
        if (blocked) blockedCount++;
        else { rectBudget -= rects.length; filterBudget--; }
        apply(owner, owner.getRootNode(), amount, rects, blocked); next.add(owner);
      }
      for (const [owner, entry] of entries) if (!next.has(owner)) release(owner, entry);
      pruneDefinitions();
      return geometryRelated;
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

    return { paint, clear, blocked };
  }

  global.HdmCutouts = { create };
})(globalThis);
