import test from "node:test";
import assert from "node:assert/strict";
import { createHost, walk, flatten } from "./host.js";
import { parseReport, PREFIX } from "../mods/agent-quota/core.js";

const now = Date.now();
const data = parseReport(JSON.stringify({ schemaVersion: 5, generatedAt: new Date(now).toISOString(), providers: [
  { provider: "codex", state: { status: "fresh" }, windows: [{ id: "session", label: "Session", kind: "session", percentRemaining: 22, resetsAt: new Date(now + 3600000).toISOString() }] },
] }));
const copilot = parseReport(JSON.stringify({ schemaVersion: 5, generatedAt: new Date(now).toISOString(), providers: [
  { provider: "copilot", state: { status: "fresh" }, windows: ["chat", "completions", "premium interactions"].map((label, i) => ({ id: label, label, kind: "monthly", percentRemaining: 90 - i * 10 })) },
] }));
function find(tree, id) { let match; walk(tree, n => { if (n.styles.id?.[0] === id) match = n; }); return match; }
function paths(tree) { const list = []; walk(tree, n => { if (n.type === "path") list.push(n.value); }); return list; }
const click = (host, id) => find(host.tree(), id).events.click({}, host.cx);

test("dashboard renders measured meters and the redline callout", async () => {
  const host = await createHost({ data });
  const text = flatten(host.tree());
  assert.match(text, /78%/); assert.match(text, /Over redline · Codex 5h 78%|Over redline · Codex Session 78%/);
  assert.match(text, /per account and shared across spaces/);
});
test("meters are painted as one path per color, not an element per cell", async () => {
  const host = await createHost({ data });
  const drawn = paths(host.tree());
  assert.ok(drawn.length >= 2 && drawn.length <= 4, `${drawn.length} paths`);
  assert.ok(drawn.reduce((n, p) => n + p.polygons.length, 0) > 20);
  // 78% used with a 70% redline: the lit cells carry the terminal's red.
  assert.ok(drawn.some(p => p.fill === "#e06c75" && p.polygons.length > 0));
});
test("gauge layout draws a segmented arc", async () => {
  const host = await createHost({ data });
  host.state[`${PREFIX}.options`] = { dash: "gauges" };
  const drawn = paths(host.tree());
  assert.equal(drawn.reduce((n, p) => n + p.polygons.length, 0), 30); // no elapsed time reported, so no pace tick
});
test("settings controls persist and immediately affect the strip", async () => {
  const host = await createHost({ data });
  click(host, "page-configure");
  assert.equal(host.view.page, "configure");
  click(host, `window-${data.providers[0].windows[0].key}`);
  assert.equal(host.state[`${PREFIX}.options`].windows[data.providers[0].windows[0].key], false);
  host.view.mode = "strip";
  assert.doesNotMatch(flatten(host.tree()), /78%/);
});
test("a limit hidden by its kind can be shown individually", async () => {
  const host = await createHost({ data });
  host.state[`${PREFIX}.options`] = { kinds: { session: false } };
  host.view.page = "configure";
  click(host, `window-${data.providers[0].windows[0].key}`);
  host.view.page = "overview";
  assert.match(flatten(host.tree()), /78%/);
});
test("strip styles and the used/left choice change what the strip shows", async () => {
  const host = await createHost({ mode: "strip", data });
  assert.ok(paths(host.tree()).length > 0);
  host.state[`${PREFIX}.options`] = { strip: "blocks" };
  assert.match(flatten(host.tree()), /█/);
  host.state[`${PREFIX}.options`] = { strip: "numbers", metric: "left" };
  const text = flatten(host.tree());
  assert.match(text, /22%/); assert.doesNotMatch(text, /78%/);
  assert.equal(paths(host.tree()).length, 0);
});
test("limits that share a kind keep distinct names", async () => {
  const host = await createHost({ mode: "strip", data: copilot });
  host.view.width = 900;
  const text = flatten(host.tree());
  assert.match(text, /Chat/); assert.match(text, /Completions/); assert.doesNotMatch(text, /Month/);
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
  click(host, `focus-${data.providers[0].key}-t9`);
  assert.deepEqual(host.commands[0], ["agent.focus", { terminal: "t9" }]);
});
test("missing data renders an actionable empty state without a percentage", async () => {
  const host = await createHost();
  host.state[`${PREFIX}.error`] = "Quota collector not found. Run npm run setup.";
  const text = flatten(host.tree());
  assert.match(text, /Quota needs attention/); assert.match(text, /npm run setup/); assert.match(text, /No providers to show/);
  click(host, "empty-settings");
  assert.equal(host.view.page, "configure");
});
test("unexpected exceptions are never stored verbatim", async () => {
  const host = await createHost({ data, runner: async () => { throw new TypeError("token=SECRET"); } });
  host.view.runtime = {};
  // Every attempt rejects, so collect reports its own not-found message.
  host.view.tick(host.cx);
  await host.tasks.at(-1)(host.cx);
  assert.match(host.state[`${PREFIX}.error`], /collector not found/);
  const broken = await createHost({ data, runner: async () => ({ code: 0, get stdout() { throw new TypeError("SECRET"); } }) });
  broken.view.tick(broken.cx);
  await broken.tasks.at(-1)(broken.cx);
  assert.doesNotMatch(broken.state[`${PREFIX}.error`], /SECRET/);
});
test("unchanged shared values are not rewritten", async () => {
  const host = await createHost({ data });
  host.state[`${PREFIX}.options`] = { redline: 80 };
  host.view.page = "configure";
  host.tree();
  click(host, "redline-80");
  assert.equal(host.writes.filter(w => w.endsWith(".options")).length, 0);
});
test("pane header suppresses local readings for a remote terminal", async () => {
  const host = await createHost({ mode: "header", data, runtime: { pane: "p1" }, paneList: [{ pane: "p1", terminal: "remote/t1", program: { key: "codex", name: "Codex", agent: true } }] });
  const text = flatten(host.tree());
  assert.match(text, /remote · quota not linked/); assert.doesNotMatch(text, /78%/);
});
test("pane headers poll less often than the strip", async () => {
  const header = await createHost({ mode: "header", data, runtime: { pane: "p1" } });
  const strip = await createHost({ mode: "strip", data });
  assert.equal(header.timers[0].ms, 60000); assert.equal(strip.timers[0].ms, 15000);
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
test("keyboard activation opens the dashboard and Escape closes it", async () => {
  const host = await createHost({ mode: "strip", data });
  host.tree().events.keydown({ key: "enter" });
  assert.equal(host.overlays.length, 1);
  const dash = await createHost({ data, runtime: { overlay: "o1" } });
  dash.tree().events.keydown({ key: "escape" });
  assert.deepEqual(dash.commands[0], ["close", "o1"]);
});
test("rendering and repainting all surfaces never allocate focus handles", async () => {
  for (const mode of ["strip", "dashboard", "header"]) {
    const host = await createHost({ mode, data, runtime: { pane: "p1" }, paneList: [{ pane: "p1", terminal: "t1", program: { key: "codex", name: "Codex", agent: true } }] });
    const allocations = host.focus.allocations;
    assert.equal(allocations, 1);
    host.tree(); host.tree();
    if (mode === "dashboard") {
      click(host, "page-configure");
      host.tree(); host.tree();
      // A newly discovered provider creates more buttons without allocating view handles.
      host.state[`${PREFIX}.discovered`] = [{ key: "claude", name: "Claude", installed: true }];
      host.tree();
    }
    assert.equal(host.focus.allocations, allocations, mode);
  }
});
