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
