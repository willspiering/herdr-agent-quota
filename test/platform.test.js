import test from "node:test";
import assert from "node:assert/strict";
import { PLATFORMS, PROGRAMS, homeFile, program, canRun, keychain, sqlite } from "../mods/agent-quota/providers/platform.js";
import { ReadFailure } from "../mods/agent-quota/providers/common.js";
import { ADAPTERS } from "../mods/agent-quota/providers/index.js";

const io = (platform, exec = async () => ({ code: 0, stdout: "", stderr: "" })) => {
  const execs = [];
  return { platform, home: () => "/home/t", sleep: ms => new Promise(r => setTimeout(r, ms)), execs,
    exec: async (cmd, args) => { execs.push([cmd, ...args]); return exec(cmd, args); } };
};

test("homeFile resolves one path for every system, or a per-system table", () => {
  assert.equal(homeFile(io("windows"), ".codex/auth.json"), "/home/t/.codex/auth.json");
  const table = { macos: "Library/x", linux: ".config/x" };
  assert.equal(homeFile(io("macos"), table), "/home/t/Library/x");
  assert.equal(homeFile(io("linux"), table), "/home/t/.config/x");
  assert.equal(homeFile(io("windows"), table), null, "no entry: not read there");
});

test("programs are absolute paths, and a system without one can't run it", () => {
  for (const [name, bySystem] of Object.entries(PROGRAMS)) {
    for (const [system, paths] of Object.entries(bySystem)) {
      assert.ok(PLATFORMS.includes(system), `${name}: unknown system ${system}`);
      assert.ok(paths.length && paths.every(p => p.startsWith("/")), `${name} on ${system}`);
    }
  }
  assert.deepEqual(program(io("windows"), "sqlite3"), []);
  assert.equal(canRun(io("macos"), "security"), true);
  assert.equal(canRun(io("linux"), "security"), false);
  assert.equal(canRun(io("linux"), "id", "ps", "lsof"), true);
  assert.equal(canRun(io("windows"), "id", "ps", "lsof"), false);
});

test("keychain asks for the secret only when allowed, and never runs off macOS", async () => {
  const mac = io("macos");
  await keychain(mac, ["-s", "svc"]);
  await keychain(mac, ["-s", "svc"], { secret: false });
  assert.deepEqual(mac.execs, [["/usr/bin/security", "find-generic-password", "-s", "svc", "-w"], ["/usr/bin/security", "find-generic-password", "-s", "svc"]]);
  const linux = io("linux");
  await assert.rejects(keychain(linux, ["-s", "svc"]));
  assert.deepEqual(linux.execs, []);
});

test("sqlite tries each install in order, keeps ~/.sqliterc out, and tells absent from slow", async () => {
  const fallback = io("linux", async cmd => { if (cmd === "/usr/bin/sqlite3") throw new Error("ENOENT"); return { code: 0, stdout: "ok", stderr: "" }; });
  assert.equal((await sqlite(fallback, 1000, ["db", "select 1;"])).stdout, "ok");
  assert.deepEqual(fallback.execs.map(e => e[0]), ["/usr/bin/sqlite3", "/usr/local/bin/sqlite3"]);
  assert.deepEqual(fallback.execs[1].slice(1, 4), ["-readonly", "-init", "/dev/null"]);
  assert.equal(await sqlite(io("linux", async () => { throw new Error("ENOENT"); }), 1000, []), null, "none installed");
  const windows = io("windows");
  assert.equal(await sqlite(windows, 1000, []), null);
  assert.deepEqual(windows.execs, []);
  await assert.rejects(sqlite(io("macos", () => new Promise(() => {})), 10, []), ReadFailure, "a held database is slow, not absent");
});

test("no provider checks the system or names a program itself", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const dir = new URL("../mods/agent-quota/providers/", import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith(".js") && f !== "platform.js")) {
    const source = await readFile(new URL(file, dir), "utf8");
    assert.doesNotMatch(source, /"\/(usr|bin|sbin)\//, `${file} names a program path; add it to platform.js`);
    assert.doesNotMatch(source, /io\.home\(\)\s*\}?\//, `${file} builds a home path; use homeFile()`);
  }
  assert.equal(ADAPTERS.length, 9);
});
