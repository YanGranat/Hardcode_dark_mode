import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { clone, load } from "../support/modules.mjs";
import { worker } from "../support/worker.mjs";
import { popupFixture } from "../support/popup.mjs";

const origin = "https://parent.test";
const exact = { path: ["#panel"], fallbackPath: ["section.panel"], label: "section" };
const group = { path: [".panel"], matchAll: true, label: "section", name: "Repeated panels" };
const local = { path: ["#chart"], label: "svg", name: "Chart", enabled: false };
const root = { ...exact, name: "Workspace", protections: [local] };
const site = () => ({ origin, enabled: true, addedAt: 17, mode: "selected", exclusions: [exact, group],
  inclusions: [root, group], protections: [{ path: ["#legacy"], label: "aside", name: "Legacy area" }] });
const patch = (kind, rule, changes, parent) => ({ type: "hdm-rule-update", origin, kind,
  path: rule.path, matchAll: rule.matchAll === true, changes, ...(parent ? { parent: { path: parent.path, matchAll: parent.matchAll === true } } : {}) });
const fixture = () => {
  const result = worker(); result.state.sites = [clone(site()), { ...site(), origin: "https://other.test" }];
  return result;
};
const rules = () => {
  const context = vm.createContext({}); load(context, "shared/rules.js"); return context.HdmRules;
};

test("rule metadata normalizes without changing structural identity or child metadata", () => {
  const api = rules(), source = { ...root, name: "  Workspace  ", enabled: false };
  const original = clone(source), normalized = api.normalizeInclusions([source])[0];
  assert.equal(normalized.name, "Workspace");
  assert.equal(normalized.enabled, false);
  assert.deepEqual(clone(normalized.protections), [local]);
  assert.equal(api.identity(normalized), api.identity(exact));
  assert.equal(api.displayLabel(normalized), "Workspace");
  assert.deepEqual(source, original, "normalization does not edit its input");
  const defaults = api.normalizeExclusions([{ ...exact, name: "  ", enabled: true }])[0];
  assert.equal(Object.hasOwn(defaults, "name"), false);
  assert.equal(Object.hasOwn(defaults, "enabled"), false, "absence retains the legacy enabled default");
});

test("metadata patches preserve rule geometry and remove explicit default fields", () => {
  const api = rules(), source = clone(root);
  assert.deepEqual(clone(api.updateMetadata(source, { enabled: false })), { ...root, enabled: false },
    "pausing a named rule retains its name, geometry and nested protections");
  const renamed = api.updateMetadata(source, { name: "  Reading area  ", enabled: false });
  assert.deepEqual(clone(renamed), { ...root, name: "Reading area", enabled: false });
  const defaults = api.updateMetadata(renamed, { name: " ", enabled: true });
  assert.deepEqual(clone(defaults), { ...exact, protections: [local] });
  assert.deepEqual(source, root);
  for (const changes of [null, [], {}, { label: "Another" }, { path: ["#elsewhere"] },
    { name: 12 }, { name: null }, { name: "x".repeat(81) }, { enabled: 0 }, { enabled: "false" }, { name: "Area", enabled: null }]) {
    assert.throws(() => api.updateMetadata(source, changes), undefined, "malformed patches cannot change rule structure or metadata");
    assert.deepEqual(source, root);
  }
});

test("each metadata list uses exact rule identity and local protection ownership", async () => {
  for (const [kind, rule, parent, list] of [
    ["exclusion", exact, null, "exclusions"], ["inversion", exact, null, "inclusions"],
    ["protection", { path: ["#legacy"] }, null, "protections"], ["protection", local, root, "local"]
  ]) {
    const h = fixture(), before = clone(h.state.sites);
    const result = await h.send(patch(kind, rule, { name: "  Named region  ", enabled: false }, parent));
    assert.equal(result.ok, true, result.error);
    const expected = clone(before);
    if (list === "local") expected[0].inclusions[0].protections[0] = { ...local, name: "Named region", enabled: false };
    else expected[0][list][0] = { ...expected[0][list][0], name: "Named region", enabled: false };
    assert.deepEqual(h.state.sites, expected, `${kind} updates only the addressed rule`);
    assert.equal(h.state.executed.length, 0, "metadata persistence does not execute page scripts");
    assert.equal(h.state.inserted.length, 0);
    assert.equal(h.state.removed.length, 0);
    assert.equal(h.state.scripts.length, 0, "metadata updates do not re-register content scripts");
  }
});

test("independent queued metadata changes compose on the current saved rule", async () => {
  const h = fixture();
  const results = await Promise.all([
    h.send(patch("inversion", exact, { name: "First" })),
    h.send(patch("inversion", exact, { enabled: false })),
    h.send(patch("inversion", exact, { name: "Final" }))
  ]);
  assert(results.every(result => result.ok));
  assert.deepEqual(h.state.sites[0].inclusions[0], { ...root, name: "Final", enabled: false });
  assert.deepEqual(h.state.sites[0].inclusions[1], group, "an exact update never targets the similar-element group");
  const restored = await h.send(patch("inversion", exact, { name: "", enabled: true }));
  assert.equal(restored.ok, true, restored.error);
  assert.deepEqual(h.state.sites[0].inclusions[0], { ...exact, protections: [local] });
});

test("metadata edits remain available for a paused site with withheld browser access", async () => {
  const h = fixture(); h.state.sites[0].enabled = false;
  h.api.permissions.contains = async () => false;
  const result = await h.send(patch("inversion", exact, { enabled: false, name: "Paused area" }));
  assert.equal(result.ok, true, result.error);
  assert.equal(h.state.sites[0].enabled, false);
  assert.deepEqual(h.state.sites[0].inclusions[0], { ...root, name: "Paused area", enabled: false });
  assert.equal(h.state.executed.length, 0);
});

test("malformed, missing and incorrectly scoped metadata targets leave the library unchanged", async () => {
  const invalid = [
    { kind: "unknown" }, { path: [] }, { path: ["#absent"] }, { matchAll: "true" },
    { kind: "exclusion", parent: { path: exact.path } },
    { kind: "inversion", parent: { path: exact.path } },
    { kind: "protection", path: local.path, parent: { path: ["#absent"] } },
    { kind: "protection", path: ["#legacy"], parent: { path: root.path } },
    { changes: {} }, { changes: { enabled: "false" } }, { changes: { name: "x".repeat(81) } },
    { changes: { path: ["#elsewhere"] } }, { origin: "https://missing.test" }
  ];
  for (const change of invalid) {
    const h = fixture(), before = clone(h.state.sites);
    const response = await h.send({ ...patch("inversion", exact, { name: "Changed" }), ...change });
    assert.equal(response.ok, false, "invalid target must not silently update a different rule");
    assert.deepEqual(h.state.sites, before);
  }
});

test("page senders cannot use the popup metadata patch endpoint", () => {
  const h = fixture(); let answered = false;
  const result = h.listener(patch("inversion", exact, { name: "Changed" }), {
    id: "test", url: origin + "/page", tab: { id: 1 }
  }, () => { answered = true; });
  assert.equal(result, false);
  assert.equal(answered, false);
});

test("editor snapshots reject concurrent metadata edits instead of overwriting them", async () => {
  for (const change of [patch("inversion", exact, { name: "Renamed" }),
    patch("inversion", exact, { enabled: false }), patch("protection", local, { enabled: true }, root)]) {
    const h = fixture(), previousRule = clone(h.state.sites[0].inclusions[0]);
    assert.equal((await h.send(change)).ok, true);
    const updated = clone(h.state.sites);
    const saved = await h.send({ type: "hdm-inversion-save", origin, previousRule,
      rule: { ...previousRule, protections: [] } });
    assert.equal(saved.ok, false);
    assert.equal(saved.error, "rule_conflict");
    assert.deepEqual(h.state.sites, updated);
  }
});

test("a failed metadata save retains the full record and permits a later retry", async () => {
  const h = fixture(), before = clone(h.state.sites);
  h.state.fail = "storage";
  const failed = await h.send(patch("protection", local, { name: "Updated chart", enabled: true }, root));
  assert.equal(failed.ok, false);
  assert.deepEqual(h.state.sites, before);
  const retried = await h.send(patch("protection", local, { name: "Updated chart", enabled: true }, root));
  assert.equal(retried.ok, true, retried.error);
  assert.deepEqual(h.state.sites[0].inclusions[0].protections[0], { path: local.path, label: "svg", name: "Updated chart" });
});

test("backup import and removal restoration retain names, paused flags and child metadata", async () => {
  const h = worker();
  const source = { ...site(), inclusions: [{ ...root, enabled: false }] };
  const imported = await h.send({ type: "hdm-library-import", sites: [source] });
  assert.equal(imported.ok, true, imported.error);
  assert.deepEqual(h.state.sites[0].inclusions, source.inclusions);
  const snapshot = clone(h.state.sites[0]);
  assert.equal((await h.send({ type: "hdm-universal-remove-site", origin })).ok, true);
  assert.equal((await h.send({ type: "hdm-universal-restore-site", site: snapshot })).ok, true);
  assert.deepEqual(h.state.sites[0], snapshot);
});

test("optimistic metadata changes compose with other pending changes and preserve child ownership", async () => {
  const h = popupFixture({ sites: [site()] }); await h.init();
  const first = h.model.updateRule("inversion", root, { name: "Reading area" });
  const second = h.model.updateRule("protection", local, { enabled: true }, root);
  const third = h.model.updateRule("inversion", root, { enabled: false });
  const visible = clone(h.model.site(origin));
  assert.deepEqual(visible.inclusions[0], { ...root, name: "Reading area", enabled: false,
    protections: [{ path: local.path, label: "svg", name: "Chart" }] });
  assert.deepEqual(visible.inclusions[1], group);
  h.requests[0].reject(Error("failed")); h.requests[1].resolve();
  await Promise.all([first, second]);
  assert.deepEqual(clone(h.model.site(origin)), visible, "older replies cannot erase the latest optimistic record");
  h.save([visible]); h.requests[2].resolve(); await third;
  assert.deepEqual(clone(h.model.site(origin)), visible);
  assert.equal(h.notices.length, 0, "successful metadata edits need no success notice");
});
