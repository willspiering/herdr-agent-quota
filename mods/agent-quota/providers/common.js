// Shared pieces of the native provider reads. Endpoints, identities and pace follow quota-axi
// 0.1.69 (MIT, github.com/kunchenguid/quota-axi) so readings and saved choices carry over.
//
// Credentials stay in the local variables of one read. Nothing here returns, stores, logs or
// puts a token in an error message: failures carry only the fixed reasons below.

// One request's bound. Herdr's fetch has no abort, so a late answer is ignored, never awaited.
export const REQUEST_MS = 12000;

// A read that could not finish: unreachable, timed out, rate-limited, a server error or a
// response we don't recognize. The provider keeps its earlier reading, marked stale.
export class ReadFailure extends Error {}

// Vendor-supplied names (limit names, model names, plans) end up in shared state that every mod
// can read; only plain short names are kept, so a stray email or token can never ride along.
export const name = v => typeof v === "string" && /^[\w .:()+\/-]{1,64}$/.test(v) && !v.includes("@") ? v : undefined;
export const obj = v => v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
export const str = v => typeof v === "string" && v.length > 0 ? v : undefined;
export function num(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
// quota-axi reports whole percentages.
export const clampPercent = v => Math.min(100, Math.max(0, Math.round(v)));
// Epoch seconds or an ISO string, as an ISO string; anything else is unknown.
export function isoTime(value) {
  const ms = typeof value === "number" && Number.isFinite(value) ? value * 1000 : typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

// quota-axi's computeWindowPace, reduced to the two fields the mod keeps: reserve within one
// point of zero is on pace; less headroom than time left is ahead of pace.
export function windowPace(w, now) {
  const unknown = { status: "unknown", timeRemainingPercent: null };
  const resetsAt = Date.parse(w.resetsAt ?? "");
  if (w.percentUsed === null || !Number.isFinite(resetsAt) || resetsAt <= now || !(w.windowSeconds > 0)) return unknown;
  const span = w.windowSeconds * 1000;
  // A cycle that hasn't started. An unused window restarts from the server's clock, a moment after
  // the read began, so a start up to five minutes ahead counts as now (quota-axi measures from
  // the end of its read instead).
  if (resetsAt - span > now + 300000) return unknown;
  const remaining = 100 * (resetsAt - now) / span, reserve = (100 - w.percentUsed) - remaining;
  return { status: Math.abs(reserve) <= 1 ? "on_pace" : reserve < 0 ? "ahead" : "behind", timeRemainingPercent: Math.round(remaining * 1e4) / 1e4 };
}

/**
 * One limit, in the report shape core.normalizeReport validates.
 * @param {number} now
 * @param {{ id: string, label: string, kind: string, percentUsed?: number, resetsAt?: string, windowSeconds?: number }} w
 */
export function limit(now, { id, label, kind, percentUsed, resetsAt, windowSeconds }) {
  const w = { id, label, kind, percentUsed: percentUsed ?? null, resetsAt: resetsAt ?? null, windowSeconds: windowSeconds ?? null };
  return { ...w, pace: windowPace(w, now) };
}

// One account lane. quota-axi names a provider's only lane by its credential key ("default",
// "codex-home"), which becomes part of every limit's saved-choice key, so it is kept as is.
export function lane(provider, label, now, { account = "default", plan = null, status = "fresh", windows = [] } = {}) {
  return { provider, accountKey: "", accountKeys: [account], label, plan, untrustedWindowIds: [], windows,
    state: { status, stale: false, reused: false, refreshedAt: new Date(now).toISOString() } };
}

// Race a promise against the read's own timer.
export function within(io, ms, promise) {
  return Promise.race([promise, io.sleep(ms).then(() => { throw new ReadFailure("timeout"); })]);
}

// GET a JSON document. A rejected credential is an answer ({ auth: true }), not a failure.
export async function getJson(io, url, headers) {
  let response;
  try { response = await within(io, REQUEST_MS, io.fetch(url, { headers })); }
  catch { throw new ReadFailure("unreachable"); }
  // Only the vendor's own host may answer. Herdr's fetch follows redirects and has no option to
  // refuse them, so an answer from anywhere else is discarded, never used.
  if (hostOf(response.url || url) !== hostOf(url)) throw new ReadFailure("redirected");
  if (response.status === 401 || response.status === 403) return { auth: true };
  if (response.status === 429) throw new ReadFailure("rate-limited");
  if (!response.ok) throw new ReadFailure("server");
  try { return { body: await within(io, REQUEST_MS, response.json()) }; }
  catch { throw new ReadFailure("malformed"); }
}

// The host of an https URL (Herdr's runtime has no global URL).
export const hostOf = url => /^https:\/\/([^/?#@]+)(?:[/?#]|$)/i.exec(typeof url === "string" ? url : "")?.[1].toLowerCase() ?? null;

export function parseJson(text) {
  try { return obj(JSON.parse(text)); } catch { return undefined; }
}

// A JWT's payload, decoded without trusting it: only read for an expiry or an account id.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export function jwtPayload(token) {
  const part = typeof token === "string" ? token.split(".")[1] : undefined;
  if (!part || part.length > 16384) return undefined;
  let bits = 0, value = 0, escaped = "";
  for (const c of part.replace(/=+$/, "")) {
    const i = B64.indexOf(c === "+" ? "-" : c === "/" ? "_" : c);
    if (i < 0) return undefined;
    value = (value << 6) | i; bits += 6;
    if (bits >= 8) { bits -= 8; escaped += `%${((value >> bits) & 255).toString(16).padStart(2, "0")}`; value &= (1 << bits) - 1; }
  }
  try { return obj(JSON.parse(decodeURIComponent(escaped))); } catch { return undefined; }
}
