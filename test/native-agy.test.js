import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as agy from "../mods/agent-quota/providers/agy.js";
import { ReadFailure } from "../mods/agent-quota/providers/common.js";
import { normalizeReport } from "../mods/agent-quota/core.js";
// quota-axi's own reader and normalizers: the port must find, name and measure limits the same way.
import { fetchQuotaWithRuntime, normalizeAgyQuotaSummary, normalizeAgyUserStatus, processInfosFromPs, portsFromLsof } from "../node_modules/quota-axi/dist/src/providers/agy.js";

// quota-axi touches its cache only on failure; keep it out of the real one regardless.
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), "agy-test-"));

const now = Date.parse("2026-10-31T12:00:00Z");
const iso = ms => new Date(ms).toISOString();
const S = "/exa.language_server_pb.LanguageServerService/";
const SUMMARY = `${S}RetrieveUserQuotaSummary`, STATUS = `${S}GetUserStatus`, MODELS = `${S}GetCommandModelConfigs`, UNLEASH = `${S}GetUnleashData`;

const APP = "/Applications/Antigravity.app/Contents/Resources/app/extensions/antigravity/bin/language_server_macos_arm";
const appPs = `  101 ${APP} --csrf_token CSRF-SECRET-1 --extension_server_port 52000 --extension_server_csrf_token EXT-SECRET-2 --random_port\n  202 /usr/bin/vim notes.txt\n`;
const cliPs = "  303 node /Users/tester/.npm/lib/node_modules/antigravity-cli/mcp-server.cjs --stdio\n";
const lsof = list => `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n${list.map(p => `language_ 101 tester 20u IPv4 0x1 0t0 TCP 127.0.0.1:${p} (LISTEN)`).join("\n")}\n`;

const summaryBody = { response: { groups: [
  { displayName: "Gemini", buckets: [
    { bucketId: "gemini-weekly", remainingFraction: 0.88, resetTime: iso(now + 5 * 86400000) },
    { bucketId: "gemini-5h", remainingFraction: 0.594, resetTime: iso(now + 3 * 3600000) }] },
  { displayName: "Claude and GPT models", buckets: [
    { bucketId: "3p-5h", remaining: { case: "remainingFraction", value: 0.9 }, resetTime: iso(now + 3600000) },
    { bucketId: "3p-weekly", remaining_fraction: "0.25", reset_time: Math.floor(now / 1000) + 86400 }] },
  { displayName: "Gemini Argon", buckets: [{ bucketId: "argon", window: "weekly", remainingFraction: 1 }, { bucketId: "off", disabled: true, remainingFraction: 0 }] },
  { displayName: "Mystery Pool", buckets: [{ bucketId: "m1", description: "resets soon" }, { bucketId: "m2" }] },
] } };
const statusBody = { userStatus: { email: "someone@example.com", name: "Some One", userTier: { name: "Google AI Pro" } } };
const modelsBody = { userStatus: { planStatus: { planInfo: { planName: "Free" } }, cascadeModelConfigData: { clientModelConfigs: [
  { label: "Gemini 3 Pro", modelOrAlias: { model: "MODEL_PLACEHOLDER_M7" }, quotaInfo: { remainingFraction: 0.5, resetTime: iso(now + 7200000) } },
  { label: "Claude Sonnet 4.5", quotaInfo: { resetTime: iso(now + 3600000) } },
  { label: "No quota" },
] } } };

// A fake Herdr: `id`, `ps`, `lsof` answers and a fetch that records each request. `routes` maps a
// full loopback URL to [status, body]; a string body is sent as is, anything else as JSON.
function fakeIo({ ps = appPs, ports = { 101: [52000, 52001], 303: [41000] }, routes = {}, platform = "macos", hang = false, psCode = 0 } = {}) {
  const requests = [], execs = [];
  return {
    requests, execs, now, platform, home: () => "/Users/tester", readTextFile: async () => null,
    exec: async (cmd, args) => {
      execs.push([cmd, ...args]);
      if (cmd === "/usr/bin/id") return { code: 0, stdout: "501\n", stderr: "" };
      if (cmd === "/bin/ps") return { code: psCode, stdout: psCode ? "" : ps, stderr: "" };
      if (cmd === "/usr/sbin/lsof" || cmd === "/usr/bin/lsof") { const list = ports[Number(args[3])] ?? []; return list.length ? { code: 0, stdout: lsof(list), stderr: "" } : { code: 1, stdout: "", stderr: "" }; }
      return { code: 127, stdout: "", stderr: "" };
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, hang ? 5 : ms)),
    fetch: (url, init) => {
      requests.push({ url, method: init?.method, headers: init?.headers ?? {}, body: init?.body });
      if (hang) return new Promise(() => {});
      const route = routes[url];
      if (!route) return Promise.reject(new Error("offline"));
      const [status, body] = route;
      const text = typeof body === "string" ? body : JSON.stringify(body);
      return Promise.resolve({ status, ok: status >= 200 && status < 300, url, text: async () => text, json: async () => JSON.parse(text) });
    },
  };
}
const http = (port, path) => `http://127.0.0.1:${port}${path}`;
const appRoutes = (extra = {}) => ({ [http(52000, UNLEASH)]: [200, {}], [http(52000, SUMMARY)]: [200, summaryBody], [http(52000, STATUS)]: [200, statusBody], ...extra });
const noSecrets = value => { const text = JSON.stringify(value); assert.ok(!/SECRET|someone@|Some One/.test(text), "a token or account detail leaked into the result"); };

test("agy reads the running app's loopback server and names limits like quota-axi", async () => {
  const io = fakeIo({ routes: appRoutes() });
  const lane = await agy.read(io);
  assert.deepEqual(io.execs, [["/usr/bin/id", "-u"], ["/bin/ps", "-x", "-u", "501", "-o", "pid=,command="], ["/usr/sbin/lsof", "-nP", "-a", "-p", "101", "-iTCP", "-sTCP:LISTEN"]]);
  // https first (refused here), then http on the same port; feature flags before the summary.
  assert.deepEqual(io.requests.map(r => r.url), [`https://127.0.0.1:52000${UNLEASH}`, http(52000, UNLEASH), http(52000, SUMMARY), http(52000, STATUS)]);
  assert.ok(io.requests.every(r => r.method === "POST" && r.headers["x-codeium-csrf-token"] === "CSRF-SECRET-1" && r.headers["connect-protocol-version"] === "1"));
  assert.deepEqual(JSON.parse(io.requests[2].body), { request: {}, forceRefresh: false });
  assert.equal(lane.provider, "agy"); assert.equal(lane.label, "Antigravity");
  assert.equal(lane.state.status, "fresh"); assert.equal(lane.plan, "Google AI Pro"); assert.deepEqual(lane.accountKeys, ["default"]);
  assert.deepEqual(lane.windows.map(w => [w.id, w.label, w.kind, w.percentUsed, w.windowSeconds]), [
    ["gemini_5h", "Gemini 5-hour", "session", 41, 18000], ["gemini_weekly", "Gemini weekly", "weekly", 12, 604800],
    ["gemini_argon_weekly", "Gemini Argon weekly", "weekly", 0, 604800],
    ["claude_gpt_5h", "Claude/GPT 5-hour", "session", 10, 18000], ["claude_gpt_weekly", "Claude/GPT weekly", "weekly", 75, 604800],
    ["mystery_pool_unknown", "Mystery Pool quota", "unknown", null, null]]);
  assert.equal(lane.windows[4].resetsAt, iso(now + 86400000));
  noSecrets(lane);
  // The lane passes the mod's own allowlist unchanged in identity.
  const report = normalizeReport({ schemaVersion: 5, generatedAt: iso(now), providers: [lane] }, now);
  assert.equal(report.providers[0].windows[0].percentUsed, 41);
});

test("agy reads a running agy CLI without a CSRF token or feature-flag call", async () => {
  const routes = { [http(41000, SUMMARY)]: [200, summaryBody], [http(41000, STATUS)]: [500, {}] };
  const io = fakeIo({ ps: cliPs, routes, platform: "linux" });
  const lane = await agy.read(io);
  assert.deepEqual(io.execs[1], ["/bin/ps", "-u", "501", "-o", "pid=,command="]);
  assert.equal(io.execs[2][0], "/usr/bin/lsof");
  assert.ok(io.requests.every(r => !("x-codeium-csrf-token" in r.headers) && !r.url.endsWith("GetUnleashData")));
  assert.equal(lane.windows.length, 6); assert.equal(lane.plan, null); // the plan call failing doesn't fail the read
});

test("agy falls back to per-model limits when the server has no quota summary", async () => {
  const io = fakeIo({ routes: appRoutes({ [http(52000, SUMMARY)]: [200, {}], [http(52000, STATUS)]: [200, modelsBody] }) });
  const lane = await agy.read(io);
  assert.equal(lane.plan, "Free");
  assert.deepEqual(lane.windows.map(w => [w.id, w.label, w.kind, w.percentUsed, w.windowSeconds]), [
    ["model:model_placeholder_m7", "Gemini 3 Pro", "model", 50, null], ["model:claude_sonnet_4_5", "Claude Sonnet 4.5", "model", null, null]]);
  // And from GetCommandModelConfigs when the user status has no model limits either.
  const third = fakeIo({ routes: appRoutes({ [http(52000, SUMMARY)]: [200, {}], [http(52000, STATUS)]: [200, statusBody], [http(52000, MODELS)]: [200, modelsBody] }) });
  assert.equal((await agy.read(third)).windows.length, 2);
});

test("agy: nothing running keeps the earlier reading; Windows is unavailable; neither sends a request", async () => {
  const idle = fakeIo({ ps: "  202 /usr/bin/vim\n  404 /Applications/Other.app/Contents/MacOS/language_server\n" });
  // Closed is not a failure: the collector keeps the last reading, which ages to stale.
  await assert.rejects(agy.read(idle), e => e instanceof ReadFailure && e.message === "not-running");
  assert.equal(idle.requests.length, 0);
  const windows = fakeIo({ platform: "windows" });
  assert.equal((await agy.read(windows)).state.status, "unavailable");
  assert.equal(windows.execs.length, 0);
});

test("agy: a refused sign-in is auth_required; a CSRF refusal is unavailable", async () => {
  const refused = fakeIo({ routes: appRoutes({ [http(52000, UNLEASH)]: [401, { message: "unauthenticated" }] }) });
  const lane = await agy.read(refused);
  assert.equal(lane.state.status, "auth_required"); assert.deepEqual(lane.windows, []);
  const csrf = fakeIo({ routes: appRoutes({ [http(52000, UNLEASH)]: [401, "missing CSRF token"] }) });
  assert.equal((await agy.read(csrf)).state.status, "unavailable");
  // A sign-in refusal outranks a plain outage on another endpoint.
  const mixed = fakeIo({ routes: { [http(52000, UNLEASH)]: [500, {}], [http(52001, UNLEASH)]: [403, {}] } });
  assert.equal((await agy.read(mixed)).state.status, "auth_required");
});

test("agy: outages and odd answers keep earlier readings", async () => {
  const fails = async (io, reason) => assert.rejects(agy.read(io), e => e instanceof ReadFailure && (!reason || e.message === reason) && !/SECRET/.test(e.message));
  await fails(fakeIo(), "unreachable"); // offline
  await fails(fakeIo({ routes: appRoutes({ [http(52000, SUMMARY)]: [500, {}] }) }), "server");
  await fails(fakeIo({ routes: appRoutes({ [http(52000, SUMMARY)]: [429, {}] }) }), "rate-limited");
  await fails(fakeIo({ routes: appRoutes({ [http(52000, SUMMARY)]: [200, "not json"], [http(52000, STATUS)]: [200, {}] }) }), "malformed");
  await fails(fakeIo({ psCode: 1 }), "discovery");
  await fails(fakeIo({ ports: {} }), "discovery"); // the port lookup failed for every process
  await fails(fakeIo({ ps: `  101 ${APP} --random_port\n` }), "no-endpoint"); // running, but no token to ask with
  await fails(fakeIo({ hang: true })); // timed out
  // An answer from anywhere but the process asked is never used.
  const moved = fakeIo({ routes: appRoutes() });
  const real = moved.fetch; moved.fetch = (u, o) => real(u, o).then(r => ({ ...r, url: "https://evil.example/x" }));
  await fails(moved, "redirected");
});

test("agy marks a reading whose reset has passed as stale, like quota-axi", async () => {
  const past = { response: { groups: [{ displayName: "Gemini", buckets: [{ bucketId: "gemini-5h", remainingFraction: 0.5, resetTime: iso(now - 1000) }] }] } };
  const lane = await agy.read(fakeIo({ routes: appRoutes({ [http(52000, SUMMARY)]: [200, past] }) }));
  assert.equal(lane.state.status, "stale"); assert.equal(lane.state.stale, true);
});

test("agy never sends a token anywhere but the process's own loopback port", async () => {
  const io = fakeIo({ routes: appRoutes({ [http(52000, SUMMARY)]: [500, {}] }) });
  await agy.read(io).catch(() => {});
  assert.ok(io.requests.length > 0);
  assert.ok(io.requests.every(r => /^https?:\/\/127\.0\.0\.1:(52000|52001)\//.test(r.url)));
});

// Differential: the same process list, ports and answers through quota-axi and the port.
const shape = w => ({ id: w.id, label: w.label, kind: w.kind, percentUsed: w.percentUsed ?? null, windowSeconds: w.windowSeconds ?? null, resetsAt: Number.isFinite(Date.parse(w.resetsAt ?? "")) ? Date.parse(w.resetsAt) : null });
test("native windows and discovery match quota-axi's for the same Antigravity answers", async () => {
  const odd = { groups: [{ name: "gemini", buckets: [{ bucket_id: "five hour", window: "5-hour limit", remaining: 0.3, resetTime: "not a date" }, { id: "x", remaining: { remaining_fraction: 2 } }] }] };
  for (const body of [summaryBody, summaryBody.response, { summary: summaryBody.response }, odd, {}]) {
    assert.deepEqual(agy.summaryWindows(body, now).map(shape), (normalizeAgyQuotaSummary(body)?.windows ?? []).map(shape));
  }
  for (const body of [modelsBody, statusBody, modelsBody.userStatus.cascadeModelConfigData]) {
    const axi = normalizeAgyUserStatus(body), mine = agy.userStatus(body, now);
    assert.deepEqual(mine.windows.map(shape), axi.windows.map(shape));
    assert.equal(mine.plan, axi.plan ?? null);
  }
  const ps = appPs + cliPs + "  505 /opt/antigravity/language_server_linux_x64 --csrf_token=T-SECRET\n  606 bun /x/antigravity-cli/mcp-server.cjs\n  707 /usr/local/bin/agy -p hi\n";
  const pick = list => list.map(p => [p.pid, p.source, p.csrfToken ?? p.csrf ?? null, p.extensionPort ?? null]);
  assert.deepEqual(pick(agy.processes(ps)), pick(processInfosFromPs(ps)));
  const ls = `${lsof([52000, 52001])}\nx 1 u 3u IPv6 0x2 0t0 TCP [::1]:6000 (LISTEN)\nx 1 u 4u IPv4 0x3 0t0 TCP 127.0.0.1:7000->127.0.0.1:1 (ESTABLISHED)`;
  assert.deepEqual(agy.ports(ls), portsFromLsof(ls));

  // End to end: quota-axi's whole loopback read against the same fake processes and server.
  for (const [ps, routes] of [[appPs, appRoutes()], [cliPs, { [http(41000, SUMMARY)]: [200, summaryBody], [http(41000, STATUS)]: [200, statusBody] }],
    [appPs, appRoutes({ [http(52000, SUMMARY)]: [200, {}], [http(52000, STATUS)]: [200, modelsBody] })]]) {
    const io = fakeIo({ ps, routes }), axiUrls = [];
    const runtime = {
      findCommandPath: async () => null, // no `agy` CLI: the loopback read, which is what the port does
      execFileText: async (cmd, args) => { const r = await io.exec(cmd === "ps" ? "/bin/ps" : cmd === "lsof" ? "/usr/sbin/lsof" : cmd, args); if (r.code) throw new Error("exit"); return r.stdout; },
      requestJson: async (endpoint, path) => {
        const url = `${endpoint.scheme}://127.0.0.1:${endpoint.port}${path}`; axiUrls.push(url);
        const route = routes[url];
        if (!route || route[0] !== 200) throw Object.assign(new Error("Antigravity loopback unavailable"), { code: "ECONNREFUSED" });
        return typeof route[1] === "string" ? JSON.parse(route[1]) : route[1];
      },
    };
    const axi = await fetchQuotaWithRuntime(runtime);
    const mineIo = fakeIo({ ps, routes }), mine = await agy.read(mineIo);
    assert.deepEqual(mineIo.requests.map(r => r.url), axiUrls); // same endpoints, same order
    assert.equal(mine.state.status, axi.state.status);
    assert.equal(mine.plan, axi.plan ?? null);
    assert.deepEqual(mine.windows.map(shape), axi.windows.map(shape));
  }
});
test("the CSRF token only goes to ports the process holds on loopback or every address", () => {
  const out = "x 1 u 3u IPv4 0x1 0t0 TCP 192.168.1.5:5000 (LISTEN)\nx 1 u 4u IPv4 0x2 0t0 TCP *:5001 (LISTEN)\nx 1 u 5u IPv4 0x3 0t0 TCP 127.0.0.1:5002 (LISTEN)\nx 1 u 6u IPv6 0x4 0t0 TCP [::1]:5003 (LISTEN)";
  assert.deepEqual(agy.ports(out), [5001, 5002, 5003]);
});
