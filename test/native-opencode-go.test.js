import test from "node:test";
import assert from "node:assert/strict";
import * as opencode from "../mods/agent-quota/providers/opencode-go.js";
import { ReadFailure } from "../mods/agent-quota/providers/common.js";
import { normalizeReport } from "../mods/agent-quota/core.js";
// quota-axi's own normalizer: the native port must name and measure limits the same way.
import { normalizeOpenCodeGoPayload, extractOpenCodeGoCredential } from "../node_modules/quota-axi/dist/src/providers/opencode-go.js";

const now = Date.parse("2026-10-31T12:00:00Z");
const KEY = "sk-SECRET-123";
const iso = ms => new Date(ms).toISOString();
const USAGE = "https://opencode.ai/zen/go/v1/usage";
const AUTH = "/Users/tester/.local/share/opencode/auth.json";
const DB = "/Users/tester/.local/share/opencode/opencode.db";

// A fake Herdr: files, a sqlite3 answer, and a fetch that records each request.
// `sqlite`: null = not installed, { code, stdout, stderr } otherwise.
function fakeIo({ files = {}, sqlite = { code: 1, stdout: "", stderr: `Error: unable to open database "${DB}": unable to open database file` }, platform = "macos", routes = {}, hang = false } = {}) {
  const requests = [], execs = [];
  return {
    requests, execs, now, platform, home: () => "/Users/tester",
    readTextFile: async path => { const f = files[path]; if (f instanceof Error) throw f; return f ?? null; },
    exec: async (cmd, args) => { execs.push([cmd, ...args]); if (sqlite === null) throw new Error("not installed"); return sqlite; },
    sleep: ms => new Promise(resolve => setTimeout(resolve, hang ? 5 : ms)),
    fetch: (url, init) => {
      requests.push({ url, headers: init?.headers ?? {} });
      if (hang) return new Promise(() => {});
      const route = routes[url];
      if (!route) return Promise.reject(new Error("offline"));
      const [status, body] = typeof route === "function" ? route() : route;
      return Promise.resolve({ status, ok: status >= 200 && status < 300, url, json: async () => (body instanceof Error ? Promise.reject(body) : body), text: async () => JSON.stringify(body) });
    },
  };
}
const authFile = (entry = { type: "api", key: KEY }, name = "opencode-go") => JSON.stringify({ [name]: entry });
const dbRow = value => ({ code: 0, stdout: `v${JSON.stringify(value)}\n`, stderr: "" });
const body = {
  rollingUsage: { usagePercent: 29.4, windowSeconds: 18000, resetInSec: 3600 },
  weeklyUsage: { usagePercent: 36, resetAt: iso(now + 4 * 86400000) },
  monthlyUsage: { percentRemaining: 87.6, resetAt: Math.floor(now / 1000) + 20 * 86400 },
};
const noSecrets = value => { const text = JSON.stringify(value); assert.ok(!text.includes("SECRET"), "a credential leaked into the result"); };
const shape = w => ({ id: w.id, label: w.label, kind: w.kind, percentUsed: w.percentUsed ?? null, windowSeconds: w.windowSeconds ?? null, resetsAt: w.resetsAt ? Date.parse(w.resetsAt) : null });

test("opencode-go reads auth.json and reports quota-axi's limit ids", async () => {
  const io = fakeIo({ files: { [AUTH]: authFile() }, routes: { [USAGE]: [200, body] } });
  const lane = await opencode.read(io);
  assert.equal(io.requests.length, 1);
  assert.equal(io.requests[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(lane.provider, "opencode-go"); assert.equal(lane.label, "OpenCode Go");
  assert.equal(lane.state.status, "fresh"); assert.equal(lane.plan, "OpenCode Go"); assert.deepEqual(lane.accountKeys, ["default"]);
  assert.deepEqual(lane.windows.map(w => [w.id, w.label, w.kind, w.percentUsed, w.windowSeconds, w.resetsAt]), [
    ["five_hour", "session", "session", 29, 18000, iso(now + 3600000)],
    ["weekly", "weekly", "weekly", 36, 604800, iso(now + 4 * 86400000)],
    ["monthly", "monthly", "monthly", 12, null, iso(now + 20 * 86400000)],
  ]);
  const report = normalizeReport({ schemaVersion: 5, generatedAt: iso(now), providers: [lane] }, now);
  assert.equal(report.providers[0].key, JSON.stringify(["opencode-go", "default"]));
  noSecrets(lane);
});

test("opencode-go prefers OpenCode 2.x's database, read-only through sqlite3", async () => {
  const io = fakeIo({ sqlite: dbRow({ type: "key", key: KEY }), files: { [AUTH]: authFile({ key: "other-SECRET" }) }, routes: { [USAGE]: [200, { ...body, plan: " Go Pro " }] } });
  const lane = await opencode.read(io);
  assert.equal(io.execs.length, 1);
  const [cmd, ...args] = io.execs[0];
  assert.equal(cmd, "/usr/bin/sqlite3");
  assert.deepEqual(args.slice(0, 6), ["-readonly", "-init", "/dev/null", "-list", "-noheader", DB]);
  assert.match(args[6], /integration_id = 'opencode-go'/);
  assert.equal(io.requests[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(lane.plan, "Go Pro");
  noSecrets(lane);
});

test("opencode-go: a refused database key falls back to auth.json; a refused last key signs out", async () => {
  let calls = 0;
  const io = fakeIo({ sqlite: dbRow({ type: "key", key: "db-SECRET" }), files: { [AUTH]: authFile() }, routes: { [USAGE]: () => (++calls === 1 ? [401, {}] : [200, body]) } });
  const lane = await opencode.read(io);
  assert.equal(lane.state.status, "fresh");
  assert.deepEqual(io.requests.map(r => r.headers.authorization), ["Bearer db-SECRET", `Bearer ${KEY}`]);
  const refused = fakeIo({ files: { [AUTH]: authFile() }, routes: { [USAGE]: [403, {}] } });
  const out = await opencode.read(refused);
  assert.equal(out.state.status, "auth_required"); assert.deepEqual(out.windows, []); assert.deepEqual(out.accountKeys, ["default"]);
  assert.deepEqual(refused.requests.map(r => r.url), [USAGE]); // no refresh, no other host
  noSecrets(out);
});

test("opencode-go: no sign-in anywhere is auth_required with no request", async () => {
  for (const io of [fakeIo(), fakeIo({ sqlite: null }), fakeIo({ sqlite: { code: 1, stdout: "", stderr: "Parse error: no such table: credential" } }),
    fakeIo({ sqlite: { code: 0, stdout: "", stderr: "" } }), fakeIo({ files: { [AUTH]: JSON.stringify({ anthropic: { key: KEY } }) } }), fakeIo({ platform: "windows" })]) {
    const lane = await opencode.read(io);
    assert.equal(lane.state.status, "auth_required"); assert.deepEqual(lane.windows, []);
    assert.equal(io.requests.length, 0);
  }
  // Windows has no known sqlite3 path; quota-axi's LOCALAPPDATA default is used for auth.json.
  const win = fakeIo({ platform: "windows", files: { "/Users/tester/AppData/Local/opencode/auth.json": authFile({ key: KEY }, "opencode") }, routes: { [USAGE]: [200, body] } });
  assert.equal((await opencode.read(win)).state.status, "fresh");
  assert.equal(win.execs.length, 0);
});

test("opencode-go: a present but unusable sign-in keeps earlier readings", async () => {
  const unusable = [
    fakeIo({ files: { [AUTH]: "{not json" } }),
    fakeIo({ files: { [AUTH]: authFile({ type: "oauth", refresh: "r-SECRET" }) } }),
    fakeIo({ files: { [AUTH]: authFile({ key: "$OPENCODE_KEY" }) } }),
    fakeIo({ files: { [AUTH]: new Error("EACCES") } }),
    fakeIo({ sqlite: dbRow({ type: "oauth", access: "a-SECRET" }) }),
    fakeIo({ sqlite: { code: 1, stdout: "", stderr: "Error: database is locked" } }),
  ];
  for (const io of unusable) {
    await assert.rejects(opencode.read(io), e => e instanceof ReadFailure && e.message === "credential" && !e.message.includes("SECRET"));
    assert.equal(io.requests.length, 0);
  }
});

test("opencode-go: outages, rate limits and odd answers keep earlier readings", async () => {
  const files = { [AUTH]: authFile() };
  const cases = [
    [fakeIo({ files }), "unreachable"],
    [fakeIo({ files, routes: { [USAGE]: [500, {}] } }), "server"],
    [fakeIo({ files, routes: { [USAGE]: [429, {}] } }), "rate-limited"],
    [fakeIo({ files, routes: { [USAGE]: [200, new Error("bad json")] } }), "malformed"],
    [fakeIo({ files, routes: { [USAGE]: [200, { hello: "world" }] } }), "malformed"],
    [fakeIo({ files, routes: { [USAGE]: [200, [1, 2]] } }), "malformed"],
  ];
  for (const [io, reason] of cases) await assert.rejects(opencode.read(io), e => e instanceof ReadFailure && e.message === reason && !e.message.includes("SECRET"));
  // A redirect to another host is never trusted.
  const moved = fakeIo({ files, routes: { [USAGE]: [200, body] } });
  const fetch = moved.fetch;
  moved.fetch = (url, init) => fetch(url, init).then(r => ({ ...r, url: "https://evil.example/usage" }));
  await assert.rejects(opencode.read(moved), e => e instanceof ReadFailure && e.message === "redirected");
});

test("opencode-go: a hung request times out", { timeout: 20000 }, async () => {
  await assert.rejects(opencode.read(fakeIo({ files: { [AUTH]: authFile() }, hang: true })), e => e instanceof ReadFailure);
});

test("native windows match quota-axi's for the same OpenCode Go answers", () => {
  const sec = Math.floor(now / 1000);
  const bodies = [
    body,
    // Nested usage, no duration: the rolling cap is not confirmed as the five-hour session.
    { usage: { rolling: { percent: 4.5, resetsAt: iso(now + 7200000) }, weekly: { usedPercent: 101, reset_at: sec + 86400 }, monthly: { remainingPercent: -3, nextResetTime: iso(now + 9e8) } } },
    // Rate-limited with no percent, a non-five-hour duration, an unparseable first reset field.
    { rollingUsage: { status: "Rate-Limited", window_seconds: 3600 }, weeklyUsage: { usagePercent: "12.5", resetsAt: "soon", resetAt: iso(now + 1000) }, monthlyUsage: { percent: 50, durationSeconds: 2592000, reset_in_sec: 99 } },
    // Duration without a reset, zero duration with a reset, a month with an end-of-month reset.
    { rollingUsage: { usagePercent: 0, windowSeconds: 0, resetInSec: 10 }, weeklyUsage: { percentUsed: 99.5, cycleSeconds: 604800 }, monthlyUsage: { percent: 1, resetAt: "2026-03-31T00:00:00Z" } },
    { weeklyUsage: { status: "ok" }, planName: "x@y.com" },
    {},
  ];
  for (const raw of bodies) {
    const axi = normalizeOpenCodeGoPayload(raw, now);
    assert.deepEqual(opencode.usageWindows(raw, now).map(shape), axi.windows.map(shape));
    if (axi.plan === "OpenCode Go" || axi.plan === "Go Pro") assert.equal(opencode.planName(raw), axi.plan);
  }
  // A plan name that isn't a plain short name is dropped rather than shared.
  assert.equal(opencode.planName({ planName: "x@y.com" }), null);
  assert.equal(opencode.planName({ plan: " Go Pro " }), normalizeOpenCodeGoPayload({ plan: " Go Pro " }, now).plan);
});

test("auth.json keys are picked the way quota-axi picks them", async () => {
  const roots = [
    { "opencode-go": { apiKey: KEY } }, { opencode: { api_key: KEY } }, { opencode: { access: KEY } }, { opencode: { token: KEY } },
    { "opencode-go": { key: "!cmd" }, opencode: { key: KEY } }, { "opencode-go": { key: "a\u0001b" } }, { opencode: "str" }, { other: {} },
  ];
  for (const root of roots) {
    const axi = extractOpenCodeGoCredential(root, AUTH);
    const io = fakeIo({ files: { [AUTH]: JSON.stringify(root) }, routes: { [USAGE]: [200, body] } });
    if (axi.status === "available") {
      assert.equal((await opencode.read(io)).state.status, "fresh");
      assert.equal(io.requests[0].headers.authorization, `Bearer ${axi.key}`);
    } else if (axi.status === "missing") assert.equal((await opencode.read(io)).state.status, "auth_required");
    else await assert.rejects(opencode.read(io), e => e instanceof ReadFailure && e.message === "credential");
  }
});
