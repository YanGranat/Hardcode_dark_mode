(function exposeCutoutGeometry(global) {
  const NS = "http://www.w3.org/2000/svg";
  const MAX_RECTS = 500, MAX_FILTERS = 500, MAX_OVERLAP_CHECKS = MAX_RECTS * 10;
  const { composedParent: parent } = HdmSelectors;

  function plan(owners, protections, suspend = false, boundaries = new Set()) {
    if (!owners.size || (!protections.length && !suspend)) return { updates: new Map(), trackGeometry: false };
    const updates = new Map(), styles = new Map(), bounds = new Map(), protectedNodes = new Set(protections);
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
    let geometryRelated = false;
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
    // HTML paint bounds and filter primitives share a CSS-pixel raster grid.
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
    // Sibling filter owners contribute to the outer block's SourceGraphic.
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
            // Outermost SVG uses CSS viewport metrics; nested SVG uses graphics bounds.
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
        if (left < box.left || right > box.right || top < box.top || bottom > box.bottom) { blocked = true; break; }
        left = Math.max(left, box.left); right = Math.min(right, box.right);
        top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom);
        if (right <= left || bottom <= top) continue;
        let originX = box.left, originY = box.top;
        if (ancestry.every(rasterAligned)) {
          // Quantize HTML in CSS pixels; retain transformed and vector coordinates.
          originX = Math.round(originX); originY = Math.round(originY);
          left = Math.round(left); right = Math.round(right); top = Math.round(top); bottom = Math.round(bottom);
          if (right <= left || bottom <= top) continue;
        }
        rects.push([(left - originX) / box.width, (top - originY) / box.height, (right - left) / box.width, (bottom - top) / box.height]);
      }
      if (!blocked && !rects.length) continue;
      if (rects.length > rectBudget || filterBudget <= 0) blocked = true;
      if (!blocked) { rectBudget -= rects.length; filterBudget--; }
      updates.set(owner, { amount, rects, blocked });
    }
    return { updates, trackGeometry: geometryRelated };
  }

  global.HdmCutoutGeometry = { plan };
})(globalThis);
