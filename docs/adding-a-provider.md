# Adding a provider

A provider is one file in `mods/agent-quota/providers/` that reads one service's
quota with the sign-in its own app or CLI already saved on this computer. This
guide covers the contract, the rules every provider follows, a template, and
how to test it. It's written so you, or an agent you ask, can add one safely.

## Just connecting an agent

If the service already has a provider and Herdr just calls the agent something
else, you don't need a new provider. Find the agent's key with `hc ls` (the
`"agent"` field, such as `"claude-code"`) and add it, lowercase, to that
provider's `agents` list:

```js
export const agents = ["claude-code", "claude code"];
```

The status bar, dashboard and pane headers all use that list. The contract
test fails if two providers claim the same name.

## How a read flows

```
collector.js  collect(io)                one read, every provider side by side, 25 s deadline
  └─ providers/<name>.js  read(io)       finds the sign-in, asks the vendor, returns a lane
       ├─ platform.js                    where files live and which programs run, per system
       └─ common.js                      getJson, lane, limit, ReadFailure, parsing helpers
core.js  normalizeReport()               validates and bounds the lane before it is stored
main.js, ui/                             draws it: status bar, dashboard, Settings, pane header
```

A provider never touches shared state, the UI or another provider. It gets an
`io` object and returns plain data.

## Rules

These protect people's sign-ins. Reviews reject a provider that breaks one.

1. **Tokens go only to the vendor's own host.** Use `getJson()` from
   `common.js`: it refuses header values with control characters and discards
   an answer that was redirected to another host. If you need another method
   (Cursor's RPC is a POST), copy those two checks.
2. **Never refresh a token.** Refreshing can rotate it and sign the person out
   of their own app. A rejected or expired token is a sign-out
   (`status: "auth_required"`), or `ReadFailure("expired")`.
3. **Never return, store, log or put a credential in an error.** A token lives
   in local variables of one `read()`. `ReadFailure` carries only a fixed
   reason. Tests check that no `SECRET` string reaches the result.
4. **No Keychain prompt from a background read.** On macOS, read Keychain items
   only through `keychain()` in `platform.js`, and only when
   `io.keychain.allowed` is true. Otherwise check presence with
   `{ secret: false }` and throw `ReadFailure("keychain")` so the person can
   approve it with Refresh.
5. **Paths and programs come from `platform.js`.** Use `homeFile(io, …)` for
   files and `program()`/`canRun()`/`sqlite()`/`keychain()` for programs. Don't
   test `io.platform` or write `/usr/bin/…` in a provider; a test enforces this.
6. **Missing usage is never zero.** Leave `percentUsed` out when the vendor
   doesn't say. The UI shows "no reading", not 0%.
7. **Keep ids stable.** The provider `id`, account key and each limit `id` are
   part of every saved choice. Changing one resets people's settings.
8. **Only plain short names from the vendor.** Pass plan and limit names
   through `name()` from `common.js`, which drops anything that looks like an
   email or a token.

## Steps

1. Copy the template below to `providers/<id>.js`.
2. Add it to `ADAPTERS` in `providers/index.js`.
3. Add `test/native-<id>.test.js` from the test template.
4. Add a row to the platform table in `README.md` (a test checks it matches
   your `platforms`), and a line to `CHANGELOG.md`.
5. Run `npm test`, `npm run typecheck` and `npm run check`, then install
   (`npm run setup`) and look at it in Herdr.

## The contract

| Export | What it is |
| --- | --- |
| `id` | Lowercase, stable: `"claude"`. Stored readings and saved choices use it. |
| `label` | Display name, 24 characters at most: `"Claude"`. |
| `agents` | Other Herdr agent keys or names for this provider, lowercase. `[]` if Herdr's key equals `id`. |
| `icon` | An SVG path Herdr resolves. `"icons/<name>.svg"` uses one Herdr ships. |
| `platforms` | `{ macos, linux, windows }`: where the sign-in is read on each system, or `null` where it isn't. |
| `read(io)` | Resolves with one lane (or an array, one per account), or throws `ReadFailure`. |

### `io`

| Field | Use |
| --- | --- |
| `io.now` | The read's clock, in ms. Use it, not `Date.now()`. |
| `io.home()` | The home folder. Use `homeFile()` instead of building paths. |
| `io.platform` | `"macos"`, `"linux"` or `"windows"`. Read it only through `platform.js`. |
| `io.readTextFile(path)` | A file's text, or null when it's absent. |
| `io.fetch(url, init)` | Herdr's fetch. Prefer `getJson()`. |
| `io.exec(cmd, args)` | Runs a program. Only through `platform.js`. |
| `io.sleep(ms)` | For timeouts; `within(io, ms, promise)` races one. |
| `io.keychain` | `{ allowed, granted, denied }` for this provider's Keychain consent. |

### What `read()` returns

Build the result with `lane()` and each limit with `limit()` from `common.js`:

```js
lane(id, label, io.now, { account: "default", plan: "pro", status: "fresh", windows: [...] })
limit(io.now, { id: "five_hour", label: "session", kind: "session", percentUsed: 42, resetsAt: iso, windowSeconds: 18000 })
```

- `status`: `"fresh"` (read now), `"auth_required"` (signed out or the token
  was refused) or `"unavailable"` (the service can't report here).
- `kind` decides the default visibility and short label: `session` (shown as
  `5h`), `weekly` (`Week`), `monthly` (`Month`), `credits`, `model` (hidden by
  default) or `unknown`.

### Failures

Throw `new ReadFailure(reason)` when the read couldn't finish. The earlier
reading is kept and marked stale.

| Reason | Effect |
| --- | --- |
| `unreachable`, `server`, `malformed`, `redirected`, `timeout`, `rate-limited` | Kept, stale; retries back off. |
| `expired` | "sign-in expired. Open it once to renew." |
| `keychain` | "needs one Keychain approval. Press Refresh…" No back-off. |
| `not-running`, `no-quota`, `no-endpoint` | Quiet: nothing to read now, no error shown. |

## Template

```js
// Example's plan limits, from the usage endpoint the Example CLI reads. Never refreshes a token.
import { ReadFailure, obj, str, num, name as plain, clampPercent, isoTime, limit, lane, getJson, parseJson } from "./common.js";
import { homeFile } from "./platform.js";

export const id = "example";
export const label = "Example";
export const agents = ["example-cli"];
export const icon = "icons/agent.svg";
const FILE = ".example/auth.json";
export const platforms = { macos: `~/${FILE}`, linux: `~/${FILE}`, windows: `~/${FILE}` };
const USAGE = "https://api.example.com/v1/usage";

async function signIn(io) {
  let text = null;
  try { text = await io.readTextFile(homeFile(io, FILE)); } catch { /* absent */ }
  return str(parseJson(text ?? "")?.access_token) ?? null;
}

export async function read(io) {
  const now = io.now, signedOut = () => lane(id, label, now, { status: "auth_required" });
  const token = await signIn(io);
  if (!token) return signedOut();
  const answer = await getJson(io, USAGE, { authorization: `Bearer ${token}`, accept: "application/json" });
  if (answer.auth) return signedOut();
  const session = obj(answer.body?.session), used = num(session?.used_percent);
  if (used === undefined) throw new ReadFailure("malformed");
  return lane(id, label, now, { plan: plain(answer.body.plan) ?? null, windows: [
    limit(now, { id: "five_hour", label: "session", kind: "session", percentUsed: clampPercent(used),
      resetsAt: isoTime(session.resets_at), windowSeconds: 18000 }),
  ] });
}
```

## Test template

Tests run in Node with a fake `io`: no network, no real files, no programs.

```js
import test from "node:test";
import assert from "node:assert/strict";
import * as example from "../mods/agent-quota/providers/example.js";

const now = Date.parse("2026-11-01T12:00:00Z");
const USAGE = "https://api.example.com/v1/usage";
const FILE = "/Users/tester/.example/auth.json";

function fakeIo({ files = {}, platform = "macos", routes = {} } = {}) {
  const requests = [];
  return { requests, now, platform, home: () => "/Users/tester",
    readTextFile: async path => files[path] ?? null,
    exec: async () => { throw new Error("no programs in this test"); },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    fetch: async (url, init) => {
      requests.push({ url, headers: init?.headers ?? {} });
      const [status, body] = routes[url] ?? [503, {}];
      return { status, ok: status < 300, url, json: async () => body };
    } };
}

test("reads the session limit and sends the token only to the vendor", async () => {
  const io = fakeIo({ files: { [FILE]: JSON.stringify({ access_token: "tok-SECRET" }) },
    routes: { [USAGE]: [200, { plan: "pro", session: { used_percent: 42 } }] } });
  const lane = await example.read(io);
  assert.equal(lane.windows[0].percentUsed, 42);
  assert.deepEqual(io.requests.map(r => r.url), [USAGE]);
  assert.ok(!JSON.stringify(lane).includes("SECRET"));
});

test("no sign-in, or a refused one, is a sign-out", async () => {
  assert.equal((await example.read(fakeIo())).state.status, "auth_required");
  const refused = fakeIo({ files: { [FILE]: JSON.stringify({ access_token: "tok" }) }, routes: { [USAGE]: [401, {}] } });
  assert.equal((await example.read(refused)).state.status, "auth_required");
});
```

Add a case for each system in `platforms`, and for each `ReadFailure` your
provider throws. `test/native.test.js` (Claude, Codex) and
`test/native-cursor.test.js` are full examples.

## Checking it in Herdr

Tests can't show what Herdr draws. After `npm run setup`, open the dashboard
(the status bar's quota button) and check that the provider appears with your
sign-in, that its limits read sensibly, and that `herdr-app status` shows no
errors. If you can't check natively, say so in the pull request.
