import { spawn } from "node:child_process";
import { constants } from "node:os";

// Herdr stops any exec at 30 s (herdr.d.ts) by killing the process it started: the supervisor.
// The supervisor must therefore always finish first, measured from its own start:
// SUPERVISOR_MS + GRACE_MS + Node startup stays well under the cap.
export const HERDR_EXEC_CAP_MS = 30000;
export const SUPERVISOR_MS = 24000;
export const GRACE_MS = 250;
// After the collector exits, how long to wait for its output to drain when a helper still holds
// the pipe open. A finished read never waits for the kill grace.
export const DRAIN_MS = 150;
export const MAX_OUTPUT = 1024 * 1024;

const posix = process.platform !== "win32";
const signal = (pid, sig) => {
  try { if (posix) process.kill(-pid, sig); else process.kill(pid, sig); return true; }
  catch { return false; } // group already gone
};
// True while any process remains in the group (signal 0 only checks).
export const groupAlive = pid => Boolean(pid) && signal(pid, 0);

// Own the deadline, output cap and process group. Subprocess stderr is discarded.
// `onSpawn(pid)` reports the group id (the child's pid: detached makes it a group leader).
export function runBounded(command, args, { timeout = SUPERVISOR_MS, maxOutput = MAX_OUTPUT, grace = GRACE_MS, drain = DRAIN_MS, onSpawn = () => {}, env } = {}) {
  return new Promise(resolve => {
    let child, timer, drainTimer, settled = false, bytes = 0;
    const chunks = [];
    const output = code => code === 0 || code === 1 ? Buffer.concat(chunks).toString("utf8") : "";
    const finish = (code, stdout = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(drainTimer);
      child?.stdout?.destroy();
      // Helpers that inherited the group can outlive the collector. Ask, then insist; skip both
      // when nothing is left, so an ordinary read returns at once.
      if (!groupAlive(child?.pid)) { resolve({ code, stdout }); return; }
      signal(child.pid, "SIGTERM");
      setTimeout(() => { signal(child.pid, "SIGKILL"); resolve({ code, stdout }); }, grace);
    };
    try { child = spawn(command, args, { detached: posix, stdio: ["ignore", "pipe", "ignore"], ...(env ? { env } : {}) }); }
    catch { finish(127); return; }
    if (child.pid) onSpawn(child.pid);
    timer = setTimeout(() => { chunks.length = 0; finish(124); }, timeout);
    child.stdout.on("data", chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxOutput) { chunks.length = 0; finish(125); }
      else chunks.push(chunk);
    });
    child.on("error", () => finish(127));
    // `exit` is the collector's own result. `close` also waits for every process holding its
    // stdout, which a helper can keep open indefinitely: drain briefly, then finish.
    child.on("exit", (code, sig) => {
      if (code === null) { finish(128 + (constants.signals[sig] ?? 0)); return; } // killed by a signal
      if (code !== 0 && code !== 1) { finish(code); return; }
      drainTimer = setTimeout(() => finish(code, output(code)), drain);
    });
    child.on("close", (code, sig) => finish(code ?? 128 + (constants.signals[sig] ?? 0), output(code)));
  });
}
