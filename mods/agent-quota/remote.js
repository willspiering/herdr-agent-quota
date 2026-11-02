// Quota for agents on other machines, read only after the person turns it on in Settings.
// Each machine keeps its own sign-in. Its sign-in file is read over Herdr's own connection
// (`readTextFile(path, { on })`), the provider's usage service is asked from this computer, and
// the token is dropped with the read, as for this computer's: never stored, logged or shown.
import * as claude from "./providers/claude.js";
import * as codex from "./providers/codex.js";
import { ReadFailure, lane, within } from "./providers/common.js";
import { MACHINE } from "./core.js";

// Providers whose sign-in is a plain file there. Keychain items can't be read over a connection
// without a prompt on that machine, so a sign-in kept in one is reported, not read.
export const REMOTE = [claude, codex];
const PLATFORM = { Darwin: "macos", Linux: "linux" };
// Another machine gets less time than this computer's read: a slow or hostile one can delay
// this computer's readings by at most this long, never the whole read.
export const REMOTE_MS = 8000;

// That machine's home folder and platform. Two constant commands, no shell; Herdr runs them there.
async function place(io, on) {
  let found;
  try { found = await Promise.all([io.exec("printenv", ["HOME"], { on }), io.exec("uname", ["-s"], { on })]); }
  catch { throw new ReadFailure("offline"); } // unreachable: earlier readings stay and age
  const [home, os] = found.map(r => r?.code === 0 ? String(r.stdout ?? "").trim() : "");
  // Windows, or an answer that isn't a plain absolute path: nothing this mod knows how to read.
  // Plain path characters only: that machine's answer becomes part of the paths read there.
  if (!PLATFORM[os] || !/^\/[A-Za-z0-9._@+\/-]{0,4095}$/.test(home) || home.split("/").includes("..")) throw new ReadFailure("no-endpoint");
  return { home: home.replace(/\/+$/, "") || "/", platform: PLATFORM[os] };
}

// One reader per remote-readable provider on each machine, with ids like `claude@splinter`.
// The machine's home and platform are asked once per read and shared by its providers.
export function remoteAdapters(machines) {
  const places = new Map();
  return machines.filter(m => typeof m === "string" && MACHINE.test(m)).flatMap(on => REMOTE.map(base => ({
    id: `${base.id}@${on}`, label: `${base.label} on ${on}`,
    read: io => within(io, REMOTE_MS, (async () => {
      if (!places.has(on)) places.set(on, place(io, on));
      const where = await places.get(on);
      // A file read that fails (the machine dropped, no permission) is not a sign-out: the
      // earlier reading stays. Providers treat a failed read as "absent", so it is noted here.
      let broken = false;
      const there = { ...io, home: () => where.home, platform: where.platform,
        readTextFile: async path => { try { return await io.readTextFile(path, { on }); } catch { broken = true; return null; } },
        // Nothing else runs there: no Keychain lookup, so no prompt on a screen nobody is watching.
        exec: async () => { throw new ReadFailure("keychain"); },
        keychain: { allowed: false, granted: false, denied: false } };
      let found;
      try { found = await base.read(there); }
      catch (error) {
        if (broken) throw new ReadFailure("offline");
        if (error instanceof ReadFailure && error.message === "keychain") return { ...lane(base.id, base.label, io.now, { status: "keychain" }), machine: on };
        throw error;
      }
      if (broken) throw new ReadFailure("offline");
      return (Array.isArray(found) ? found : [found]).map(l => ({ ...l, machine: on }));
    })()),
  })));
}
