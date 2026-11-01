import { normalizeReport, QuotaError } from "./core.js";
import { ADAPTERS } from "./providers/index.js";
import { ReadFailure } from "./providers/common.js";

// The longest a read runs. Native reads race their own timer, so a hung request, a Keychain prompt
// left open or a slow local process never holds the read past this; the claim outlives it.
export const READ_MS = 25000;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Not failures: the provider is fine but has nothing to read now (Antigravity closed, a sign-in
// without consumer credits, an app that exposes no endpoint). Earlier readings stay and age to
// stale; nothing backs off and no error is shown.
const QUIET = new Set(["not-running", "no-quota", "no-endpoint"]);
// What failed providers' reasons tell the user to do. Our own words only. A specific hint only
// when every failed provider shares it, so one provider's reason is never pinned on another.
function failureMessage(failures) {
  const labels = failures.map(f => f.label), reasons = new Set(failures.map(f => f.error?.message));
  // Short enough that the instruction always survives the 160-character limit.
  const who = labels.length > 2 ? `${labels.slice(0, 2).join(", ")} and ${labels.length - 2} more` : labels.join(" and ");
  const one = reasons.size === 1 ? [...reasons][0] : null;
  if (one === "expired") return `${who}: sign-in expired. Open it once to renew; earlier readings were kept.`;
  if (one === "keychain") return `${who}: needs one Keychain approval. Press Refresh in the quota dashboard and allow it.`;
  return `${who}: quota could not be read. Earlier readings were kept; retries back off.`;
}

// Read quota with Herdr's fetch, every selected provider side by side.
// `io`: { exec, fetch, readTextFile, home, platform, sleep, adapters?, keychain?(id) }: each
// provider gets its own Keychain consent ({ allowed, granted }), never another provider's.
// `providers`: ids to read, or null for a sweep of every provider.
// Returns { report, swept, read, failed }: `read` lists the provider ids this read replaced
// (null: everything, a complete sweep); `failed` is { message, ids } for providers that kept
// their earlier readings. Throws only when nothing could be read at all.
export async function collect(io, now = Date.now(), providers = null, deadline = now + READ_MS) {
  const adapters = io.adapters ?? ADAPTERS;
  const ids = Array.isArray(providers) && providers.length && providers.every(id => ID.test(id)) ? providers : null;
  const own = adapters.filter(a => !ids || ids.includes(a.id));
  // Each read must finish inside the deadline, Keychain lookup included; Herdr's fetch can't be
  // cancelled, so a late one is ignored and counts as a failure.
  // One deadline for the whole read, raced by every provider.
  const late = io.sleep(Math.max(1000, deadline - Date.now() - 2000)).then(() => { throw new ReadFailure("timeout"); });
  const keychain = id => typeof io.keychain === "function" ? io.keychain(id) : io.keychain;
  // Each provider is validated on its own, so one malformed answer fails only that provider.
  const generatedAt = new Date(now).toISOString();
  // Started inside a promise, so even an adapter that throws at once fails only itself.
  const results = await Promise.all(own.map(a => Promise.race([Promise.resolve().then(() => a.read({ ...io, now, keychain: keychain(a.id) })), late])
    .then(lane => ({ id: a.id, label: a.label ?? a.id, providers: normalizeReport({ schemaVersion: 5, generatedAt, providers: Array.isArray(lane) ? lane : [lane] }, now).providers, error: null }))
    .catch(error => ({ id: a.id, label: a.label ?? a.id, providers: [], error }))));

  const quiet = results.filter(r => r.error instanceof ReadFailure && QUIET.has(r.error.message));
  const bad = results.filter(r => r.error && !quiet.includes(r)), good = results.filter(r => !r.error);
  const message = bad.length ? failureMessage(bad).slice(0, 160) : null;
  if (bad.length && !good.length && !quiet.length) throw new QuotaError(message);
  const report = { schema: 5, at: now, providers: good.flatMap(r => r.providers) };
  // A sweep replaces everything only when every provider answered; otherwise it merges. A quiet
  // provider isn't failing, so its old stale flag clears (`cleared`) though its reading stays.
  // Waiting for a Keychain approval is the user's to give, not a reason to back everything off.
  const complete = ids === null && !bad.length && !quiet.length;
  return { report, swept: complete, read: complete ? null : good.map(r => r.id), cleared: complete ? null : [...good, ...quiet].map(r => r.id),
    failed: bad.length ? { message, ids: bad.map(r => r.id), backoff: bad.some(r => r.error?.message !== "keychain") } : null };
}
