import test from "node:test";
import assert from "node:assert/strict";
import * as cursor from "../mods/agent-quota/providers/cursor.js";
import { ReadFailure } from "../mods/agent-quota/providers/common.js";
import { normalizeReport } from "../mods/agent-quota/core.js";
// quota-axi's own normalizer and pace: the native port must name and measure limits the same way.
import { normalizeCursorUsage } from "../node_modules/quota-axi/dist/src/providers/cursor.js";
import { computeWindowPace } from "../node_modules/quota-axi/dist/src/pace.js";

const now = Date.parse("2026-10-31T12:00:00Z");
const TOKEN = "tok-SECRET-123", CLI_TOKEN = "cli-SECRET-456";
const iso = ms => new Date(ms).toISOString();
const HOME = "/Users/tester";
const DB = `${HOME}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
const LINUX_DB = `${HOME}/.config/Cursor/User/globalStorage/state.vscdb`;
const CLI_CONFIG = `${HOME}/.cursor/cli-config.json`;
const LINUX_AUTH = `${HOME}/.config/cursor/auth.json`;
const API = "https://api2.cursor.sh/aiserver.v1.DashboardService/";
const USAGE = `${API}GetCurrentPeriodUsage`, PLAN = `${API}GetPlanInfo`, SAND = `${API}GetSandUsageStatus`;

// sqlite3 -ascii output: unit separator between columns, record separator after rows.
const rows = entries => entries.map(([k, v]) => `${k}\x1f${v}\x1e`).join("");
const editorRows = (token = TOKEN) => rows([["cursorAuth/accessToken", token], ["cursorAuth/stripeMembershipType", "pro"]]);

// A fake Herdr: files, sqlite3 and security answers, and a fetch that records each request.
function fakeIo({ files = {}, sqlite = { code: 1, stdout: "", stderr: "Error: unable to open database \"x\": unable to open database file" },
  keychain = { code: 44, stdout: "", stderr: "not found" }, platform = "macos", routes = {}, hang = false, allowed } = {}) {
  const requests = [], execs = [];
  return {
    requests, execs, now, platform, home: () => HOME,
    ...(allowed === undefined ? {} : { keychain: { allowed, granted: false } }),
    readTextFile: async path => files[path] ?? null,
    exec: async (cmd, args) => {
      execs.push([cmd, ...args]);
      const answer = cmd === "/usr/bin/sqlite3" ? sqlite : cmd === "/usr/bin/security" ? keychain : null;
      if (answer instanceof Error || answer === null) throw answer ?? new Error("ENOENT");
      return typeof answer === "function" ? answer(args) : answer;
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, hang ? 5 : ms)),
    fetch: (url, init) => {
      requests.push({ url, method: init?.method, body: init?.body, headers: init?.headers ?? {} });
      if (hang) return new Promise(() => {});
      const route = routes[url];
      if (!route) return Promise.reject(new Error("offline"));
      const auth = init?.headers?.authorization;
      const [status, body] = typeof route === "function" ? route(auth) : route;
      return Promise.resolve({ status, ok: status >= 200 && status < 300, url, json: async () => (body instanceof Error ? Promise.reject(body) : body), text: async () => JSON.stringify(body) });
    },
  };
}
const cycleEnd = now + 12 * 86400000;
const usageBody = {
  billingCycleStart: String(now - 18 * 86400000), billingCycleEnd: String(cycleEnd),
  planUsage: { totalPercentUsed: 41.6, autoPercentUsed: 12.2, apiPercentUsed: 77 },
  spendLimitUsage: { individualLimit: 2000, individualRemaining: 1500 },
};
const planBody = { planInfo: { planName: "Pro", billingCycleEnd: String(cycleEnd) } };
const sandBody = { usagePercent: 33, currentPeriodStart: iso(now - 2 * 86400000), nextResetTimestampUtc: iso(now + 5 * 86400000) };
const ok = { [USAGE]: [200, usageBody], [PLAN]: [200, planBody], [SAND]: [200, sandBody] };
const cliConfig = JSON.stringify({ authInfo: { email: "someone@example.com", userId: "user-1" } });
const noSecrets = value => { const text = JSON.stringify(value); assert.ok(!text.includes("SECRET"), "a credential leaked"); assert.ok(!text.includes("@"), "an email leaked"); };

test("cursor reads the editor's state.vscdb read-only and reports quota-axi's limit ids", async () => {
  const io = fakeIo({ sqlite: { code: 0, stdout: editorRows(), stderr: "" }, routes: ok });
  const lane = await cursor.read(io);
  assert.equal(io.execs.length, 1);
  const [cmd, ...args] = io.execs[0];
  assert.equal(cmd, "/usr/bin/sqlite3");
  assert.deepEqual(args.slice(0, 3), ["-readonly", "-ascii", DB]);
  assert.ok(!args[3].includes("cachedEmail"), "the cached email is never read");
  assert.deepEqual(io.requests.map(r => [r.url, r.method, r.body]), [[USAGE, "POST", "{}"], [PLAN, "POST", "{}"], [SAND, "POST", "{}"]]);
  for (const r of io.requests) { assert.equal(r.headers.authorization, `Bearer ${TOKEN}`); assert.equal(r.headers["connect-protocol-version"], "1"); }
  assert.equal(lane.provider, "cursor"); assert.equal(lane.label, "Cursor");
  assert.equal(lane.state.status, "fresh"); assert.equal(lane.plan, "Pro"); assert.deepEqual(lane.accountKeys, ["default"]);
  assert.deepEqual(lane.windows.map(w => [w.id, w.kind, w.percentUsed, w.windowSeconds]), [["included_usage", "monthly", 42, null],
    ["auto_usage", "monthly", 12, null], ["api_usage", "monthly", 77, null], ["spend_limit", "credits", 25, null], ["grok_bot", "weekly", 33, null]]);
  assert.equal(lane.windows[0].resetsAt, iso(cycleEnd));
  // Monthly pools pace over the billing cycle: 12 of 30 days left with 58% left is behind pace.
  assert.equal(lane.windows[0].pace.status, "behind"); assert.equal(lane.windows[0].pace.timeRemainingPercent, 40);
  assert.equal(lane.windows[3].pace.status, "unknown");
  // The lane passes the mod's own schema check.
  const report = normalizeReport({ schemaVersion: 5, generatedAt: iso(now), providers: [lane] }, now);
  assert.equal(report.providers[0].windows.length, 5);
  assert.equal(io.keychain, undefined);
  noSecrets(lane);
});

test("cursor falls back to the CLI Keychain item when the editor store is absent", async () => {
  const io = fakeIo({ files: { [CLI_CONFIG]: cliConfig }, keychain: { code: 0, stdout: `${CLI_TOKEN}\n`, stderr: "" }, routes: ok, allowed: true });
  const lane = await cursor.read(io);
  assert.deepEqual(io.execs[1], ["/usr/bin/security", "find-generic-password", "-a", "cursor-user", "-s", "cursor-access-token", "-w"]);
  assert.equal(io.requests[0].headers.authorization, `Bearer ${CLI_TOKEN}`);
  assert.equal(io.keychain.granted, true);
  assert.equal(lane.state.status, "fresh"); assert.equal(lane.plan, "Pro");
  noSecrets(lane);
});

test("cursor tries the CLI token when Cursor refuses the editor's", async () => {
  const routes = Object.fromEntries(Object.entries(ok).map(([u, answer]) => [u, auth => auth === `Bearer ${TOKEN}` ? [401, {}] : answer]));
  const io = fakeIo({ sqlite: { code: 0, stdout: editorRows(), stderr: "" }, files: { [CLI_CONFIG]: cliConfig }, keychain: { code: 0, stdout: CLI_TOKEN, stderr: "" }, routes });
  assert.equal((await cursor.read(io)).state.status, "fresh");
  // Both refused: signed out, and no refresh or token-exchange endpoint was called.
  const refused = fakeIo({ sqlite: { code: 0, stdout: editorRows(), stderr: "" }, files: { [CLI_CONFIG]: cliConfig }, keychain: { code: 0, stdout: CLI_TOKEN, stderr: "" }, routes: { [USAGE]: [401, {}], [PLAN]: [401, {}], [SAND]: [401, {}] } });
  assert.equal((await cursor.read(refused)).state.status, "auth_required");
  assert.ok(refused.requests.every(r => [USAGE, PLAN, SAND].includes(r.url)));
});

test("cursor reads the CLI auth.json on Linux and the editor database at its XDG path", async () => {
  const cli = fakeIo({ platform: "linux", sqlite: new Error("ENOENT"), files: { [LINUX_AUTH]: JSON.stringify({ accessToken: ` ${CLI_TOKEN} `, refreshToken: "REFRESH-SECRET" }) }, routes: ok });
  const lane = await cursor.read(cli);
  assert.equal(cli.requests[0].headers.authorization, `Bearer ${CLI_TOKEN}`);
  assert.equal(lane.windows.length, 5);
  const editor = fakeIo({ platform: "linux", sqlite: { code: 0, stdout: editorRows(), stderr: "" }, routes: ok });
  await cursor.read(editor);
  assert.equal(editor.execs[0][3], LINUX_DB);
});

test("cursor without any sign-in is signed out, with no Keychain read and no request", async () => {
  for (const io of [fakeIo(), fakeIo({ allowed: false }), fakeIo({ platform: "linux" }), fakeIo({ platform: "windows" }),
    fakeIo({ sqlite: { code: 0, stdout: "", stderr: "" } }), fakeIo({ sqlite: new Error("ENOENT") })]) {
    const lane = await cursor.read(io);
    assert.equal(lane.state.status, "auth_required"); assert.deepEqual(lane.windows, []);
    assert.equal(io.requests.length, 0);
    assert.ok(io.execs.every(e => e[0] !== "/usr/bin/security"), "no CLI config, no Keychain lookup");
  }
});

test("cursor: a refused token is signed out", async () => {
  for (const status of [401, 403]) {
    const io = fakeIo({ sqlite: { code: 0, stdout: editorRows(), stderr: "" }, routes: { [USAGE]: [status, {}], [PLAN]: [status, {}], [SAND]: [status, {}] } });
    assert.equal((await cursor.read(io)).state.status, "auth_required");
  }
});

test("cursor never reads the Keychain secret without approval", async () => {
  // Item present, approval not given: a presence check only (no -w), then the approval message.
  const present = fakeIo({ files: { [CLI_CONFIG]: cliConfig }, keychain: args => ({ code: args.includes("-w") ? 0 : 0, stdout: args.includes("-w") ? CLI_TOKEN : "", stderr: "" }), routes: ok, allowed: false });
  await assert.rejects(cursor.read(present), e => e instanceof ReadFailure && e.message === "keychain");
  assert.ok(present.execs.every(e => !e.includes("-w")));
  assert.equal(present.requests.length, 0);
  // Item absent: signed out.
  const absent = fakeIo({ files: { [CLI_CONFIG]: cliConfig }, allowed: false });
  assert.equal((await cursor.read(absent)).state.status, "auth_required");
  // Approval allowed but the Keychain refuses: earlier readings stay.
  const denied = fakeIo({ files: { [CLI_CONFIG]: cliConfig }, keychain: { code: 51, stdout: "", stderr: "denied" }, allowed: true });
  await assert.rejects(cursor.read(denied), e => e instanceof ReadFailure && e.message === "keychain");
});

test("cursor: outages, odd answers and unreadable stores keep earlier readings", async () => {
  const sqlite = { code: 0, stdout: editorRows(), stderr: "" };
  for (const route of [[500, {}], [429, {}], [200, { unexpected: true }], [200, new Error("bad json")]]) {
    await assert.rejects(cursor.read(fakeIo({ sqlite, routes: { [USAGE]: route, [PLAN]: [200, planBody] } })), e => e instanceof ReadFailure && !e.message.includes("SECRET"));
  }
  await assert.rejects(cursor.read(fakeIo({ sqlite })), e => e instanceof ReadFailure && e.message === "unreachable"); // offline
  await assert.rejects(cursor.read(fakeIo({ sqlite, hang: true })), e => e instanceof ReadFailure && e.message === "unreachable");
  const moved = fakeIo({ sqlite, routes: ok });
  const real = moved.fetch; moved.fetch = (u, o) => real(u, o).then(r => ({ ...r, url: "https://evil.example/usage" }));
  await assert.rejects(cursor.read(moved), e => e instanceof ReadFailure && e.message === "redirected");
  // The plan and Grok Bot calls are optional, as in quota-axi.
  const partial = await cursor.read(fakeIo({ sqlite, routes: { [USAGE]: [200, usageBody], [PLAN]: [500, {}], [SAND]: [429, {}] } }));
  assert.deepEqual(partial.windows.map(w => w.id), ["included_usage", "auto_usage", "api_usage", "spend_limit"]);
  assert.equal(partial.plan, "pro"); // the editor's stored membership
  // A locked database or a broken CLI config may still hold a sign-in: not a sign-out.
  await assert.rejects(cursor.read(fakeIo({ sqlite: { code: 1, stdout: "", stderr: "Error: database is locked" } })), e => e instanceof ReadFailure && e.message === "unreadable");
  await assert.rejects(cursor.read(fakeIo({ files: { [CLI_CONFIG]: "{nope" } })), e => e instanceof ReadFailure && e.message === "unreadable");
});

test("cursor keeps credentials and vendor PII out of every result and error", async () => {
  const errors = [];
  const sqlite = { code: 0, stdout: editorRows(), stderr: "" };
  for (const routes of [{ [USAGE]: [500, { token: TOKEN }] }, { [USAGE]: [200, new Error(TOKEN)] }, {}]) {
    try { await cursor.read(fakeIo({ sqlite, routes })); } catch (e) { errors.push(String(e?.message), String(e?.stack)); }
  }
  assert.equal(errors.length, 6); assert.ok(errors.every(t => !t.includes("SECRET")));
  const named = await cursor.read(fakeIo({ sqlite, routes: { ...ok, [PLAN]: [200, { planInfo: { planName: "owner@example.com" } }] } }));
  assert.equal(named.plan, null);
  noSecrets(named);
});

// Differential: the same vendor answers through quota-axi's normalizer and the native port.
const shape = w => ({ id: w.id, label: w.label, kind: w.kind, percentUsed: w.percentUsed ?? null, windowSeconds: w.windowSeconds ?? null, resetsAt: w.resetsAt ? Date.parse(w.resetsAt) : null });
test("native windows, plan and pace match quota-axi's for the same Cursor answers", () => {
  const cases = [
    [usageBody, planBody, sandBody, "pro"],
    // Seconds and ISO times, no cycle start (a calendar month back from the 31st), plan by price.
    [{ billingCycleEnd: Math.floor(Date.parse("2026-12-31T00:00:00Z") / 1000), planUsage: { totalPercentUsed: "99.5" },
      spendLimitUsage: { individualLimit: 1000, individualUsed: 1250 } }, { planInfo: { price: "Ultra" } }, { usage_percent: 101, next_reset_timestamp_utc: "2026-11-02T00:00:00Z" }, undefined],
    // Cycle end only on the plan info; spend limit without usage; pooled enterprise Grok Bot.
    [{ planUsage: { autoPercentUsed: 0 }, spendLimitUsage: { individualLimit: 500 } }, { planInfo: { billingCycleEnd: iso(now + 86400000) } }, { usesPooledEnterpriseAllowance: true, usagePercent: 5 }, "free"],
    [{ planUsage: {} }, undefined, { usagePercent: 7 }, undefined],
    [{}, undefined, undefined, "pro"],
  ];
  for (const [usage, plan, sand, membership] of cases) {
    const axi = normalizeCursorUsage(usage, plan, { accessToken: "x", membershipType: membership }, sand);
    const mine = cursor.usageWindows(usage, plan, sand, now);
    assert.deepEqual(mine.map(shape), (axi?.windows ?? []).map(shape));
    if (axi) assert.equal(cursor.planName(plan, membership), axi.plan ?? null);
    (axi?.windows ?? []).forEach((w, i) => {
      const pace = computeWindowPace(w, iso(now));
      assert.equal(mine[i].pace.status, pace.status, w.id);
      if (pace.status !== "unknown") assert.equal(mine[i].pace.timeRemainingPercent, pace.timeRemainingPercent);
    });
  }
});
