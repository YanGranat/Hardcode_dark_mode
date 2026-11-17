import assert from "node:assert/strict";
import { load } from "../support/modules.mjs";
import vm from "node:vm";
import test from "node:test";

const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

function fixture({ ratio } = {}) {
  const counts = { attributes: 0, tree: 0, ancestry: 0, geometry: 0, styles: 0 };
  const document = { URL: "http://fixture.test/page" };
  class Element {
    constructor(name) {
      this.localName = name; this.attributes = new Map(); this.children = []; this._parent = null;
      this.assignedSlot = null; this.shadowRoot = null;
      this.box = box(0, 0, 100, 100);
      this.offsetWidth = this.offsetHeight = this.clientWidth = this.clientHeight = 100;
      this.clientLeft = this.clientTop = 0;
      this.css = { transform: "none", rotate: "none", scale: "none", perspective: "none", overflowX: "visible", overflowY: "visible" };
      const properties = new Map();
      this.style = {
        getPropertyValue: key => properties.get(key)?.[0] || "",
        getPropertyPriority: key => properties.get(key)?.[1] || "",
        setProperty(key, value, priority = "") { counts.attributes++; properties.set(key, [value, priority]); },
        removeProperty(key) { counts.attributes++; properties.delete(key); }
      };
    }
    get parentElement() { counts.ancestry++; return this._parent; }
    get id() { return this.getAttribute("id") || ""; }
    get isConnected() { return this === document.documentElement || Boolean(this._parent?.isConnected); }
    getRootNode() { return document; }
    appendChild(node) { counts.tree++; node._parent = this; this.children.push(node); return node; }
    remove() { counts.tree++; if (this._parent) this._parent.children = this._parent.children.filter(node => node !== this); this._parent = null; }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { counts.attributes++; this.attributes.set(name, String(value)); }
    removeAttribute(name) { counts.attributes++; this.attributes.delete(name); }
    getBoundingClientRect() { counts.geometry++; return this.box; }
  }
  document.documentElement = new Element("html");
  document.createElementNS = (_, name) => new Element(name);
  const context = vm.createContext({ document, URL, Uint32Array, devicePixelRatio: ratio,
    // Insecure HTTP contexts do not provide crypto.randomUUID().
    crypto: { getRandomValues(values) { values.fill(1234); return values; } },
    getComputedStyle(element) { counts.styles++; return element.css; },
    DOMMatrixReadOnly: class {
      constructor(value) {
        this.is2D = !value.startsWith("matrix3d");
        [this.a, this.b, this.c, this.d] = value.slice(value.indexOf("(") + 1, -1).split(",").map(Number);
      }
    }
  });
  load(context, "shared/rules.js", "content/selectors.js", "content/cutout-geometry.js", "content/cutouts.js");
  const api = context.HdmCutouts.create();
  const node = (parent = document.documentElement, name = "div") => parent.appendChild(new Element(name));
  const filters = () => document.documentElement.children.filter(node => node.localName === "svg").flatMap(node => node.children);
  return { api, node, counts, document, filters, plan: context.HdmCutoutGeometry.plan };
}

test("geometry plans read the page without mutating it or retaining earlier results", () => {
  const h = fixture(), owner = h.node(), target = h.node(owner);
  owner.box = box(10, 20, 200, 100);
  owner.offsetWidth = owner.clientWidth = 200;
  target.box = box(50, 30, 80, 30);
  const before = { ...h.counts };
  const first = h.plan(new Map([[owner, 90]]), [target]);
  assert.equal(h.counts.attributes, before.attributes);
  assert.equal(h.counts.tree, before.tree);
  assert.equal(first.trackGeometry, true);
  assert.equal(first.updates.get(owner).blocked, false);
  assert.deepEqual(JSON.parse(JSON.stringify(first.updates.get(owner).rects)), [[0.2, 0.1, 0.4, 0.3]]);
  target.box = box(70, 40, 80, 30);
  const second = h.plan(new Map([[owner, 90]]), [target]);
  assert.deepEqual(JSON.parse(JSON.stringify(second.updates.get(owner).rects)), [[0.3, 0.2, 0.4, 0.3]]);
  assert.deepEqual(JSON.parse(JSON.stringify(first.updates.get(owner).rects)), [[0.2, 0.1, 0.4, 0.3]]);
  assert.equal(h.filters().length, 0);
});

test("cutouts retain SourceGraphic within an sRGB mask without requiring secure-context UUIDs", () => {
  const h = fixture(), owner = h.node(), target = h.node(owner);
  target.box = box(20, 10, 40, 30);
  h.api.paint(new Map([[owner, 90]]), [target]);
  assert.equal(owner.getAttribute("data-hdm-cutout"), "mask");
  const filter = h.filters()[0];
  assert.equal(filter.style.getPropertyValue("color-interpolation-filters"), "sRGB");
  assert.equal(filter.style.getPropertyPriority("color-interpolation-filters"), "important");
  const original = filter.children.find(node => node.getAttribute("result") === "original");
  assert.equal(original.getAttribute("in"), "SourceGraphic");
  assert.equal(original.getAttribute("operator"), "in");
  const mask = filter.children.find(node => node.localName === "feFlood");
  assert.deepEqual(["x", "y", "width", "height"].map(name => Number(mask.getAttribute(name))), [0.2, 0.1, 0.4, 0.3]);
  const sum = filter.children.at(-1);
  assert.equal(sum.getAttribute("operator"), "arithmetic");
  assert.equal(sum.getAttribute("k2"), "1"); assert.equal(sum.getAttribute("k3"), "1");
  const transfer = filter.children.find(node => node.localName === "feComponentTransfer");
  assert(transfer.children.every(node => node.getAttribute("slope") === "-0.8" && node.getAttribute("intercept") === "0.9"));
  assert.match(owner.style.getPropertyValue("--hdm-cutout-filter"), /http:\/\/fixture\.test\/page#hdm-cutout-/);
  h.api.paint(new Map([[owner, 100]]), [target]);
  const counter = h.filters()[0].children.find(node => node.localName === "feComponentTransfer");
  assert(counter.children.every(node => node.getAttribute("slope") === "-1" && node.getAttribute("intercept") === "1"));
});

test("unchanged geometry performs no writes and moving masks retain their filter identity", () => {
  const h = fixture(), owner = h.node(), target = h.node(owner);
  target.box = box(20, 10, 40, 30);
  const owners = new Map([[owner, 90]]);
  h.api.paint(owners, [target]);
  const filter = h.filters()[0], id = filter.getAttribute("id"), property = owner.style.getPropertyValue("--hdm-cutout-filter");
  const before = { ...h.counts }; h.api.paint(owners, [target]);
  assert.equal(h.counts.attributes, before.attributes); assert.equal(h.counts.tree, before.tree);
  target.box = box(30, 10, 40, 30); h.api.paint(owners, [target]);
  assert.equal(h.filters()[0], filter); assert.equal(filter.getAttribute("id"), id);
  assert.equal(owner.style.getPropertyValue("--hdm-cutout-filter"), property);
  assert.equal(h.counts.tree, before.tree);
  assert.equal(filter.children.find(node => node.localName === "feFlood").getAttribute("x"), "0.3");
});

test("cleanup restores prior owner state and removes unused SVG resources", () => {
  const h = fixture(), owner = h.node(), target = h.node(owner);
  target.box = box(20, 10, 40, 30);
  owner.setAttribute("data-hdm-cutout", "site-owned");
  owner.style.setProperty("--hdm-cutout-filter", "initial", "important");
  h.api.paint(new Map([[owner, 90]]), [target]); h.api.clear();
  assert.equal(owner.getAttribute("data-hdm-cutout"), "site-owned");
  assert.equal(owner.style.getPropertyValue("--hdm-cutout-filter"), "initial");
  assert.equal(owner.style.getPropertyPriority("--hdm-cutout-filter"), "important");
  assert.equal(h.filters().length, 0);
  const before = { ...h.counts }; h.api.paint(new Map(), []);
  assert.equal(h.counts.tree, before.tree); assert.equal(h.counts.attributes, before.attributes);
  h.api.paint(new Map([[owner, 90]]), [target]);
  owner.style.setProperty("--hdm-cutout-filter", "updated-by-page");
  h.api.clear();
  assert.equal(owner.style.getPropertyValue("--hdm-cutout-filter"), "updated-by-page", "cleanup must preserve a newer page-owned change");
});

test("geometry refresh reuses settled styles and filter resources while retaining live inputs", () => {
  const h = fixture(), owner = h.node(), target = h.node(owner);
  target.box = box(20, 10, 40, 30);
  h.api.paint(new Map([[owner, 90]]), [target]);
  const filter = h.filters()[0], before = { ...h.counts };
  for (let index = 0; index < 12; index++) assert.equal(h.api.updateGeometry(), true);
  assert.equal(h.counts.styles, before.styles, "idle frames must not reacquire computed styles");
  assert.equal(h.counts.ancestry, before.ancestry, "idle frames must not rebuild owner paths");
  assert.equal(h.counts.attributes, before.attributes);
  assert.equal(h.counts.tree, before.tree);
  target.box = box(30, 10, 40, 30);
  h.api.updateGeometry();
  assert.equal(h.filters()[0], filter);
  assert.equal(filter.children.find(node => node.localName === "feFlood").getAttribute("x"), "0.3");
  target.css.rotate = "180deg";
  h.api.updateGeometry();
  assert.equal(owner.getAttribute("data-hdm-cutout"), "blocked", "same-size rotation still changes protection safety");
  target.css.rotate = "none";
  h.api.updateGeometry();
  assert.equal(owner.getAttribute("data-hdm-cutout"), "mask");
  h.document.URL = "http://fixture.test/next";
  h.api.updateGeometry();
  assert.match(owner.style.getPropertyValue("--hdm-cutout-filter"), /\/next#hdm-cutout-/);
  h.api.clear();
  assert.equal(h.api.updateGeometry(), false);
  assert.equal(h.filters().length, 0, "a cleared plan must not revive its filters");
});

test("geometry refresh notices clipping metrics and disconnection without changing outer bounds", () => {
  const h = fixture(), owner = h.node(), clip = h.node(owner), target = h.node(clip);
  clip.css.overflowX = clip.css.overflowY = "hidden";
  clip.clientWidth = clip.clientHeight = 80;
  target.box = box(20, 10, 60, 30);
  h.api.paint(new Map([[owner, 90]]), [target]);
  const flood = () => h.filters()[0].children.find(node => node.localName === "feFlood");
  assert.equal(flood().getAttribute("width"), "0.6");
  clip.clientWidth = 60;
  h.api.updateGeometry();
  assert.equal(flood().getAttribute("width"), "0.4", "scrollbar or viewport metrics can change independently");
  target.remove();
  assert.equal(h.api.updateGeometry(), false);
  assert.equal(owner.getAttribute("data-hdm-cutout"), null);
});

test("settled geometry restores removed resources and externally replaced owner state", () => {
  const h = fixture(), owner = h.node(), target = h.node(owner);
  target.box = box(20, 10, 40, 30);
  h.api.paint(new Map([[owner, 90]]), [target]);
  h.filters()[0].remove();
  h.api.updateGeometry();
  assert.equal(h.filters().length, 1);
  owner.removeAttribute("data-hdm-cutout");
  owner.style.removeProperty("--hdm-cutout-filter");
  h.api.updateGeometry();
  assert.equal(owner.getAttribute("data-hdm-cutout"), "mask");
  assert.match(owner.style.getPropertyValue("--hdm-cutout-filter"), /^url\(/);
});

test("unsupported transforms, protected ancestors and overflow suspension never invert protected areas", () => {
  const h = fixture(), owner = h.node(), target = h.node(owner), nested = h.node(target);
  target.box = box(20, 10, 40, 30); nested.box = box(20, 10, 10, 10);
  h.api.paint(new Map([[owner, 90], [nested, 100]]), [target]);
  assert.equal(nested.getAttribute("data-hdm-cutout"), "blocked");
  assert.equal(nested.style.getPropertyValue("--hdm-cutout-filter"), "opacity(1)");
  target.css.transform = "matrix(1,0.5,0,1,0,0)";
  h.api.paint(new Map([[owner, 90]]), [target]);
  assert.equal(owner.getAttribute("data-hdm-cutout"), "blocked"); assert.equal(h.api.blocked(), true);
  target.css.transform = "none";
  assert.equal(h.api.paint(new Map([[owner, 90]]), [], true), false);
  assert.equal(owner.getAttribute("data-hdm-cutout"), "blocked");
  h.api.paint(new Map([[owner, 90]]), [target], false);
  assert.equal(owner.getAttribute("data-hdm-cutout"), "mask"); assert.equal(h.api.blocked(), false);
});

test("scoped blocking ignores unrelated owners and follows ancestor, descendant and slot relationships", () => {
  const h = fixture(), valid = h.node(), validTarget = h.node(valid), unsupported = h.node(), target = h.node(unsupported);
  validTarget.box = target.box = box(20, 10, 40, 30);
  target.css.transform = "matrix(1,0.5,0,1,0,0)";
  h.api.paint(new Map([[valid, 90], [unsupported, 90]]), [validTarget, target]);
  assert.equal(h.api.blocked(), true, "legacy global status remains available");
  assert.equal(h.api.blocked([valid]), false, "an unrelated unsafe region must not prevent saving a valid draft");
  assert.equal(h.api.blocked([unsupported]), true);
  assert.equal(h.api.blocked([target]), true, "an unsafe ancestor covers a nested draft");
  assert.equal(h.api.blocked([h.document.documentElement]), true, "an unsafe descendant affects its containing draft");
  assert.equal(h.api.blocked([]), false);
  const slot = h.node(unsupported, "slot"), slotted = h.node(); slotted.assignedSlot = slot;
  assert.equal(h.api.blocked([slotted]), true, "slot ancestry must reach the blocked owner");
  const shadowChild = h.node(); shadowChild._parent = null; shadowChild.getRootNode = () => ({ host: unsupported });
  assert.equal(h.api.blocked([shadowChild]), true, "open-shadow ancestry must reach the blocked owner");
  h.api.clear();
  assert.equal(h.api.blocked(), false); assert.equal(h.api.blocked([unsupported]), false);
});

test("clipping and axis-aligned scaling normalize mask coordinates without protecting invisible overflow", () => {
  const h = fixture(), owner = h.node(), clip = h.node(owner), target = h.node(clip);
  owner.box = box(0, 0, 200, 200);
  clip.box = box(20, 20, 80, 80); clip.offsetWidth = clip.offsetHeight = 40;
  clip.clientWidth = clip.clientHeight = 40; clip.css.overflowX = clip.css.overflowY = "hidden";
  target.box = box(60, 40, 100, 80);
  h.api.paint(new Map([[owner, 90]]), [target]);
  assert.deepEqual(Array.from(h.plan(new Map([[owner, 90]]), [target]).updates.get(owner).rects[0]), [0.3, 0.2, 0.2, 0.3]);
});

test("fractional mask edges follow the whole-pixel rounding of painted boxes", () => {
  const plannedRect = (h, owner, target) => Array.from(h.plan(new Map([[owner, 90]]), [target]).updates.get(owner).rects[0]);
  const near = (actual, expected, message) => actual.forEach((value, index) =>
    assert(Math.abs(value - expected[index]) < 1e-9, `${message}: ${actual} instead of ${expected}`));
  let h = fixture(), owner = h.node(), target = h.node(owner);
  // The owner's corner rounds to (0, 1); the target's edges to 21, 10, 61 and 41.
  owner.box = box(0.3, 0.7, 100, 100); target.box = box(20.5, 10.25, 40.25, 30.25);
  near(plannedRect(h, owner, target), [0.21, 0.09, 0.4, 0.31], "each edge rounds to the nearest pixel from the owner's rounded corner");

  h = fixture({ ratio: 1.25 }); owner = h.node(); target = h.node(owner);
  // HTML paint bounds use the same CSS grid at fractional display densities.
  target.box = box(20.3, 10, 40, 30);
  near(plannedRect(h, owner, target), [0.2, 0.1, 0.4, 0.3], "display density does not move the HTML mask into its target");

  for (const css of [{ transform: "matrix(1.25,0,0,1.25,0,0)" }, { translate: "0.3px" }, { scale: "0.8" }, { zoom: "1.25" }]) {
    h = fixture({ ratio: 2 }); owner = h.node(); target = h.node(owner);
    Object.assign(owner.css, css);
    owner.box = box(0.3, 0.7, 125, 125); target.box = box(20.5, 10.25, 40.25, 30.25);
    near(plannedRect(h, owner, target), [20.2 / 125, 9.55 / 125, 40.25 / 125, 30.25 / 125], "transformed branches retain geometric coordinates");
  }

  h = fixture(); const ancestor = h.node(); owner = h.node(ancestor); target = h.node(owner);
  ancestor.css.transform = "matrix(1,0,0,1,0.3,0.3)";
  owner.box = box(0.3, 0.7, 100, 100); target.box = box(20.5, 10.25, 40.25, 30.25);
  near(plannedRect(h, owner, target), [0.202, 0.0955, 0.4025, 0.3025], "a transform above the filter owner still changes its raster grid");

  h = fixture(); owner = h.node(); target = h.node(owner);
  target.box = box(20.2, 10.2, 0.2, 30);
  assert.equal(h.plan(new Map([[owner, 90]]), [target]).updates.has(owner), false, "a target narrower than a pixel that rounds to nothing leaves no mask");

  h = fixture(); owner = h.node(); target = h.node(owner);
  owner.namespaceURI = "http://www.w3.org/2000/svg";
  owner.box = box(0.5, 0.5, 100, 100); target.box = box(20.75, 10.75, 40, 30);
  near(plannedRect(h, owner, target), [0.2025, 0.1025, 0.4, 0.3], "an SVG owner is drawn as vector geometry and keeps exact coordinates");

  h = fixture(); owner = h.node(); target = h.node(owner);
  target.namespaceURI = "http://www.w3.org/2000/svg";
  owner.box = box(0.5, 0.5, 100, 100); target.box = box(20.75, 10.75, 40, 30);
  near(plannedRect(h, owner, target), [0.2025, 0.1025, 0.4, 0.3], "an SVG target does not inherit HTML paint snapping from its owner");
});

test("outer SVG viewport clipping works without HTML offset metrics and retains transform safeguards", () => {
  const h = fixture(), owner = h.node(), viewport = h.node(owner, "svg"), target = h.node(viewport, "svg");
  owner.box = box(0, 0, 200, 200);
  viewport.namespaceURI = "http://www.w3.org/2000/svg";
  viewport.ownerSVGElement = null;
  delete viewport.offsetWidth; delete viewport.offsetHeight;
  viewport.box = box(20, 20, 80, 80);
  viewport.css.overflowX = viewport.css.overflowY = "hidden";
  target.box = box(60, 40, 100, 80);
  const owners = new Map([[owner, 90]]);
  h.api.paint(owners, [target]);
  assert.equal(h.api.blocked(), false);
  assert.equal(owner.getAttribute("data-hdm-cutout"), "mask");
  assert.deepEqual(Array.from(h.plan(new Map([[owner, 90]]), [target]).updates.get(owner).rects[0]), [0.3, 0.2, 0.2, 0.3]);
  viewport.css.transform = "matrix(2,0,0,2,0,0)";
  h.api.paint(owners, [target]);
  assert.equal(h.api.blocked(), false, "positive axis-aligned scaling remains supported");
  viewport.css.transform = "matrix(1,0.5,0,1,0,0)";
  h.api.paint(owners, [target]);
  assert.equal(h.api.blocked(), true, "SVG clipping must not bypass skew rejection");
  viewport.css.transform = "none";
  viewport.ownerSVGElement = h.document.documentElement;
  h.api.paint(owners, [target]);
  assert.equal(h.api.blocked(), true, "nested SVG graphics bounds must not be mistaken for a viewport");
  viewport.ownerSVGElement = null;
  viewport.css.borderLeftWidth = "2px";
  h.api.paint(owners, [target]);
  assert.equal(h.api.blocked(), true, "unmapped SVG borders must not broaden the clipping rectangle");
  viewport.css.borderLeftWidth = "0px";
  viewport.localName = "g";
  h.api.paint(owners, [target]);
  assert.equal(h.api.blocked(), true, "the viewport fallback must not accept arbitrary SVG graphics");
});

test("sparse ownership is linear in ancestry visits and unrelated protection needs no geometry loop", () => {
  const h = fixture(), owners = new Map(), protections = [];
  for (let index = 0; index < 500; index++) {
    const owner = h.node(), target = h.node(owner); target.box = box(20, 20, 40, 40);
    owners.set(owner, 90); protections.push(target);
  }
  h.counts.ancestry = h.counts.geometry = 0;
  assert.equal(h.api.paint(owners, protections), true);
  assert.equal(h.filters().length, 500); assert.equal(h.api.blocked(), false);
  assert(h.counts.ancestry < 15000, `unrelated pairs caused ${h.counts.ancestry} ancestry reads`);
  assert(h.counts.geometry <= 1000, "each owner and protected element is measured at most once");
  const unrelated = h.node(); h.counts.geometry = 0;
  assert.equal(h.api.paint(owners, [unrelated]), false); assert.equal(h.counts.geometry, 0);
  assert.equal(h.filters().length, 0);
});

test("resource overflow disables owners instead of applying only some protection rectangles", () => {
  const h = fixture(), owner = h.node();
  const targets = Array.from({ length: 501 }, () => { const node = h.node(owner); node.box = box(10, 10, 20, 20); return node; });
  h.api.paint(new Map([[owner, 90]]), targets);
  assert.equal(owner.getAttribute("data-hdm-cutout"), "blocked"); assert.equal(h.filters().length, 0);
  h.api.paint(new Map([[owner, 90]]), Array(501).fill(targets[0]));
  assert.equal(owner.getAttribute("data-hdm-cutout"), "mask", "duplicate rules do not consume separate geometry resources");
  assert.equal(h.filters()[0].children.filter(node => node.localName === "feFlood").length, 1);
});

test("overlapping sibling filter owners suspend their own block only and recover when their rectangles separate", () => {
  const h = fixture(), root = h.node(), protectedNode = h.node(root), sibling = h.node(root, "img"), separate = h.node();
  const other = h.node(), otherProtected = h.node(other);
  protectedNode.box = box(20, 20, 40, 40); sibling.box = box(80, 20, 20, 20); otherProtected.box = box(10, 10, 20, 20);
  const owners = new Map([[root, 90], [sibling, 100], [separate, 90], [other, 90]]), protections = [protectedNode, otherProtected];
  assert.equal(h.api.paint(owners, protections), true);
  assert.equal(root.getAttribute("data-hdm-cutout"), "mask");
  assert.equal(sibling.getAttribute("data-hdm-cutout"), null);
  assert.equal(h.api.blocked(), false);
  sibling.box = box(40, 20, 20, 20);
  assert.equal(h.api.paint(owners, protections), true, "the guard must keep tracking so moving layers can recover");
  assert.equal(h.api.blocked(), true);
  for (const owner of [root, sibling]) {
    assert.equal(owner.getAttribute("data-hdm-cutout"), "blocked");
    assert.equal(owner.style.getPropertyValue("--hdm-cutout-filter"), "opacity(1)", "identity filtering preserves containing-block geometry");
  }
  assert.equal(separate.getAttribute("data-hdm-cutout"), null, "an unrelated block keeps its ordinary inversion");
  assert.equal(other.getAttribute("data-hdm-cutout"), "mask", "an unrelated block keeps its own protected area");
  assert.equal(h.api.blocked([separate]), false); assert.equal(h.api.blocked([other]), false);
  assert.equal(h.api.blocked([root]), true);
  assert.equal(h.filters().length, 1);
  sibling.box = box(80, 20, 20, 20);
  h.api.paint(owners, protections);
  assert.equal(h.api.blocked(), false);
  assert.equal(root.getAttribute("data-hdm-cutout"), "mask");
  assert.equal(sibling.getAttribute("data-hdm-cutout"), null);
  assert.equal(separate.getAttribute("data-hdm-cutout"), null);
});

test("overlap-check exhaustion preserves colors rather than accepting unchecked sibling layers", () => {
  const h = fixture(), root = h.node(), owners = new Map([[root, 90]]), protections = [];
  for (let index = 0; index < 100; index++) {
    const media = h.node(root, "img"); media.box = box(80, 80, 10, 10); owners.set(media, 100);
  }
  for (let index = 0; index < 51; index++) {
    const area = h.node(root); area.box = box(10, 10, 10, 10); protections.push(area);
  }
  assert.equal(h.api.paint(owners, protections), true);
  assert.equal(h.api.blocked(), true);
  assert.equal(h.filters().length, 0);
  assert([...owners.keys()].every(owner => owner.getAttribute("data-hdm-cutout") === "blocked"));
});

test("a protected area reaching outside its block, or under a rotated ancestor, suspends that block", () => {
  const h = fixture(), owner = h.node(), inside = h.node(owner), owners = new Map([[owner, 90]]);
  inside.box = box(20, 20, 40, 40);
  h.api.paint(owners, [inside]);
  assert.equal(owner.getAttribute("data-hdm-cutout"), "mask");
  inside.box = box(80, 20, 40, 40);
  h.api.paint(owners, [inside]);
  assert.equal(owner.getAttribute("data-hdm-cutout"), "blocked", "a truncated mask would invert the part outside the block");
  inside.box = box(20, 20, 40, 40); inside.css.rotate = "30deg";
  h.api.paint(owners, [inside]);
  assert.equal(owner.getAttribute("data-hdm-cutout"), "blocked", "a rotated area has no axis-aligned rectangle to protect");
  inside.css.rotate = "0deg";
  h.api.paint(owners, [inside]);
  assert.equal(owner.getAttribute("data-hdm-cutout"), "mask");
});

test("a top-layer element is neither masked by nor in conflict with the block it sits in", () => {
  const h = fixture(), root = h.node(), protectedNode = h.node(root), dialog = h.node(root, "dialog"), inner = h.node(dialog);
  protectedNode.box = box(20, 20, 40, 40); dialog.box = box(10, 10, 80, 80); inner.box = box(30, 30, 20, 20);
  const owners = new Map([[root, 90], [dialog, 90]]), boundaries = new Set([dialog]);
  h.api.paint(owners, [protectedNode], false, boundaries);
  assert.equal(root.getAttribute("data-hdm-cutout"), "mask", "an open dialog over a protected area must not suspend the block");
  assert.equal(dialog.getAttribute("data-hdm-cutout"), null);
  assert.equal(h.api.blocked([root]), false);
  h.api.paint(owners, [protectedNode]);
  assert.equal(root.getAttribute("data-hdm-cutout"), "blocked", "the same geometry inside the block's own layer is a real conflict");
  h.api.paint(owners, [inner], false, boundaries);
  assert.equal(dialog.getAttribute("data-hdm-cutout"), "mask", "an area protected inside the dialog is cut out of the dialog");
  assert.equal(root.getAttribute("data-hdm-cutout"), null, "and not out of the block behind it");
});
