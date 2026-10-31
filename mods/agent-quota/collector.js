import { parseReport, QuotaError } from "./core.js";

export const ARGS = ["--json", "--full", "--max-age", "90s", "--no-credential-refresh"];

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Herdr's exec has no timeout/cancellation option. Always use our bounded Node supervisor;
// direct executable and login-shell fallbacks would defeat that bound.
export async function collect(exec, runtime = {}, now = Date.now(), providers = null, deadline = now + 35000) {
  if (![runtime.node, runtime.collector, runtime.runner].every(p => typeof p === "string" && p.length > 0)) {
    throw new QuotaError("Quota collector needs setup. Run npm run setup in the Herdr Agent Quota project.");
  }
  const ids = Array.isArray(providers) && providers.length && providers.every(id => ID.test(id)) ? providers : [];
  let result;
  try { result = await exec(runtime.node, [runtime.runner, runtime.collector, String(deadline), ...ids]); }
  catch { throw new QuotaError("Quota collector could not start. Run npm run setup in the Herdr Agent Quota project."); }
  if (result.code === 124) throw new QuotaError("Quota collection exceeded 30 seconds. Automatic retries will back off.");
  if (result.code === 125) throw new QuotaError("Quota report exceeded the collection budget. Previous readings were kept.");
  if (result.code !== 0 && result.code !== 1) throw new QuotaError("Collector failed. Run npm run setup, then retry.");
  return { report: parseReport(result.stdout, now), swept: ids.length === 0 };
}
