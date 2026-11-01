import test from "node:test";
import assert from "node:assert/strict";
import * as grok from "../mods/agent-quota/providers/grok.js";
import { ReadFailure } from "../mods/agent-quota/providers/common.js";
// quota-axi's own normalizer and pace: the native port must name and measure limits the same way.
import { normalizeGrokConsumerPayload } from "../node_modules/quota-axi/dist/src/providers/grok.js";
import { computeWindowPace } from "../node_modules/quota-axi/dist/src/pace.js";

const now = Date.parse("2026-10-31T12:00:00Z");
const TOKEN = "tok-SECRET-123", PI_TOKEN = "pi-SECRET-456";
const iso = ms => new Date(ms).toISOString();
const QUOTA = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
const BUILD_MODELS = "https://cli-chat-proxy.grok.com/v1/models";
const XAI_MODELS = "https://api.x.ai/v1/models";
const GROK_AUTH = "/Users/tester/.grok/auth.json", PI_AUTH = "/Users/tester/.pi/agent/auth.json";
const XAI_HOSTS = new Set(["grok.com", "cli-chat-proxy.grok.com", "api.x.ai"]);

// ---- A tiny protobuf / gRPC-web writer for vendor answers.
function varint(n) {
  let v = BigInt(n); const out = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return out;
}
const field = (n, wire, bytes) => [...varint(n * 8 + wire), ...(wire === 2 ? varint(bytes.length) : []), ...bytes];
const f32 = v => { const b = Buffer.alloc(4); b.writeFloatLE(v); return [...b]; };
const msg = (...parts) => parts.flat();
const ts = ms => field(1, 0, varint(Math.floor(ms / 1000)));
function config({ shared, products = [], period, prepaid } = {}) {
  const body = msg(
    shared === undefined ? [] : field(1, 5, f32(shared)),
    ...products.map(([n, used]) => field(7, 2, msg(field(1, 0, varint(n)), used === undefined ? [] : field(2, 5, f32(used))))),
    period ? field(8, 2, msg(field(1, 0, varint(period.type)), period.start === undefined ? [] : field(2, 2, ts(period.start)), period.end === undefined ? [] : field(3, 2, ts(period.end)))) : [],
    prepaid === undefined ? [] : field(12, 2, field(1, 0, varint(prepaid))),
  );
  return Uint8Array.from(field(1, 2, body));
}
const frame = (flags, bytes) => [flags, ...[24, 16, 8, 0].map(s => (bytes.length >>> s) & 255), ...bytes];
const trailer = text => frame(0x80, [...Buffer.from(text)]);
const b64 = bytes => Buffer.from(Uint8Array.from(bytes)).toString("base64");
// Data and trailer frames base64'd separately, as gRPC-web-text servers may stream them.
const answer = (payload, status = "grpc-status:0\r\n") => b64(frame(0, [...payload])) + b64(trailer(status));

const week = { type: 2, start: now - 2 * 86400000, end: now + 5 * 86400000 };
const body = config({ shared: 42.5, products: [[2, 12.34], [4, 0], [9, 77.7]], period: week, prepaid: 1500 });

function fakeIo({ files = {}, routes = {}, hang = false } = {}) {
  const requests = [];
  return {
    requests, now, platform: "macos", home: () => "/Users/tester",
    readTextFile: async path => files[path] ?? null,
    exec: async () => { throw new Error("grok never runs a program"); },
    sleep: ms => new Promise(resolve => setTimeout(resolve, hang ? 5 : ms)),
    fetch: (url, init) => {
      requests.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body });
      if (hang) return new Promise(() => {});
      const route = routes[url];
      if (!route) return Promise.reject(new Error("offline"));
      const [status, text] = typeof route === "function" ? route() : route;
      return Promise.resolve({ status, ok: status >= 200 && status < 300, url, json: async () => JSON.parse(text), text: async () => text });
    },
  };
}
const signIn = (extra = {}) => JSON.stringify({ "https://accounts.x.ai/sign-in": { key: TOKEN, email: "person@example.com", refresh_token: "REFRESH-SECRET", ...extra } });
const oidc = (extra = {}) => JSON.stringify({ "https://auth.x.ai::grok-cli": { key: TOKEN, auth_mode: "oidc", refresh_token: "REFRESH-SECRET", expires_at: iso(now + 3600000), ...extra } });
const noSecrets = value => { const text = JSON.stringify(value); assert.ok(!/SECRET|example\.com/.test(text), "a credential or address leaked into the result"); };
const failsWith = reason => e => e instanceof ReadFailure && (reason === undefined || e.message === reason) && !e.message.includes("SECRET");

test("grok reads the CLI sign-in, posts one empty gRPC-web-text call and names windows like quota-axi", async () => {
  const io = fakeIo({ files: { [GROK_AUTH]: signIn() }, routes: { [QUOTA]: [200, answer(body)] } });
  const lane = await grok.read(io);
  assert.equal(io.requests.length, 1);
  const [r] = io.requests;
  assert.equal(r.method, "POST"); assert.equal(r.body, "AAAAAAA="); assert.equal(r.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(r.headers["content-type"], "application/grpc-web-text+proto");
  assert.equal(lane.provider, "grok"); assert.equal(lane.state.status, "fresh"); assert.equal(lane.plan, null);
  assert.deepEqual(lane.accountKeys, ["default"]); assert.deepEqual(lane.untrustedWindowIds, []);
  assert.deepEqual(lane.windows.map(w => [w.id, w.label, w.kind, w.windowSeconds, w.resetsAt]), [
    ["credits", "week", "weekly", null, iso(week.end)], ["product:grok_build", "Grok Build", "weekly", null, iso(week.end)],
    ["product:chat", "Chat", "weekly", null, iso(week.end)], ["product:unknown_9", "Product 9", "weekly", null, iso(week.end)]]);
  assert.equal(lane.windows[0].percentUsed, 42.5);
  assert.ok(Math.abs(lane.windows[1].percentUsed - 12.34) < 1e-5); // exact float, as quota-axi keeps it
  // Pace runs over the billing period's own start and end: 2 of 7 days gone.
  assert.equal(lane.windows[0].pace.status, "ahead"); assert.equal(lane.windows[0].pace.timeRemainingPercent, 71.4286);
  noSecrets(lane);
});

test("grok: missing or unusable sign-ins are signed out; API keys are never sent to grok.com", async () => {
  const missing = fakeIo();
  assert.equal((await grok.read(missing)).state.status, "auth_required");
  assert.equal(missing.requests.length, 0);
  const junk = fakeIo({ files: { [GROK_AUTH]: "{not json", [PI_AUTH]: JSON.stringify({ other: {} }) } });
  assert.equal((await grok.read(junk)).state.status, "auth_required");
  const apiKeyOnly = fakeIo({ files: { [GROK_AUTH]: JSON.stringify({ "https://api.x.ai": { key: TOKEN } }) } });
  const lane = await grok.read(apiKeyOnly);
  assert.equal(lane.state.status, "auth_required"); assert.equal(lane.windows.length, 0); assert.equal(apiKeyOnly.requests.length, 0);
});

test("grok: a refused sign-in is signed out, unless the model catalog says it still works", async () => {
  const files = { [GROK_AUTH]: signIn() };
  const plain = fakeIo({ files, routes: { [QUOTA]: [401, ""] } });
  assert.equal((await grok.read(plain)).state.status, "auth_required");
  assert.deepEqual(plain.requests.map(r => r.url), [QUOTA]); // no probe for a web sign-in, no refresh endpoint
  // A gRPC Unauthenticated trailer is a refusal too.
  assert.equal((await grok.read(fakeIo({ files, routes: { [QUOTA]: [200, b64(trailer("grpc-status:16\r\n"))] } }))).state.status, "auth_required");
  assert.equal((await grok.read(fakeIo({ files, routes: { [QUOTA]: [200, b64(trailer("grpc-status:7\r\ngrpc-message:invalid%20token\r\n"))] } }))).state.status, "auth_required");
  // Grok Build OIDC: refused by billing, refused by the catalog -> signed out; live -> kept, stale.
  const dead = fakeIo({ files: { [GROK_AUTH]: oidc() }, routes: { [QUOTA]: [403, ""], [BUILD_MODELS]: [401, ""] } });
  assert.equal((await grok.read(dead)).state.status, "auth_required");
  assert.deepEqual(dead.requests.map(r => [r.method, r.url]), [["POST", QUOTA], ["GET", BUILD_MODELS]]);
  await assert.rejects(grok.read(fakeIo({ files: { [GROK_AUTH]: oidc() }, routes: { [QUOTA]: [403, ""], [BUILD_MODELS]: [200, "{}"] } })), failsWith("no-quota"));
  // An expired session with a refresh token is never refreshed here: earlier readings stay.
  const expired = fakeIo({ files: { [GROK_AUTH]: oidc({ expires_at: iso(now - 1000) }) }, routes: { [QUOTA]: [401, ""], [BUILD_MODELS]: [401, ""] } });
  await assert.rejects(grok.read(expired), failsWith("expired"));
  assert.deepEqual(expired.requests.map(r => r.url), [QUOTA, BUILD_MODELS]);
  // A stored expiry is advisory: the endpoint decides.
  assert.equal((await grok.read(fakeIo({ files: { [GROK_AUTH]: oidc({ expires_at: iso(now - 1000) }) }, routes: { [QUOTA]: [200, answer(body)] } }))).state.status, "fresh");
});

test("grok tries valid sign-ins before expired ones, then Pi's xAI sign-in", async () => {
  const two = JSON.stringify({ "https://accounts.x.ai/sign-in": { key: "old-SECRET", expires_at: iso(now - 1) }, "grok.com": { key: TOKEN } });
  const io = fakeIo({ files: { [GROK_AUTH]: two }, routes: { [QUOTA]: () => [200, answer(body)] } });
  await grok.read(io);
  assert.deepEqual(io.requests.map(r => r.headers.Authorization), [`Bearer ${TOKEN}`]);
  // Pi's OAuth access token reads the same credits; its refresh token is never used.
  const pi = JSON.stringify({ xai: { type: "oauth", access: PI_TOKEN, refresh: "REFRESH-SECRET", expires: now + 3600000 } });
  const viaPi = fakeIo({ files: { [GROK_AUTH]: signIn(), [PI_AUTH]: pi }, routes: { [QUOTA]: () => viaPi.requests.at(-1).headers.Authorization.includes(PI_TOKEN) ? [200, answer(body)] : [401, ""] } });
  const lane = await grok.read(viaPi);
  assert.equal(lane.state.status, "fresh"); assert.equal(viaPi.requests.length, 2);
  // Refused Pi token that still lists models: not signed out.
  await assert.rejects(grok.read(fakeIo({ files: { [PI_AUTH]: pi }, routes: { [QUOTA]: [401, ""], [XAI_MODELS]: [200, "{}"] } })), failsWith("no-quota"));
  // A Pi xAI API key works for models but has no consumer credits; nothing is sent.
  const key = fakeIo({ files: { [PI_AUTH]: JSON.stringify({ xai: { type: "api_key", key: PI_TOKEN } }) } });
  await assert.rejects(grok.read(key), failsWith("no-quota"));
  assert.equal(key.requests.length, 0);
  // An expired Pi token with a refresh token: kept, stale.
  const old = JSON.stringify({ xai: { type: "oauth", access: PI_TOKEN, refresh: "REFRESH-SECRET", expires: now - 1 } });
  await assert.rejects(grok.read(fakeIo({ files: { [PI_AUTH]: old }, routes: { [QUOTA]: [401, ""], [XAI_MODELS]: [401, ""] } })), failsWith("expired"));
  // Pi references are never resolved.
  assert.equal((await grok.read(fakeIo({ files: { [PI_AUTH]: JSON.stringify({ xai: { type: "api_key", key: "$XAI_API_KEY" } }) } }))).state.status, "auth_required");
});

test("grok: outages, rate limits and odd answers keep earlier readings", async () => {
  const files = { [GROK_AUTH]: signIn() };
  const routes = [[500, ""], [429, ""], [200, "@@@ not base64 ünïcode"], [200, b64([1, 2, 3])],
    [200, answer(Uint8Array.from(field(1, 2, [])))], [200, b64(trailer("grpc-status:8\r\n"))], [200, b64(trailer("grpc-status:13\r\n"))],
    [200, answer(body, "grpc-status:99\r\n")]];
  for (const route of routes) await assert.rejects(grok.read(fakeIo({ files, routes: { [QUOTA]: route } })), failsWith(), JSON.stringify(route));
  await assert.rejects(grok.read(fakeIo({ files, routes: { [QUOTA]: [429, ""] } })), failsWith("rate-limited"));
  await assert.rejects(grok.read(fakeIo({ files })), failsWith("unreachable")); // offline
  await assert.rejects(grok.read(fakeIo({ files, hang: true })), failsWith("unreachable"));
  const moved = fakeIo({ files, routes: { [QUOTA]: [200, answer(body)] } });
  const real = moved.fetch; moved.fetch = (u, o) => real(u, o).then(r => ({ ...r, url: "https://evil.example/q" }));
  await assert.rejects(grok.read(moved), failsWith("redirected"));
  // A transient failure stops the tries: the next sign-in is not spent on it.
  const two = fakeIo({ files: { [GROK_AUTH]: signIn(), [PI_AUTH]: JSON.stringify({ xai: { type: "oauth", access: PI_TOKEN } }) }, routes: { [QUOTA]: [500, ""] } });
  await assert.rejects(grok.read(two), failsWith("server"));
  assert.equal(two.requests.length, 1);
});

test("grok never puts a token in output or errors, or sends one off xAI's hosts", async () => {
  const pi = JSON.stringify({ xai: { type: "oauth", access: PI_TOKEN } });
  const all = [];
  for (const routes of [{ [QUOTA]: [200, answer(body)] }, { [QUOTA]: [401, ""], [BUILD_MODELS]: [401, ""], [XAI_MODELS]: [401, ""] }, { [QUOTA]: [500, ""] }, {}]) {
    const io = fakeIo({ files: { [GROK_AUTH]: oidc(), [PI_AUTH]: pi }, routes });
    try { noSecrets(await grok.read(io)); } catch (e) { assert.ok(e instanceof ReadFailure, String(e)); noSecrets({ m: e.message, s: String(e.stack) }); }
    all.push(...io.requests);
  }
  assert.ok(all.length > 0);
  for (const r of all) assert.ok(XAI_HOSTS.has(new URL(r.url).hostname), r.url);
});

// Differential: the same vendor payload through quota-axi's normalizer and the native port.
test("grok's windows match quota-axi's normalizer, pace included", () => {
  const payloads = [
    body,
    config({ shared: 0, period: { type: 1, start: now - 10 * 86400000, end: now + 20 * 86400000 } }),
    config({ products: [[1, 120], [3, -4], [5, 33.3], [6, 99.99]] }), // no period: credits windows, clamped
    config({ period: week, products: [[0], [2]] }), // valid period: missing figures count as zero
    config({ shared: 5, period: { type: 0, start: now - 1000, end: now + 1000 } }),
    config({ shared: 50, period: { type: 2, start: now + 3600000, end: now + 8 * 86400000 } }), // cycle not started
    config({ shared: 50, period: { type: 2, end: now + 86400000 } }), // no start: not a valid period
  ];
  const shape = w => [w.id, w.label, w.kind, w.percentUsed, w.resetsAt ?? null, w.windowSeconds ?? null];
  for (const payload of payloads) {
    const axi = normalizeGrokConsumerPayload(payload).windows, mine = grok.usageWindows(payload, now);
    assert.deepEqual(mine.map(shape), axi.map(shape));
    axi.forEach((w, i) => {
      const pace = computeWindowPace(w, iso(now));
      assert.equal(mine[i].pace.status, pace.status);
      assert.equal(mine[i].pace.timeRemainingPercent, pace.timeRemainingPercent ?? null);
    });
  }
  // Answers quota-axi rejects, the port rejects too.
  for (const bad of [config({ products: [[2]] }), Uint8Array.from([0x0a]), Uint8Array.from(field(1, 2, field(12, 2, field(1, 0, varint(2n ** 60n))).concat(field(1, 5, f32(1))))), Uint8Array.from(field(1, 2, field(1, 5, f32(NaN))))]) {
    assert.throws(() => normalizeGrokConsumerPayload(bad));
    assert.throws(() => grok.usageWindows(bad, now), ReadFailure);
  }
});
// grok.com sends a refused sign-in "trailers-only" (status in headers, empty body), as it did for
// an unauthenticated probe on 2026-10-31. The models check decides instead of a stale failure.
test("an empty gRPC answer is a refused sign-in, settled by the models check", async () => {
  const signedOut = await grok.read(fakeIo({ files: { [GROK_AUTH]: oidc() }, routes: { [QUOTA]: [200, ""], [BUILD_MODELS]: [401, "{}"] } }));
  assert.equal(signedOut.state.status, "auth_required");
  await assert.rejects(grok.read(fakeIo({ files: { [GROK_AUTH]: oidc() }, routes: { [QUOTA]: [200, ""], [BUILD_MODELS]: [200, "{}"] } })), failsWith());
});
