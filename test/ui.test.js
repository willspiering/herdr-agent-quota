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
  assert.match(text, /per account, read from this computer's sign-ins/);
});
const calls = drawn => drawn.reduce((n, p) => n + p.commands.length, 0);
test("meters are painted as one dashed stroke per run of cells, not a shape per cell", async () => {
  const host = await createHost({ data });
  const drawn = paths(host.tree());
  // 78% used with a 70% redline: one lit run in the terminal's red, then the rest of the red zone.
  assert.equal(drawn.length, 2);
  assert.ok(drawn.every(p => p.fill === "#e06c75"));
  assert.ok(drawn.every(p => p.commands.map(c => c[0]).join() === "move_to,line_to,dash_array"));
});
test("gauge layout draws a segmented arc", async () => {
  const host = await createHost({ data });
  host.state[`${PREFIX}.options`] = { dash: "gauges" };
  const drawn = paths(host.tree());
  assert.equal(drawn.length, 2); // no elapsed time reported, so no pace tick
  assert.ok(drawn.every(p => p.commands.map(c => c[0]).join() === "move_to,arc_to,dash_array"));
});
// The regression behind "could not be re-rendered · interrupted": host calls must not grow with cells.
test("a full dashboard stays within a small, cell-independent path-command budget", async () => {
  const providers = ["codex", "claude", "gemini", "copilot", "cursor", "grok"].map((provider, k) => ({ provider, state: { status: "fresh" },
    windows: ["session", "weekly", "monthly"].map((kind, i) => ({ id: kind, label: kind, kind, percentRemaining: 95 - k * 12 - i * 9,
      windowSeconds: 604800, resetsAt: new Date(now + 3600000 * (i + 1)).toISOString() })) }));
  const big = parseReport(JSON.stringify({ schemaVersion: 5, generatedAt: new Date(now).toISOString(), providers }));
  for (const dash of ["bars", "gauges"]) {
    const host = await createHost({ data: big });
    host.state[`${PREFIX}.options`] = { dash, windows: {} };
    const drawn = paths(host.tree());
    // These count path commands, excluding path construction, painting and builder setters.
    // 18 limits, each at most three runs (3 commands) plus the time tick (2 commands).
    assert.ok(drawn.length > 0, dash);
    assert.ok(calls(drawn) <= 18 * 11, `${dash}: ${calls(drawn)} host calls`);
  }
});
test("the time tick is explained by a legend and by each meter's tooltip", async () => {
  const timed = parseReport(JSON.stringify({ schemaVersion: 5, generatedAt: new Date(now).toISOString(), providers: [
    { provider: "codex", state: { status: "fresh" }, windows: [{ id: "weekly", label: "Weekly", kind: "weekly", percentRemaining: 40, windowSeconds: 604800, resetsAt: new Date(now + 302400000).toISOString() }] },
  ] }));
  const host = await createHost({ data: timed });
  assert.match(flatten(find(host.tree(), "quota-legend")), /used.*redline 70%\+.*time elapsed/);
  let tip;
  walk(host.tree(), n => { if (n.type === "div" && n.nodes.some(c => c.type === "path")) tip = n.styles.tooltip?.[0]; });
  assert.match(tip, /60% used · 40% left/);
  assert.match(tip, /50% of this window has passed/);
  assert.match(tip, /faster than time/);
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
  assert.deepEqual(host.commands.find(c => c[0] === "agent.focus"), ["agent.focus", { terminal: "t9" }]);
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
  const throws = [{ id: "codex", label: "Codex", read: async () => { throw new TypeError("token=SECRET"); } }];
  const host = await createHost({ data, adapters: throws });
  host.view.tick(host.cx);
  await host.tasks.at(-1)(host.cx);
  assert.match(host.state[`${PREFIX}.error`].message, /^Codex: quota could not be read/);
  assert.doesNotMatch(JSON.stringify(host.state[`${PREFIX}.error`]), /SECRET/);
  const odd = [{ id: "codex", label: "Codex", read: async () => ({ get provider() { throw new TypeError("SECRET"); } }) }];
  const broken = await createHost({ data, adapters: odd });
  broken.view.tick(broken.cx);
  await broken.tasks.at(-1)(broken.cx);
  assert.doesNotMatch(JSON.stringify(broken.state[`${PREFIX}.error`]), /SECRET/);
});
test("unchanged shared values are not rewritten", async () => {
  const host = await createHost({ data });
  host.state[`${PREFIX}.options`] = { redline: 80 };
  host.view.page = "configure";
  host.tree();
  click(host, "redline-80");
  assert.equal(host.writes.filter(w => w.endsWith(".options")).length, 0);
});
test("a terminal on another machine has no quota button, and never shows this computer's reading", async () => {
  const host = await createHost({ mode: "header", data, runtime: { pane: "p1" }, paneList: [{ pane: "p1", terminal: "remote/t1", program: { key: "codex", name: "Codex", agent: true } }] });
  const tree = host.tree(), text = flatten(tree);
  assert.match(text, /Codex/); assert.doesNotMatch(text, /78%|quota/);
  assert.ok(!ids(tree).some(id => id.startsWith("quota-for-")));
  assert.ok(ids(tree).includes("pane-head-p1"));
});
test("the pane header is Herdr's own, with one quiet quota figure before its hover buttons", async () => {
  const host = await createHost({ mode: "header", data, runtime: { pane: "p1" }, paneList: [{ pane: "p1", terminal: "t1", cwd: "/home/tester/work", status: "idle", program: { key: "codex", name: "Codex", agent: true } }] });
  let tree = host.tree();
  // At rest: name, folder and the figure; no buttons, no status word, nothing of our own.
  assert.match(flatten(tree), /Codex.*~\/work.*78%/); assert.doesNotMatch(flatten(tree), /Split|Zoom|Close|Idle/);
  assert.ok(!ids(tree).some(id => id.startsWith("ph-")));
  // Hovered: Herdr's four icon buttons, after the figure, with its own icons and commands.
  tree.styles.on_hover[0](true, { notify() {} });
  tree = host.tree();
  const order = ids(tree);
  assert.deepEqual(order.filter(id => id.startsWith("ph-")), ["ph-r-p1", "ph-d-p1", "ph-z-p1", "ph-x-p1"]);
  assert.ok(order.indexOf("quota-for-p1") < order.indexOf("ph-r-p1"));
  const icons = []; walk(tree, n => { if (n.type === "svg") icons.push(n.value); });
  assert.deepEqual(icons, ["mods/pane/split-right.svg", "mods/pane/split-down.svg", "mods/pane/zoom.svg", "mods/pane/close.svg"]);
});
const ids = tree => { const out = []; walk(tree, n => { const id = n.styles?.id?.[0]; if (typeof id === "string") out.push(id); }); return out; };
test("the dashboard lists only this computer's agents", async () => {
  const live = [
    { address: "t1", space: "s1", space_name: "Here", tab_name: "1", program: { key: "codex", name: "Codex" }, status: "working" },
    { address: "box/t2", space: "box/s2", space_name: "There", tab_name: "1", program: { key: "codex", name: "Codex" }, status: "idle" },
    { address: "t3", space: "s3", space_name: "Mounted", tab_name: "1", program: { key: "grok", name: "Grok" }, status: "idle" },
  ];
  const host = await createHost({ data, live, spaceList: [{ id: "s1" }, { id: "box/s2", machine: "box" }, { id: "s3", machine: "box" }] });
  const text = flatten(host.tree());
  assert.match(text, /1 agent · 1 space/); assert.match(text, /Here \/ 1/);
  assert.doesNotMatch(text, /There|Mounted|Grok|on box|remote/i);
});
test("readings and the on/off record left by the other-machines build are dropped once", async () => {
  const there = { ...data.providers[0], key: JSON.stringify(["codex", "codex-home", "box"]), machine: "box", axi: "codex@box" };
  const host = await createHost({ mode: "strip", sharedState: {
    [`${PREFIX}.data`]: { ...data, providers: [...data.providers, there] },
    [`${PREFIX}.remote`]: { v: 1, on: true, at: now },
    [`${PREFIX}.error`]: { message: "Couldn't reach box.", providers: ["codex@box"] } } });
  await host.tasks[0](host.cx);
  assert.deepEqual(host.state[`${PREFIX}.data`].providers.map(p => p.key), data.providers.map(p => p.key));
  assert.equal(host.state[`${PREFIX}.remote`] ?? null, null);
  const dash = await createHost({ sharedState: { ...host.state, [`${PREFIX}.error`]: { message: "Couldn't reach box.", providers: ["codex@box"] } } });
  assert.doesNotMatch(flatten(dash.tree()), /Quota needs attention|choose account/);
});
test("pane headers schedule nothing: no timers, no tasks, no reads", async () => {
  const runs = [];
  const host = await createHost({ mode: "header", data, runtime: { pane: "p1" }, adapters: [{ id: "codex", label: "Codex", read: async () => { runs.push("codex"); } }] });
  assert.equal(host.timers.length, 0); assert.equal(host.tasks.length, 0);
  host.tree(); assert.equal(runs.length, 0);
});
test("the strip checks every 10 s and the dashboard only repaints its clock", async () => {
  const strip = await createHost({ mode: "strip", data });
  assert.deepEqual(strip.timers.map(t => t.ms), [10000]);
  const dash = await createHost({ data });
  assert.deepEqual(dash.timers.filter(t => !t.once).map(t => t.ms), [60000]);
});
// A host whose providers record each collection (the ids it read) and answer fresh.
async function reader(mode, live, extra = {}) {
  const runs = [];
  let current = null;
  const adapters = ["claude", "codex", "copilot"].map(id => ({ id, label: id, read: async () => {
    if (!current) { current = []; runs.push(current); Promise.resolve().then(() => { current = null; }); }
    current.push(id);
    return { provider: id, accountKeys: ["default"], state: { status: "fresh" }, windows: [] };
  } }));
  const host = await createHost({ mode, data, live, adapters, ...extra });
  return { host, runs, settle: async () => { while (host.tasks.length > (mode === "strip" ? 2 : 1)) await host.tasks.splice(-1)[0](host.cx); } };
}
test("an agent finishing its turn triggers a targeted read once the gap allows", async () => {
  const live = [{ address: "t1", space: "s", program: { key: "codex" }, status: "working" }];
  const { host, runs, settle } = await reader("strip", live);
  host.state[`${PREFIX}.control`] = { attempt: Date.now() - 30000, sweptAt: Date.now() };
  host.timers[0].fn(host.cx); await settle();
  assert.equal(runs.length, 0); // working, read 30 s ago: nothing due
  live[0].status = "idle";
  host.timers[0].fn(host.cx); await settle();
  assert.equal(runs.length, 0); // finished, but inside the one-minute gap
  host.state[`${PREFIX}.control`] = { attempt: Date.now() - 61000, sweptAt: Date.now() };
  host.timers[0].fn(host.cx); await settle();
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], ["codex"]); // only the provider with limits or a running agent
  assert.equal(host.state[`${PREFIX}.control`].reason, "turn");
  host.timers[0].fn(host.cx); await settle();
  assert.equal(runs.length, 1); // served once, not again
});
test("opening the dashboard asks the strip to read data older than a minute", async () => {
  const dash = await reader("dashboard", []);
  assert.deepEqual(dash.host.commands.find(c => c[0].startsWith("agent-quota.")), ["agent-quota.look", undefined]);
  assert.equal(dash.runs.length, 0); // the dashboard window does not read itself
  for (const [age, reads] of [[30000, 0], [90000, 1]]) {
    let sent = false;
    const { host, runs, settle } = await reader("strip", [], { nextCommand: async () => (sent ? new Promise(() => {}) : (sent = true, "look")) });
    host.state[`${PREFIX}.control`] = { attempt: Date.now() - age, sweptAt: Date.now() };
    host.tasks[1](host.cx); await new Promise(r => setImmediate(r)); await settle();
    assert.equal(runs.length, reads, `${age} ms old`);
    if (reads) assert.equal(host.state[`${PREFIX}.control`].reason, "look");
  }
});
test("a read in flight blocks a second one through shared control", async () => {
  const { host, runs } = await reader("strip", []);
  host.state[`${PREFIX}.control`] = null;
  host.timers[0].fn(host.cx); host.timers[0].fn(host.cx);
  assert.equal(host.tasks.length, 3); // init, command loop, one read
  host.view.pending = false; // as if the copy's task was cancelled mid-read
  host.timers[0].fn(host.cx);
  assert.equal(host.tasks.length, 3); // still guarded by the shared timestamp
  assert.equal(runs.length, 0);
});
test("Refresh asks the strip, which reads every provider; no shared write to ask", async () => {
  const dash = await reader("dashboard", [], { runtime: { overlay: "o1" } });
  dash.host.state[`${PREFIX}.control`] = { attempt: Date.now() - 20000, sweptAt: Date.now() };
  find(dash.host.tree(), "refresh").events.click({}, dash.host.cx);
  assert.ok(dash.host.commands.some(c => c[0] === "agent-quota.refresh"));
  assert.equal(dash.host.writes.length, 0);
  let sent = false;
  const { host, runs, settle } = await reader("strip", [], { nextCommand: async () => (sent ? new Promise(() => {}) : (sent = true, "refresh")) });
  host.state[`${PREFIX}.control`] = { attempt: Date.now() - 20000, sweptAt: Date.now() };
  host.tasks[1](host.cx); await new Promise(r => setImmediate(r)); await settle();
  assert.equal(runs.length, 1); assert.deepEqual(runs[0], ["claude", "codex", "copilot"]); // a Refresh reads every provider
  assert.equal(host.state[`${PREFIX}.control`].reason, "manual");
});
test("every endless loop yields to Herdr through cx, and nothing uses browser timers", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const dir = new URL("../mods/agent-quota/", import.meta.url);
  // The view and its scheduling: every module but the providers' parsers, whose bounded scans
  // also use for (;;).
  const files = (await readdir(dir, { recursive: true })).filter(f => f.endsWith(".js") && !f.startsWith("providers"));
  assert.ok(files.includes("main.js") && files.includes("reads.js") && files.some(f => f.startsWith("ui")), "every view module");
  const source = (await Promise.all(files.map(f => readFile(new URL(f, dir), "utf8")))).join("\n");
  assert.doesNotMatch(source, /\b(setTimeout|setInterval|while \(true\))/);
  for (const match of source.matchAll(/for \(;;\) \{/g)) {
    let depth = 0, i = match.index + match[0].length - 1;
    do { if (source[i] === "{") depth++; else if (source[i] === "}") depth--; i++; } while (depth);
    assert.match(source.slice(match.index, i), /\bcx\.(notify|spawn|phase)\(/, "a for (;;) body must use cx");
  }
  for (const m of source.matchAll(/timer\.every\((\d+)/g)) assert.ok(Number(m[1]) >= 10000, `timer at ${m[1]} ms`);
});
test("keyboard activation opens the dashboard and Escape closes it", async () => {
  const host = await createHost({ mode: "strip", data });
  host.tree().events.keydown({ key: "enter" });
  assert.equal(host.overlays.length, 1);
  const dash = await createHost({ data, runtime: { overlay: "o1" } });
  dash.tree().events.keydown({ key: "escape" });
  assert.deepEqual(dash.commands.find(c => c[0] === "close"), ["close", "o1"]);
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
test("pane headers never read live agents or spaces", async () => {
  const host = await createHost({ mode: "header", data, runtime: { pane: "p1" }, paneList: [{ pane: "p1", terminal: "t1", program: { key: "codex", name: "Codex", agent: true } }] });
  host.tree(); host.tree();
  assert.deepEqual(host.reads, { agents: 0, spaces: 0 });
  assert.match(flatten(host.tree()), /78%/);
});
test("a dashboard render reads live agents and spaces once", async () => {
  const host = await createHost({ data });
  host.tree();
  assert.deepEqual(host.reads, { agents: 1, spaces: 1 });
});
test("animated switch knobs keep identity when rows above them change", async () => {
  const host = await createHost({ data });
  host.view.page = "configure";
  const knobs = [];
  walk(host.tree(), n => { if (n.styles.transition) knobs.push(n.styles.id?.[0]); });
  assert.ok(knobs.length >= 3);
  assert.ok(knobs.every(id => typeof id === "string" && id.endsWith("-knob")));
});
test("each page keeps its own scroll position", async () => {
  const host = await createHost({ data });
  assert.ok(find(host.tree(), "quota-scroll-overview"));
  host.view.page = "configure";
  assert.ok(find(host.tree(), "quota-scroll-configure"));
});
test("the command loop yields to Herdr and stops when commands end", async () => {
  let calls = 0, checked = 0, notified = 0;
  const host = await createHost({ mode: "strip", data, nextCommand: async () => (++calls === 1 ? "open" : undefined) });
  host.cx.notify = () => { notified++; };
  host.cx.phase = () => { checked++; return "task"; };
  await host.tasks[1](host.cx); // must return rather than spin
  assert.equal(calls, 2); assert.equal(host.overlays.length, 1); assert.equal(checked, 2); assert.equal(notified, 0);
  // A retired copy's cx throws on use, which ends the loop even if commands keep coming.
  const retired = await createHost({ mode: "strip", data, nextCommand: async () => "noop" });
  retired.cx.phase = () => { throw new Error("view released"); };
  await assert.rejects(retired.tasks[1](retired.cx), /released/);
});
test("a provider can leave the status bar and stay in the dashboard and its pane headers", async () => {
  const host = await createHost({ data });
  host.view.page = "configure";
  click(host, `strip-${data.providers[0].key}`);
  assert.deepEqual(host.state[`${PREFIX}.options`].offStrip, ["codex"]);
  assert.match(flatten(host.tree()), /not in the status bar/);
  host.view.page = "overview";
  assert.match(flatten(host.tree()), /78%/);
  const strip = await createHost({ mode: "strip", sharedState: { ...host.state } });
  assert.doesNotMatch(flatten(strip.tree()), /78%/);
  const header = await createHost({ mode: "header", sharedState: { ...host.state }, runtime: { pane: "p1" }, paneList: [{ pane: "p1", terminal: "t1", program: { key: "codex", name: "Codex", agent: true } }] });
  assert.match(flatten(header.tree()), /78%/);
  // And back on.
  host.view.page = "configure";
  click(host, `strip-${data.providers[0].key}`);
  assert.deepEqual(host.state[`${PREFIX}.options`].offStrip, []);
});
test("a pane header with no reading for its agent shows no figure at all", async () => {
  for (const reading of [null, parseReport(JSON.stringify({ schemaVersion: 5, generatedAt: new Date(now).toISOString(), providers: [{ provider: "codex", state: { status: "auth_required" }, windows: [] }] }))]) {
    const host = await createHost({ mode: "header", data: reading, runtime: { pane: "p1" }, paneList: [{ pane: "p1", terminal: "t1", program: { key: "codex", name: "Codex", agent: true } }] });
    const tree = host.tree();
    assert.ok(!ids(tree).includes("quota-for-p1"));
    assert.doesNotMatch(flatten(tree), /quota|—|null|undefined/);
  }
});
test("each provider's choices are two labeled rows: where it shows, then which limits", async () => {
  const host = await createHost({ data });
  host.view.page = "configure";
  const text = flatten(host.tree());
  assert.match(text, /Show in\s+Status bar\s+Limits\s+Session/);
  // Hidden everywhere: neither row is offered.
  host.state[`${PREFIX}.options`] = { hidden: ["codex"] };
  assert.doesNotMatch(flatten(host.tree()), /Show in\s+Status bar|Limits\s+Session/);
});

// Review fixes, local-only.
const codexPane = { pane: "p1", terminal: "t1", program: { key: "codex", name: "Codex", agent: true } };
const headerHost = (extra = {}) => createHost({ mode: "header", data, runtime: { pane: "p1" }, paneList: [codexPane], ...extra });
const lanes = (...specs) => parseReport(JSON.stringify({ schemaVersion: 5, generatedAt: new Date(now).toISOString(), providers: specs.map(([account, status, used]) => ({
  provider: "codex", accountKeys: [account], state: { status },
  windows: used === null ? [] : [{ id: "session", label: "Session", kind: "session", percentUsed: used, resetsAt: new Date(now + 3600000).toISOString() }] })) }));

test("a provider hidden everywhere has no figure in its pane header; off the status bar it keeps one", async () => {
  const hidden = await headerHost({ sharedState: { [`${PREFIX}.data`]: data, [`${PREFIX}.options`]: { hidden: ["codex"] } } });
  assert.ok(!ids(hidden.tree()).includes("quota-for-p1"));
  const offStrip = await headerHost({ sharedState: { [`${PREFIX}.data`]: data, [`${PREFIX}.options`]: { offStrip: ["codex"] } } });
  assert.match(flatten(offStrip.tree()), /78%/);
});
test("the header figure is a native, named, focusable button that can't crowd out the pane buttons", async () => {
  const host = await headerHost();
  const figure = find(host.tree(), "quota-for-p1");
  assert.equal(figure.type, "button");
  assert.match(figure.styles.accessibility_label[0], /^Open Codex quota: Session 78%/);
  assert.deepEqual(figure.styles.tab_stop, [true]);
  assert.ok(figure.styles.focus, "a visible focus treatment");
  // Bounded and shrinking; never flex_none.
  assert.ok(figure.styles.max_w && figure.styles.truncate && figure.styles.min_w);
  assert.deepEqual(figure.styles.flex_shrink, [1]); assert.equal(figure.styles.flex_none, undefined);
  let stopped = false;
  figure.events.click({}, { stop_propagation() { stopped = true; } });
  assert.ok(stopped, "clicking the figure doesn't also focus the pane");
});
test("a header never shows another machine's lane, even before the strip drops it", async () => {
  const there = { ...data.providers[0], key: JSON.stringify(["codex", "codex-home", "box"]), machine: "box" };
  const host = await headerHost({ sharedState: { [`${PREFIX}.data`]: { ...data, providers: [...data.providers, there] } } });
  const text = flatten(host.tree());
  assert.match(text, /78%/); assert.doesNotMatch(text, /choose account/);
});
test("several accounts are offered in a header only when one has a reading", async () => {
  const none = await headerHost({ sharedState: { [`${PREFIX}.data`]: lanes(["a", "auth_required", null], ["b", "auth_required", null]) } });
  assert.ok(!ids(none.tree()).includes("quota-for-p1"));
  const allHidden = await headerHost({ sharedState: { [`${PREFIX}.data`]: lanes(["a", "fresh", 40], ["b", "fresh", 50]), [`${PREFIX}.options`]: { kinds: { session: false } } } });
  assert.ok(!ids(allHidden.tree()).includes("quota-for-p1"));
  const one = await headerHost({ sharedState: { [`${PREFIX}.data`]: lanes(["a", "fresh", 40], ["b", "auth_required", null]) } });
  assert.match(flatten(one.tree()), /choose account/);
});
test("with every provider off the status bar, the bar and its preview say so instead of waiting", async () => {
  const state = { [`${PREFIX}.data`]: data, [`${PREFIX}.options`]: { offStrip: ["codex"] } };
  const strip = await createHost({ mode: "strip", sharedState: { ...state } });
  const text = flatten(strip.tree());
  assert.match(text, /quota/); assert.doesNotMatch(text, /waiting for agents|78%/);
  const settings = await createHost({ sharedState: { ...state } });
  settings.view.page = "configure";
  assert.match(flatten(settings.tree()), /No providers in the status bar/);
});
test("the Settings preview shows the status bar's overflow count", async () => {
  const many = parseReport(JSON.stringify({ schemaVersion: 5, generatedAt: new Date(now).toISOString(), providers: ["codex", "claude", "grok", "cursor", "kimi", "copilot", "opencode-go", "agy"].map(provider => ({
    provider, state: { status: "fresh" }, windows: ["a", "b"].map(id => ({ id, label: `${id} window`, kind: "session", percentUsed: 10, resetsAt: new Date(now + 3600000).toISOString() })) })) }));
  const host = await createHost({ data: many });
  host.view.page = "configure";
  const text = flatten(host.tree()); // also sets the frame stripItems reads
  const preview = host.view.stripItems(host.view.width - 2 * host.view.pad());
  assert.ok(preview.hidden > 0);
  assert.match(text, new RegExp(`\\+${preview.hidden}\\b`));
});
test("each Settings chip is named with its provider for screen readers", async () => {
  const host = await createHost({ data });
  host.view.page = "configure";
  const tree = host.tree();
  assert.equal(find(tree, `strip-${data.providers[0].key}`).styles.accessibility_label[0], "Codex in the status bar: shown");
  assert.match(find(tree, `window-${data.providers[0].windows[0].key}`).styles.accessibility_label[0], /^Codex .+ limit: shown$/);
});
