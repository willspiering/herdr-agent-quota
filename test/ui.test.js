import test from "node:test";
import assert from "node:assert/strict";
import { createHost, walk, flatten } from "./host.js";
import { parseReport, PREFIX } from "../mods/agent-quota/core.js";

const now = Date.now();
const data = parseReport(JSON.stringify({ schemaVersion: 5, generatedAt: new Date(now).toISOString(), providers: [
  { provider: "codex", state: { status: "fresh" }, windows: [{ id: "session", label: "Session", kind: "session", percentRemaining: 22, resetsAt: new Date(now + 3600000).toISOString() }] },
] }));
function find(tree, id) { let match; walk(tree, n => { if (n.styles.id?.[0] === id) match = n; }); return match; }

test("dashboard renders measured gauges and redline summary", async () => {
  const host = await createHost({ data });
  const text = flatten(host.tree());
  assert.match(text, /78%/); assert.match(text, /1 limit is redlining/); assert.match(text, /Token counts are unavailable/);
});
test("configuration controls persist and immediately affect the strip", async () => {
  const host = await createHost({ data });
  find(host.tree(), "configure").events.click({}, host.cx);
  assert.equal(host.view.page, "configure");
  find(host.tree(), "kind-session").events.click({}, host.cx);
  assert.equal(host.state[`${PREFIX}.options`].kinds.session, false);
  host.view.mode = "strip";
  assert.doesNotMatch(flatten(host.tree()), /78%/);
});
test("strip click opens the native dashboard window with saved options", async () => {
  const host = await createHost({ mode: "strip", data });
  host.tree().events.click();
  assert.equal(host.overlays[0].kind, "window");
  assert.equal(host.overlays[0].props.mode, "dashboard");
  assert.equal(host.overlays[0].key, "agent-quota-dashboard");
});
test("agent navigation targets the correct terminal", async () => {
  const host = await createHost({ data, live: [{ address: "t9", space: "s", space_name: "Personal", tab_name: "Build", program: { key: "codex" }, status: "working" }] });
  const id = `focus-${data.providers[0].key}-t9`;
  find(host.tree(), id).events.click({}, host.cx);
  assert.deepEqual(host.commands[0], ["agent.focus", { terminal: "t9" }]);
});
test("missing data renders an actionable empty state without a percentage", async () => {
  const host = await createHost();
  host.state[`${PREFIX}.error`] = "Quota collector not found. Run npm run setup.";
  const text = flatten(host.tree());
  assert.match(text, /Quota needs attention/); assert.match(text, /npm run setup/); assert.match(text, /No providers to show/);
});
test("pane header suppresses local readings for a remote terminal", async () => {
  const host = await createHost({ mode: "header", data, runtime: { pane: "p1" }, paneList: [{ pane: "p1", terminal: "remote/t1", program: { key: "codex", name: "Codex", agent: true } }] });
  const text = flatten(host.tree());
  assert.match(text, /Remote quota/); assert.doesNotMatch(text, /78%/);
});
test("two surfaces compete for one collection lease", async () => {
  const a = await createHost({ data }), b = await createHost({ data });
  const old = a.state[`${PREFIX}.control`];
  a.view.tick(a.cx);
  b.state[`${PREFIX}.control`] = a.state[`${PREFIX}.control`];
  b.view.tick(b.cx);
  assert.equal(a.tasks.length, 2); // initialization and one collection task
  assert.equal(b.tasks.length, 1); // initialization only
  assert.notDeepEqual(a.state[`${PREFIX}.control`], old);
});
test("keyboard activation opens the dashboard", async () => {
  const host = await createHost({ mode: "strip", data });
  host.tree().events.keydown({ key: "enter" });
  assert.equal(host.overlays.length, 1);
});
test("rendering and repainting all surfaces never allocate focus handles", async () => {
  for (const mode of ["strip", "dashboard", "header"]) {
    const host = await createHost({ mode, data, runtime: { pane: "p1" }, paneList: [{ pane: "p1", terminal: "t1", program: { key: "codex", name: "Codex", agent: true } }] });
    const allocations = host.focus.allocations;
    assert.equal(allocations, 1);
    host.tree(); host.tree();
    if (mode === "dashboard") {
      find(host.tree(), "configure").events.click({}, host.cx);
      host.tree(); host.tree();
      // A newly discovered provider creates more buttons without allocating view handles.
      host.state[`${PREFIX}.discovered`] = [{ key: "claude", name: "Claude", installed: true }];
      host.tree();
    }
    assert.equal(host.focus.allocations, allocations, mode);
  }
});
