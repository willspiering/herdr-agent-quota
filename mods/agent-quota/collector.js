import { parseReport, QuotaError } from "./core.js";

export const ARGS = ["--json", "--full", "--max-age", "90s", "--no-credential-refresh"];

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Try the bundled executable first, then PATH and the user's login shell.
// `providers` narrows a read to those ids, passed as one argv element. The login-shell
// fallback is constant text and always reads every provider.
export async function collect(exec, runtime = {}, now = Date.now(), providers = null) {
  const only = Array.isArray(providers) && providers.length && providers.every(id => ID.test(id)) ? ["--provider", providers.join(",")] : [];
  const attempts = [];
  if (typeof runtime.node === "string" && typeof runtime.collector === "string") {
    attempts.push([runtime.node, [runtime.collector, ...ARGS, ...only], only.length === 0]);
  }
  attempts.push(["quota-axi", [...ARGS, ...only], only.length === 0]);
  attempts.push(["sh", ["-c", 'exec "${SHELL:-/bin/sh}" -lic "quota-axi --json --full --max-age 90s --no-credential-refresh" </dev/null'], true]);
  for (const [command, args, swept] of attempts) {
    let result;
    try { result = await exec(command, args); } catch { continue; }
    // Exit 1 may contain a valid report describing unavailable providers.
    if (result.code === 0 || result.code === 1) {
      return { report: parseReport(result.stdout, now), swept };
    }
    // A found executable failing is not a reason to repeat all provider calls.
    if (![126, 127].includes(result.code)) throw new QuotaError("Collector failed. Check quota-axi in a terminal, then retry.");
  }
  throw new QuotaError("Quota collector not found. Run npm run setup in the Herdr Agent Quota project.");
}
