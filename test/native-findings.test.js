import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHost, walk, flatten } from "./host.js";
import { parseReport, PREFIX } from "../mods/agent-quota/core.js";

// Run these same regressions against the pre-fix source without changing the worktree.
const source = process.env.QUOTA_NATIVE_TEST_SOURCE
  ? await readFile(process.env.QUOTA_NATIVE_TEST_SOURCE, "utf8") : undefined;
const host = args => createHost({ ...args, source });
const now = 1793990000000;
const data = parseReport(JSON.stringify({ schemaVersion: 5, generatedAt: new Date(now).toISOString(), providers: [
  { provider: "codex", state: { status: "fresh" }, windows: [
    { id: "session", label: "Session", kind: "session", percentUsed: 40, resetsAt: new Date(now + 3600000).toISOString() },
  ] },
] }));
function find(tree, id) {
  let found;
  walk(tree, node => { if (node.styles.id?.[0] === id) found = node; });
  return found;
}

test("native Settings: a starting docked panel honors only a recent opener target", async () => {
  for (const age of [0, 1999, 2000, 2001, 60000, -1]) {
    for (const [page, provider] of [["configure", null], ["overview", "codex"]]) {
      const panel = await host({ mode: "panel", clock: { now }, sharedState: {
        [`${PREFIX}.data`]: data, [`${PREFIX}.view`]: { at: now - age, page, provider },
      } });
      panel.tree();
      const recent = age >= 0 && age <= 2000;
      assert.equal(panel.view.page, recent ? page : "overview", `page at age ${age}`);
      assert.equal(panel.view.selected, recent ? provider : null, `provider at age ${age}`);
      // A later targeted open still follows normally after ignoring an old request.
      panel.state[`${PREFIX}.view`] = { at: now + 2, page: "configure", provider: "codex" };
      panel.tree();
      assert.equal(panel.view.page, "configure");
      assert.equal(panel.view.selected, "codex");
    }
  }
  const window = await host({ runtime: { page: "overview" }, clock: { now }, sharedState: {
    [`${PREFIX}.view`]: { at: now, page: "configure", provider: "codex" },
  } });
  assert.equal(window.view.page, "overview", "a separate window keeps its explicit target");
});

test("native narrow header: its label truncates independently inside the shrinking button", async () => {
  const panel = await host({ mode: "header", data, clock: { now }, runtime: { pane: "p1" }, paneList: [
    { pane: "p1", terminal: "t1", status: "blocked", program: { key: "codex", name: "Codex", agent: true } },
  ] });
  panel.view.hovered = true;
  const tree = panel.tree(), figure = find(tree, "quota-for-p1");
  assert.deepEqual(figure.styles.flex_shrink, [1]);
  assert.deepEqual(figure.styles.min_w, [0]);
  assert.deepEqual(figure.styles.max_w, [200]);
  const label = figure.nodes[0];
  assert.equal(label?.type, "div", "truncate the text element, not just the Button interior");
  assert.deepEqual(label.styles.min_w, [0]);
  assert.ok(label.styles.flex_1 && label.styles.truncate);
  assert.match(flatten(label), /^Session 40%/);
  for (const key of ["r", "d", "z", "x"]) assert.ok(find(tree, `ph-${key}-p1`));
});

test("native hidden provider: its summary names hidden state and saved limit selections", async () => {
  const panel = await host({ data, clock: { now }, runtime: { page: "configure" }, sharedState: {
    [`${PREFIX}.data`]: data, [`${PREFIX}.options`]: { hidden: ["codex"] },
  } });
  const tree = panel.tree();
  assert.match(flatten(tree), /Hidden · 1 of 1 limits selected/);
  assert.doesNotMatch(flatten(tree), /1 of 1 limits shown|Show in|Limits\s+Session/);
  panel.state[`${PREFIX}.options`] = { hidden: [] };
  assert.match(flatten(panel.tree()), /1 of 1 limits shown/);
});
