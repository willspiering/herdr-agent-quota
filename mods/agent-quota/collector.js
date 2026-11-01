import { parseReport, normalizeReport, QuotaError } from "./core.js";
import { ADAPTERS } from "./providers/index.js";
import { ReadFailure } from "./providers/common.js";

export const ARGS = ["--json", "--full", "--max-age", "90s", "--no-credential-refresh"];
// Herdr stops every exec at 30 s (herdr.d.ts). A read's supervisor never runs past the claim
// time plus this, and never longer than its own 24 s budget from launch.
export const READ_MS = 30000;
// quota-axi 0.1.69's providers (package.json pins that exact version), so a sweep can name the
// ones not read natively yet. Goes away with quota-axi.
const AXI_PROVIDERS = ["claude", "codex", "cursor", "copilot", "grok", "kimi", "zai", "agy", "alibaba", "opencode-go", "commandcode",
  "minimax", "mimo", "deepseek", "openrouter", "elevenlabs", "devin", "muse", "higgsfield"];

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const STOPPED = "Herdr stopped the quota read before it finished. Automatic retries will back off.";
const SETUP = "Quota collector needs setup. Run npm run setup in the Herdr Agent Quota project.";
// What a failed provider's reason tells the user to do. Our own words only.
function failureMessage(error, labels) {
  const who = labels.join(" and ");
  if (error?.message === "expired") return `${who}'s sign-in has expired. Open ${who} once to renew it; earlier readings were kept.`;
  if (error?.message === "keychain") return `${who} needs one Keychain approval: press Refresh in the quota dashboard and allow it.`;
  return `${who} quota could not be read. Earlier readings were kept; retries back off.`;
}

// Read quota: native providers through Herdr's fetch, the rest through quota-axi, side by side.
// `io`: { exec, fetch, readTextFile, home, platform, sleep, adapters? }.
// Returns { report, swept, read, failed }: `read` lists the provider ids this read replaced
// (null: everything, a complete sweep); `failed` is { message, ids } for providers that kept
// their earlier readings. Throws only when nothing could be read at all.
export async function collect(io, runtime = {}, now = Date.now(), providers = null, deadline = now + READ_MS) {
  const adapters = io.adapters ?? ADAPTERS, native = new Set(adapters.map(a => a.id));
  const ids = Array.isArray(providers) && providers.length && providers.every(id => ID.test(id)) ? providers : null;
  const own = adapters.filter(a => !ids || ids.includes(a.id));
  const axi = ids ? ids.filter(id => !native.has(id)) : native.size ? AXI_PROVIDERS.filter(id => !native.has(id)) : [];
  const axiReady = [runtime.node, runtime.collector, runtime.runner].every(p => typeof p === "string" && p.length > 0);
  // Without quota-axi set up, native providers still read; only the old path needs setup.
  const useAxi = native.size === 0 || (axi.length > 0 && axiReady);

  // Each native read must finish inside the read's deadline, Keychain lookup included; Herdr's
  // fetch can't be cancelled, so a late one is ignored and counts as a failure.
  const budget = Math.max(1000, deadline - Date.now() - 2000);
  const late = () => io.sleep(budget).then(() => { throw new ReadFailure("timeout"); });
  const reads = own.map(a => Promise.race([a.read({ ...io, now }), late()]).then(lane => ({ id: a.id, lane, error: null }), error => ({ id: a.id, lane: null, error })));
  const axiRead = useAxi ? collectAxi(io.exec, runtime, now, native.size ? axi : ids, deadline).then(r => ({ report: r.report, error: null }), error => ({ report: null, error })) : null;
  const [lanes, other] = await Promise.all([Promise.all(reads), axiRead]);

  // quota-axi alone keeps its old contract: a failure fails the read.
  if (!own.length && other?.error) throw other.error;
  const bad = lanes.filter(r => r.error), failed = bad.map(r => r.id), messages = [];
  if (failed.length) messages.push(failureMessage(bad[0].error, bad.map(r => adapters.find(a => a.id === r.id)?.label ?? r.id)));
  if (other?.error) { failed.push(...axi); messages.push(other.error instanceof QuotaError ? other.error.message : STOPPED); }
  // Providers only quota-axi reads, without it set up: they keep their readings and say why.
  if (!useAxi && axi.length) { failed.push(...axi); messages.push(SETUP); }
  const good = lanes.filter(r => !r.error);
  if (failed.length && !good.length && !other?.report) throw new QuotaError(messages[0].slice(0, 160));

  const mine = normalizeReport({ schemaVersion: 5, generatedAt: new Date(now).toISOString(), providers: good.map(r => r.lane) }, now);
  const report = { schema: 5, at: Math.min(mine.at, other?.report?.at ?? mine.at), providers: [...mine.providers, ...(other?.report?.providers ?? [])] };
  const sweep = ids === null;
  return {
    report, swept: sweep && !failed.length,
    read: sweep && !failed.length ? null : [...good.map(r => r.id), ...(other?.report ? (native.size ? axi : ids ?? []) : [])],
    failed: failed.length ? { message: messages[0].slice(0, 160), ids: failed } : null,
  };
}

// Always go through the bounded Node supervisor: it owns the collector's process group, a budget
// that ends before Herdr's cap, and the allowlist. Direct or login-shell fallbacks would not.
export async function collectAxi(exec, runtime = {}, now = Date.now(), providers = null, deadline = now + READ_MS) {
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

