import test from "node:test";
import assert from "node:assert/strict";
import * as grokbot from "../mods/agent-quota/providers/grokbot.js";
import * as cursor from "../mods/agent-quota/providers/cursor.js";
import { ReadFailure } from "../mods/agent-quota/providers/common.js";
import { normalizeReport } from "../mods/agent-quota/core.js";

const now = Date.parse("2026-11-12T12:00:00Z");
const TOKEN = "tok-SECRET-123", CLI_TOKEN = "cli-SECRET-456";
const iso = ms => new Date(ms).toISOString();
const HOME = "/home/tester";
const LINUX_DB = `${HOME}/.config/Cursor/User/globalStorage/state.vscdb`;
const LINUX_AUTH = `${HOME}/.config/cursor/auth.json`;
const SAND = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus";

const editorRows = (token = TOKEN) => `cursorAuth/accessToken\x1f${token}\x1ecursorAuth/stripeMembershipType\x1fpro\x1e`;
const editor = { code: 0, stdout: editorRows(), stderr: "" };
const noDb = { code: 1, stdout: "", stderr: "Error: unable to open database \"x\": unable to open database file" };

// A fake Herdr on Linux: files, sqlite3, and a fetch that records each request.
function fakeIo({ files = {}, sqlite = noDb, platform = "linux", routes = {}, hang = false } = {}) {
  const requests = [], execs = [];
  return {
    requests, execs, now, platform, home: () => HOME,
    readTextFile: async path => files[path] ?? null,
    exec: async (cmd, args) => {
      execs.push([cmd, ...args]);
      if (cmd !== "/usr/bin/sqlite3" || sqlite instanceof Error) throw sqlite instanceof Error ? sqlite : new Error("ENOENT");
      return sqlite;
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, hang ? 5 : ms)),
    fetch: (url, init) => {
      requests.push({ url, method: init?.method, body: init?.body, headers: init?.headers ?? {} });
      if (hang) return new Promise(() => {});
      const route = routes[url];
      if (!route) return Promise.reject(new Error("offline"));
      const [status, body] = typeof route === "function" ? route(init?.headers?.authorization) : route;
      return Promise.resolve({ status, ok: status >= 200 && status < 300, url, json: async () => (body instanceof Error ? Promise.reject(body) : body) });
    },
  };
}
const reset = now + 4 * 86400000;
const sandBody = { hasNonZeroIncludedLimit: true, usagePercent: 3.4, currentPeriodStart: iso(now - 3 * 86400000), nextResetTimestampUtc: iso(reset), grokPlanLabel: "SuperGrok" };
const noSecrets = value => { const text = JSON.stringify(value); assert.ok(!text.includes("SECRET"), "a credential leaked"); assert.ok(!text.includes("@"), "an email leaked"); };

test("grokbot reads Grok Bot's weekly allowance with the Cursor editor's sign-in", async () => {
  const io = fakeIo({ sqlite: editor, routes: { [SAND]: [200, sandBody] } });
  const lane = await grokbot.read(io);
  assert.equal(io.execs[0][5], LINUX_DB);
  assert.deepEqual(io.requests.map(r => [r.url, r.method, r.body]), [[SAND, "POST", "{}"]]);
  assert.equal(io.requests[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(lane.provider, "grokbot"); assert.equal(lane.label, "Grok Bot");
  assert.equal(lane.state.status, "fresh"); assert.equal(lane.plan, "SuperGrok");
  assert.deepEqual(lane.windows.map(w => [w.id, w.kind, w.percentUsed, w.resetsAt]), [["weekly", "weekly", 3, iso(reset)]]);
  // Pace runs over this week, from its start to its reset: 4 of 7 days left with 97% left is behind.
  assert.equal(lane.windows[0].pace.status, "behind");
  const report = normalizeReport({ schemaVersion: 5, generatedAt: iso(now), providers: [lane] }, now);
  assert.equal(report.providers[0].windows.length, 1);
  noSecrets(lane);
});

test("grokbot: an allowance with nothing used yet is 0%, not a missing reading", async () => {
  const { usagePercent, ...unused } = sandBody;
  const lane = await grokbot.read(fakeIo({ sqlite: editor, routes: { [SAND]: [200, unused] } }));
  assert.equal(lane.windows[0].percentUsed, 0);
  // Without the allowance flag a missing percentage stays missing: no window at all.
  assert.equal(grokbot.weeklyWindow({ nextResetTimestampUtc: iso(reset) }, now), undefined);
});

test("grokbot: a Cursor account without Grok Bot is read, with nothing to show", async () => {
  for (const body of [{}, { hasNonZeroIncludedLimit: false }, { usesPooledEnterpriseAllowance: true, usagePercent: 5, hasNonZeroIncludedLimit: true }]) {
    const lane = await grokbot.read(fakeIo({ sqlite: editor, routes: { [SAND]: [200, body] } }));
    assert.equal(lane.state.status, "fresh"); assert.deepEqual(lane.windows, []);
  }
});

test("grokbot without a Cursor sign-in is signed_out, with no request", async () => {
  for (const io of [fakeIo(), fakeIo({ sqlite: new Error("ENOENT") }), fakeIo({ sqlite: { code: 0, stdout: "", stderr: "" } }), fakeIo({ platform: "windows" })]) {
    const lane = await grokbot.read(io);
    assert.equal(lane.state.status, "signed_out"); assert.deepEqual(lane.windows, []);
    assert.equal(io.requests.length, 0);
  }
});

test("grokbot tries the Cursor CLI's token when the editor's is refused, and never refreshes", async () => {
  const files = { [LINUX_AUTH]: JSON.stringify({ accessToken: CLI_TOKEN, refreshToken: "REFRESH-SECRET" }) };
  const one = fakeIo({ sqlite: editor, files, routes: { [SAND]: auth => auth === `Bearer ${TOKEN}` ? [401, {}] : [200, sandBody] } });
  assert.equal((await grokbot.read(one)).state.status, "fresh");
  assert.deepEqual(one.requests.map(r => r.headers.authorization), [`Bearer ${TOKEN}`, `Bearer ${CLI_TOKEN}`]);
  // The CLI's auth.json alone is enough.
  assert.equal((await grokbot.read(fakeIo({ files, routes: { [SAND]: [200, sandBody] } }))).windows.length, 1);
  // Both refused: a sign-in to renew, and only the usage endpoint was called.
  const refused = fakeIo({ sqlite: editor, files, routes: { [SAND]: [403, {}] } });
  assert.equal((await grokbot.read(refused)).state.status, "auth_required");
  assert.ok(refused.requests.every(r => r.url === SAND));
});

test("grokbot: outages, odd answers and redirects keep earlier readings", async () => {
  for (const route of [[500, {}], [429, {}], [200, "nope"], [200, new Error("bad json")]]) {
    await assert.rejects(grokbot.read(fakeIo({ sqlite: editor, routes: { [SAND]: route } })), e => e instanceof ReadFailure && !e.message.includes("SECRET"));
  }
  await assert.rejects(grokbot.read(fakeIo({ sqlite: editor })), e => e instanceof ReadFailure && e.message === "unreachable");
  await assert.rejects(grokbot.read(fakeIo({ sqlite: editor, hang: true })), e => e instanceof ReadFailure && e.message === "unreachable");
  const moved = fakeIo({ sqlite: editor, routes: { [SAND]: [200, sandBody] } });
  const real = moved.fetch; moved.fetch = (u, o) => real(u, o).then(r => ({ ...r, url: "https://evil.example/usage" }));
  await assert.rejects(grokbot.read(moved), e => e instanceof ReadFailure && e.message === "redirected");
  // A locked editor database may still hold a sign-in: not a sign-out.
  await assert.rejects(grokbot.read(fakeIo({ sqlite: { code: 1, stdout: "", stderr: "Error: database is locked" } })), e => e instanceof ReadFailure && e.message === "unreadable");
});

test("grokbot keeps a plan name only when it is plain", async () => {
  const lane = await grokbot.read(fakeIo({ sqlite: editor, routes: { [SAND]: [200, { ...sandBody, grokPlanLabel: "owner@example.com" }] } }));
  assert.equal(lane.plan, null);
  noSecrets(lane);
});

// The window quota-axi drew under Cursor (its id and label aside) is the same reading.
test("grokbot's window matches the reading quota-axi put under Cursor", () => {
  for (const body of [sandBody, { usage_percent: 101, next_reset_timestamp_utc: "2026-11-14T00:00:00Z" }, { usagePercent: 7 }]) {
    const mine = grokbot.weeklyWindow(body, now), axi = cursor.usageWindows({}, undefined, body, now).find(w => w.id === "grok_bot");
    assert.deepEqual([mine.kind, mine.percentUsed, mine.resetsAt, mine.pace], [axi.kind, axi.percentUsed, axi.resetsAt, axi.pace]);
  }
});
