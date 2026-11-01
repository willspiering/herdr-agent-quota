import test from "node:test";
import assert from "node:assert/strict";
import * as copilot from "../mods/agent-quota/providers/copilot.js";
import { ReadFailure } from "../mods/agent-quota/providers/common.js";
import { normalizeReport } from "../mods/agent-quota/core.js";
// quota-axi's own readers: the port must name, measure and pick credentials the same way.
import { normalizeCopilotUser } from "../node_modules/quota-axi/dist/src/providers/copilot.js";
import { resolveGhCliCredential } from "../node_modules/quota-axi/dist/src/providers/gh-cli-credential.js";

const now = Date.parse("2026-10-31T12:00:00Z");
const TOKEN = "gho_SECRET123";
const HOME = "/Users/tester";
const USER = "https://api.github.com/copilot_internal/user";
const APPS = `${HOME}/.config/github-copilot/apps.json`;
const CLI = `${HOME}/.copilot/config.json`;
const GH = `${HOME}/.config/gh/hosts.yml`;

// A fake Herdr: files, a Keychain answer, and a fetch that records each request.
function fakeIo({ files = {}, keychain = null, keychainPolicy, platform = "macos", routes = {}, hang = false } = {}) {
  const requests = [], execs = [];
  return {
    requests, execs, now, platform, home: () => HOME, keychain: keychainPolicy,
    readTextFile: async path => files[path] ?? null,
    exec: async (cmd, args) => { execs.push([cmd, ...args]); return keychain === null ? { code: 44, stdout: "", stderr: "not found" } : { code: 0, stdout: args.includes("-w") ? keychain : "", stderr: "" }; },
    sleep: ms => new Promise(resolve => setTimeout(resolve, hang ? 5 : ms)),
    fetch: (url, init) => {
      requests.push({ url, headers: init?.headers ?? {} });
      if (hang) return new Promise(() => {});
      const route = routes[url];
      if (!route) return Promise.reject(new Error("offline"));
      const [status, body] = typeof route === "function" ? route(init) : route;
      return Promise.resolve({ status, ok: status >= 200 && status < 300, url, json: async () => (body instanceof Error ? Promise.reject(body) : body), text: async () => JSON.stringify(body) });
    },
  };
}
const ghHosts = (token = TOKEN) => `github.com:\n    users:\n        octo:\n            oauth_token: ${token}\n    git_protocol: https\n    oauth_token: ${token}\n    user: octo\n`;
const apps = (token = TOKEN, key = "github.com:Iv1.b507a08c87ecfe98") => JSON.stringify({ [key]: { user: "octo", oauth_token: token, githubAppId: "Iv1.b507a08c87ecfe98" } });
const cliConfig = (login = "octo") => `// written by the CLI\n{\n  "lastLoggedInUser": { "host": "https://github.com", "login": "${login}" }\n}\n`;
const body = {
  login: "octo-SECRET-login", copilot_plan: "individual", quota_reset_date_utc: "2026-12-01T00:00:00.000Z",
  quota_snapshots: {
    chat: { percent_remaining: 100, unlimited: true, quota_reset_at: 0 },
    completions: { percent_remaining: 100, unlimited: true },
    premium_interactions: { percent_remaining: 12.6, entitlement: 300, quota_reset_at: 1764547200 },
  },
};
const noSecrets = value => { const text = JSON.stringify(value); assert.ok(!text.includes("SECRET"), "a credential or login leaked into the result"); };
const shape = w => ({ id: w.id, label: w.label, kind: w.kind, percentUsed: w.percentUsed, windowSeconds: w.windowSeconds ?? null, resetsAt: w.resetsAt ?? null });

test("copilot reads the gh login and reports quota-axi's monthly windows", async () => {
  const io = fakeIo({ files: { [GH]: ghHosts() }, routes: { [USER]: [200, body] } });
  const lane = await copilot.read(io);
  assert.equal(io.requests.length, 1);
  assert.equal(io.requests[0].url, USER);
  assert.equal(io.requests[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(io.requests[0].headers["user-agent"], "GitHubCopilotCLI/1.0");
  assert.equal(io.execs.length, 0);
  assert.equal(lane.provider, "copilot");
  assert.equal(lane.label, "GitHub Copilot");
  assert.deepEqual(lane.accountKeys, ["default"]);
  assert.equal(lane.plan, "individual");
  assert.equal(lane.state.status, "fresh");
  assert.deepEqual(lane.windows.map(shape), [
    { id: "chat", label: "chat", kind: "monthly", percentUsed: 0, windowSeconds: null, resetsAt: "2026-12-01T00:00:00.000Z" },
    { id: "completions", label: "completions", kind: "monthly", percentUsed: 0, windowSeconds: null, resetsAt: "2026-12-01T00:00:00.000Z" },
    { id: "premium_interactions", label: "premium interactions", kind: "monthly", percentUsed: 87, windowSeconds: null, resetsAt: "2025-12-01T00:00:00.000Z" },
  ]);
  noSecrets(lane);
  const report = normalizeReport({ schemaVersion: 5, generatedAt: new Date(now).toISOString(), providers: [lane] }, now);
  assert.equal(report.providers[0].windows.length, 3);
  noSecrets(report);
});

test("copilot prefers apps.json, then the Copilot CLI's Keychain item, then gh", async () => {
  const seen = [];
  const routes = { [USER]: init => { seen.push(init.headers.authorization); return [200, body]; } };
  await copilot.read(fakeIo({ files: { [APPS]: apps("gho_APPS"), [CLI]: cliConfig(), [GH]: ghHosts("gho_GH") }, keychain: "gho_CLI\n", routes }));
  await copilot.read(fakeIo({ files: { [CLI]: cliConfig(), [GH]: ghHosts("gho_GH") }, keychain: "gho_CLI\n", routes }));
  // A rejected token hands over to the next store.
  const rejectApps = { [USER]: init => { seen.push(init.headers.authorization); return init.headers.authorization === "Bearer gho_APPS" ? [401, {}] : [200, body]; } };
  const lane = await copilot.read(fakeIo({ files: { [APPS]: apps("gho_APPS"), [GH]: ghHosts("gho_GH") }, routes: rejectApps }));
  assert.deepEqual(seen, ["Bearer gho_APPS", "Bearer gho_CLI", "Bearer gho_APPS", "Bearer gho_GH"]);
  assert.equal(lane.state.status, "fresh");
});

test("copilot reads the Copilot CLI's Keychain item for the selected account and records the grant", async () => {
  const io = fakeIo({ files: { [CLI]: cliConfig() }, keychain: `${TOKEN}\n`, keychainPolicy: { allowed: true, granted: false }, routes: { [USER]: [200, body] } });
  const lane = await copilot.read(io);
  assert.deepEqual(io.execs, [["/usr/bin/security", "find-generic-password", "-s", "copilot-cli", "-a", "https://github.com:octo", "-w"]]);
  assert.equal(io.keychain.granted, true);
  assert.equal(lane.state.status, "fresh");
  noSecrets(lane);
});

test("copilot never reads a Keychain secret without consent", async () => {
  // Only the item's presence is checked; with no other store the read keeps its earlier reading.
  const io = fakeIo({ files: { [CLI]: cliConfig() }, keychain: TOKEN, keychainPolicy: { allowed: false, granted: false }, routes: { [USER]: [200, body] } });
  await assert.rejects(copilot.read(io), e => e instanceof ReadFailure && e.message === "keychain");
  assert.deepEqual(io.execs, [["/usr/bin/security", "find-generic-password", "-s", "copilot-cli", "-a", "https://github.com:octo"]]);
  assert.equal(io.requests.length, 0);
  // A gh login still answers.
  const withGh = fakeIo({ files: { [CLI]: cliConfig(), [GH]: ghHosts() }, keychain: TOKEN, keychainPolicy: { allowed: false, granted: false }, routes: { [USER]: [200, body] } });
  assert.equal((await copilot.read(withGh)).state.status, "fresh");
  assert.ok(withGh.execs.every(args => !args.includes("-w")));
  // Off macOS there is no Keychain to read.
  const linux = fakeIo({ files: { [CLI]: cliConfig() }, keychain: TOKEN, platform: "linux" });
  assert.equal((await copilot.read(linux)).state.status, "auth_required");
  assert.equal(linux.execs.length, 0);
});

test("copilot: no credential or a rejected one is signed out", async () => {
  const none = await copilot.read(fakeIo());
  assert.equal(none.state.status, "auth_required");
  assert.deepEqual(none.windows, []);
  assert.deepEqual(none.accountKeys, ["default"]);
  for (const status of [401, 403]) {
    const lane = await copilot.read(fakeIo({ files: { [GH]: ghHosts() }, routes: { [USER]: [status, {}] } }));
    assert.equal(lane.state.status, "auth_required");
    assert.deepEqual(lane.windows, []);
  }
  // A keyring gh login, a token for another host, a $reference: no credential, nothing sent.
  const keyring = "github.com:\n    git_protocol: https\n    user: octo\n";
  const otherHost = JSON.stringify({ "ghe.example.com:Iv1": { oauth_token: TOKEN } });
  for (const files of [{ [GH]: keyring }, { [APPS]: otherHost }, { [GH]: ghHosts("$GH_TOKEN") }, { [GH]: "github.com:\n\toauth_token: x\n" }]) {
    const io = fakeIo({ files });
    assert.equal((await copilot.read(io)).state.status, "auth_required");
    assert.equal(io.requests.length, 0);
  }
  // A Copilot CLI account whose item can't be read is unmeasured, not signed out.
  const missing = await copilot.read(fakeIo({ files: { [CLI]: cliConfig() } }));
  assert.equal(missing.state.status, "unavailable");
});

test("copilot: outages and odd answers keep earlier readings", async () => {
  const files = { [GH]: ghHosts() };
  const cases = [
    [fakeIo({ files }), "unreachable"],
    [fakeIo({ files, routes: { [USER]: [500, {}] } }), "server"],
    [fakeIo({ files, routes: { [USER]: [429, {}] } }), "rate-limited"],
    [fakeIo({ files, routes: { [USER]: [200, new Error("not json")] } }), "malformed"],
    [fakeIo({ files, routes: { [USER]: [200, { unrelated: true }] } }), "malformed"],
    [fakeIo({ files, hang: true }), "unreachable"],
  ];
  for (const [io, reason] of cases) {
    await assert.rejects(copilot.read(io), e => e instanceof ReadFailure && e.message === reason && !e.message.includes("SECRET"));
  }
  // A failure stops the search: the next store's token is never sent.
  const io = fakeIo({ files: { [APPS]: apps("gho_APPS"), [GH]: ghHosts("gho_GH") }, routes: { [USER]: [500, {}] } });
  await assert.rejects(copilot.read(io), ReadFailure);
  assert.equal(io.requests.length, 1);
});

test("copilot windows match quota-axi's for the same Copilot answers", () => {
  const answers = [
    body,
    { copilot_plan: "business", quota_snapshots: { premium_interactions: { percent_remaining: "40.5", quota_reset_at: "1764547200000" }, chat: { percent_remaining: -5 } } },
    { access_type_sku: "free_limited_copilot", quota_reset_date_utc: 1764547200, quota_snapshots: { chat: { percent_remaining: 99.4 }, completions: { percent_remaining: 150 }, bogus: { unlimited: true } } },
    { sku: "x", quota_snapshots: { chat: { percent_remaining: 50, quota_reset_at: "not a date" } }, quota_reset_date_utc: "garbage" },
  ];
  for (const answer of answers) {
    const theirs = normalizeCopilotUser(answer);
    const ours = copilot.usageWindows(answer, now);
    assert.deepEqual(ours.map(shape), theirs.windows.map(shape));
  }
});

test("copilot reads gh's hosts.yml exactly like quota-axi", async () => {
  const files = [
    ghHosts(),
    `---\n"github.com":\n  oauth_token: '${TOKEN}' # comment\n`,
    `github.com:\n  oauth_token: "${TOKEN}"\n`,
    `ghe.example.com:\n  oauth_token: other\ngithub.com:\n  user: octo\n`,
    `github.com:\n  oauth_token:\n    nested: x\n`,
    `github.com:\n  oauth_token: ${TOKEN}\ngithub.com:\n  oauth_token: second\n`,
    `github.com: plain\n`,
    `- github.com\n`,
    `github.com:\n  oauth_token: !secret\n`,
  ];
  for (const text of files) {
    const theirs = await resolveGhCliCredential({ host: "github.com", homeDirectory: () => HOME, environment: {}, platform: "darwin", readFile: async () => Buffer.from(text) });
    const io = fakeIo({ files: { [GH]: text }, routes: { [USER]: [200, body] } });
    await copilot.read(io);
    const sent = io.requests[0]?.headers.authorization?.slice("Bearer ".length);
    assert.equal(sent, theirs.status === "resolved" ? theirs.token : undefined, text);
  }
});
