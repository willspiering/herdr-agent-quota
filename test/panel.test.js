// The dashboard as a hidden layout column, toggled by Herdr. A window overlay builds a new copy on
// every open (measured natively: about 0.29 MB retained per open/close); a layout block's copy is
// built the first time it shows and kept, so opening and closing it allocates nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { createHost, walk, flatten } from "./host.js";
import { PREFIX, parseReport } from "../mods/agent-quota/core.js";
import { integrateLayout, PANEL } from "../scripts/layout.mjs";

const data = parseReport(JSON.stringify({ schemaVersion: 5, generatedAt: new Date().toISOString(), providers: [
  { provider: "codex", state: { status: "fresh" }, windows: [{ id: "week", label: "Weekly", kind: "weekly", percentUsed: 40 }] },
  { provider: "claude", state: { status: "fresh" }, windows: [{ id: "week", label: "Weekly", kind: "weekly", percentUsed: 20 }] },
] }));
const find = (tree, id) => { let match; walk(tree, n => { if (n.styles.id?.[0] === id) match = n; }); return match; };
const click = (host, id) => find(host.tree(), id).events.click({}, host.cx);

const tabRow = (panel) => ({ id: "root", type: "column", children: [
  { id: "work-body", type: "row", children: [{ id: "main", type: "block", content: { tab: "active" } }, ...(panel ? [panel] : [])] },
  { id: "status", type: "block", size: { px: 28 }, content: { mod: "workspace-status" } },
] });
// As Herdr's layout() reports it (seen natively): a shown node has no `hidden` key at all.
const panelNode = (hidden = true) => ({ id: PANEL, type: "block", content: { mod: "agent-quota", props: { mode: "panel" } }, ...(hidden ? { hidden: true } : {}) });

// ── layout ──

test("panel: setup adds one hidden quota column beside the terminals, and only once", () => {
  const next = integrateLayout(tabRow());
  const row = next.children[0];
  assert.equal(row.children.length, 2);
  const panel = row.children[1];
  assert.equal(panel.id, PANEL);
  assert.equal(panel.hidden, true, "must start hidden: a never-opened panel never starts its copy");
  assert.deepEqual(panel.content, { mod: "agent-quota", props: { mode: "panel" } });
  assert.ok(panel.size.px >= 440 && panel.min >= 360, JSON.stringify(panel));
  assert.deepEqual(integrateLayout(next), next, "idempotent");
});

test("panel: a layout whose terminals are not in a row keeps the window dashboard", () => {
  const source = { id: "root", type: "column", children: [{ id: "main", type: "block", content: { tab: "active" } }, { id: "status", type: "block", content: { mod: "workspace-status" } }] };
  const next = integrateLayout(source);
  let found = false;
  JSON.stringify(next, (k, v) => { if (v?.id === PANEL) found = true; return v; });
  assert.equal(found, false);
});

// ── opening and closing ──

test("panel: the strip toggles a hidden panel open and asks for a look read, without an overlay", async () => {
  const host = await createHost({ mode: "strip", data, layoutTree: tabRow(panelNode(true)) });
  host.tree().events.click();
  assert.equal(host.overlays.length, 0);
  assert.deepEqual(host.commands.find(c => c[0].startsWith("layout.")), ["layout.toggle", { id: PANEL }]);
  assert.ok(host.commands.some(c => c[0] === "agent-quota.look"), "opening reads stale quota, as the window did");
});

test("panel: the strip toggles a shown panel closed without starting a read", async () => {
  const host = await createHost({ mode: "strip", data, layoutTree: tabRow(panelNode(false)) });
  host.tree().events.click();
  assert.deepEqual(host.commands.find(c => c[0].startsWith("layout.")), ["layout.toggle", { id: PANEL }]);
  assert.ok(!host.commands.some(c => c[0] === "agent-quota.look"));
  assert.equal(host.overlays.length, 0);
});

test("panel: the open command and keyboard activation toggle it too", async () => {
  let calls = 0;
  const host = await createHost({ mode: "strip", data, layoutTree: tabRow(panelNode(true)), nextCommand: async () => (++calls === 1 ? "open" : undefined) });
  await host.tasks[1](host.cx);
  host.tree().events.keydown({ key: "enter" });
  assert.equal(host.commands.filter(c => c[0] === "layout.toggle").length, 2);
  assert.equal(host.overlays.length, 0);
});

test("panel: a pane header's quota button shows the panel on that provider", async () => {
  const host = await createHost({ mode: "header", data, layoutTree: tabRow(panelNode(false)), runtime: { pane: "p1" },
    paneList: [{ pane: "p1", terminal: "t1", program: { key: "codex", name: "Codex", agent: true } }] });
  click(host, "quota-for-p1");
  assert.deepEqual(host.commands.find(c => c[0].startsWith("layout.")), ["layout.show", { id: PANEL }], "never hides on a targeted open");
  const view = host.state[`${PREFIX}.view`];
  assert.equal(view.provider, "codex"); assert.equal(view.page, "overview");
  assert.equal(host.overlays.length, 0);
});

test("panel: Settings from the strip shows the panel on its Settings page", async () => {
  let calls = 0;
  const host = await createHost({ mode: "strip", data, layoutTree: tabRow(panelNode(true)), nextCommand: async () => (++calls === 1 ? "settings" : undefined) });
  await host.tasks[1](host.cx);
  assert.deepEqual(host.commands.find(c => c[0].startsWith("layout.")), ["layout.show", { id: PANEL }]);
  assert.equal(host.state[`${PREFIX}.view`].page, "configure");
});

test("panel: without a panel in the layout the strip still opens the window", async () => {
  const host = await createHost({ mode: "strip", data, layoutTree: tabRow() });
  host.tree().events.click();
  assert.equal(host.overlays.length, 1);
  assert.equal(host.overlays[0].kind, "window");
  assert.ok(!host.commands.some(c => c[0].startsWith("layout.")));
});

// ── the panel copy ──

test("panel: the panel copy starts no read, no overlay and no command of its own", async () => {
  const host = await createHost({ mode: "panel", data });
  await host.tasks[0]?.(host.cx);
  assert.equal(host.commands.length, 0);
  assert.equal(host.overlays.length, 0);
  assert.equal(host.timers.filter(t => t.once).length, 0, "no delegated-read fallback");
  assert.match(flatten(host.tree()), /Agent quota/);
});

test("panel: ✕ and Escape hide the column instead of closing an overlay", async () => {
  const host = await createHost({ mode: "panel", data });
  click(host, "close");
  host.tree().events.keydown({ key: "escape" });
  assert.deepEqual(host.commands.filter(c => c[0] === "layout.hide"), [["layout.hide", { id: PANEL }], ["layout.hide", { id: PANEL }]]);
  assert.ok(!host.commands.some(c => c[0] === "close"));
});

test("panel: going to an agent keeps the column open (it covers nothing)", async () => {
  const host = await createHost({ mode: "panel", data, live: [{ address: "t9", space: "s", space_name: "Personal", tab_name: "Build", program: { key: "codex" }, status: "working" }] });
  click(host, `focus-${data.providers.find(p => p.provider === "codex" || p.id === "codex").key}-t9`);
  assert.deepEqual(host.commands, [["agent.focus", { terminal: "t9" }]]);
});

test("panel: it follows a newer view request, and ignores one from before it started", async () => {
  const sharedState = { [`${PREFIX}.data`]: data, [`${PREFIX}.view`]: { provider: "claude", page: "configure", at: Date.now() - 5000 } };
  const host = await createHost({ mode: "panel", sharedState });
  host.tree();
  assert.equal(host.view.page, "overview", "an old request is not replayed on start");
  host.state[`${PREFIX}.view`] = { provider: "codex", page: "overview", at: Date.now() + 1 };
  const text = flatten(host.tree());
  assert.match(text, /Codex/); assert.doesNotMatch(text, /Claude/);
  click(host, "show-all");
  assert.match(flatten(host.tree()), /Claude/);
  assert.equal(host.overlays.length, 0, "← All providers never opens anything");
});

test("panel: the minute clock repaints only while the panel is being drawn", async () => {
  const host = await createHost({ mode: "panel", data });
  let notified = 0;
  host.cx.notify = () => { notified++; };
  const minute = host.timers.find(t => !t.once);
  assert.equal(minute.ms, 60000);
  host.tree();            // shown: drawn
  minute.fn(host.cx);     // repaint for the age labels
  assert.equal(notified, 1);
  minute.fn(host.cx);     // hidden: Herdr drew nothing since, so no wasted window redraw
  minute.fn(host.cx);
  assert.equal(notified, 1);
  host.tree();            // shown again
  minute.fn(host.cx);
  assert.equal(notified, 2);
});

test("panel: the window dashboard still repaints its age labels every minute", async () => {
  const host = await createHost({ data, runtime: { overlay: "o1" } });
  let notified = 0;
  host.cx.notify = () => { notified++; };
  const minute = host.timers.find(t => !t.once && t.ms === 60000);
  for (let i = 0; i < 3; i++) { host.tree(); minute.fn(host.cx); }
  assert.equal(notified, 3);
});

test("panel: the overlay dashboard's ← All providers no longer rebuilds the window", async () => {
  const host = await createHost({ data, runtime: { provider: "codex", overlay: "o1" } });
  assert.doesNotMatch(flatten(host.tree()), /Claude/);
  click(host, "show-all");
  assert.equal(host.overlays.length, 0);
  assert.match(flatten(host.tree()), /Claude/);
});

test("panel: at column width the legend gets its own row and meters keep a readable width", async () => {
  const host = await createHost({ mode: "panel", data }); // its default width, as first shown
  const tree = host.tree();
  assert.ok(find(tree, "quota-legend"));
  walk(tree, n => {
    if (n.nodes.some(c => c?.styles?.id?.[0] === "quota-legend")) assert.equal(find(n, "page-configure"), undefined, "legend shares the tabs row");
  });
  let meters = [];
  walk(tree, n => { if (n.nodes.some(c => c?.type === "path") && n.styles.w) meters.push(n.styles.w[0]); });
  assert.ok(meters.length > 0 && meters.every(w => w >= 100), `meter widths ${meters}`);
});

// ── key ──

test("panel: setup binds a free toggle key for the quota layout only, never over the person's keys", async () => {
  const { bindToggle } = await import("../scripts/layout.mjs");
  const keys = { global: { "cmd-b": "layout.toggle:sidebar" }, terminal: { "ctrl-c": "terminal" } };
  const next = bindToggle(keys, "darwin");
  assert.deepEqual(next["layout:agent-quota"], { "cmd-shift-u": "agent-quota.open" });
  assert.deepEqual(next.global, keys.global); assert.equal(keys["layout:agent-quota"], undefined, "input untouched");
  assert.equal(bindToggle(keys, "linux")["layout:agent-quota"]["ctrl-shift-u"], "agent-quota.open");
  assert.deepEqual(bindToggle(next, "darwin"), next, "idempotent");
  // Taken anywhere (globally, or already in the section): left alone.
  assert.equal(bindToggle({ global: { "cmd-shift-u": "tab.new" } }, "darwin"), null);
  assert.equal(bindToggle({ "layout:agent-quota": { "cmd-shift-u": "space.next" } }, "darwin"), null);
});
