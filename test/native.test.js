import test from "node:test";
import assert from "node:assert/strict";
import * as claude from "../mods/agent-quota/providers/claude.js";
import * as codex from "../mods/agent-quota/providers/codex.js";
import { ReadFailure, jwtPayload, windowPace } from "../mods/agent-quota/providers/common.js";
import { collect } from "../mods/agent-quota/collector.js";
import { normalizeReport, PREFIX } from "../mods/agent-quota/core.js";
import { createHost } from "./host.js";
// quota-axi's own normalizers: the native ports must name and measure limits the same way.
import { normalizeClaudeApiUsage } from "../node_modules/quota-axi/dist/src/providers/claude.js";
import { normalizeCodexUsage } from "../node_modules/quota-axi/dist/src/providers/codex.js";

const now = Date.parse("2026-10-31T12:00:00Z");
const TOKEN = "tok-SECRET-123";
const iso = ms => new Date(ms).toISOString();
const jwt = payload => `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;

// A fake Herdr: files, a Keychain answer, and a fetch that records each request.
function fakeIo({ files = {}, keychain = null, platform = "macos", routes = {}, hang = false } = {}) {
  const requests = [], execs = [];
  return {
    requests, execs, now, platform, home: () => "/Users/tester",
    readTextFile: async path => files[path] ?? null,
    exec: async (cmd, args) => { execs.push([cmd, ...args]); return keychain === null ? { code: 44, stdout: "", stderr: "not found" } : { code: 0, stdout: keychain, stderr: "" }; },
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
const CLAUDE_USAGE = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_OLD = "https://chatgpt.com/backend-api/codex/usage";
const claudeSecret = (extra = {}) => JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, refreshToken: "REFRESH-SECRET", expiresAt: now + 365 * 86400000, subscriptionType: "pro", ...extra } });
const claudeBody = {
  five_hour: { utilization: 29.4, resets_at: iso(now + 2 * 3600000) },
  seven_day: { utilization: 36, resets_at: iso(now + 4 * 86400000) },
  seven_day_opus: null,
  extra_usage: { is_enabled: true, used_credits: 1250, monthly_limit: 5000, decimal_places: 2 },
};
const codexAuth = (extra = {}) => JSON.stringify({ tokens: { access_token: TOKEN, refresh_token: "REFRESH-SECRET", id_token: jwt({ "https://api.openai.com/auth/account_id": "acct-1" }), ...extra } });
const codexBody = {
  plan_type: "plus",
  rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: Math.floor(now / 1000) + 18000 },
    secondary_window: { used_percent: 13, limit_window_seconds: 604800, reset_after_seconds: 400000 } },
  code_review_rate_limit: { primary_window: { used_percent: 50, limit_window_seconds: 7200, reset_at: Math.floor(now / 1000) + 3600 } },
  additional_rate_limits: [{ metered_feature: "gpt-preview", limit_name: "GPT Preview", rate_limit: { primary_window: { used_percent: 70, limit_window_seconds: 18000, reset_at: Math.floor(now / 1000) + 900 } } }],
};
const noSecrets = value => { const text = JSON.stringify(value); assert.ok(!text.includes("SECRET"), "a credential leaked into the result"); };

test("claude reads its Keychain sign-in and reports quota-axi's limit ids", async () => {
  const io = fakeIo({ keychain: claudeSecret(), routes: { [CLAUDE_USAGE]: [200, claudeBody] } });
  const lane = await claude.read(io);
  assert.deepEqual(io.execs[0], ["/usr/bin/security", "find-generic-password", "-s", "Claude Code-credentials", "-a", "tester", "-w"]);
  assert.equal(io.requests.length, 1);
  assert.equal(io.requests[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(lane.state.status, "fresh"); assert.equal(lane.plan, "pro"); assert.deepEqual(lane.accountKeys, ["default"]);
  assert.deepEqual(lane.windows.map(w => [w.id, w.kind, w.percentUsed, w.windowSeconds]), [["five_hour", "session", 29, 18000], ["seven_day", "weekly", 36, 604800], ["extra_usage", "credits", 25, null]]);
  noSecrets(lane);
});
test("claude falls back to the credentials file off macOS and never refreshes an expired token", async () => {
  const file = "/Users/tester/.claude/.credentials.json";
  const lane = await claude.read(fakeIo({ platform: "linux", files: { [file]: claudeSecret() }, routes: { [CLAUDE_USAGE]: [200, claudeBody] } }));
  assert.equal(lane.windows.length, 3);
  // A stored expiry is advisory: the endpoint decides, and nothing is refreshed.
  const old = { [file]: claudeSecret({ expiresAt: now - 1 }) };
  assert.equal((await claude.read(fakeIo({ platform: "linux", files: old, routes: { [CLAUDE_USAGE]: [200, claudeBody] } }))).state.status, "fresh");
  const refused = fakeIo({ platform: "linux", files: old, routes: { [CLAUDE_USAGE]: [401, {}] } });
  await assert.rejects(claude.read(refused), e => e instanceof ReadFailure && e.message === "expired"); // earlier readings stay
  assert.deepEqual(refused.requests.map(r => r.url), [CLAUDE_USAGE]); // no refresh endpoint
  const missing = fakeIo({ platform: "linux" });
  assert.equal((await claude.read(missing)).state.status, "auth_required");
});
test("claude: a rejected token is signed out; outages and odd answers keep earlier readings", async () => {
  assert.equal((await claude.read(fakeIo({ keychain: claudeSecret(), routes: { [CLAUDE_USAGE]: [401, {}] } }))).state.status, "auth_required");
  for (const route of [[500, {}], [429, {}], [200, { unexpected: true }], [200, new Error("bad json")]]) {
    await assert.rejects(claude.read(fakeIo({ keychain: claudeSecret(), routes: { [CLAUDE_USAGE]: route } })), e => e instanceof ReadFailure && !e.message.includes("SECRET"));
  }
  await assert.rejects(claude.read(fakeIo({ keychain: claudeSecret() })), ReadFailure); // offline
  // An answer that arrived through a redirect to another host is never used.
  const moved = fakeIo({ keychain: claudeSecret(), routes: { [CLAUDE_USAGE]: [200, claudeBody] } });
  const real = moved.fetch; moved.fetch = (u, o) => real(u, o).then(r => ({ ...r, url: "https://evil.example/usage" }));
  await assert.rejects(claude.read(moved), e => e instanceof ReadFailure && e.message === "redirected");
  await assert.rejects(claude.read(fakeIo({ keychain: claudeSecret(), hang: true })), e => e instanceof ReadFailure && e.message === "unreachable");
});
test("claude's model-scoped limits list wins over the fixed fields", async () => {
  const body = { ...claudeBody, limits: [
    { group: "session", percent: 10, resets_at: iso(now + 3600000) },
    { group: "weekly", percent: 20, resets_at: iso(now + 86400000) },
    { percent: 40, resets_at: iso(now + 86400000), scope: { model: { display_name: "Claude Fable" } } },
    { percent: 5, kind: "mystery" },
    { percent: 6, scope: { model: { display_name: "someone@example.com" } }, kind: "x@y" }, // never stored as a name
  ] };
  const lane = await claude.read(fakeIo({ keychain: claudeSecret(), routes: { [CLAUDE_USAGE]: [200, body] } }));
  assert.deepEqual(lane.windows.map(w => [w.id, w.label, w.kind]), [["five_hour", "session", "session"], ["seven_day", "week", "weekly"],
    ["model:claude_fable", "Claude Fable week", "model"], ["mystery", "mystery", "unknown"], ["limit", "limit", "unknown"], ["extra_usage", "extra usage", "credits"]]);
});

test("codex reads auth.json, sends its account id and names every window like quota-axi", async () => {
  const io = fakeIo({ files: { "/Users/tester/.codex/auth.json": codexAuth() }, routes: { [CODEX_USAGE]: [200, codexBody] } });
  const lane = await codex.read(io);
  assert.equal(io.requests[0].headers["ChatGPT-Account-Id"], "acct-1");
  assert.deepEqual(lane.accountKeys, ["codex-home"]); assert.equal(lane.plan, "plus");
  assert.deepEqual(lane.windows.map(w => [w.id, w.kind, w.percentUsed]), [["five_hour", "session", 0], ["weekly", "weekly", 13],
    ["code_review_window:2h", "unknown", 50], ["model:gpt-preview:5h", "model", 70]]);
  assert.equal(lane.windows[1].resetsAt, iso(now + 400000 * 1000));
  noSecrets(lane);
});
test("codex tries the older endpoint, and is signed out only when both refuse the token", async () => {
  const files = { "/Users/tester/.codex/auth.json": codexAuth() };
  const fallback = await codex.read(fakeIo({ files, routes: { [CODEX_USAGE]: [404, {}], [CODEX_OLD]: [200, codexBody] } }));
  assert.equal(fallback.windows[0].id, "five_hour");
  assert.equal((await codex.read(fakeIo({ files, routes: { [CODEX_USAGE]: [401, {}], [CODEX_OLD]: [403, {}] } }))).state.status, "auth_required");
  await assert.rejects(codex.read(fakeIo({ files, routes: { [CODEX_USAGE]: [401, {}], [CODEX_OLD]: [500, {}] } })), ReadFailure);
  await assert.rejects(codex.read(fakeIo({ files, routes: { [CODEX_USAGE]: [429, {}], [CODEX_OLD]: [200, codexBody] } })), ReadFailure);
  assert.equal((await codex.read(fakeIo())).state.status, "auth_required");
});

// Differential: the same vendor answer through quota-axi's normalizer and the native port.
const shape = w => ({ id: w.id, label: w.label, kind: w.kind, percentUsed: w.percentUsed ?? null, windowSeconds: w.windowSeconds ?? null, resetsAt: w.resetsAt ? Date.parse(w.resetsAt) : null });
test("native windows match quota-axi's for the same Claude and Codex answers", () => {
  const claudeScoped = { ...claudeBody, limits: [{ group: "session", percent: 10.6, resets_at: iso(now + 3600000) }, { percent: 40, scope: { model: { id: "fable-1", display_name: "Fable" } } }] };
  for (const body of [claudeBody, claudeScoped, { seven_day_opus: { utilization: 3 } }]) {
    assert.deepEqual(claude.usageWindows(body, now).map(shape), normalizeClaudeApiUsage(body, "pro").windows.map(shape));
  }
  const spend = { spend_control: { reached: false, individual_limit: { limit: 200, used: 50, remaining: 150, reset_at: Math.floor(now / 1000) + 99 } } };
  const camel = { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 60 } },
    rateLimitsByLimitId: { x: { limitName: "Model X", primary: { usedPercent: 1, windowDurationMins: 10080 } } } };
  for (const body of [codexBody, spend, camel]) {
    // quota-axi stamps reset_after_seconds from its own clock; compare the rest exactly.
    const axi = normalizeCodexUsage(body).windows.map(shape), mine = codex.usageWindows(body, now).map(shape);
    assert.deepEqual(mine.map(w => ({ ...w, resetsAt: null })), axi.map(w => ({ ...w, resetsAt: null })));
    mine.forEach((w, i) => assert.ok(w.resetsAt === null ? axi[i].resetsAt === null : Math.abs(w.resetsAt - axi[i].resetsAt) < 86400000 * 400));
  }
});
test("pace follows quota-axi: within a point is on pace, less headroom than time is ahead", () => {
  const w = { percentUsed: 50, resetsAt: iso(now + 0.5 * 18000000), windowSeconds: 18000 };
  assert.equal(windowPace(w, now).status, "on_pace");
  assert.equal(windowPace({ ...w, percentUsed: 60 }, now).status, "ahead");
  assert.equal(windowPace({ ...w, percentUsed: 30 }, now).status, "behind");
  assert.equal(windowPace({ ...w, percentUsed: null }, now).status, "unknown");
  assert.equal(windowPace({ ...w, resetsAt: iso(now + 99 * 18000000) }, now).status, "unknown"); // not started
  // An unused window the server restarted a few seconds after the read began is on pace.
  assert.equal(windowPace({ percentUsed: 0, resetsAt: iso(now + 18000000 + 4000), windowSeconds: 18000 }, now).status, "on_pace");
  assert.equal(windowPace(w, now).timeRemainingPercent, 50);
  assert.equal(jwtPayload(jwt({ a: "é" })).a, "é");
  assert.equal(jwtPayload("not-a-jwt"), undefined);
});

// The collector: every provider read natively, side by side, one report.
function routedIo(extra = {}) {
  const runs = [];
  const io = { ...fakeIo({ keychain: claudeSecret(), files: { "/Users/tester/.codex/auth.json": codexAuth() }, routes: { [CLAUDE_USAGE]: [200, claudeBody], [CODEX_USAGE]: [200, codexBody] }, ...extra }),
    adapters: [claude, codex] };
  io.exec = async (cmd, args) => { runs.push([cmd, ...args]); return cmd === "/usr/bin/security" ? { code: 0, stdout: claudeSecret(), stderr: "" } : { code: 127, stdout: "", stderr: "" }; };
  return { io, runs };
}
test("a sweep reads every provider natively; only Claude's Keychain lookup runs a program", async () => {
  const { io, runs } = routedIo();
  const result = await collect(io, now, null);
  assert.ok(runs.every(r => r[0] === "/usr/bin/security"));
  assert.equal(result.swept, true); assert.equal(result.read, null); assert.equal(result.failed, null);
  assert.deepEqual(result.report.providers.map(p => [p.id, p.status, p.windows.length]), [["claude", "fresh", 3], ["codex", "fresh", 4]]);
  noSecrets(result);
  const targeted = await collect(routedIo().io, now, ["codex"]);
  assert.deepEqual(targeted.read, ["codex"]); assert.equal(targeted.swept, false);
});
test("one provider failing keeps the others' readings and marks only itself stale", async () => {
  const { io } = routedIo({ routes: { [CODEX_USAGE]: [200, codexBody] } }); // Claude offline
  const result = await collect(io, now, ["claude", "codex"]);
  assert.deepEqual(result.read, ["codex"]);
  assert.deepEqual(result.failed.ids, ["claude"]);
  assert.match(result.failed.message, /^Claude: quota could not be read/);
  assert.equal(result.swept, false);
  const down = routedIo({ routes: {} }).io;
  await assert.rejects(collect(down, now, ["claude", "codex"]), /could not be read/);
});
test("a malformed answer from one provider fails only that provider", async () => {
  const twins = { id: "agy", label: "Antigravity", read: async () => ({ provider: "agy", accountKeys: ["default"], state: { status: "fresh" },
    windows: [{ id: "gemini_5h", label: "a", kind: "session", percentUsed: 1 }, { id: "gemini_5h", label: "b", kind: "session", percentUsed: 2 }] }) };
  const { io } = routedIo(); io.adapters = [claude, twins];
  const result = await collect(io, now, null);
  assert.deepEqual(result.read, ["claude"]); assert.deepEqual(result.failed.ids, ["agy"]);
});
test("a provider with nothing to read now is neither a failure nor a reason to drop its reading", async () => {
  const closed = { id: "agy", label: "Antigravity", read: async () => { throw new ReadFailure("not-running"); } };
  const { io } = routedIo(); io.adapters = [claude, closed];
  const result = await collect(io, now, null);
  assert.equal(result.failed, null);
  assert.equal(result.swept, false); // a sweep that skipped one keeps that provider's earlier reading
  assert.deepEqual(result.read, ["claude"]);
});
test("a failure's hint is only given when every failed provider shares it", async () => {
  const needs = (id, label, reason) => ({ id, label, read: async () => { throw new ReadFailure(reason); } });
  const ok = { id: "codex", label: "Codex", read: async () => codex.read(routedIo().io) };
  const mixed = await collect({ ...routedIo().io, adapters: [needs("claude", "Claude", "keychain"), needs("agy", "Antigravity", "discovery"), ok] }, now, null);
  assert.doesNotMatch(mixed.failed.message, /Keychain/);
  const same = await collect({ ...routedIo().io, adapters: [needs("claude", "Claude", "keychain"), ok] }, now, null);
  assert.match(same.failed.message, /^Claude: needs one Keychain approval/);
});
test("a native read through the strip stores no credential and keeps a failed provider's reading", async () => {
  const before = normalizeReport({ schemaVersion: 5, generatedAt: iso(now - 600000), providers: [
    { provider: "claude", accountKeys: ["default"], state: { status: "fresh" }, windows: [{ id: "five_hour", label: "session", kind: "session", percentUsed: 5 }] }] }, now);
  const fetcher = async url => url === CODEX_USAGE ? { status: 200, ok: true, json: async () => codexBody } : Promise.reject(new Error("offline"));
  // Both sign-ins Claude Code might use (Keychain through exec, or the file), so the read reaches
  // the network on any platform; the Codex sign-in is a file.
  const files = { "/home/tester/.codex/auth.json": codexAuth(), "/home/tester/.claude/.credentials.json": claudeSecret() };
  const host = await createHost({ mode: "strip", data: before, adapters: [claude, codex], fetcher, files,
    runner: async () => ({ code: 0, stdout: claudeSecret(), stderr: "" }) });
  host.view.runtime = {};
  host.view.tick(host.cx, { force: true });
  await host.tasks.splice(-1)[0](host.cx);
  const stored = JSON.stringify(host.state);
  assert.ok(!stored.includes("SECRET"));
  const claudeLane = host.state[`${PREFIX}.data`].providers.find(p => p.id === "claude");
  assert.equal(claudeLane.windows[0].percentUsed, 5); // the earlier reading stays
  const stale = host.state[`${PREFIX}.error`].providers;
  assert.ok(stale.includes("claude") && !stale.includes("codex"));
});

test("a background read never opens a Keychain prompt; a Refresh may, and the grant is remembered", async () => {
  const blocked = fakeIo({ keychain: claudeSecret(), routes: { [CLAUDE_USAGE]: [200, claudeBody] } });
  blocked.keychain = { allowed: false, granted: false };
  await assert.rejects(claude.read(blocked), e => e instanceof ReadFailure && e.message === "keychain");
  assert.equal(blocked.execs.length, 0);
  const asked = fakeIo({ keychain: claudeSecret(), routes: { [CLAUDE_USAGE]: [200, claudeBody] } });
  asked.keychain = { allowed: true, granted: false };
  assert.equal((await claude.read(asked)).state.status, "fresh");
  assert.equal(asked.keychain.granted, true);
  // Denied (not "no such item"): no second lookup without the account.
  const denied = fakeIo({ routes: { [CLAUDE_USAGE]: [200, claudeBody] } });
  denied.exec = async (cmd, args) => { denied.execs.push(args); return { code: 51, stdout: "", stderr: "" }; };
  assert.equal((await claude.read(denied)).state.status, "auth_required");
  assert.equal(denied.execs.length, 1);
});
test("native reads that outlast the read's deadline are given up as failures", async () => {
  const { io } = routedIo({ hang: true });
  io.sleep = () => Promise.resolve(); // the deadline arrives at once
  const result = await collect(io, now, ["claude", "codex"], now + 3000).catch(e => e);
  assert.match(String(result.message), /could not be read/);
});
test("a denied Keychain read forgets that provider's grant", async () => {
  const io = fakeIo({ routes: { [CLAUDE_USAGE]: [200, claudeBody] } });
  io.keychain = { allowed: true, granted: false, denied: false };
  io.exec = async () => ({ code: 51, stdout: "", stderr: "" });
  assert.equal((await claude.read(io)).state.status, "auth_required");
  assert.equal(io.keychain.denied, true); assert.equal(io.keychain.granted, false);
});
test("the strip backs off after a provider fails and remembers a Keychain grant", async () => {
  const fetcher = async url => url === CODEX_USAGE ? { status: 200, ok: true, json: async () => codexBody } : Promise.reject(new Error("offline"));
  const files = { "/home/tester/.codex/auth.json": codexAuth() };
  const host = await createHost({ mode: "strip", data: null, adapters: [claude, codex], fetcher, files,
    runner: async () => ({ code: 0, stdout: claudeSecret(), stderr: "" }) });
  host.view.runtime = {};
  host.view.tick(host.cx, { force: true });
  await host.tasks.splice(-1)[0](host.cx);
  const control = host.state[`${PREFIX}.control`];
  assert.equal(control.failures, 1); // Claude failed: back off, as a failed read does
  assert.deepEqual(control.keychains, ["claude"]); // the manual read read Claude's item: no prompt next time, for it alone
  assert.ok(control.sweptAt > 0);
});
