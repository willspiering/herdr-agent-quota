// Everything that differs between macOS, Linux and Windows, in one place. Providers never test
// `io.platform` for a path or a program themselves: they look it up here, so supporting another
// system (or fixing a path on one) is a change to a table, not a search through every provider.
//
// `io.platform` is Herdr's `appWindow().platform`: "macos", "linux" or "windows".
import { ReadFailure, within } from "./common.js";

export const PLATFORMS = ["macos", "linux", "windows"];

/**
 * A file in the home folder, from a table of home-relative paths per system: a string for every
 * system, or `{ macos, linux, windows }`. null where the table has no entry: not read there.
 * Paths are joined with "/", which Windows accepts too.
 * @param {{ home(): string, platform: string }} io
 * @param {string | Partial<Record<"macos" | "linux" | "windows", string>>} table
 */
export function homeFile(io, table) {
  const path = typeof table === "string" ? table : table[io.platform];
  return typeof path === "string" ? `${io.home()}/${path}` : null;
}

// Programs a read may run, by system, always by absolute path (never whatever comes first on
// PATH). A system with no entry can't run that program, so the source that needs it is skipped.
export const PROGRAMS = {
  // macOS Keychain lookups.
  security: { macos: ["/usr/bin/security"] },
  // Read-only queries of an app's SQLite store. macOS ships sqlite3; on Linux it's looked for in
  // the usual places.
  sqlite3: { macos: ["/usr/bin/sqlite3"], linux: ["/usr/bin/sqlite3", "/usr/local/bin/sqlite3"] },
  // Finding a running app's local server (Antigravity).
  id: { macos: ["/usr/bin/id"], linux: ["/usr/bin/id"] },
  ps: { macos: ["/bin/ps"], linux: ["/bin/ps"] },
  lsof: { macos: ["/usr/sbin/lsof"], linux: ["/usr/bin/lsof"] },
};
/** The program's paths on this system, first choice first; empty when it can't run here. */
export const program = (io, name) => PROGRAMS[name]?.[io.platform] ?? [];
/** Whether every named program can run on this system. */
export const canRun = (io, ...names) => names.every(name => program(io, name).length > 0);

// ── macOS Keychain ───────────────────────────────────────────

// `security` exits with 44 when the item doesn't exist.
export const KEYCHAIN_MISSING = 44;

/**
 * Look up a Keychain item with `security find-generic-password <args>`. With `secret: false` only
 * its presence is checked: that never shows a prompt and never returns the secret. Rejects when
 * `security` can't run; otherwise resolves with its { code, stdout, stderr }.
 * @param {{ exec: Function, platform: string }} io
 * @param {string[]} args
 * @param {{ secret?: boolean }} [options]
 */
export function keychain(io, args, { secret = true } = {}) {
  const [security] = program(io, "security");
  if (!security) return Promise.reject(new Error("No Keychain on this system"));
  return io.exec(security, ["find-generic-password", ...args, ...(secret ? ["-w"] : [])]);
}

// ── SQLite ───────────────────────────────────────────────────

/**
 * Run `sqlite3 -readonly -init /dev/null <args>` with the first sqlite3 this system has.
 * `-init /dev/null` keeps the user's ~/.sqliterc out of it (it could redirect a token's output).
 * Resolves with { code, stdout, stderr }, or null when no sqlite3 is installed here.
 * Throws ReadFailure("timeout") when the query outruns `ms` (an app holding its database).
 * @param {{ exec: Function, platform: string, sleep(ms: number): Promise<void> }} io
 * @param {number} ms
 * @param {string[]} args
 */
export async function sqlite(io, ms, args) {
  for (const bin of program(io, "sqlite3")) {
    try { return await within(io, ms, io.exec(bin, ["-readonly", "-init", "/dev/null", ...args])); }
    catch (error) {
      if (error instanceof ReadFailure) throw error;
      // not installed at this path: try the next one
    }
  }
  return null;
}

// ── The GitHub CLI's keyring login ───────────────────────────

// Where `gh` is looked for, first choice first. "~/" is the home folder (a mise shim, a
// ~/.local/bin or Nix install); PATH is never searched. Windows isn't supported here.
export const GH = {
  macos: ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "~/.local/share/mise/shims/gh", "~/.local/bin/gh", "~/.nix-profile/bin/gh"],
  linux: ["/usr/bin/gh", "/usr/local/bin/gh", "/home/linuxbrew/.linuxbrew/bin/gh", "/snap/bin/gh", "/run/current-system/sw/bin/gh",
    "~/.local/share/mise/shims/gh", "~/.local/bin/gh", "~/.nix-profile/bin/gh"],
};
const ENV = { macos: "/usr/bin/env", linux: "/usr/bin/env" };
// gh exits 1 when it has no login; `env` exits 127 (or 126) when there is no gh at that path.
const NOT_HERE = new Set([126, 127]);
const GH_MS = 15000;
// What `gh` is asked: github.com's token and nothing else. Only `auth token` runs (a built-in
// command no alias or extension can replace), for github.com whatever GH_HOST says. It never
// prompts, never checks for updates, and a mise shim never installs a missing gh.
const GH_ENV = ["GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "GH_SPINNER_DISABLED=1", "MISE_NOT_FOUND_AUTO_INSTALL=false"];
const GH_ARGS = ["auth", "token", "--hostname", "github.com"];

/**
 * Ask the first `gh` on this system for github.com's token: `gh auth token --hostname github.com`,
 * through `/usr/bin/env` so the variables above apply, from the home folder (so no project's mise
 * config is involved). Resolves with { code, stdout } from the gh that ran, or null when no gh is
 * installed here. Throws ReadFailure("timeout") if gh outruns its time (a keyring prompt left open).
 * The output is a secret: callers check its shape, send it only to GitHub, and never keep it.
 * @param {{ exec: Function, platform: string, home(): string, sleep(ms: number): Promise<void> }} io
 */
export async function githubCli(io) {
  const env = ENV[io.platform];
  if (!env) return null;
  for (const path of GH[io.platform] ?? []) {
    const gh = path.startsWith("~/") ? `${io.home()}/${path.slice(2)}` : path;
    let result;
    try { result = await within(io, GH_MS, io.exec(env, [...GH_ENV, gh, ...GH_ARGS], { cwd: io.home(), timeout: GH_MS })); }
    catch (error) { if (error instanceof ReadFailure) throw error; continue; }
    if (NOT_HERE.has(result?.code)) continue;
    return { code: result?.code ?? 1, stdout: String(result?.stdout ?? "") };
  }
  return null;
}
