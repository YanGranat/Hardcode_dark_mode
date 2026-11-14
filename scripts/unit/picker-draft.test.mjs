import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { clone, load } from "../support/modules.mjs";

function fixture({ invert = true, initialRule, saved = [] } = {}) {
  const matches = new Map();
  const node = (id, parentElement = null) => {
    const element = { id, localName: "div", parentElement, isConnected: true };
    matches.set(`#${id}`, [element]);
    return element;
  };
  const a = node("a"), b = node("b"), child = node("child", a), nextChild = node("next-child", a), outside = node("outside", b);
  const pathKey = path => path.join(" / ");
  const resolveRules = rules => rules.flatMap(rule => {
    let found = (matches.get(pathKey(rule.path)) || []).filter(node => node.isConnected);
    if (!found.length && rule.fallbackPath) found = (matches.get(pathKey(rule.fallbackPath)) || []).filter(node => node.isConnected);
    return rule.matchAll || found.length === 1 ? found : [];
  });
  const selectors = {
    parent: node => node.parentElement,
    allowed: node => Boolean(node && !["html", "body"].includes(node.localName)),
    selectionFor: node => node.promoted || { target: node, history: [] },
    ruleFor: node => ({ path: [`#${node.id}`], label: node.localName }),
    resolveRules,
    inside(node, roots) {
      for (let parent = node.parentElement; parent; parent = parent.parentElement) if (roots.includes(parent)) return true;
      return false;
    },
    groupRuleFor(node) {
      if (!node.group || !(matches.get(node.group) || []).includes(node)) throw Error("group_unavailable");
      return { path: [node.group], label: node.localName, matchAll: true };
    },
  };
  const context = vm.createContext({ HdmSelectors: selectors });
  load(context, "shared/rules.js", "editor/draft.js");
  const draft = context.HdmPickerDraft.create({ invert, initialRule, rules: () => saved });
  const choose = element => { draft.hover(element); return draft.select(element); };
  return { draft, context, matches, node, a, b, child, nextChild, outside, choose, saved };
}

test("commands expose coherent preview and save bundles without an extra synchronization call", () => {
  const h = fixture(), { draft } = h;
  assert.equal(h.choose(h.a).status, "chosen");
  let state = draft.snapshot();
  assert.deepEqual(clone(state.save.rule), { path: ["#a"], label: "div", protections: [] });
  assert.deepEqual(clone(state.preview.draft.rule), clone(state.save.rule));
  draft.beginException(); h.choose(h.child);
  state = draft.snapshot();
  assert.equal(state.choosingException, true);
  assert.deepEqual(clone(state.preview.draft.rule.protections), [{ path: ["#child"], label: "div" }]);
  assert.equal(draft.finishException(true).accepted, true);
  state = draft.snapshot();
  assert.deepEqual(clone(state.save.rule.protections), [{ path: ["#child"], label: "div" }]);
  draft.removeException(0);
  assert.deepEqual(clone(draft.snapshot().save.rule.protections), []);
  assert.deepEqual(clone(draft.snapshot().preview.draft.rule), clone(draft.snapshot().save.rule));
});

test("an untouched adopted rule releases borrowed exceptions and metadata when selection moves", () => {
  const saved = [{ path: ["#a"], label: "div", name: "Named area", enabled: false,
    protections: [{ path: ["#child"], label: "div", name: "Chart" }] }];
  const h = fixture({ saved }); h.choose(h.a);
  assert.deepEqual(clone(h.draft.snapshot().save.original), saved[0]);
  assert.equal(h.draft.snapshot().save.rule.name, "Named area");
  h.draft.select(h.b);
  assert.deepEqual(clone(h.draft.snapshot().save), {
    rule: { path: ["#b"], label: "div", protections: [] }, original: null, removeLegacyProtections: [],
  });
  assert.equal(saved[0].protections.length, 1);
});

test("editing adopted exceptions pins the root and preserves metadata across an exact-to-group change", () => {
  const saved = [{ path: ["#a"], label: "div", name: "Named area", enabled: false,
    protections: [{ path: ["#child"], label: "div" }] }];
  const h = fixture({ saved }); h.a.group = ".area"; h.matches.set(".area", [h.a, h.b]);
  h.choose(h.a); h.draft.removeException(0); h.draft.select(h.b);
  assert.equal(h.draft.snapshot().target, h.a);
  h.draft.scope(true);
  const state = h.draft.snapshot();
  assert.deepEqual(clone(state.save.rule), { path: [".area"], label: "div", matchAll: true,
    name: "Named area", enabled: false, protections: [] });
  assert.deepEqual(clone(state.save.original), saved[0]);
  assert.equal(state.selectedMatches.length, 2);
});

test("an explicitly opened rule cannot be retargeted by hover or a second click", () => {
  const initialRule = { path: ["#a"], label: "div", name: "Work area", protections: [] };
  const h = fixture({ initialRule, saved: [initialRule] });
  h.draft.hover(h.b); h.draft.select(h.b);
  assert.equal(h.draft.snapshot().target, h.a);
  assert.deepEqual(clone(h.draft.snapshot().save.original), initialRule);
});

test("resolved exact aliases retain their original snapshot while conflicting aliases are rejected", () => {
  const saved = [{ path: ["#alias"], label: "section", name: "Aliased area", protections: [] }];
  const h = fixture({ saved }); h.matches.set("#alias", [h.a]); h.choose(h.a);
  assert.deepEqual(clone(h.draft.snapshot().save.original), saved[0]);
  assert.deepEqual(clone(h.draft.snapshot().save.rule.path), ["#a"]);
  assert.equal(h.draft.snapshot().save.rule.name, "Aliased area");
  const other = fixture({ saved: [...saved, { path: ["#alias-two"], label: "div" }] });
  other.matches.set("#alias", [other.a]); other.matches.set("#alias-two", [other.a]);
  assert.equal(other.choose(other.a).status, "conflict");
  assert.equal(other.draft.snapshot().save.rule, undefined);
});

test("editing an exception retains its metadata and cancellation restores the saved child", () => {
  const originalChild = { path: ["#child"], label: "div", name: "Chart colors", enabled: false };
  const initialRule = { path: ["#a"], label: "div", protections: [originalChild] };
  const h = fixture({ initialRule, saved: [initialRule] });
  h.draft.beginException(0); h.draft.select(h.nextChild);
  assert.deepEqual(clone(h.draft.snapshot().preview.draft.rule.protections), [
    { path: ["#next-child"], label: "div", name: "Chart colors", enabled: false },
  ]);
  h.draft.finishException(false);
  assert.deepEqual(clone(h.draft.snapshot().save.rule.protections), [originalChild]);
  h.draft.beginException(0); h.draft.select(h.nextChild); h.draft.finishException(true);
  assert.deepEqual(clone(h.draft.snapshot().save.rule.protections), [
    { path: ["#next-child"], label: "div", name: "Chart colors", enabled: false },
  ]);
  assert.deepEqual(initialRule.protections, [originalChild]);
});

test("exceptions exclude neither their parent nor another block, including promoted graphic hits", () => {
  const h = fixture(); h.choose(h.a); h.draft.beginException();
  h.choose(h.a); assert.equal(h.draft.snapshot().target, null);
  h.choose(h.outside); assert.equal(h.draft.snapshot().selectedMatches.length, 0);
  assert.equal(h.draft.finishException(true).accepted, false);
  h.child.promoted = { target: h.a, history: [h.child] };
  h.choose(h.child);
  assert.equal(h.draft.snapshot().target, h.child, "promotion cannot escape the exception's parent");
  h.child.group = ".graphic"; h.matches.set(".graphic", [h.child, h.outside]);
  h.draft.scope(true);
  assert.deepEqual(Array.from(h.draft.snapshot().selectedMatches), [h.child]);
  h.draft.finishException(true);
  assert.equal(h.draft.snapshot().save.rule.protections[0].matchAll, true);
});

test("a full exception list refuses another child without truncating the existing bundle", () => {
  const children = Array.from({ length: 100 }, (_, index) => ({ path: [`#child-${index}`], label: "div" }));
  const initialRule = { path: ["#a"], label: "div", protections: children };
  const h = fixture({ initialRule, saved: [initialRule] });
  h.draft.beginException(); h.choose(h.child);
  assert.deepEqual(clone(h.draft.finishException(true)), { accepted: false, status: "limit" });
  assert.equal(h.draft.snapshot().exceptions.length, 100);
  h.draft.finishException(false);
  assert.deepEqual(clone(h.draft.snapshot().save.rule.protections), children);
});

test("missing edited roots remain pinned and rebind to replacement nodes with the whole bundle", () => {
  const initialRule = { path: ["#a"], label: "div", name: "Reading area", protections: [{ path: ["#child"], label: "div" }] };
  const h = fixture({ initialRule, saved: [initialRule] });
  h.a.isConnected = false; h.child.isConnected = false; h.draft.reconcile();
  assert.equal(h.draft.snapshot().awaitingRoot, true);
  h.draft.hover(h.b); h.draft.select(h.b);
  assert.equal(h.draft.snapshot().target, null);
  const replacement = h.node("a"), child = h.node("child", replacement);
  h.draft.reconcile();
  assert.equal(h.draft.snapshot().target, replacement);
  assert.equal(h.draft.snapshot().awaitingRoot, false);
  assert.deepEqual(Array.from(h.draft.snapshot().exceptionMatches[0]), [child]);
  assert.deepEqual(clone(h.draft.snapshot().save.rule), initialRule);
});

test("an untouched new root may be replaced after it disappears", () => {
  const h = fixture(); h.choose(h.a); h.a.isConnected = false; h.draft.reconcile();
  assert.equal(h.draft.snapshot().awaitingRoot, false);
  h.draft.hover(h.b); h.draft.reconcile(); h.draft.select(h.b);
  assert.deepEqual(clone(h.draft.snapshot().save.rule.path), ["#b"]);
});

test("a new block with collected exceptions waits for its replacement without changing the save bundle", () => {
  const h = fixture(); h.choose(h.a); h.draft.beginException(); h.choose(h.child);
  assert.equal(h.draft.finishException(true).accepted, true);
  const before = clone(h.draft.snapshot().save);
  h.a.isConnected = false; h.child.isConnected = false; h.draft.reconcile();
  assert.equal(h.draft.snapshot().awaitingRoot, true);
  h.draft.hover(h.b); h.draft.select(h.b);
  assert.equal(h.draft.snapshot().target, null);
  assert.deepEqual(clone(h.draft.snapshot().save), before);
  const replacement = h.node("a"); h.node("child", replacement); h.draft.reconcile();
  assert.equal(h.draft.snapshot().target, replacement);
  assert.deepEqual(clone(h.draft.snapshot().save), before);
});

test("page exclusions preserve exact aliases and release a disappeared preview", () => {
  const saved = [{ path: ["#alias"], label: "div", name: "Banner" }];
  const h = fixture({ invert: false, saved }); h.matches.set("#alias", [h.a]); h.choose(h.a);
  assert.deepEqual(clone(h.draft.snapshot().save.rule), saved[0]);
  assert.equal(h.draft.snapshot().preview.draft, null);
  h.a.isConnected = false;
  assert.equal(h.draft.reconcile().paint, true);
  assert.equal(h.draft.snapshot().preview.exclusion, null);
  h.choose(h.b);
  assert.deepEqual(clone(h.draft.snapshot().save.rule.path), ["#b"]);
});

test("graphic selection history remains reversible through larger and smaller commands", () => {
  const h = fixture(), svg = h.node("svg", h.a), group = h.node("drawing", svg), leaf = h.node("leaf", group);
  leaf.promoted = { target: svg, history: [leaf, group] };
  h.choose(leaf);
  assert.equal(h.draft.snapshot().target, svg);
  assert.equal(h.draft.snapshot().historyLength, 2);
  h.draft.resize(false); assert.equal(h.draft.snapshot().target, group);
  h.draft.resize(false); assert.equal(h.draft.snapshot().target, leaf);
  h.draft.resize(true); assert.equal(h.draft.snapshot().target, group);
  assert.deepEqual(clone(h.draft.snapshot().save.rule.path), ["#drawing"]);
});

test("legacy cleanup snapshots travel with the same bundle and pin collected work", () => {
  const h = fixture(); h.choose(h.a);
  const first = { path: ["#legacy"], label: "div", name: "Original area" }, second = { ...first, name: "Updated area" };
  h.draft.removeLegacy(first); h.draft.removeLegacy(second); h.draft.select(h.b);
  const state = h.draft.snapshot();
  assert.equal(state.target, h.a);
  assert.deepEqual(clone(state.save.removeLegacyProtections), [second]);
  assert.deepEqual(clone(state.preview.draft.removeLegacyProtections), [second]);
  assert.equal(state.save.original, null);
});

function adapterFixture() {
  const h = fixture(), paints = [], ended = [], messages = [];
  let actions, input, releaseSave, hit = h.a;
  const control = () => ({
    style: {}, dataset: {}, children: [], isConnected: true, disabled: false, textContent: "",
    setAttribute() {}, remove() { this.isConnected = false; }, focus() {},
    getClientRects: () => [{}], contains: () => false,
    replaceChildren() { this.children = []; },
  });
  const controls = ["host", "panel", "outline", "title", "status", "larger", "smaller", "one", "similar",
    "matchCount", "rootContext", "exceptionsSection", "exceptionList", "emptyExceptions", "addException",
    "legacySection", "legacyList", "back", "applyException", "save", "cancel"];
  const renderer = {
    snapshot: () => ({ rules: [], protections: [], legacyCoversRoot: false, coveringRule: null }),
    blocked: () => false,
    preview: value => paints.push(clone(value)),
    endEdit: value => ended.push(value),
  };
  Object.assign(h.context, {
    queueMicrotask,
    document: { createElement: control },
    HdmPickerView: { create(value) {
      actions = value.actions;
      const view = Object.fromEntries(controls.map(name => [name, control()]));
      view.text = new Proxy({}, { get: (_, key) => String(key) });
      view.shadow = { activeElement: null, insertBefore() {} };
      view.mount = () => {};
      view.previousFocus = null;
      return view;
    } },
    HdmPickerInput: { connect(value) {
      input = value;
      return { own: () => false, hit: () => hit, disconnect() {} };
    } },
    HdmRequests: { send: request => request() },
    chrome: { runtime: { sendMessage(message) {
      messages.push(clone(message));
      return new Promise(resolve => { releaseSave = resolve; });
    } } },
  });
  for (const node of [h.a, h.child]) node.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 80 });
  load(h.context, "editor/picker.js");
  const event = { preventDefault() {}, stopImmediatePropagation() {} };
  return {
    ...h, paints, ended, messages,
    open: () => h.context.HdmPicker.open(renderer, { invert: true, language: "en", origin: "https://example.test" }),
    select(node) { hit = node; input.onMove(event); input.onClick(event); },
    actions: () => actions, input: () => input, release: value => releaseSave(value),
  };
}

test("the picker adapter publishes commands and ignores a successful reply after its session closes", async () => {
  const h = adapterFixture(); h.open(); h.select(h.a);
  assert.deepEqual(h.paints.at(-1).draft.rule, { path: ["#a"], label: "div", protections: [] });
  const pending = h.actions().save();
  assert.deepEqual(h.messages[0].rule, h.paints.at(-1).draft.rule);
  h.actions().cancel(); assert.equal(h.ended.length, 0, "a pending save cannot be presented as cancelled");
  h.input().onClose();
  const paints = h.paints.length;
  h.release({ ok: true }); await pending;
  assert.equal(h.ended.length, 1, "a late success cannot end a replacement session");
  assert.equal(h.ended[0], undefined, "forced closure does not claim a completed save");
  assert.equal(h.paints.length, paints);
});

test("queued repaint after exception removal cannot revive a closed draft or overwrite a new session", async () => {
  const h = adapterFixture(); h.open(); h.select(h.a);
  h.actions().beginException(); h.select(h.child);
  assert.equal(h.paints.at(-1).draft.rule.protections.length, 1);
  h.child.isConnected = false; h.input().refresh();
  h.actions().cancel();
  const oldInput = h.input();
  h.open(); h.select(h.a);
  const latest = clone(h.paints.at(-1)), count = h.paints.length;
  oldInput.refresh();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.paints.length, count, "closed queued work must not publish a preview");
  assert.deepEqual(h.paints.at(-1), latest);
  assert.deepEqual(latest.draft.rule.protections, []);
  h.actions().cancel();
});
