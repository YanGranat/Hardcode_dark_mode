import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { load } from "../support/modules.mjs";

function manualPainter() {
  const shadows = [], elements = [], listeners = new Set();
  let attributeWrites = 0, cutoutOwners, protectedTargets, suspended, cutoutBoundaries;
  const isMedia = element => ["img", "video", "iframe"].includes(element.localName) ||
    (element.getAttribute("style") || "").includes("background-image");
  function scope(host = null) {
    return { host, fullscreenElement: null, getRootNode() { return this; },
      querySelectorAll(selector) {
        if (selector === "slot") return elements.filter(element => element.localName === "slot" && element.getRootNode() === this && element.isConnected);
        const wanted = selector.includes(":modal") ? element => element.topLayer === true : isMedia;
        return elements.filter(element => element.isConnected && element.getRootNode() === this && wanted(element));
      },
      appendChild(style) { style.isConnected = true; },
      addEventListener(type) { this.listening = (this.listening || new Set()).add(type); },
      removeEventListener(type) { this.listening?.delete(type); }
    };
  }
  const document = scope();
  document.head = document;
  document.createElement = () => ({ isConnected: false, setAttribute() {}, remove() { this.isConnected = false; } });
  const capture = options => options === true || options?.capture === true;
  document.addEventListener = (type, listener, options) => {
    if (![...listeners].some(entry => entry.type === type && entry.listener === listener && entry.capture === capture(options))) {
      listeners.add({ type, listener, capture: capture(options) });
    }
  };
  document.removeEventListener = (type, listener, options) => {
    for (const entry of listeners) {
      if (entry.type === type && entry.listener === listener && entry.capture === capture(options)) listeners.delete(entry);
    }
  };
  function element(localName = "div", parentElement = null, tree = document) {
    const attributes = new Map();
    const node = { localName, parentElement, assignedSlot: null, shadowRoot: null, isConnected: true,
      querySelectorAll(selector) {
        const wanted = selector === "slot" ? element => element.localName === "slot" : selector.includes(":modal") ? element => element.topLayer === true : isMedia;
        return elements.filter(element => {
          if (!element.isConnected) return false;
          for (let parent = element.parentElement; parent; parent = parent.parentElement) if (parent === this) return wanted(element);
          return false;
        });
      },
      assignedElements() { return elements.filter(element => element.assignedSlot === this); },
      getRootNode() { return this.parentElement ? this.parentElement.getRootNode() : tree; },
      matches(selector) { return selector.includes(":modal") ? this.topLayer === true : selector.includes("background-image") ? isMedia(this) : selector.split(",").includes(localName); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      setAttribute(name, value) { attributeWrites++; attributes.set(name, value); },
      removeAttribute(name) { attributeWrites++; attributes.delete(name); }
    };
    elements.push(node);
    return node;
  }
  function shadow(host) { const root = scope(host); host.shadowRoot = root; shadows.push(root); return root; }
  const context = vm.createContext({ document, getShadowRoots: () => shadows,
    HdmCutouts: { create: () => ({ paint(owners, targets, suspend, boundaries) { cutoutOwners = owners; protectedTargets = targets; suspended = suspend; cutoutBoundaries = boundaries; } }) },
    HdmSelectors: { owned: () => false, parent: element => element.parentElement || element.getRootNode().host || null,
      composedParent: element => element.assignedSlot || element.parentElement || element.getRootNode().host || null,
      resolveRule: rule => rule.element, resolveRules: rules => rules.map(rule => rule.element).filter(Boolean),
      resolveGroupResult: rule => ({ elements: rule.elements, overflow: rule.overflow }),
      inside(element, roots) { const parent = value => value.assignedSlot || value.parentElement || value.getRootNode().host || null; for (let node = parent(element); node; node = parent(node)) if (roots.includes(node)) return true; return false; }
    },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {}
  });
  load(context, "shared/rules.js");
  // Synthetic rules carry direct node references instead of serializable paths.
  Object.assign(context.HdmRules, { normalizeExclusions: rules => rules, normalizeInclusions: rules => rules });
  load(context, "content/painter.js");
  context.painter = context.HdmRulePainter.create(() => shadows, "invert");
  return { element, shadow, document, listeners, repaint: () => context.painter.refresh(),
    select: (nodes, active = true, protectedNodes = []) => context.painter.set(nodes.map(element => ({ element })), active, protectedNodes.map(element => ({ element }))),
    protectGroup: (nodes, elements, overflow) => context.painter.set(nodes.map(element => ({ element })), true, [{ matchAll: true, elements, overflow }]),
    selectRules: rules => context.painter.set(rules, true),
    draft: value => context.painter.preview({ draft: value }),
    legacyConflict: () => context.painter.snapshot().legacyCoversRoot,
    coveringRule: () => context.painter.snapshot().coveringRule,
    cutouts: () => ({ owners: cutoutOwners, targets: protectedTargets, suspended, boundaries: cutoutBoundaries }),
    writes: () => attributeWrites };
}

test("manual painter compensates media once per branch and suppresses nested selected roots", () => {
  const h = manualPainter(), root = h.element(), background = h.element("div", root);
  background.setAttribute("style", "background-image: url(test.png)");
  const nested = h.element("img", background), sibling = h.element("img", root), outside = h.element("img");
  h.select([root, background, nested]);
  assert.equal(root.getAttribute("data-hdm-inverted"), "root");
  assert.equal(background.getAttribute("data-hdm-inverted"), null, "nested choices must not add another inversion");
  assert.equal(nested.getAttribute("data-hdm-inverted"), null);
  assert.equal(background.getAttribute("data-hdm-invert-media"), "root");
  assert.equal(nested.getAttribute("data-hdm-invert-media"), "inside", "the background already compensates this branch");
  assert.equal(sibling.getAttribute("data-hdm-invert-media"), "root");
  assert.equal(outside.getAttribute("data-hdm-invert-media"), null);
  const before = h.writes(); h.repaint();
  assert.equal(h.writes(), before, "unchanged painting must not create attribute-observer feedback");
  background.removeAttribute("style"); h.repaint();
  assert.equal(background.getAttribute("data-hdm-invert-media"), null);
  assert.equal(nested.getAttribute("data-hdm-invert-media"), "root", "removing the background transfers compensation to the image");
});

test("protected manual regions suppress internal filters and cut every crossing owner", () => {
  const h = manualPainter(), root = h.element(), background = h.element("div", root);
  background.setAttribute("style", "background-image: url(test.png)");
  const protectedRegion = h.element("div", background), image = h.element("img", protectedRegion);
  h.select([root, image], true, [protectedRegion]);
  assert.equal(image.getAttribute("data-hdm-inverted"), null, "protection overrides a nested inclusion");
  assert.equal(image.getAttribute("data-hdm-invert-media"), null, "protected media must not be pre-transformed");
  assert.equal(background.getAttribute("data-hdm-invert-media"), "root");
  assert.equal(h.cutouts().owners.get(root), 90);
  assert.equal(h.cutouts().owners.get(background), 100, "both crossing filters require original-pixel cutouts");
  assert.deepEqual(Array.from(h.cutouts().targets), [protectedRegion]);
  h.select([root], false, [protectedRegion]);
  assert.equal(h.cutouts().owners.size, 0); assert.equal(h.cutouts().targets.length, 0);
});

test("an overflowing protection group suspends all inversion owners instead of dropping protection", () => {
  const h = manualPainter(), root = h.element(), child = h.element("img", root);
  h.protectGroup([root], [], true);
  assert.equal(h.cutouts().suspended, true);
  assert.equal(h.cutouts().owners.get(root), 90);
  assert.equal(h.cutouts().owners.get(child), 100, "nested automatic filters must also be suspended");
  h.protectGroup([root], [child], false);
  assert.equal(h.cutouts().suspended, false);
  assert.deepEqual(Array.from(h.cutouts().targets), [child]);
});

test("local exceptions apply only below their own matched inclusion and never cancel the entire root", () => {
  const h = manualPainter(), first = h.element(), second = h.element();
  const child = h.element("img", first), outside = h.element("img", second);
  const rule = { path: ["#first"], element: first, protections: [{ element: child }, { element: outside }, { element: first }] };
  h.selectRules([rule, { path: ["#second"], element: second }]);
  assert.equal(first.getAttribute("data-hdm-inverted"), "root", "a self-match must not remove the parent inversion");
  assert.equal(second.getAttribute("data-hdm-inverted"), "root");
  assert.deepEqual(Array.from(h.cutouts().targets), [child]);
  assert.equal(child.getAttribute("data-hdm-invert-media"), null);
  assert.equal(outside.getAttribute("data-hdm-invert-media"), "root", "a local class rule must not protect another root");
});

test("editing a draft replaces its persisted preview and cancellation restores the original exceptions", () => {
  const h = manualPainter(), root = h.element(), child = h.element("img", root);
  const stored = { path: ["#root"], element: root, protections: [{ element: child }] };
  h.selectRules([stored]);
  assert.deepEqual(Array.from(h.cutouts().targets), [child]);
  h.draft({ original: stored, rule: { ...stored, protections: [] } });
  assert.equal(h.cutouts().targets.length, 0, "removed draft exception must not survive through the persisted rule");
  assert.equal(child.getAttribute("data-hdm-invert-media"), "root");
  h.draft(null);
  assert.deepEqual(Array.from(h.cutouts().targets), [child]);
  assert.equal(child.getAttribute("data-hdm-invert-media"), null);
});

test("a legacy whole-root exception is visible to the editor and removable only in its draft", () => {
  const h = manualPainter(), root = h.element();
  const inclusion = { element: root, path: ["#root"] };
  h.select([root], true, [root]);
  h.draft({ original: null, rule: inclusion });
  assert.equal(h.legacyConflict(), true, "a missing root filter is not successful protection");
  h.draft({ original: null, rule: inclusion, removeLegacyProtections: [{ element: root }] });
  assert.equal(h.legacyConflict(), false);
  assert.equal(root.getAttribute("data-hdm-inverted"), "root");
  h.draft(null);
  assert.equal(root.getAttribute("data-hdm-inverted"), null, "cancel must restore the legacy setting");
});

test("a covering local exception identifies its owning rule instead of pretending the child can invert", () => {
  const h = manualPainter(), outer = h.element(), inner = h.element();
  inner.parentElement = outer;
  const parentRule = { path: ["#outer"], element: outer, label: "Outer block", protections: [{ element: inner }] };
  const innerRule = { path: ["#inner"], element: inner, label: "Inner block" };
  h.selectRules([parentRule, innerRule]);
  h.draft({ original: innerRule, rule: innerRule });
  assert.equal(h.legacyConflict(), false);
  assert.equal(h.coveringRule(), "Outer block");
  assert.equal(inner.getAttribute("data-hdm-inverted"), null);
});

test("manual painter inverts explicitly selected media instead of compensating its root", () => {
  for (const tag of ["img", "video", "iframe", "canvas", "div"]) {
    const h = manualPainter(), root = h.element(tag), child = h.element("img", root);
    if (tag === "div") root.setAttribute("style", "background-image: url(test.png)");
    h.select([root]);
    assert.equal(root.getAttribute("data-hdm-inverted"), "root", tag);
    assert.equal(root.getAttribute("data-hdm-invert-media"), null, tag);
    assert.equal(child.getAttribute("data-hdm-invert-media"), "root", "the selected root is the inversion boundary, even when it is media");
  }
});

test("manual painter follows shadow hosts and assigned slots for ownership and nested selection", () => {
  const h = manualPainter(), outer = h.element(), host = h.element("div", outer), tree = h.shadow(host);
  const background = h.element("div", null, tree); background.setAttribute("style", "background-image: url(test.png)");
  const shadowImage = h.element("img", background), slot = h.element("slot", background);
  const slottedImage = h.element("img", host); slottedImage.assignedSlot = slot;
  h.select([outer, slottedImage]);
  assert.equal(background.getAttribute("data-hdm-invert-media"), "root");
  assert.equal(shadowImage.getAttribute("data-hdm-invert-media"), "inside");
  assert.equal(slottedImage.getAttribute("data-hdm-invert-media"), "inside", "slot ancestry includes the compensating shadow background");
  assert.equal(slottedImage.getAttribute("data-hdm-inverted"), null);
  h.select([background, slottedImage]);
  assert.equal(slottedImage.getAttribute("data-hdm-inverted"), null, "light DOM parentage must not duplicate a selected shadow ancestor");
  assert.equal(slottedImage.getAttribute("data-hdm-invert-media"), "root");
  slottedImage.assignedSlot = null; h.repaint();
  assert.equal(slottedImage.getAttribute("data-hdm-inverted"), "root", "an independently selected reassigned image becomes its own root");
  assert.equal(slottedImage.getAttribute("data-hdm-invert-media"), null);
});

test("manual painter restarts media compensation at the deepest fullscreen boundary", () => {
  const h = manualPainter(), root = h.element(), background = h.element("div", root);
  background.setAttribute("style", "background-image: url(test.png)");
  const host = h.element("div", background), tree = h.shadow(host);
  const panel = h.element("div", null, tree), image = h.element("img", panel);
  h.select([root]);
  assert.equal(image.getAttribute("data-hdm-invert-media"), "inside");
  h.document.fullscreenElement = host; tree.fullscreenElement = panel; h.repaint();
  assert.equal(panel.getAttribute("data-hdm-invert-fullscreen"), "invert");
  assert.equal(host.getAttribute("data-hdm-invert-fullscreen"), null);
  assert.equal(image.getAttribute("data-hdm-invert-media"), "root", "a background above fullscreen no longer compensates the image");
  tree.fullscreenElement = image; h.repaint();
  assert.equal(image.getAttribute("data-hdm-invert-fullscreen"), "original", "fullscreen descendant media must retain its original colors");
  assert.equal(panel.getAttribute("data-hdm-invert-fullscreen"), null);
  h.select([image]);
  assert.equal(image.getAttribute("data-hdm-invert-fullscreen"), "invert", "explicitly chosen fullscreen media remains intentionally inverted");
  h.document.fullscreenElement = null; h.repaint();
  assert.equal(image.getAttribute("data-hdm-invert-fullscreen"), null);
});

test("manual painter removes all owned markers when disabled or a rule stops resolving", () => {
  const h = manualPainter(), root = h.element(), panel = h.element("div", root), image = h.element("img", panel);
  const outside = h.element(); h.document.fullscreenElement = outside; h.select([root]);
  assert.equal(outside.getAttribute("data-hdm-invert-fullscreen"), null, "unselected fullscreen areas must not be changed");
  h.document.fullscreenElement = panel; h.repaint();
  assert.equal(panel.getAttribute("data-hdm-invert-fullscreen"), "invert");
  assert.equal(image.getAttribute("data-hdm-invert-media"), "root");
  h.select([root], false);
  for (const node of [root, panel, image]) for (const name of ["data-hdm-inverted", "data-hdm-invert-media", "data-hdm-invert-fullscreen"]) {
    assert.equal(node.getAttribute(name), null, `disabled painter retained ${name}`);
  }
  assert.equal(h.listeners.size, 0);
  h.select([root]);
  assert.deepEqual([...h.listeners].map(({ type, capture }) => [type, capture]).sort(),
    [["beforetoggle", true], ["fullscreenchange", false], ["toggle", true], ["visibilitychange", false]]);
  image.isConnected = false; h.repaint();
  assert.equal(image.getAttribute("data-hdm-invert-media"), null, "detached nodes must not carry stale extension state");
  h.select([null]);
  assert.equal(root.getAttribute("data-hdm-inverted"), null);
  assert.equal(panel.getAttribute("data-hdm-invert-fullscreen"), null);
});

test("modal dialogs and popovers inside an inverted block are filtered as their own top-layer boundary", () => {
  const h = manualPainter(), root = h.element(), dialog = h.element("dialog", root), image = h.element("img", dialog);
  const outside = h.element("dialog"), host = h.element("section", root), tree = h.shadow(host), popover = h.element("div", null, tree);
  dialog.topLayer = outside.topLayer = popover.topLayer = true;
  h.select([root]);
  assert.equal(dialog.getAttribute("data-hdm-invert-fullscreen"), "invert");
  assert.equal(popover.getAttribute("data-hdm-invert-fullscreen"), "invert", "a popover in a shadow tree of the block is found through its scope");
  assert.equal(outside.getAttribute("data-hdm-invert-fullscreen"), null, "a dialog outside every block keeps the page's own colors");
  assert.equal(image.getAttribute("data-hdm-invert-media"), "root", "media restarts its compensation inside the dialog");
  assert.deepEqual([...h.cutouts().boundaries], [dialog, popover]);
  assert.equal(h.cutouts().owners.get(dialog), 90);
  assert.deepEqual([...tree.listening].sort(), ["beforetoggle", "toggle"], "popover events do not leave their shadow tree");
  dialog.topLayer = false; h.repaint();
  assert.equal(dialog.getAttribute("data-hdm-invert-fullscreen"), null);
  assert.equal(image.getAttribute("data-hdm-invert-media"), "root", "the closed dialog's media is compensated under the block again");
  h.select([root], false);
  assert.equal(tree.listening.size, 0);
  assert.equal(popover.getAttribute("data-hdm-invert-fullscreen"), null);
});
