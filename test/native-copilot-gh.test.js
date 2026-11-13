import test from "node:test";
import assert from "node:assert/strict";
import * as copilot from "../mods/agent-quota/providers/copilot.js";
import { ReadFailure } from "../mods/agent-quota/providers/common.js";
import { githubCli } from "../mods/agent-quota/providers/platform.js";
import { collect } from "../mods/agent-quota/collector.js";

// Copilot through a GitHub CLI login kept in the system keyring: hosts.yml names the login but
// holds no token, so the token comes from `gh auth token --hostname github.com`.
const now = Date.parse("2026-11-13T12:00:00Z");
const TOKEN = "gho_SECRET123";
const HOME = "/home/tester";
const USER = "https://api.github.com/copilot_internal/user";
const GH = `${HOME}/.config/gh/hosts.yml`;
const ENV = ["GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "GH_SPINNER_DISABLED=1", "MISE_NOT_FOUND_AUTO_INSTALL=false"];
const ARGS = ["auth", "token", "--hostname", "github.com"];
const keyring = "github.com:\n    git_protocol: https\n    users:\n        octo:\n    user: octo\n";
const plainLogin = `github.com:\n    oauth_token: ${TOKEN}\n    user: octo\n`;
const body = { login: "octo-SECRET-login", copilot_plan: "individual", quota_snapshots: { premium_interactions: { percent_remaining: 40, quota_reset_at: 1764547200 } } };

// `installed`: the gh paths that exist; `gh`: what that gh answers ({ code, stdout } or an Error).
function fakeIo({ files = { [GH]: keyring }, platform = "linux", installed = ["/usr/bin/gh"], gh = { code: 0, stdout: `${TOKEN}\n` }, consent, routes = { [USER]: [200, body] } } = {}) {
  const requests = [], execs = [];
  return {
    requests, execs, now, platform, home: () => HOME, keychain: consent,
    readTextFile: async path => files[path] ?? null,
    exec: async (cmd, args, options) => {
      execs.push({ cmd, args, options });
      if (cmd !== "/usr/bin/env") throw new Error("ENOENT");
      const path = args[ENV.length];
      if (!installed.includes(path)) return { code: 127, stdout: "", stderr: `env: '${path}': No such file or directory` };
      if (gh === "hang") return new Promise(() => {});
      if (gh instanceof Error) throw gh;
      return { stderr: "gh's own words, never read", ...gh };
    },
    // Time passes only for a gh that hangs; otherwise no timer outlives the test.
    sleep: () => new Promise(resolve => { if (gh === "hang") setTimeout(resolve, 5); }),
    fetch: (url, init) => {
      requests.push({ url, headers: init?.headers ?? {} });
      const route = routes[url];
      if (!route) return Promise.reject(new Error("offline"));
      const [status, json] = route;
      return Promise.resolve({ status, ok: status >= 200 && status < 300, url, json: async () => json });
    },
  };
}
const noSecrets = value => assert.ok(!JSON.stringify(value).includes("SECRET"), "a credential or login leaked");

test("copilot reads a keyring gh login through `gh auth token`, and sends the token only to GitHub", async () => {
  const grant = { allowed: true, granted: false, denied: false };
  const io = fakeIo({ consent: grant });
  const lane = await copilot.read(io);
  assert.equal(lane.state.status, "fresh");
  assert.deepEqual(lane.windows.map(w => [w.id, w.percentUsed]), [["premium_interactions", 60]]);
  // Exactly one program: gh, by absolute path, through /usr/bin/env, from the home folder, asked
  // for github.com's token and nothing else.
  assert.equal(io.execs.length, 1);
  assert.deepEqual([io.execs[0].cmd, ...io.execs[0].args], ["/usr/bin/env", ...ENV, "/usr/bin/gh", ...ARGS]);
  assert.equal(io.execs[0].options.cwd, HOME);
  // Exactly one request: GitHub's Copilot endpoint.
  assert.deepEqual(io.requests.map(r => [r.url, r.headers.authorization]), [[USER, `Bearer ${TOKEN}`]]);
  assert.equal(grant.granted, true);
  noSecrets(lane);
});

test("copilot never launches gh without a keyring login to read", async () => {
  // A plain hosts.yml token is read from the file; no hosts.yml, or one without github.com, or an
  // unreadable one: nothing to ask gh. Windows: gh is never run.
  const cases = [
    [fakeIo({ files: { [GH]: plainLogin } }), "fresh"],
    [fakeIo({ files: {} }), "signed_out"],
    [fakeIo({ files: { [GH]: "ghe.example.com:\n    user: octo\n" } }), "signed_out"],
    [fakeIo({ files: { [GH]: "github.com:\n\tuser: octo\n" } }), "signed_out"],
    [fakeIo({ platform: "windows" }), "signed_out"],
  ];
  for (const [io, status] of cases) {
    assert.equal((await copilot.read(io)).state.status, status);
    assert.equal(io.execs.length, 0);
  }
});

test("copilot asks gh only with consent, as a Keychain item is read", async () => {
  // A background read with no earlier grant: no gh, no request, a reason that doesn't back off.
  const io = fakeIo({ consent: { allowed: false, granted: false, denied: false } });
  await assert.rejects(copilot.read(io), e => e instanceof ReadFailure && e.message === "keyring");
  assert.equal(io.execs.length, 0);
  assert.equal(io.requests.length, 0);
  // Alongside a provider that read, the wait is named and nothing backs off.
  const fine = { id: "fine", label: "Fine", read: async () => ({ provider: "fine", label: "Fine", accountKeys: ["default"], state: { status: "fresh", fetchedAt: new Date(now).toISOString() }, windows: [] }) };
  const base = { ...fakeIo(), sleep: () => new Promise(() => {}), keychain: () => ({ allowed: false, granted: false, denied: false }) };
  const result = await collect({ ...base, adapters: [copilot, fine] }, now);
  assert.match(result.failed.message, /^GitHub Copilot: reads its GitHub CLI sign-in from the keyring once you press Refresh/);
  assert.equal(result.failed.backoff, false);
  // Alone, the read fails with the same words.
  await assert.rejects(collect({ ...base, adapters: [copilot] }, now), /keyring once you press Refresh/);
});

test("copilot looks for gh only at known paths, the home folder's included", async () => {
  const shim = `${HOME}/.local/share/mise/shims/gh`;
  const io = fakeIo({ installed: [shim] });
  assert.equal((await copilot.read(io)).state.status, "fresh");
  assert.deepEqual(io.execs.map(e => e.args[ENV.length]), ["/usr/bin/gh", "/usr/local/bin/gh", "/home/linuxbrew/.linuxbrew/bin/gh", "/snap/bin/gh", "/run/current-system/sw/bin/gh", shim]);
  assert.ok(io.execs.every(e => e.args[ENV.length].startsWith("/")), "never a bare name looked up on PATH");
  // No gh anywhere: the login can't be read, and nothing is sent.
  const none = fakeIo({ installed: [] });
  assert.equal((await copilot.read(none)).state.status, "signed_out");
  assert.equal(none.requests.length, 0);
  assert.equal(await githubCli(fakeIo({ platform: "windows" })), null);
});

test("copilot sends nothing when gh refuses or answers with something that isn't a token", async () => {
  const refused = { allowed: true, granted: false, denied: false };
  const io = fakeIo({ gh: { code: 1, stdout: "" }, consent: refused });
  assert.equal((await copilot.read(io)).state.status, "unavailable");
  assert.equal(refused.denied, true);
  assert.equal(io.requests.length, 0);
  // Only GitHub's own token shapes, one line, of a sane length.
  for (const stdout of ["", "hello world\n", `${TOKEN}\nsecond line\n`, "Bearer gho_x", "gho_a$(id)", `gho_${"a".repeat(20000)}`, "-----BEGIN KEY-----"]) {
    const odd = fakeIo({ gh: { code: 0, stdout } });
    assert.equal((await copilot.read(odd)).state.status, "unavailable", JSON.stringify(stdout.slice(0, 20)));
    assert.equal(odd.requests.length, 0);
  }
  for (const stdout of ["gho_abc123\n", "ghu_abc\r\n", "ghp_abc", "github_pat_11AB_cd"]) {
    assert.equal((await copilot.read(fakeIo({ gh: { code: 0, stdout } }))).state.status, "fresh", stdout);
  }
});

test("copilot: a gh that hangs (a keyring prompt left open) times out and keeps earlier readings", async () => {
  await assert.rejects(copilot.read(fakeIo({ gh: "hang" })), e => e instanceof ReadFailure && e.message === "timeout");
  // A gh token GitHub refuses is a sign-in to renew, as with any other store.
  const io = fakeIo({ routes: { [USER]: [401, {}] } });
  assert.equal((await copilot.read(io)).state.status, "auth_required");
  assert.equal(io.requests.length, 1);
});
