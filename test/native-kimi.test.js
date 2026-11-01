import test from "node:test";
import assert from "node:assert/strict";
import * as kimi from "../mods/agent-quota/providers/kimi.js";
import { ReadFailure } from "../mods/agent-quota/providers/common.js";
import { normalizeReport } from "../mods/agent-quota/core.js";
// quota-axi's own Kimi reader: the port must name, measure and classify limits the same way.
import { normalizeKimiPayload, createKimiAdapter } from "../node_modules/quota-axi/dist/src/providers/kimi.js";
import { createPiKimiCredentialBroker } from "../node_modules/quota-axi/dist/src/providers/pi-kimi-credential.js";
import { createKimiCodeCliCredentialSource } from "../node_modules/quota-axi/dist/src/providers/kimi-code-cli-credential.js";

const now = Date.parse("2026-10-31T12:00:00Z");
const TOKEN = "tok-SECRET-kimi";
const HOME = "/Users/tester";
const PI = `${HOME}/.pi/agent/auth.json`;
const CONFIG = `${HOME}/.kimi-code/config.toml`;
const CLI = `${HOME}/.kimi-code/credentials/kimi-code.json`;
const USAGES = "https://api.kimi.com/coding/v1/usages";
const USAGES_AI = "https://api.kimi.ai/coding/v1/usages";
const iso = ms => new Date(ms).toISOString();

function fakeIo({ files = {}, routes = {}, hang = false, redirect = null } = {}) {
  const requests = [], reads = [];
  return {
    requests, reads, now, platform: "macos", home: () => HOME,
    readTextFile: async path => { reads.push(path); const f = files[path]; if (f instanceof Error) throw f; return f ?? null; },
    exec: async () => { throw new Error("kimi must not run programs"); },
    sleep: ms => new Promise(resolve => setTimeout(resolve, hang ? 5 : ms)),
    fetch: (url, init) => {
      requests.push({ url, ...init });
      if (hang) return new Promise(() => {});
      const route = routes[url];
      if (!route) return Promise.reject(new Error("offline"));
      const [status, body] = typeof route === "function" ? route() : route;
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return Promise.resolve({ status, ok: status >= 200 && status < 300, url: redirect ?? url, json: async () => JSON.parse(text), text: async () => text });
    },
  };
}
const piApiKey = (extra = {}) => JSON.stringify({ "kimi-coding": { type: "api_key", key: TOKEN, ...extra } });
const piOauth = (extra = {}) => JSON.stringify({ "kimi-coding": { type: "oauth", access: TOKEN, refresh: "REFRESH-SECRET", expires: now + 3600000, ...extra } });
const cliCred = (extra = {}) => JSON.stringify({ access_token: TOKEN, refresh_token: "REFRESH-SECRET", expires_at: now / 1000 + 3600, ...extra });
const body = {
  usage: { limit: "100", used: "92", resetTime: iso(now + 4 * 86400000) },
  limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", remaining: "70", resetTime: iso(now + 3600000) } }],
  usages: {
    limit_7d: { used_ratio: 0, reset_at: iso(now + 4 * 86400000) },
    limit_month_total: { used_ratio: 0.873, reset_at: "2026-11-15T00:00:00+08:00" },
    limit_month_code: { used_ratio: 0.57 },
  },
  goods_version: 3,
};
const noSecrets = value => { const text = JSON.stringify(value); assert.ok(!text.includes("SECRET"), "a credential leaked into the result"); };
const shape = w => ({ id: w.id, label: w.label, kind: w.kind, percentUsed: w.percentUsed ?? null, windowSeconds: w.windowSeconds ?? null, resetsAt: w.resetsAt ?? null, shareOf: w.shareOf ?? null });

test("kimi reads Pi's login first and reports quota-axi's limits, shares and percentages", async () => {
  const io = fakeIo({ files: { [PI]: piApiKey() }, routes: { [USAGES]: [200, body] } });
  const lane = await kimi.read(io);
  assert.deepEqual(io.requests.map(r => [r.url, r.method, r.headers.Authorization]), [[USAGES, "GET", `Bearer ${TOKEN}`]]);
  assert.equal(lane.provider, "kimi"); assert.equal(lane.state.status, "fresh"); assert.equal(lane.plan, null); assert.deepEqual(lane.accountKeys, ["default"]);
  assert.deepEqual(lane.windows.map(w => [w.id, w.kind, w.percentUsed, w.windowSeconds, w.shareOf ?? null]), [
    ["weekly", "weekly", 92, 604800, null], ["month_total", "monthly", 87.3, null, null], ["month_code", "monthly", 57, null, "month_total"], ["five_hour", "session", 30, 18000, null]]);
  assert.equal(lane.windows[1].resetsAt, "2026-11-14T16:00:00.000Z");
  assert.deepEqual(lane.untrustedWindowIds, []);
  // The mod keeps the share relation and the fractional percentage.
  const p = normalizeReport({ schemaVersion: 5, providers: [lane] }, now).providers[0];
  assert.equal(p.windows.find(w => w.id === "month_code").shareOf, "month_total");
  assert.equal(p.windows.find(w => w.id === "month_total").percentUsed, 87.3);
  noSecrets(lane);
});

test("kimi falls back to the Kimi Code CLI sign-in, and a global config sends it only to the .ai host", async () => {
  const io = fakeIo({ files: { [CLI]: cliCred() }, routes: { [USAGES]: [200, body] } });
  assert.equal((await kimi.read(io)).windows.length, 4);
  assert.deepEqual(io.requests.map(r => r.url), [USAGES]);
  const toml = `[providers."managed:kimi-code"]\napi_key = "sk-SECRET"\nbase_url = "https://api.kimi.ai/coding/v1/"\n[providers."managed:kimi-code".oauth]\nstorage = "file"\nkey = "oauth/kimi-code-abc123"\noauth_host = "https://auth.kimi.ai"\n`;
  const global = fakeIo({ files: { [CONFIG]: toml, [`${HOME}/.kimi-code/credentials/kimi-code-abc123.json`]: cliCred() }, routes: { [USAGES_AI]: [200, body] } });
  const lane = await kimi.read(global);
  assert.deepEqual(global.requests.map(r => r.url), [USAGES_AI]);
  assert.equal(lane.windows.length, 4); noSecrets(lane);
  // A config pairing the default slot with the .ai deployment names no real environment: no request.
  const mismatched = fakeIo({ files: { [CONFIG]: toml.replace("kimi-code-abc123", "kimi-code"), [CLI]: cliCred() }, routes: { [USAGES]: [200, body], [USAGES_AI]: [200, body] } });
  await assert.rejects(kimi.read(mismatched), e => e instanceof ReadFailure && e.message === "config");
  assert.equal(mismatched.requests.length, 0);
  // A key that would leave the credentials folder is refused.
  assert.equal(kimi.environment({ status: "read", text: `[providers."managed:kimi-code".oauth]\nkey = "oauth/../../x"\n` }).status, "invalid_config");
});

test("kimi without any sign-in, or with a rejected token, is signed out; it never refreshes", async () => {
  const none = fakeIo();
  const lane = await kimi.read(none);
  assert.equal(lane.state.status, "auth_required"); assert.deepEqual(lane.windows, []); assert.equal(none.requests.length, 0);
  const rejected = fakeIo({ files: { [PI]: piApiKey(), [CLI]: cliCred() }, routes: { [USAGES]: [401, {}] } });
  assert.equal((await kimi.read(rejected)).state.status, "auth_required");
  assert.deepEqual(rejected.requests.map(r => r.url), [USAGES, USAGES]); // both stores tried, no refresh endpoint
  // An expired token whose record can rotate is only expired: earlier readings stay.
  const soft = fakeIo({ files: { [PI]: piOauth({ expires: now - 1 }) }, routes: { [USAGES]: [403, {}] } });
  await assert.rejects(kimi.read(soft), e => e instanceof ReadFailure && e.message === "expired");
  const hard = fakeIo({ files: { [PI]: piOauth({ expires: now - 1, refresh: undefined }) }, routes: { [USAGES]: [401, {}] } });
  assert.equal((await kimi.read(hard)).state.status, "auth_required");
  // A reference instead of a literal secret is never resolved.
  assert.equal((await kimi.read(fakeIo({ files: { [PI]: piApiKey({ key: "$KIMI_KEY" }) }, routes: { [USAGES]: [200, body] } }))).state.status, "auth_required");
});

test("kimi: outages, rate limits, redirects and odd answers keep earlier readings", async () => {
  const files = { [PI]: piApiKey(), [CLI]: cliCred() };
  const fails = async (io, reason) => { await assert.rejects(kimi.read(io), e => e instanceof ReadFailure && e.message === reason); noSecrets(io.requests.map(r => r.url)); };
  await fails(fakeIo({ files }), "unreachable");
  await fails(fakeIo({ files, routes: { [USAGES]: [500, {}] } }), "server");
  await fails(fakeIo({ files, routes: { [USAGES]: [429, {}] } }), "rate-limited");
  await fails(fakeIo({ files, routes: { [USAGES]: [200, "<html>"] } }), "malformed");
  await fails(fakeIo({ files, routes: { [USAGES]: [200, { usage: { limit: 0 } }] } }), "malformed");
  await fails(fakeIo({ files, routes: { [USAGES]: [200, body] }, redirect: "https://evil.example/usages" }), "redirected");
  await fails(fakeIo({ files, hang: true }), "unreachable");
  // A request failure is not handed to the second store.
  const once = fakeIo({ files, routes: { [USAGES]: [500, {}] } });
  await assert.rejects(kimi.read(once));
  assert.equal(once.requests.length, 1);
});

test("kimi: a Free-tier answer is a fresh reading with no limits; unparsed limits are untrusted", async () => {
  const free = await kimi.read(fakeIo({ files: { [PI]: piApiKey() }, routes: { [USAGES]: [200, { usages: {}, goods_version: 1 }] } }));
  assert.equal(free.state.status, "fresh"); assert.deepEqual(free.windows, []);
  const partial = await kimi.read(fakeIo({ files: { [PI]: piApiKey() }, routes: { [USAGES]: [200, { usage: { limit: "x" }, usages: { limit_5h: { used_ratio: 0.5 }, limit_7d: { used_ratio: "bad" } } }] } }));
  assert.deepEqual(partial.windows.map(w => w.id), ["five_hour"]);
  assert.deepEqual(partial.untrustedWindowIds, ["usages:limit_7d", "usage"]);
});

// ---------------------------------------------------------------------------------------------
// Differential: the same vendor answers through quota-axi's reader and the port.

const payloads = [
  body,
  { usage: { limit: 3, remaining: 1, reset_at: "2026-11-01T00:00:00.5+05:30" }, limits: [
    { window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: 7, used: 2 } },
    { window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: 10, used: 11 } },
    { window: { duration: 1, timeUnit: "TIME_UNIT_DAY" }, detail: { limit: "1e2", used: "33.3" } },
    { detail: { limit: -1 } }, "junk"] },
  { usage: { limit: 100, used: 10 } },
  { usage: { limit: 100, used: 10 }, limits: {} },
  { usages: { limit_5h: { used_ratio: 1.5, resetTime: "2026-02-30T00:00:00Z" }, limit_7d: { used_ratio: "0.1234567" }, limit_month_total: null, other: 1 } },
  { usage: { limit: 100, used: 40, resetTime: iso(now + 9e6) }, usages: { limit_7d: { used_ratio: 0.4 } }, limits: [{ window: { duration: 18000, timeUnit: "TIME_UNIT_SECOND" }, detail: { limit: 1, used: 0 } }] },
  { usage: { limit: 100, used: 50 }, usages: { limit_7d: { used_ratio: 0.2, reset_at: iso(now + 5e6) } } },
  { usages: { limit_month_code: { used_ratio: 0.9 } }, usage: "nope" },
];
const axiShape = w => ({ ...shape(w), resetsAt: w.resetsAt ? Date.parse(w.resetsAt) : null });
const axiUntrusted = d => d.code === "detail_invalid" ? `limit:${d.index}` : d.code === "usage_detail_invalid" ? `usages:${d.key}` : d.code === "usage_invalid" ? "usage" : "limits";

test("kimi windows match quota-axi's normalizer for the same answers", () => {
  for (const payload of payloads) {
    const axi = normalizeKimiPayload(payload), mine = kimi.usageWindows(payload, now);
    assert.equal(axi.kind, "windows");
    assert.deepEqual(mine.windows.map(axiShape), axi.windows.map(axiShape), JSON.stringify(payload));
    assert.deepEqual(mine.untrusted, [...new Set(axi.diagnostics.map(axiUntrusted))]);
  }
  for (const empty of [{}, { usages: null, limits: [] }, { boosterWallet: {} }]) {
    assert.equal(normalizeKimiPayload(empty).kind, "no_quota");
    assert.deepEqual(kimi.usageWindows(empty, now), { empty: true });
  }
  for (const bad of [null, [], { usages: { limit_5h: {} } }, { unexpected: 1 }]) {
    assert.throws(() => normalizeKimiPayload(bad));
    assert.throws(() => kimi.usageWindows(bad, now), ReadFailure);
  }
});

// The whole read, quota-axi's adapter against the port: same files, same answers, same verdict.
function axiAdapter(files, route) {
  const readFile = async path => { if (!(path in files)) throw Object.assign(new Error("absent"), { code: "ENOENT" }); return Buffer.from(files[path]); };
  const environment = { HOME };
  const clock = () => now;
  return createKimiAdapter({
    broker: createPiKimiCredentialBroker({ environment, homeDirectory: () => HOME, readFile, now: clock }),
    cliCredentialSource: createKimiCodeCliCredentialSource({ environment, homeDirectory: () => HOME, now: clock, readFile, readConfigFile: readFile }),
    fetch: async url => { if (!route[url]) throw new TypeError("offline"); const [status, b] = route[url]; return new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } }); },
    readCachedProvider: () => undefined, deleteCachedProvider: () => {}, now: clock,
  });
}
test("kimi's whole read agrees with quota-axi's adapter on status and limits", async () => {
  const toml = `[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.ai/coding/v1"\noauth.key = "oauth/kimi-code-zz"\n`;
  const cases = [
    [{}, {}],
    [{ [PI]: piApiKey() }, { [USAGES]: [200, body] }],
    [{ [CLI]: cliCred() }, { [USAGES]: [200, body] }],
    [{ [PI]: piApiKey(), [CLI]: cliCred() }, { [USAGES]: [401, {}] }],
    [{ [PI]: piOauth({ expires: now - 1 }), [CLI]: cliCred() }, { [USAGES]: [401, {}] }],
    [{ [PI]: piOauth({ expires: now - 1, refresh: undefined }) }, { [USAGES]: [401, {}] }],
    [{ [PI]: piApiKey() }, { [USAGES]: [500, {}] }],
    [{ [PI]: piApiKey() }, { [USAGES]: [429, {}] }],
    [{ [PI]: piApiKey() }, { [USAGES]: [200, { usages: {} }] }],
    [{ [PI]: "{not json" , [CLI]: cliCred() }, { [USAGES]: [200, body] }],
    [{ [CONFIG]: toml, [`${HOME}/.kimi-code/credentials/kimi-code-zz.json`]: cliCred() }, { [USAGES_AI]: [200, body] }],
    [{ [CONFIG]: "[[broken", [CLI]: cliCred() }, { [USAGES]: [200, body] }],
    [{ [CLI]: cliCred({ expires_at: now / 1000 + 30 }) }, { [USAGES]: [401, {}] }],
  ];
  for (const [files, route] of cases) {
    const axi = await axiAdapter(files, route).fetchQuota({});
    let mine;
    try { mine = await kimi.read(fakeIo({ files, routes: route })); }
    catch (error) { mine = { failed: error.message }; }
    const label = JSON.stringify(Object.keys(files));
    if (axi.state.status === "fresh") {
      assert.equal(mine.state?.status, "fresh", label);
      assert.deepEqual(mine.windows.map(axiShape), axi.windows.map(axiShape), label);
      assert.deepEqual(mine.untrustedWindowIds, axi.state.untrustedWindowIds ?? [], label);
    } else if (axi.state.status === "auth_required") {
      assert.equal(mine.state?.status, "auth_required", label);
    } else {
      // Anything else is a failed read: the mod keeps its earlier reading.
      assert.ok(mine.failed, `${label}: quota-axi said ${axi.state.status}`);
      if (axi.state.authStatus === "expired_refreshable") assert.equal(mine.failed, "expired");
    }
  }
});
