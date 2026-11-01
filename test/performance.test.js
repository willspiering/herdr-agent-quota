import test from "node:test";
import assert from "node:assert/strict";
import { createHost, walk, flatten } from "./host.js";
import { parseReport, PREFIX, catalog, options } from "../mods/agent-quota/core.js";

// One fake native provider: `read` decides when and what it answers.
const lane = { provider: "codex", accountKeys: ["default"], state: { status: "fresh" }, windows: [{ id: "week", label: "week", kind: "weekly", percentUsed: 60 }] };
const provider = read => [{ id: "codex", label: "Codex", read }];
const now = Date.now();
const raw = { schemaVersion: 5, generatedAt: new Date(now).toISOString(), providers: [{ provider: "codex", state: { status: "fresh" }, windows: [{ id: "week", kind: "weekly", percentUsed: 60 }] }] };
const data = parseReport(JSON.stringify(raw));
const find = (tree, id) => { let found; walk(tree, n => { if (n.styles.id?.[0] === id) found = n; }); return found; };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("independent module copies share a single claim before any asynchronous work", async () => {
  const clock = { now }, state = { [`${PREFIX}.data`]: data }, wait = deferred();
  let calls = 0;
  const adapters = provider(() => { calls++; return wait.promise; });
  const strip = await createHost({ mode: "strip", sharedState: state, clock, adapters });
  const dash = await createHost({ sharedState: state, clock, adapters });
  strip.view.tick(strip.cx);
  dash.view.tick(dash.cx, { force: true });
  assert.equal(strip.tasks.length, 3); assert.equal(dash.tasks.length, 1);
  const pending = strip.tasks[2](strip.cx);
  dash.view.tick(dash.cx, { force: true });
  await new Promise(r => setImmediate(r)); // the read starts asynchronously
  assert.equal(calls, 1);
  wait.resolve(lane); await pending;
  assert.ok(!state[`${PREFIX}.control`].busyUntil);
});

test("a retired collection cannot write state or launch discovery after await", async () => {
  const wait = deferred();
  const host = await createHost({ data, adapters: provider(() => wait.promise) });
  host.view.tick(host.cx);
  const work = host.tasks.at(-1)(host.cx);
  const before = host.writes.length;
  host.cx.phase = () => { throw Error("retired"); };
  wait.resolve(lane);
  await assert.rejects(work, /retired/);
  assert.equal(host.writes.length, before);
  assert.equal(host.tasks.length, 2);
});

test("an expired queued collection never starts a read", async () => {
  let calls = 0;
  const clock = { now };
  const host = await createHost({ clock, adapters: provider(async () => { calls++; return lane; }) }); host.view.tick(host.cx);
  clock.now += 45001;
  await host.tasks.at(-1)(host.cx);
  assert.equal(calls, 0); assert.equal(host.view.pending, false);
});

test("an expired claim recovers and its late result cannot replace a newer claim", async () => {
  const clock = { now }, state = {}, wait = deferred();
  const old = await createHost({ sharedState: state, clock, adapters: provider(() => wait.promise) });
  old.view.tick(old.cx);
  const work = old.tasks.at(-1)(old.cx), oldToken = state[`${PREFIX}.control`].token;
  clock.now += 45001;
  const next = await createHost({ sharedState: state, clock });
  next.view.tick(next.cx);
  assert.notEqual(state[`${PREFIX}.control`].token, oldToken);
  const writes = old.writes.length;
  wait.resolve(lane); await work;
  assert.equal(old.writes.length, writes);
  assert.equal(state[`${PREFIX}.data`], undefined);
});

test("short turns seen by reactive renders are retained until the next collection check", async () => {
  const live = [{ address: "t1", status: "idle", program: { key: "codex" } }], clock = { now };
  const host = await createHost({ mode: "strip", live, clock, data });
  host.tree(); live[0].status = "working"; clock.now += 1000; host.tree();
  live[0].status = "idle"; clock.now += 1000; host.tree();
  assert.equal(host.view.finishedAt, clock.now);
  assert.equal(host.writes.length, 0); // observing reactive data does not trigger a render loop
});

test("large account reports have bounded native descriptions and remain navigable", async () => {
  const providers = Array.from({ length: 40 }, (_, i) => ({ ...raw.providers[0], accountKey: `${i}`,
    windows: Array.from({ length: 20 }, (_, j) => ({ id: `${j}`, label: `Limit ${j}`, kind: "weekly", percentUsed: 50 })) }));
  const report = parseReport(JSON.stringify({ ...raw, providers }));
  for (const page of ["overview", "configure"]) for (const dash of ["bars", "gauges"]) {
    const host = await createHost({ data: report }); host.view.page = page;
    host.state[`${PREFIX}.options`] = { dash };
    let nodes = 0, paths = 0;
    const tree = host.tree(); walk(tree, n => { nodes++; if (n.type === "path") paths++; });
    assert.ok(nodes < 650, `${page}/${dash}: ${nodes} nodes`);
    assert.ok(paths <= 128, `${page}/${dash}: ${paths} paths`);
    const id = `${page}-providers`;
    assert.match(flatten(tree), /Page 1 of 10/);
    find(tree, `${id}-next`).events.click({}, host.cx);
    assert.match(flatten(host.tree()), /Page 2 of 10/);
  }
  const host = await createHost({ data: report });
  const key = report.providers[0].key, id = `limits-${key}`;
  const seen = new Set();
  for (let page = 0; page < 3; page++) {
    const text = flatten(host.tree());
    for (const match of text.matchAll(/Limit (\d+)/g)) seen.add(match[1]);
    if (page < 2) find(host.tree(), `${id}-next`).events.click({}, host.cx);
  }
  assert.equal(seen.size, 20);
});

test("pane headers deserialize quota only when a collection changes it", async () => {
  // shared() deserializes a copy on every call in Herdr; that copy is the cost being bounded.
  const report = { ...data, providers: [...data.providers, { ...data.providers[0], id: "unrelated", key: "unrelated" }] };
  const host = await createHost({ mode: "header", data: report, runtime: { pane: "p" }, paneList: [{ pane: "p", program: { key: "codex", agent: true } }] });
  assert.match(flatten(host.tree()), /60%/);
  for (let i = 0; i < 100; i++) host.tree();
  assert.equal(host.sharedReads.filter(k => k.endsWith(".data")).length, 1);
  host.state[`${PREFIX}.control`] = { attempt: now, token: "collecting" };
  host.tree();
  host.state[`${PREFIX}.data`] = { ...data, providers: [{ ...data.providers[0], windows: [{ ...data.providers[0].windows[0], percentUsed: 80 }] }] };
  host.state[`${PREFIX}.control`] = { attempt: now };
  assert.match(flatten(host.tree()), /80%/);
  assert.equal(host.sharedReads.filter(k => k.endsWith(".data")).length, 3);
});

test("activity classification is linear in agents and spaces, independent of account lanes", () => {
  let reads = 0;
  const spaces = Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}`, machine: i % 2 ? "remote" : null }));
  const live = spaces.map((_, i) => ({ address: `t${i}`, get space() { reads++; return `s${i}`; }, status: "working", program: { key: "codex" } }));
  const providers = Array.from({ length: 100 }, (_, i) => ({ ...data.providers[0], account: `${i}`, key: `${i}` }));
  const list = catalog({ providers }, [], live, spaces, options());
  assert.equal(list.length, 100); assert.ok(reads <= 1000, `${reads} space lookups`);
  assert.equal(list[0].localSessions.length, 500); assert.equal(list[0].remoteSessions.length, 500);
  assert.equal(list[0].sessions, list[99].sessions);
});

test("session rows are bounded and subsequent agents remain reachable", async () => {
  const live = Array.from({ length: 200 }, (_, i) => ({ address: `t${i}`, space: "s", space_name: "Example", tab_name: "Build", program: { key: "codex" }, status: "working" }));
  const host = await createHost({ data, live });
  const id = `sessions-${data.providers[0].key}`;
  let links = 0;
  walk(host.tree(), n => { if (n.styles.id?.[0]?.startsWith("focus-")) links++; });
  assert.equal(links, 8);
  find(host.tree(), `${id}-next`).events.click({}, host.cx);
  find(host.tree(), `focus-${data.providers[0].key}-t8`).events.click({}, host.cx);
  assert.equal(host.commands.at(-1)[1].terminal, "t8");
});

test("oversized report structures fail explicitly instead of silently hiding accounts or limits", () => {
  assert.throws(() => parseReport(JSON.stringify({ ...raw, providers: Array.from({ length: 201 }, (_, i) => ({ ...raw.providers[0], accountKey: `${i}` })) })), /too many account/);
  assert.throws(() => parseReport(JSON.stringify({ ...raw, providers: [{ ...raw.providers[0], windows: Array.from({ length: 101 }, (_, i) => ({ id: `${i}` })) }] })), /too many limits/);
});
