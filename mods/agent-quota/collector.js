import { parseReport, QuotaError } from "./core.js";

export const ARGS = ["--json", "--full", "--max-age", "90s", "--no-credential-refresh"];
// Herdr stops every exec at 30 s (herdr.d.ts). A read's supervisor never runs past the claim
// time plus this, and never longer than its own 24 s budget from launch.
export const READ_MS = 30000;

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const STOPPED = "Herdr stopped the quota read before it finished. Automatic retries will back off.";

// Always go through the bounded Node supervisor: it owns the collector's process group, a budget
// that ends before Herdr's cap, and the allowlist. Direct or login-shell fallbacks would not.
export async function collect(exec, runtime = {}, now = Date.now(), providers = null, deadline = now + READ_MS) {
  if (![runtime.node, runtime.collector, runtime.runner].every(p => typeof p === "string" && p.length > 0)) {
    throw new QuotaError("Quota collector needs setup. Run npm run setup in the Herdr Agent Quota project.");
  }
  const ids = Array.isArray(providers) && providers.length && providers.every(id => ID.test(id)) ? providers : [];
  let result;
  try { result = await exec(runtime.node, [runtime.runner, runtime.collector, String(deadline), ...ids]); }
  catch (error) {
    // Herdr rejects both when a program can't start and when it hits the 30 s cap. Only the
    // wording is inspected; it is never stored.
    if (/longer than|was stopped/i.test(error instanceof Error ? error.message : String(error))) throw new QuotaError(STOPPED);
    throw new QuotaError("Quota collector could not start. Run npm run setup in the Herdr Agent Quota project.");
  }
  const code = result?.code;
  if (code === 0 || code === 1) return { report: parseReport(result.stdout, now), swept: ids.length === 0 };
  if (code === 124) throw new QuotaError("Quota collection ran past its 24-second budget and was stopped. Automatic retries will back off.");
  if (code === 125) throw new QuotaError("Quota report exceeded the collection budget. Previous readings were kept.");
  if (code === 126 || code === 127) throw new QuotaError("Quota collector could not run. Run npm run setup, then retry.");
  if (typeof code !== "number" || code < 0 || code >= 128) throw new QuotaError(STOPPED);
  throw new QuotaError(`quota-axi exited with code ${code}. Run quota-axi in a terminal to check it.`);
}
