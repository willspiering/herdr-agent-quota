// Codex's ChatGPT plan limits, from the usage endpoints the Codex CLI reads.
// Ported from quota-axi 0.1.69 providers/codex.js (MIT). Never refreshes the token.
import { ReadFailure, obj, str, num, name as plain, clampPercent, isoTime, limit, lane, getJson, parseJson, jwtPayload } from "./common.js";

export const id = "codex";
export const label = "Codex";
const ENDPOINTS = ["https://chatgpt.com/backend-api/wham/usage", "https://chatgpt.com/backend-api/codex/usage"];
// quota-axi's key for the ~/.codex sign-in: every limit's saved-choice key includes it.
const ACCOUNT = "codex-home";

async function signIn(io) {
  let text = null;
  try { text = await io.readTextFile(`${io.home()}/.codex/auth.json`); } catch { /* absent */ }
  const tokens = obj(parseJson(text ?? "")?.tokens);
  const token = str(tokens?.access_token) ?? str(tokens?.accessToken);
  if (!token) return null;
  const decoded = jwtPayload(str(tokens.id_token) ?? str(tokens.idToken)) ?? jwtPayload(token);
  const account = str(tokens.account_id) ?? str(tokens.accountId) ?? str(decoded?.["https://api.openai.com/auth/account_id"]) ?? str(decoded?.account_id);
  return { token, account };
}

const hours = seconds => { const h = seconds / 3600; return `${Number.isInteger(h) ? h : Number(h.toFixed(2))}h`; };
// A 5-hour and a weekly window keep fixed ids; any other length is named by its duration.
function window(raw, fallback, names, now) {
  const w = obj(raw), used = num(w?.used_percent) ?? num(w?.usedPercent);
  if (used === undefined) return undefined;
  const minutes = num(w.windowDurationMins);
  const windowSeconds = num(w.limit_window_seconds) ?? (minutes === undefined ? undefined : minutes * 60);
  const after = num(w.reset_after_seconds);
  const name = windowSeconds === undefined ? fallback : windowSeconds === 18000 ? names.session : windowSeconds === 604800 ? names.weekly : names.other(windowSeconds);
  return limit(now, { ...name, percentUsed: clampPercent(used), windowSeconds,
    resetsAt: isoTime(w.reset_at) ?? isoTime(w.resetsAt) ?? (after === undefined ? undefined : new Date(now + after * 1000).toISOString()) });
}
function pair(container, names, now) {
  const c = obj(container);
  if (!c) return [];
  return [window(c.primary_window ?? c.primary, names.session, names, now), window(c.secondary_window ?? c.secondary, names.weekly, names, now)].filter(Boolean);
}
const base = (session, weekly, prefix) => ({ session, weekly, other: s => ({ id: `${prefix}:${hours(s)}`, label: `${hours(s)} window`, kind: "unknown" }) });
const named = (key, label) => ({
  session: { id: `model:${key}:5h`, label: `${label} session`, kind: "model" },
  weekly: { id: `model:${key}:7d`, label: `${label} week`, kind: "model" },
  other: s => ({ id: `model:${key}:window:${hours(s)}`, label: `${label} ${hours(s)} window`, kind: "model" }),
});
function spendControl(raw, now) {
  const control = obj(raw), cap = obj(control?.individual_limit);
  if (!cap) return [];
  const total = num(cap.limit), used = num(cap.used), left = num(cap.remaining);
  const totals = total > 0 && used >= 0 && left >= 0;
  const bounded = v => v === undefined ? undefined : Math.min(100, Math.max(0, v));
  const at = num(cap.reset_at), after = num(cap.reset_after_seconds);
  const resetMs = at !== undefined ? at * 1000 : after >= 0 ? now + after * 1000 : undefined;
  return [limit(now, { id: "spend_control", label: "workspace credit cap", kind: "credits",
    percentUsed: control.reached === true ? 100 : bounded(totals ? used / total * 100 : num(cap.used_percent)),
    resetsAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : undefined })];
}
export function usageWindows(raw, now) {
  const data = obj(raw);
  if (!data) return [];
  const rate = obj(data.rate_limit) ?? obj(data.rateLimits) ?? obj(data.rate_limits) ?? data;
  const windows = [
    ...pair(rate, base({ id: "five_hour", label: "session", kind: "session" }, { id: "weekly", label: "week", kind: "weekly" }, "window"), now),
    ...pair(data.code_review_rate_limit, base({ id: "code_review_five_hour", label: "code review session", kind: "session" }, { id: "code_review_weekly", label: "code review week", kind: "weekly" }, "code_review_window"), now),
  ];
  for (const entry of Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : []) {
    const item = obj(entry), key = plain(item?.metered_feature) ?? plain(item?.limit_name), label = plain(item?.limit_name) ?? key;
    if (key && label && obj(item.rate_limit)) windows.push(...pair(item.rate_limit, named(key, label), now));
  }
  for (const [key, value] of Object.entries(obj(data.rateLimitsByLimitId) ?? {})) {
    const label = plain(obj(value)?.limitName) ?? plain(obj(value)?.limit_name);
    if (label && plain(key)) windows.push(...pair(value, named(key, label), now));
  }
  windows.push(...spendControl(data.spend_control, now));
  // A repeated id gets a numeric suffix, as quota-axi does.
  const seen = new Map();
  return windows.map(w => { const n = (seen.get(w.id) ?? 0) + 1; seen.set(w.id, n); return n === 1 ? w : { ...w, id: `${w.id}_${n}` }; });
}

export async function read(io) {
  const now = io.now, signedOut = () => lane(id, label, now, { account: ACCOUNT, status: "auth_required" });
  const sign = await signIn(io);
  if (!sign) return signedOut();
  const headers = { authorization: `Bearer ${sign.token}`, accept: "application/json", ...(sign.account ? { "ChatGPT-Account-Id": sign.account } : {}) };
  // The first endpoint is current; the second is the older path. Only the endpoint decides
  // whether a token works: a stored expiry is not checked first.
  let rejected = false, failure = null;
  for (const url of ENDPOINTS) {
    try {
      const answer = await getJson(io, url, headers);
      if (answer.auth) { rejected = true; continue; }
      const windows = usageWindows(answer.body, now);
      if (windows.length) return lane(id, label, now, { account: ACCOUNT, plan: plain(answer.body.plan_type) ?? plain(answer.body.planType) ?? null, windows });
      failure = new ReadFailure("malformed");
    } catch (error) {
      if (error instanceof ReadFailure && error.message === "rate-limited") throw error;
      failure = error instanceof ReadFailure ? error : new ReadFailure("unreachable");
    }
  }
  if (failure) throw failure;
  if (rejected) return signedOut();
  throw new ReadFailure("malformed");
}
