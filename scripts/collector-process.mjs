import { spawn } from "node:child_process";

export const COLLECTION_MS = 30000;
export const MAX_OUTPUT = 1024 * 1024;

// Own the deadline, output cap and process group even when a Herdr view closes/reloads.
// Subprocess stderr is discarded. Tests use shorter deadlines, never real credentials.
export function runBounded(command, args, { timeout = COLLECTION_MS, maxOutput = MAX_OUTPUT, grace = 250 } = {}) {
  return new Promise(resolve => {
    let child, timer, settled = false, bytes = 0;
    const chunks = [];
    const signal = sig => {
      if (!child?.pid) return;
      try {
        if (process.platform === "win32") child.kill(sig);
        else process.kill(-child.pid, sig);
      } catch { /* group already exited */ }
    };
    const finish = (code, stdout = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal("SIGTERM");
      // Helpers can inherit stdout and outlive the collector. Kill the entire group.
      setTimeout(() => { signal("SIGKILL"); resolve({ code, stdout }); }, grace);
    };
    try { child = spawn(command, args, { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"] }); }
    catch { finish(127); return; }
    timer = setTimeout(() => { chunks.length = 0; finish(124); }, timeout);
    child.stdout.on("data", chunk => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxOutput) { chunks.length = 0; finish(125); }
      else chunks.push(chunk);
    });
    child.on("error", () => finish(127));
    child.on("close", code => finish(code ?? 126,
      code === 0 || code === 1 ? Buffer.concat(chunks).toString("utf8") : ""));
  });
}
