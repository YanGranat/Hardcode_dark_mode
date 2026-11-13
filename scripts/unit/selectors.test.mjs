import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { worker } from "../support/worker.mjs";

import { clone, load } from "../support/modules.mjs";

function fixture() {
  const scope = host => ({ host, selectors: new Map(), querySelectorAll(selector) {
    if (selector === "[") throw Error("invalid selector");
    return this.selectors.get(selector) || [];
  } });
  const document = scope();
  class Element {
    constructor(localName, classes, root = document) {
      Object.assign(this, { localName, tagName: localName.toUpperCase(), classList: classes,
        isConnected: true, shadowRoot: null, root });
    }
    getRootNode() { return this.root; }
    get id() { assert.fail("group selectors must not depend on IDs"); }
  }
  const escaped = [];
  const context = vm.createContext({ URL, document, Element, CSS: { escape(value) {
    escaped.push(value);
    return value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`);
  } } });
  load(context, "shared/rules.js", "shared/site-utils.js", "content/selectors.js");
  return { document, scope, Element, escaped, sites: { ...context.HdmSites, ...context.HdmRules }, groups: { ruleFor: context.HdmSelectors.groupRuleFor, resolve: rule => context.HdmSelectors.resolveGroupResult(rule).elements, resolveResult: context.HdmSelectors.resolveGroupResult } };
}

test("rule identity preserves exact and explicit group rules independently", () => {
  const { sites } = fixture(), path = ["div.surface"], fallbackPath = ["main > div.surface"];
  const result = sites.normalizeExclusions([
    { path, fallbackPath, label: "Exact" }, { path, matchAll: true, label: "Group" },
    { path, matchAll: true, label: "Duplicate" }, { path, matchAll: false }, { path, matchAll: "true" }
  ]);
  assert.deepEqual(clone(result), [
    { path, fallbackPath, label: "Exact" }, { path, matchAll: true, label: "Group" }
  ]);
  path.push("changed"); fallbackPath.push("changed");
  assert.deepEqual(clone(result[0].path), ["div.surface"]);
  assert.deepEqual(clone(result[0].fallbackPath), ["main > div.surface"]);
  assert.equal(sites.normalizeStoredSite({ origin: "https://example.test", inclusions: result }).inclusions[1].matchAll, true);
});

test("group selectors use all sorted non-extension classes and include future matches", () => {
  const { groups, Element, document, escaped } = fixture();
  const first = new Element("div", ["surface", "dmx-on", "wide", "hdm-picked"]);
  const second = new Element("div", ["wide", "surface"]);
  document.selectors.set("div.surface.wide", [first, second]);
  const rule = groups.ruleFor(first);
  assert.deepEqual(clone(rule), { path: ["div.surface.wide"], matchAll: true, label: "div.surface.wide" });
  assert.deepEqual(clone(groups.ruleFor(second)), clone(rule), "class ordering must not create duplicate groups");
  assert.deepEqual(Array.from(groups.resolve(rule)), [first, second]);
  const third = new Element("div", ["surface", "wide"]);
  document.selectors.set("div.surface.wide", [first, second, third]);
  assert.deepEqual(Array.from(groups.resolve(rule)), [first, second, third]);
  assert(escaped.includes("surface") && escaped.includes("wide"));
  const special = new Element("div", ["panel:wide"]);
  document.selectors.set("div.panel\\:wide", [special]);
  assert.deepEqual(clone(groups.ruleFor(special).path), ["div.panel\\:wide"]);
});

test("only explicit groups branch across matching open shadow hosts", () => {
  const { groups, Element, document, scope } = fixture();
  const first = new Element("x-panel", ["panel"]), second = new Element("x-panel", ["panel"]);
  const closed = new Element("x-panel", ["panel"]);
  first.shadowRoot = scope(first); second.shadowRoot = scope(second);
  const a = new Element("svg", ["slide"], first.shadowRoot);
  const b = new Element("svg", ["slide"], second.shadowRoot);
  document.selectors.set("x-panel.panel", [first, second, closed]);
  first.shadowRoot.selectors.set("svg.slide", [a]); second.shadowRoot.selectors.set("svg.slide", [b]);
  const rule = groups.ruleFor(a);
  assert.deepEqual(clone(rule.path), ["x-panel.panel", "svg.slide"]);
  assert.deepEqual(Array.from(groups.resolve(rule)), [a, b]);
  assert.deepEqual(Array.from(groups.resolve({ path: rule.path })), [], "exact rules remain owned by the exact resolver");
  assert.deepEqual(Array.from(groups.resolve({ ...rule, matchAll: "true" })), []);
  second.shadowRoot.selectors.set("svg.slide", []);
  assert.deepEqual(Array.from(groups.resolve(rule)), [a]);
});

test("classless graphic groups use a nearby classed container and direct child types, never slide IDs", () => {
  const { groups, Element, document } = fixture();
  const container = new Element("div", ["viewer"]), wrapper = new Element("section", []);
  wrapper.parentElement = container;
  const slide = new Element("svg", []), second = new Element("svg", []);
  slide.parentElement = second.parentElement = wrapper;
  document.selectors.set("div.viewer > section > svg", [slide, second]);
  const rule = groups.ruleFor(slide);
  assert.deepEqual(clone(rule), { path: ["div.viewer > section > svg"], matchAll: true, label: "div.viewer > section > svg" });
  assert.deepEqual(Array.from(groups.resolve(rule)), [slide, second]);
  const replacement = new Element("svg", []); replacement.parentElement = wrapper;
  document.selectors.set("div.viewer > section > svg", [replacement, second]);
  assert.deepEqual(Array.from(groups.resolve(rule)), [replacement, second], "a new classless slide must inherit the saved container rule");
  const graphic = new Element("g", []); graphic.parentElement = replacement;
  document.selectors.set("div.viewer > section > svg > g", [graphic]);
  assert.deepEqual(clone(groups.ruleFor(graphic).path), ["div.viewer > section > svg > g"]);
});

test("classless group anchors cannot become document-wide selectors or cross a shadow boundary", () => {
  const { groups, Element, document, scope } = fixture();
  const body = new Element("body", ["loaded"]), wrapper = new Element("main", []);
  wrapper.parentElement = body;
  const slide = new Element("svg", ["hdm-picked"]); slide.parentElement = wrapper;
  document.selectors.set("svg", [slide]);
  document.selectors.set("main > svg", [slide]);
  assert.throws(() => groups.ruleFor(slide), /group_unavailable/, "body classes cannot anchor every SVG on the page");
  const host = new Element("x-panel", ["panel"]); host.shadowRoot = scope(host);
  const shadowSlide = new Element("svg", [], host.shadowRoot);
  document.selectors.set("x-panel.panel", [host]);
  host.shadowRoot.selectors.set("svg", [shadowSlide]);
  assert.throws(() => groups.ruleFor(shadowSlide), /group_unavailable/, "a host's class is not an ordinary ancestor inside its shadow root");
});

test("classless groups support independently anchored shadow segments with the same match budget", () => {
  const { groups, Element, document, scope } = fixture();
  const container = new Element("div", ["widget"]), host = new Element("x-panel", []);
  host.parentElement = container; host.shadowRoot = scope(host);
  const inner = new Element("section", ["surface"], host.shadowRoot), slide = new Element("svg", [], host.shadowRoot);
  slide.parentElement = inner;
  document.selectors.set("div.widget > x-panel", [host]);
  host.shadowRoot.selectors.set("section.surface > svg", [slide]);
  const rule = groups.ruleFor(slide);
  assert.deepEqual(clone(rule.path), ["div.widget > x-panel", "section.surface > svg"]);
  assert.deepEqual(Array.from(groups.resolve(rule)), [slide]);
  host.shadowRoot.selectors.set("section.surface > svg", Array(500).fill(slide));
  assert.equal(groups.resolveResult(rule).overflow, true, "intermediate classless hosts still consume the total budget");
});

test("ordinary ancestor depth has a separate bounded limit from shadow path depth", () => {
  const { groups, Element, document } = fixture();
  const anchor = new Element("div", ["viewer"]);
  let parent = anchor;
  for (let i = 0; i < 7; i++) { const child = new Element("div", []); child.parentElement = parent; parent = child; }
  const slide = new Element("svg", []); slide.parentElement = parent;
  const selector = "div.viewer" + " > div".repeat(7) + " > svg";
  document.selectors.set(selector, [slide]);
  assert.deepEqual(clone(groups.ruleFor(slide).path), [selector], "an anchor eight ancestors away is supported");
  const deeper = new Element("svg", []); deeper.parentElement = slide;
  document.selectors.set(selector + " > svg", [deeper]);
  assert.throws(() => groups.ruleFor(deeper), /group_unavailable/, "a ninth ordinary ancestor must not be searched");
});

test("group construction rejects unanchored, disconnected and excessively deep selections", () => {
  const { groups, Element, document, scope } = fixture();
  for (const node of [new Element("div", []), new Element("div", ["dmx-on", "hdm-picked"]), new Element("body", ["page"])]) {
    assert.throws(() => groups.ruleFor(node), /group_unavailable/);
  }
  const disconnected = new Element("div", ["surface"]); disconnected.isConnected = false;
  assert.throws(() => groups.ruleFor(disconnected), /group_unavailable/);
  const host = new Element("x-panel", []); host.shadowRoot = scope(host);
  assert.throws(() => groups.ruleFor(new Element("div", ["surface"], host.shadowRoot)), /group_unavailable/);
  const unmatched = new Element("div", ["surface"]);
  assert.throws(() => groups.ruleFor(unmatched), /group_unavailable/, "the chosen node must actually belong to the resolved group");
  let root = document;
  for (let depth = 0; depth < 8; depth++) {
    const host = new Element("x-panel", ["panel"], root); host.shadowRoot = scope(host); root = host.shadowRoot;
  }
  assert.throws(() => groups.ruleFor(new Element("div", ["surface"], root)), /group_unavailable/);
});

test("group resolution is fail-closed for malformed rules, forbidden roots and total-match overflow", () => {
  const { groups, Element, document, scope } = fixture();
  for (const rule of [null, {}, { path: [] }, { path: [1] }, { path: ["x".repeat(2049)] }, { path: Array(9).fill("div") }, { path: ["["] }]) {
    assert.deepEqual(Array.from(groups.resolve({ ...rule, matchAll: true })), []);
    assert.equal(groups.resolveResult({ ...rule, matchAll: true }).overflow, false, "invalid input is not a match-budget overflow");
  }
  assert.deepEqual(clone(groups.resolveResult({ path: ["div.missing"], matchAll: true })), { elements: [], overflow: false });
  document.selectors.set("body.page", [new Element("body", ["page"])]);
  assert.deepEqual(Array.from(groups.resolve({ path: ["body.page"], matchAll: true })), []);
  const nodes = Array.from({ length: 501 }, () => new Element("div", ["surface"]));
  document.selectors.set("div.surface", nodes.slice(0, 500));
  assert.equal(groups.resolve({ path: ["div.surface"], matchAll: true }).length, 500);
  assert.equal(groups.resolveResult({ path: ["div.surface"], matchAll: true }).overflow, false);
  document.selectors.set("div.surface", nodes);
  assert.equal(groups.resolve({ path: ["div.surface"], matchAll: true }).length, 0);
  assert.equal(groups.resolveResult({ path: ["div.surface"], matchAll: true }).overflow, true,
    "a protection rule must distinguish 501 matches from an absent area");
  assert.throws(() => groups.ruleFor(nodes[0]), /group_unavailable/);
  const hosts = [new Element("x-panel", ["panel"]), new Element("x-panel", ["panel"])];
  for (const host of hosts) host.shadowRoot = scope(host);
  document.selectors.set("x-panel.panel", hosts);
  hosts[0].shadowRoot.selectors.set("div.surface", nodes.slice(0, 250));
  hosts[1].shadowRoot.selectors.set("div.surface", nodes.slice(250, 499));
  assert.equal(groups.resolve({ path: ["x-panel.panel", "div.surface"], matchAll: true }).length, 0,
    "the budget includes intermediate host matches, not only the final group");
  assert.equal(groups.resolveResult({ path: ["x-panel.panel", "div.surface"], matchAll: true }).overflow, true);
});

test("worker preserves exact and group identities across active writers and legacy protection removal", async () => {
  const { send, state } = worker();
  const origin = "https://example.test", path = ["div.surface"];
  assert.equal((await send({ type: "hdm-universal-add-site", url: origin })).ok, true);
  await send({ type: "hdm-universal-set-mode", origin, mode: "selected" });
  for (const list of ["exclusion", "inversion"]) {
    const key = list === "exclusion" ? "exclusions" : "inclusions";
    const type = list === "exclusion" ? "hdm-exclusion-add" : "hdm-inversion-save";
    for (const rule of [{ path }, { path, matchAll: true }, { path, matchAll: true }]) {
      const existing = state.sites[0][key].some(item => JSON.stringify(item.path) === JSON.stringify(rule.path) &&
        (item.matchAll === true) === (rule.matchAll === true));
      const result = await send({ type, origin, rule });
      if (list === "inversion" && existing) assert.equal(result.error, "rule_conflict");
      else assert.equal(result.ok, true);
    }
    assert.equal(state.sites[0][key].length, 2);
    assert.equal((await send({ type: `hdm-${list}-remove`, origin, path, matchAll: true })).ok, true);
    assert.equal(state.sites[0][key].length, 1);
    assert.equal(state.sites[0][key][0].matchAll, undefined);
    await send({ type, origin, rule: { path, matchAll: true } });
    await send({ type: `hdm-${list}-remove`, origin, path });
    assert.deepEqual(state.sites[0][key].map(rule => rule.matchAll), [true]);
  }
  state.sites[0].protections = [{ path, label: "Exact" }, { path, matchAll: true, label: "Group" }];
  await send({ type: "hdm-protection-remove", origin, path, matchAll: true });
  assert.deepEqual(state.sites[0].protections, [{ path, label: "Exact" }]);
  state.sites[0].protections.push({ path, matchAll: true, label: "Group" });
  await send({ type: "hdm-protection-remove", origin, path });
  assert.deepEqual(state.sites[0].protections, [{ path, matchAll: true, label: "Group" }]);
});

test("selector fallback requires a regional anchor and cannot redirect to an unrelated shifted tag", () => {
  class Element { constructor(tag) { this.tagName = tag.toUpperCase(); this.localName = tag; } }
  const replacement = new Element("svg"), unrelated = new Element("div"), host = new Element("x-host");
  // The positional host does resolve, so only the anchoring rule can reject its path.
  host.shadowRoot = { querySelectorAll: selector => selector === '#stage > svg' ? [replacement] : [] };
  const matches = new Map([
    ['html > body > div:nth-of-type(1)', [unrelated]], ['body.loaded > div', [unrelated]],
    ['#stage > svg', [replacement]], ['#reused', [unrelated]], ['#present', [replacement]],
    ['x-host:nth-of-type(1)', [host]], ['x-host.panel', [host]]
  ]);
  const context = vm.createContext({ Element, CSS: { escape: value => value }, document: { querySelectorAll: selector => matches.get(selector) || [] } });
  load(context, "shared/rules.js", "content/selectors.js");
  const resolve = rule => context.HdmSelectors.resolveRule(rule);
  for (const selector of ['html > body > div:nth-of-type(1)', 'body.loaded > div']) {
    assert.equal(resolve({ path: ['#missing'], fallbackPath: [selector] }), null);
  }
  assert.equal(resolve({ path: ['#missing'], fallbackPath: ['#stage > svg'] }), replacement);
  assert.equal(resolve({ path: ['#reused'], fallbackPath: ['#stage > svg'] }), null);
  assert.equal(resolve({ path: ['#present'], fallbackPath: ['svg'] }), replacement, 'a precise primary ID remains authoritative');
  assert.equal(resolve({ path: ['#missing-host', '#missing'], fallbackPath: ['x-host:nth-of-type(1)', '#stage > svg'] }), null,
    'every shadow segment needs its own anchor');
  assert.equal(resolve({ path: ['#missing-host', '#missing'], fallbackPath: ['x-host.panel', '#stage > svg'] }), replacement);
});

test("graphic selection promotes SVG leaves to the nearest viewport and retains reversible ancestry", () => {
  const context = vm.createContext({ parent: element => element.parentElement });
  load(context, "shared/rules.js", "content/selectors.js");
  const svgNamespace = "http://www.w3.org/2000/svg";
  function node(localName, parentElement = null, namespaceURI = svgNamespace) {
    return { localName, parentElement, namespaceURI, closest(selector) {
      assert.equal(selector, "svg");
      for (let current = this; current; current = current.parentElement) {
        if (current.localName === "svg") return current;
      }
      return null;
    } };
  }
  const outer = node("svg"), inner = node("svg", outer), group = node("g", inner), leaf = node("rect", group);
  const selection = context.HdmSelectors.selectionFor(leaf);
  assert.equal(selection.target, inner, "nested SVG must not expand into the outer drawing");
  assert.deepEqual(Array.from(selection.history), [leaf, group]);
  assert.equal(selection.history.pop(), group, "first Smaller step restores the drawing group");
  assert.equal(selection.history.pop(), leaf, "second Smaller step restores the exact original shape");
  assert.equal(leaf.parentElement, group, "selection must not mutate page ancestry");
  const direct = context.HdmSelectors.selectionFor(inner);
  assert.equal(direct.target, inner);
  assert.deepEqual(Array.from(direct.history), []);
  const text = node("text", group);
  assert.equal(context.HdmSelectors.selectionFor(text).target, inner);
  const standalone = node("rect");
  assert.equal(context.HdmSelectors.selectionFor(standalone).target, standalone, "SVG namespace without a viewport remains selectable");
});

test("graphic selection leaves HTML foreignObject controls and canvas unchanged", () => {
  const context = vm.createContext({ parent: element => element.parentElement });
  load(context, "shared/rules.js", "content/selectors.js");
  const outer = { localName: "svg", namespaceURI: "http://www.w3.org/2000/svg" };
  const foreignObject = { localName: "foreignObject", parentElement: outer, namespaceURI: outer.namespaceURI };
  for (const localName of ["button", "div", "canvas", "svg"]) {
    const element = { localName, namespaceURI: "http://www.w3.org/1999/xhtml", parentElement: foreignObject,
      closest() { assert.fail("HTML content must not be promoted just because it has an SVG ancestor or name"); } };
    const selected = context.HdmSelectors.selectionFor(element);
    assert.equal(selected.target, element);
    assert.deepEqual(Array.from(selected.history), []);
  }
});

test("unknown added dates remain stable across normalization without consulting the clock", () => {
  const context = vm.createContext({ URL, Date: { now() { assert.fail("normalization must not invent a creation date"); } } });
  load(context, "shared/rules.js", "shared/site-utils.js");
  for (const addedAt of [undefined, null, 0, -1, NaN, Infinity, -Infinity, "123"]) {
    const original = { origin: "https://parent.test", addedAt };
    const normalized = context.HdmSites.normalizeStoredSite(original);
    assert.equal(normalized.addedAt, 0);
    assert.equal(context.HdmSites.normalizeStoredSite(normalized).addedAt, 0);
    assert.equal(original.addedAt, addedAt);
  }
  assert.equal(context.HdmSites.normalizeStoredSite({ origin: "https://parent.test", addedAt: 123 }).addedAt, 123);
});

test("site normalization defaults legacy mode and preserves bounded independent rule metadata", () => {
  const context = vm.createContext({ URL });
  load(context, "shared/rules.js", "shared/site-utils.js");
  const normalize = value => clone(context.HdmRules.normalizeExclusions(value));
  const primary = ["#host", "#shape"], fallback = [".viewer", "svg"];
  const rules = [{ path: primary, fallbackPath: fallback, label: "Slide" },
    { path: [...primary], fallbackPath: [".different"], label: "Duplicate" }];
  assert.deepEqual(normalize(rules), [{ path: primary, fallbackPath: fallback, label: "Slide" }]);
  const normalized = context.HdmRules.normalizeExclusions(rules);
  normalized[0].path[0] = "#changed"; normalized[0].fallbackPath[0] = ".changed";
  assert.deepEqual(primary, ["#host", "#shape"]);
  assert.deepEqual(fallback, [".viewer", "svg"]);
  for (const path of [undefined, null, [], [""], [1], "#one", Array(9).fill("x"), ["x".repeat(2049)]]) {
    assert.deepEqual(normalize([{ path }]), []);
    assert.deepEqual(normalize([{ path: ["#valid"], fallbackPath: path, label: "Kept" }]), [{ path: ["#valid"], label: "Kept" }]);
  }
  const largest = Array(8).fill("x".repeat(2048));
  assert.deepEqual(normalize([{ path: largest, fallbackPath: largest, label: "x".repeat(81) }]),
    [{ path: largest, fallbackPath: largest, label: "x".repeat(80) }]);
  assert.equal(normalize(Array.from({ length: 101 }, (_, index) => ({ path: [`#item-${index}`] }))).length, 100);
  const legacy = clone(context.HdmSites.normalizeStoredSite({ origin: "https://parent.test", exclusions: rules }));
  assert.equal(legacy.mode, "page"); assert.deepEqual(legacy.inclusions, []);
  for (const mode of [undefined, null, "invalid", "PAGE", true]) {
    assert.equal(context.HdmSites.normalizeStoredSite({ origin: legacy.origin, mode }).mode, "page");
  }
  const selected = clone(context.HdmSites.normalizeStoredSite({ ...legacy, mode: "selected", inclusions: rules }));
  assert.equal(selected.mode, "selected");
  assert.deepEqual(selected.inclusions, legacy.exclusions);
  assert.deepEqual(selected.exclusions, legacy.exclusions);
});
