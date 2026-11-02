import test from "node:test";
import assert from "node:assert/strict";
import { remoteAdapters } from "../mods/agent-quota/remote.js";
import { collect } from "../mods/agent-quota/collector.js";
import { normalizeReport, parseReport, mergeReport, targets, catalog, options, forgetRemote, forgetUnreadable, consented, PREFIX } from "../mods/agent-quota/core.js";
import { createHost, walk, flatten } from "./host.js";

const now = Date.now();
const TOKEN = "tok-SECRET-remote";
const iso = ms => new Date(ms).toISOString();
const CODEX_USAGE = "https://chatgpt.com/backend-api/wham/usage";
const codexAuth = JSON.stringify({ tokens: { access_token: TOKEN, refresh_token: "REFRESH-SECRET", account_id: "acct-1" } });
const codexBody = { plan_type: "plus", rate_limit: {
  primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: Math.floor(now / 1000) + 9000 },
  secondary_window: { used_percent: 10, limit_window_seconds: 604800, reset_at: Math.floor(now / 1000) + 400000 } } };
const claudeFile = JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: "REFRESH-SECRET", expiresAt: now + 86400000, subscriptionType: "max" } });
const claudeBody = { five_hour: { utilization: 20, resets_at: iso(now + 3600000) }, seven_day: { utilization: 30, resets_at: iso(now + 86400000 * 3) } };
const noSecrets = value => assert.ok(!JSON.stringify(value).includes("SECRET"), "a credential leaked");
const unref = ms => new Promise(resolve => setTimeout(resolve, ms).unref());

// A fake Herdr with other machines: `machines[name]` gives that machine's home, OS and files.
function fakeIo({ machines = {}, offline = [], routes = {} } = {}) {
  const execs = [], reads = [], requests = [];
  const io = {
    execs, reads, requests, platform: "macos", home: () => "/Users/local", sleep: unref,
    keychain: { allowed: true, granted: false, denied: false },
    exec: async (cmd, args = [], opts) => {
      execs.push([cmd, ...args, opts?.on ?? null]);
      if (offline.includes(opts?.on)) throw new Error("machine cannot be reached");
      const m = machines[opts?.on];
      if (!m) return { code: 127, stdout: "", stderr: "" };
      if (cmd === "printenv") return { code: 0, stdout: `${m.home}\n`, stderr: "" };
      if (cmd === "uname") return m.os ? { code: 0, stdout: `${m.os}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    },
    readTextFile: async (path, opts) => { reads.push([path, opts?.on ?? null]); return machines[opts?.on]?.files?.[path] ?? null; },
    fetch: async (url, init) => {
      requests.push({ url, auth: init?.headers?.authorization });
      const route = routes[url];
      if (!route) throw new Error("offline");
      return { status: route[0], ok: route[0] < 300, url, json: async () => route[1] };
    },
  };
  return io;
}
const read = (io, machines, ids = null) => collect({ ...io, adapters: remoteAdapters(machines) }, now, ids, Date.now() + 25000);

test("another machine's Codex is read through Herdr's connection and kept as its own lane", async () => {
  const io = fakeIo({ machines: { splinter: { home: "/home/will", os: "Linux", files: { "/home/will/.codex/auth.json": codexAuth } } },
    routes: { [CODEX_USAGE]: [200, codexBody] } });
  const result = await read(io, ["splinter"]);
  const lane = result.report.providers.find(p => p.id === "codex");
  assert.equal(lane.machine, "splinter"); assert.equal(lane.axi, "codex@splinter");
  assert.equal(lane.key, JSON.stringify(["codex", "codex-home", "splinter"]));
  assert.equal(lane.windows.find(w => w.kind === "session").percentUsed, 42);
  // Every file read went to that machine; only the vendor heard the token, from this computer.
  assert.ok(io.reads.every(([, on]) => on === "splinter"));
  assert.ok(io.reads.some(([path]) => path === "/home/will/.codex/auth.json"));
  assert.deepEqual(io.requests.map(r => r.url), [CODEX_USAGE]);
  // Only the two constant questions ran there, and only once for both providers.
  assert.deepEqual(io.execs.map(e => e.slice(0, 2)).sort(), [["printenv", "HOME"], ["uname", "-s"]]);
  assert.ok(io.execs.every(e => e.at(-1) === "splinter"));
  noSecrets(result);
});

test("a remote Mac's Keychain sign-in is reported, never read or prompted for", async () => {
  const io = fakeIo({ machines: { mini: { home: "/Users/will", os: "Darwin", files: {} } } });
  const result = await read(io, ["mini"]);
  const claude = result.report.providers.find(p => p.id === "claude");
  assert.equal(claude.status, "keychain"); assert.equal(claude.machine, "mini");
  assert.ok(!io.execs.some(([cmd]) => cmd.includes("security")));
  assert.equal(io.requests.length, 0);
  assert.equal(result.failed, null);
});

test("a remote Claude file sign-in is read like this computer's", async () => {
  const io = fakeIo({ machines: { box: { home: "/home/w", os: "Linux", files: { "/home/w/.claude/.credentials.json": claudeFile } } },
    routes: { "https://api.anthropic.com/api/oauth/usage": [200, claudeBody] } });
  const result = await read(io, ["box"]);
  const claude = result.report.providers.find(p => p.id === "claude");
  assert.equal(claude.plan, "max"); assert.equal(claude.windows.length, 2); assert.equal(claude.machine, "box");
  noSecrets(result);
});

test("an offline or unsupported machine is quiet: no error, no backoff", async () => {
  const io = fakeIo({ machines: { win: { home: "/c/Users/w", os: null } }, offline: ["gone"] });
  const result = await read(io, ["gone", "win"]);
  assert.equal(result.failed, null);
  assert.deepEqual(result.report.providers, []);
  assert.deepEqual(result.read, []);
});

test("machine names that aren't Herdr's are never used", () => {
  assert.deepEqual(remoteAdapters(["ok-1", "../x", "a b", "", null]).map(a => a.id), ["claude@ok-1", "codex@ok-1"]);
});

const local = parseReport(JSON.stringify({ schemaVersion: 5, generatedAt: iso(now), providers: [
  { provider: "codex", accountKeys: ["codex-home"], state: { status: "fresh" }, windows: [{ id: "five_hour", kind: "session", label: "session", percentUsed: 78, windowSeconds: 18000, resetsAt: iso(now + 3600000) }] },
] }), now);
const remote = normalizeReport({ schemaVersion: 5, generatedAt: iso(now), providers: [
  { provider: "codex", machine: "splinter", accountKeys: ["codex-home"], state: { status: "fresh" }, windows: [{ id: "five_hour", kind: "session", label: "session", percentUsed: 42, windowSeconds: 18000, resetsAt: iso(now + 3600000) }] },
] }, now);
const both = mergeReport(local, remote, false);

test("local and remote lanes of one provider merge, target and forget independently", () => {
  assert.equal(both.providers.length, 2);
  // A local read of Codex replaces only this computer's lane.
  assert.equal(mergeReport(both, local, false).providers.length, 2);
  assert.deepEqual(targets(both), ["codex"]);
  const gone = forgetRemote(both, { message: "x", providers: ["codex", "codex@splinter"] });
  assert.deepEqual(gone.data.providers.map(p => p.machine), [null]);
  assert.deepEqual(gone.error.providers, ["codex"]);
  // Off, or the machine gone: a sweep forgets that machine's reading.
  assert.equal(forgetUnreadable(both, null, new Set(["codex"])).data.providers.length, 1);
});

test("consent is only the Settings switch's own record", () => {
  for (const record of [undefined, null, true, { on: true }, { v: 1, on: "true" }, { v: 2, on: true }]) assert.equal(consented(record), false);
  assert.equal(consented({ v: 1, on: true, at: 1 }), true);
});

test("a remote lane owns its machine's sessions; this computer's lane keeps the rest", () => {
  const live = [{ address: "t1", space: "s1", program: { key: "codex" }, status: "working" }, { address: "splinter/t2", space: "s2", program: { key: "codex" }, status: "idle" }];
  const list = catalog(both, [], live, [{ id: "s1" }, { id: "s2", machine: "splinter" }], options());
  const here = list.find(p => !p.machine), there = list.find(p => p.machine === "splinter");
  assert.deepEqual(here.sessions.map(a => a.address), ["t1"]);
  assert.deepEqual(there.sessions.map(a => a.address), ["splinter/t2"]);
  assert.equal(here.multiAccount, false); assert.equal(there.multiAccount, false);
});

function find(tree, id) { let match; walk(tree, n => { if (n.styles.id?.[0] === id) match = n; }); return match; }
const pane = { pane: "p1", terminal: "splinter/t1", program: { key: "codex", name: "Codex", agent: true } };

test("a remote pane header shows that machine's own reading once remote reads are on", async () => {
  const host = await createHost({ mode: "header", data: both, runtime: { pane: "p1" }, paneList: [pane] });
  host.state[`${PREFIX}.remote`] = { v: 1, on: true };
  const text = flatten(host.tree());
  assert.match(text, /on splinter · 5h 42%/); assert.doesNotMatch(text, /78%/);
  const mine = await createHost({ mode: "header", data: both, runtime: { pane: "p1" }, paneList: [{ ...pane, terminal: "t1" }] });
  assert.match(flatten(mine.tree()), /5h 78%/);
});

test("with remote reads off, the header says so and leads to the setting", async () => {
  const host = await createHost({ mode: "header", data: local, runtime: { pane: "p1" }, paneList: [pane] });
  const button = find(host.tree(), "quota-for-p1");
  assert.match(flatten(button), /on splinter · quota off/);
  assert.match(button.styles.tooltip[0], /Click to see why/);
  button.events.click({}, host.cx);
  assert.equal(host.overlays[0].props.page, "configure"); assert.equal(host.overlays[0].props.section, "remote");
});

test("the setting explains itself, reads on consent, and forgets on withdrawal", async () => {
  const host = await createHost({ data: both, runtime: { section: "remote" }, spaceList: [{ id: "s2", machine: "splinter" }] });
  host.view.page = "configure";
  const text = flatten(host.tree());
  // Called out first when opened from a header.
  assert.ok(text.indexOf("other machines") < text.indexOf("status bar"));
  assert.match(text, /Show quota from other machines/); assert.match(text, /never saved, logged or sent anywhere else/);
  find(host.tree(), "remote-quota").events.click({}, host.cx);
  assert.ok(consented(host.state[`${PREFIX}.remote`]));
  // Turning it on reads at once, as its own command: never a Refresh's Keychain prompt.
  assert.ok(host.commands.some(c => c[0] === "agent-quota.remote"));
  assert.ok(!host.commands.some(c => c[0] === "agent-quota.refresh"));
  assert.match(flatten(host.tree()), /On · reading splinter/);
  find(host.tree(), "remote-quota").events.click({}, host.cx);
  assert.equal(consented(host.state[`${PREFIX}.remote`]), false);
  assert.deepEqual(host.state[`${PREFIX}.data`].providers.map(p => p.machine), [null]);
});

test("a read with remote reads on asks each connected machine; off, it asks none", async () => {
  const run = async remoteOn => {
    const execs = [];
    const host = await createHost({ spaceList: [{ id: "s1" }, { id: "s2", machine: "splinter" }],
      runner: async (cmd, args, opts) => { execs.push([cmd, opts?.on]); return cmd === "printenv" ? { code: 0, stdout: "/home/will\n" } : { code: 0, stdout: "Linux\n" }; },
      remoteFiles: { splinter: { "/home/will/.codex/auth.json": codexAuth } },
      fetcher: async url => ({ status: 200, ok: true, url, json: async () => codexBody }) });
    host.state[`${PREFIX}.remote`] = remoteOn ? { v: 1, on: true } : null;
    host.view.tick(host.cx, { force: true });
    await host.tasks.at(-1)(host.cx);
    return { execs, host };
  };
  const on = await run(true);
  assert.ok(on.execs.every(([, where]) => where === "splinter") && on.execs.length === 2);
  const lane = on.host.state[`${PREFIX}.data`].providers.find(p => p.machine === "splinter" && p.id === "codex");
  assert.equal(lane.windows.find(w => w.kind === "session").percentUsed, 42);
  noSecrets(on.host.state);
  const off = await run(false);
  assert.equal(off.execs.length, 0);
  assert.ok(!(off.host.state[`${PREFIX}.data`]?.providers ?? []).some(p => p.machine));
});

test("layout props and options saved by older builds never grant remote reads", async () => {
  assert.equal(options({ remote: true }, { remote: true }).remote, false);
  // An older build copied every layout prop into saved options; that `remote: true` is ignored.
  const execs = [];
  const host = await createHost({ runtime: { remote: true }, spaceList: [{ id: "s2", machine: "splinter" }],
    runner: async (cmd, args, opts) => { execs.push(opts?.on); return { code: 0, stdout: "x" }; } });
  host.state[`${PREFIX}.options`] = { remote: true };
  host.view.tick(host.cx, { force: true });
  await host.tasks.at(-1)(host.cx);
  assert.equal(execs.length, 0);
  assert.match(flatten(host.tree()), /other machines show activity only/);
});

test("turning the switch off mid-read drops what that read brought back", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const host = await createHost({ spaceList: [{ id: "s2", machine: "splinter" }],
    runner: async cmd => { await gate; return cmd === "printenv" ? { code: 0, stdout: "/home/will\n" } : { code: 0, stdout: "Linux\n" }; },
    remoteFiles: { splinter: { "/home/will/.codex/auth.json": codexAuth } },
    fetcher: async url => ({ status: 200, ok: true, url, json: async () => codexBody }) });
  host.state[`${PREFIX}.remote`] = { v: 1, on: true };
  host.view.tick(host.cx, { force: true });
  const work = host.tasks.at(-1)(host.cx);
  await new Promise(r => setImmediate(r));
  host.view.setRemote(false);
  release();
  await work;
  assert.ok(!(host.state[`${PREFIX}.data`]?.providers ?? []).some(p => p.machine));
  assert.ok(!JSON.stringify(host.state[`${PREFIX}.error`] ?? null).includes("@"));
});

test("a failing machine never backs off this computer's reads, and is bounded in time", async () => {
  const io = fakeIo({ machines: { splinter: { home: "/home/will", os: "Linux", files: { "/home/will/.codex/auth.json": codexAuth } } },
    routes: { [CODEX_USAGE]: [500, {}] } });
  const result = await read(io, ["splinter"]);
  assert.ok(result.failed.ids.includes("codex@splinter")); assert.equal(result.failed.backoff, false);
  // A machine that never answers is cut off at its own short limit.
  const slow = { ...fakeIo(), exec: () => new Promise(() => {}), sleep: ms => unref(Math.min(ms, 20)) };
  const started = Date.now(), late = await read(slow, ["stuck"]);
  assert.ok(Date.now() - started < 2000); assert.equal(late.failed.backoff, false);
});

test("a remote file read that fails keeps the earlier reading instead of showing a sign-out", async () => {
  const io = fakeIo({ machines: { splinter: { home: "/home/will", os: "Linux", files: {} } } });
  const flaky = { ...io, readTextFile: async () => { throw new Error("connection dropped"); } };
  const result = await read(flaky, ["splinter"]);
  assert.deepEqual(result.report.providers, []); assert.equal(result.failed, null);
});

test("hiding another machine's lane keeps this computer's", async () => {
  const host = await createHost({ data: both });
  host.state[`${PREFIX}.options`] = { hidden: ["codex@splinter"] };
  const text = flatten(host.tree());
  assert.match(text, /78%/); assert.doesNotMatch(text, /42%/);
});

test("a sign-in file that would forge request headers is refused before anything is sent", async () => {
  for (const bad of [`${TOKEN}\r\nX-Evil: 1`, `${TOKEN}\u010aX-Evil: 1`, `${TOKEN}\u2028`]) {
  const forged = JSON.stringify({ tokens: { access_token: bad, account_id: "acct" } });
  const io = fakeIo({ machines: { splinter: { home: "/home/will", os: "Linux", files: { "/home/will/.codex/auth.json": forged } } },
    routes: { [CODEX_USAGE]: [200, codexBody] } });
  const result = await read(io, ["splinter"]);
  assert.equal(io.requests.length, 0);
  assert.ok(result.failed.ids.includes("codex@splinter"));
  noSecrets(result);
  }
});

test("a home folder answer with anything but plain path characters is never used", async () => {
  for (const home of ["/home/$(id)", "/home/a;b", "/home/../etc", "relative", "/home/a b"]) {
    const io = fakeIo({ machines: { box: { home, os: "Linux", files: {} } } });
    const result = await read(io, ["box"]);
    assert.equal(io.reads.length, 0, home); assert.equal(result.failed, null, home);
  }
});
