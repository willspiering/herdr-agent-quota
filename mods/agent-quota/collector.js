import { parseReport, QuotaError } from "./core.js";

export const ARGS = ["--json", "--full", "--max-age", "90s", "--no-credential-refresh"];

// Try the bundled executable first, then PATH and the user's login shell.
// All shell text is constant; no provider fields ever become executable text.
export async function collect(exec, runtime = {}, now = Date.now()) {
  const attempts = [];
  if (typeof runtime.node === "string" && typeof runtime.collector === "string") {
    attempts.push([runtime.node, [runtime.collector, ...ARGS]]);
  }
  attempts.push(["quota-axi", ARGS]);
  attempts.push(["sh", ["-c", 'exec "${SHELL:-/bin/sh}" -lic "quota-axi --json --full --max-age 90s --no-credential-refresh" </dev/null']]);
  for (const [command, args] of attempts) {
    let result;
    try { result = await exec(command, args); } catch { continue; }
    // Exit 1 may contain a valid report describing unavailable providers.
    if (result.code === 0 || result.code === 1) {
      return parseReport(result.stdout, now);
    }
    // A found executable failing is not a reason to repeat all provider calls.
    if (![126, 127].includes(result.code)) throw new QuotaError("Collector failed. Check quota-axi in a terminal, then retry.");
  }
  throw new QuotaError("Quota collector not found. Run npm run setup in the Herdr Agent Quota project.");
}

export function canCollect(control, now, force = false) {
  if (control?.until > now) return false;
  const wait = Math.min(600000, 120000 * 2 ** Math.min(control?.failures ?? 0, 3));
  return force ? now - (control?.attempt ?? 0) >= 10000 : now - (control?.attempt ?? 0) >= wait;
}
