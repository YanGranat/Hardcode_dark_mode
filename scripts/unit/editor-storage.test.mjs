import assert from "node:assert/strict";
import { clone, load } from "../support/modules.mjs";
import vm from "node:vm";
import test from "node:test";
import { worker as createWorker } from "../support/worker.mjs";

const origin = "https://editor.test";
const root = (id, protections = []) => ({ path: [`#${id}`], label: id, protections });
const child = (id = "slide") => ({ path: [`#${id}`], label: id });
const save = (rule, previousRule) => ({ type: "hdm-inversion-save", origin, rule,
  ...(previousRule === undefined ? {} : { previousRule }) });

async function fixture() {
  const h = createWorker();
  await h.send({ type: "hdm-universal-add-site", url: origin });
  await h.send({ type: "hdm-universal-set-mode", origin, mode: "selected" });
  const write = h.api.storage.local.set;
  h.writes = [];
  h.api.storage.local.set = async value => { h.writes.push(clone(value)); return write(value); };
  return h;
}

test("inclusion normalization preserves legacy shapes and copies bounded one-level protections", () => {
  const context = vm.createContext({ URL });
  load(context, "shared/rules.js", "shared/site-utils.js");
  const normalize = value => clone(context.HdmRules.normalizeInclusions(value));
  const legacy = { path: ["#workspace"], fallbackPath: [".workspace"], label: "Workspace", matchAll: true };
  assert.deepEqual(normalize([legacy]), [legacy]);
  const input = { ...clone(legacy), protections: [{ path: ["#slide"], fallbackPath: ["svg.slide"], label: "Slide", matchAll: true,
    protections: [child("must-not-recurse")] }] };
  const normalized = context.HdmRules.normalizeInclusions([input]);
  assert.deepEqual(clone(normalized), [{ ...legacy, protections: [{ path: ["#slide"], fallbackPath: ["svg.slide"], label: "Slide", matchAll: true }] }]);
  normalized[0].path[0] = "#changed";
  normalized[0].protections[0].path[0] = "#changed-child";
  normalized[0].protections[0].fallbackPath[0] = "changed";
  assert.equal(input.path[0], "#workspace"); assert.equal(input.protections[0].path[0], "#slide");
  assert.equal(input.protections[0].fallbackPath[0], "svg.slide");
  const repeated = [root("same", [child("first")]), root("same", [child("discarded")])];
  assert.deepEqual(normalize(repeated), [repeated[0]], "duplicate identity keeps the first complete bundle");
  assert.equal(normalize([root("many", Array.from({ length: 101 }, (_, i) => child(`child-${i}`)))])[0].protections.length, 100);
  assert.equal(normalize(Array.from({ length: 101 }, (_, i) => root(`root-${i}`))).length, 100);
  for (const value of [undefined, null, {}, "invalid", []]) assert.deepEqual(normalize(value), []);
  assert.deepEqual(normalize([{ path: ["#safe"], protections: "invalid" }]), [{ path: ["#safe"], label: "Element" }]);
});

test("editor save commits the root and all exceptions in one write without page work", async () => {
  const h = await fixture();
  const bundle = root("workspace", [child(), { path: ["svg.diagram"], matchAll: true, label: "Diagrams" }]);
  const before = clone(h.state.sites);
  await h.send({ type: "hdm-universal-get-sites" });
  assert.equal(h.writes.length, 0, "reading or discarding a local draft does not commit anything");
  h.api.tabs.query = () => assert.fail("saving must not scan tabs");
  h.api.scripting.executeScript = () => assert.fail("saving must not wait for a page");
  const write = h.api.storage.local.set;
  let release;
  h.api.storage.local.set = value => new Promise(resolve => {
    release = async () => { await write(value); resolve(); };
    assert.deepEqual(clone(value.universalSites[0].inclusions), [bundle], "the first and only write already contains the complete bundle");
  });
  const pending = h.send(save(bundle));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.state.sites, before, "no partial root exists before the transaction commits");
  await release();
  assert.equal((await pending).ok, true);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.state.sites[0].inclusions, [bundle]);
  assert.deepEqual(h.state.sites[0].protections, [], "local exceptions do not become global protections");
});

test("nested metadata survives atomic saves, mode switches and site toggles alongside legacy global settings", async () => {
  const h = await fixture(), bundle = root("workspace", [child()]);
  h.state.sites[0].protections = [child("legacy-global")];
  await h.send(save(bundle));
  await h.send(save({ path: ["#toolbar"], label: "Toolbar" }));
  const before = clone(h.state.sites[0]);
  await h.send({ type: "hdm-universal-set-mode", origin, mode: "page" });
  await h.send({ type: "hdm-universal-set-enabled", origin, enabled: false });
  await h.send({ type: "hdm-universal-set-enabled", origin, enabled: true });
  assert.deepEqual(h.state.sites[0].inclusions, before.inclusions);
  assert.deepEqual(h.state.sites[0].protections, before.protections);
  assert.equal(h.state.sites[0].addedAt, before.addedAt);
});

test("snapshot edits preserve unrelated rules and reject concurrent stale edits", async () => {
  const h = await fixture(), first = root("first", [child("one")]), second = root("second", [child("two")]);
  await h.send(save(first)); await h.send(save(second));
  h.writes.length = 0;
  const update = { ...first, protections: [child("winner")] };
  const results = await Promise.all([h.send(save(update, first)), h.send(save({ ...first, protections: [child("stale")] }, first))]);
  assert.deepEqual(results.map(result => result.ok), [true, false]);
  assert.equal(results[1].error, "rule_conflict");
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.state.sites[0].inclusions, [update, second]);
  h.writes.length = 0;
  assert.equal((await h.send(save(update, update))).ok, true);
  assert.equal(h.writes.length, 0, "an unchanged edit need not emit another storage event");
  const independent = { ...second, protections: [] };
  const both = await Promise.all([h.send(save({ ...update, label: "Updated" }, update)), h.send(save(independent, second))]);
  assert(both.every(result => result.ok));
  assert.deepEqual(h.state.sites[0].inclusions, [{ ...update, label: "Updated" }, independent]);
});

test("identity changes cannot overwrite another root and missing snapshots cannot recreate deleted rules", async () => {
  const h = await fixture(), first = root("first"), second = root("second");
  await h.send(save(first)); await h.send(save(second)); h.writes.length = 0;
  assert.equal((await h.send(save({ ...first, protections: [child()] }))).error, "rule_conflict");
  assert.equal((await h.send(save({ ...second, protections: [child()] }, first))).error, "rule_conflict");
  assert.equal(h.writes.length, 0);
  const group = { ...first, matchAll: true, protections: [child()] };
  assert.equal((await h.send(save(group, first))).ok, true);
  assert.deepEqual(h.state.sites[0].inclusions, [group, second]);
  await h.send({ type: "hdm-inversion-remove", origin, path: group.path, matchAll: true });
  h.writes.length = 0;
  assert.equal((await h.send(save({ ...group, label: "Stale" }, group))).error, "rule_conflict");
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.state.sites[0].inclusions, [second]);
});

test("failed storage writes leave both new bundles and edited bundles wholly unchanged", async () => {
  const h = await fixture(), bundle = root("workspace", [child()]);
  const before = clone(h.state.sites);
  h.state.fail = "storage";
  assert.equal((await h.send(save(bundle))).ok, false);
  assert.deepEqual(h.state.sites, before);
  assert.equal((await h.send(save(bundle))).ok, true);
  const saved = clone(h.state.sites);
  h.state.fail = "storage";
  assert.equal((await h.send(save({ ...bundle, protections: [] }, bundle))).ok, false);
  assert.deepEqual(h.state.sites, saved);
});

test("editor saves require own-origin authorization and the current enabled selected mode", async () => {
  const h = await fixture(), message = save(root("workspace", [child()]));
  const sender = { id: "test", tab: { id: 1 }, url: origin + "/editor" };
  const fromPicker = value => new Promise(resolve => h.listener(value, sender, resolve));
  let unauthorizedReplies = 0;
  const deniedReply = () => unauthorizedReplies++;
  assert.equal(h.listener(message, { ...sender, id: "other" }, deniedReply), false);
  assert.equal(h.listener(message, { ...sender, url: "https://other.test/" }, deniedReply), false);
  assert.equal(h.listener({ type: "hdm-inversion-remove", origin, path: ["#workspace"] }, sender, deniedReply), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unauthorizedReplies, 0); assert.equal(h.writes.length, 0);
  assert.equal((await fromPicker(message)).ok, true);
  const next = save(root("next"));
  await h.send({ type: "hdm-universal-set-mode", origin, mode: "page" });
  assert.equal((await fromPicker(next)).error, "settings_changed");
  await h.send({ type: "hdm-universal-set-mode", origin, mode: "selected" });
  await h.send({ type: "hdm-universal-set-enabled", origin, enabled: false });
  assert.equal((await fromPicker(next)).error, "site_paused");
  assert.equal((await h.send({ ...next, origin: "https://missing.test" })).error, "site_not_found");
});

test("malformed, recursive and oversized local exceptions are rejected without truncating a save", async () => {
  const h = await fixture();
  const invalid = [null, "svg", {}, [], { path: [] }, { path: [""] }, { path: [1] }, { path: Array(9).fill("svg") },
    { path: ["x".repeat(2049)] }, { path: ["svg"], fallbackPath: [] }, { path: ["svg"], matchAll: "true" },
    { ...child(), protections: [] }];
  for (const item of invalid) {
    const result = await h.send(save(root("invalid", [item])));
    assert.equal(result.error, "invalid_rule", JSON.stringify(item));
  }
  for (const protections of [null, "svg", {}, Array(1)]) {
    assert.equal((await h.send(save({ path: ["#invalid"], protections }))).error, "invalid_rule");
  }
  const tooMany = root("too-many", Array.from({ length: 101 }, (_, i) => child(`child-${i}`)));
  assert.equal((await h.send(save(tooMany))).error, "too_many_rules");
  assert.equal(h.writes.length, 0);
  const full = root("valid", Array.from({ length: 100 }, (_, i) => child(`child-${i}`)));
  assert.equal((await h.send(save(full))).ok, true);
  assert.equal(h.state.sites[0].inclusions[0].protections.length, 100);
  assert.equal((await h.send(save({ ...full, protections: [] }, { ...full, protections: [null] }))).error, "invalid_rule");
  assert.equal(h.state.sites[0].inclusions[0].protections.length, 100);
});

test("retired standalone inversion and protection writers are rejected for popup and content senders", async () => {
  const h = await fixture(), before = clone(h.state.sites);
  const sender = { id: "test", tab: { id: 1 }, url: origin + "/editor" };
  for (const type of ["hdm-inversion-add", "hdm-protection-add"]) {
    const message = { type, origin, rule: root("retired", [child()]) };
    assert.equal((await h.send(message)).error, "invalid_message");
    assert.equal(h.listener(message, sender, () => {}), false);
  }
  assert.equal(h.writes.length, 0); assert.deepEqual(h.state.sites, before);
});

test("full libraries of inversion roots still allow editing one bundle without adding another", async () => {
  const h = await fixture();
  h.state.sites[0].inclusions = Array.from({ length: 100 }, (_, index) => root(`root-${index}`));
  const original = clone(h.state.sites[0].inclusions[30]);
  assert.equal((await h.send(save(root("extra")))).error, "too_many_rules");
  const edited = { ...original, protections: [child()] };
  assert.equal((await h.send(save(edited, original))).ok, true);
  assert.equal(h.state.sites[0].inclusions.length, 100);
  assert.deepEqual(h.state.sites[0].inclusions[30], edited);
});

test("explicit legacy cleanup commits atomically with the bundle and preserves every unchosen rule", async () => {
  const h = await fixture(), bundle = root("workspace", [child()]);
  const exact = child("legacy"), group = { ...exact, matchAll: true, label: "Legacy group" }, other = child("other");
  h.state.sites[0].protections = [exact, group, other];
  const before = clone(h.state.sites);
  const message = { ...save(bundle), removeLegacyProtections: [exact] };
  h.state.fail = "storage";
  assert.equal((await h.send(message)).ok, false);
  assert.deepEqual(h.state.sites, before, "a failed cleanup cannot leave half a bundle or remove a global rule");
  h.writes.length = 0;
  assert.equal((await h.send(message)).ok, true);
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.writes[0].universalSites[0].inclusions, [bundle]);
  assert.deepEqual(h.writes[0].universalSites[0].protections, [group, other]);
  assert.deepEqual(h.state.sites[0].protections, [group, other]);
  h.writes.length = 0;
  assert.equal((await h.send({ ...save(bundle, bundle), removeLegacyProtections: [group] })).ok, true);
  assert.equal(h.writes.length, 1, "an unchanged parent still commits requested cleanup");
  assert.deepEqual(h.state.sites[0].protections, [other]);
  h.writes.length = 0;
  assert.equal((await h.send({ ...save(bundle, bundle), removeLegacyProtections: [] })).ok, true);
  assert.equal(h.writes.length, 0, "an empty cleanup remains an idempotent edit");
});

test("legacy cleanup snapshots reject concurrent changes, missing rules and conflicting duplicates", async () => {
  const h = await fixture(), bundle = root("workspace"), old = child("legacy"), current = { ...old, label: "Changed elsewhere" };
  await h.send(save(bundle));
  h.state.sites[0].protections = [current, child("keep")];
  h.writes.length = 0;
  const before = clone(h.state.sites);
  for (const removeLegacyProtections of [[old], [child("missing")], [{ ...current, matchAll: true }], [current, old]]) {
    assert.equal((await h.send({ ...save(bundle, bundle), removeLegacyProtections })).error, "rule_conflict");
    assert.deepEqual(h.state.sites, before);
  }
  assert.equal(h.writes.length, 0);
  const message = { ...save(bundle, bundle), removeLegacyProtections: [current] };
  const results = await Promise.all([h.send(message), h.send(message)]);
  assert.deepEqual(results.map(result => result.ok), [true, false]);
  assert.equal(results[1].error, "rule_conflict", "the losing cleanup cannot recreate or remove another global rule");
  assert.equal(h.writes.length, 1);
  assert.deepEqual(h.state.sites[0].protections, [child("keep")]);
  assert.deepEqual(h.state.sites[0].inclusions, [bundle]);
});

test("legacy cleanup accepts only bounded flat snapshots without silently normalizing away invalid entries", async () => {
  const h = await fixture(), bundle = root("workspace");
  for (const removeLegacyProtections of [null, {}, "invalid", Array(1), [null], [{ path: [] }],
    [{ path: ["#legacy"], fallbackPath: [] }], [{ ...child(), protections: [] }]]) {
    assert.equal((await h.send({ ...save(bundle), removeLegacyProtections })).error, "invalid_rule");
  }
  const tooMany = Array.from({ length: 101 }, (_, index) => child(`legacy-${index}`));
  assert.equal((await h.send({ ...save(bundle), removeLegacyProtections: tooMany })).error, "too_many_rules");
  assert.equal(h.writes.length, 0);
  h.state.sites[0].protections = tooMany.slice(0, 100);
  assert.equal((await h.send({ ...save(bundle), removeLegacyProtections: tooMany.slice(0, 100) })).ok, true);
  assert.deepEqual(h.state.sites[0].protections, []);
  assert.equal(h.writes.length, 1);
});
