// Claude Code's subscription limits, from the same OAuth usage endpoint Claude Code reads.
// Ported from quota-axi 0.1.69 providers/claude.js (MIT). Never refreshes the token: Anthropic
// rotates refresh tokens on use, so spending one here would sign the user out of Claude Code.
import { ReadFailure, obj, str, num, name as plain, clampPercent, limit, lane, getJson, parseJson } from "./common.js";

export const id = "claude";
export const label = "Claude";
const USAGE = "https://api.anthropic.com/api/oauth/usage";
const HEADERS = { "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.202", accept: "application/json" };
const KEYCHAIN = "Claude Code-credentials";
const FIVE_HOURS = 18000, SEVEN_DAYS = 604800;

function credential(text) {
  const data = parseJson(text);
  const oauth = obj(data?.claudeAiOauth) ?? data;
  const token = str(oauth?.accessToken) ?? str(oauth?.access_token);
  if (!token) return null;
  const at = num(oauth.expiresAt) ?? (typeof oauth.expiresAt === "string" ? Date.parse(oauth.expiresAt) : undefined);
  return { token, expiresAt: Number.isFinite(at) ? at : undefined, plan: plain(oauth.subscriptionType) ?? plain(data.subscriptionType) ?? null };
}

// Claude Code keeps its sign-in in the macOS Keychain (account: the login name), elsewhere in
// ~/.claude/.credentials.json. `security` is the only program a read runs, and only here.
// `io.keychain.allowed` false: reading the item could raise a prompt nobody asked for, so skip it.
async function signIn(io) {
  let text = null;
  try { text = await io.readTextFile(`${io.home()}/.claude/.credentials.json`); } catch { /* absent */ }
  const file = text ? credential(text) : null;
  if (io.platform !== "macos" || file) return file;
  if (io.keychain && !io.keychain.allowed) throw new ReadFailure("keychain");
  const user = io.home().split("/").filter(Boolean).pop() ?? "";
  for (const account of /^[a-zA-Z0-9._-]+$/.test(user) ? [["-a", user], []] : [[]]) {
    let result;
    try { result = await io.exec("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN, ...account, "-w"]); } catch { break; }
    if (result?.code === 0) {
      const found = credential(result.stdout);
      if (found && io.keychain) io.keychain.granted = true;
      return found;
    }
    if (result?.code !== 44) break; // 44: no such item for this account; anything else (denied) stops here
  }
  return null;
}

// The `limits` list is the vendor's own list of every window, model-scoped ones included; the
// fixed fields are the fallback. Ids match quota-axi's, so saved per-limit choices still apply.
function scoped(entry, now) {
  const e = obj(entry), percent = typeof e?.percent === "number" ? clampPercent(e.percent) : undefined;
  if (percent === undefined) return undefined;
  const resetsAt = str(e.resets_at), model = obj(obj(e.scope)?.model), name = plain(model?.display_name);
  if (name) {
    const key = plain(model.id) ?? name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    return limit(now, { id: `model:${key}`, label: `${name} week`, kind: "model", percentUsed: percent, resetsAt, windowSeconds: SEVEN_DAYS });
  }
  if (e.group === "session") return limit(now, { id: "five_hour", label: "session", kind: "session", percentUsed: percent, resetsAt, windowSeconds: FIVE_HOURS });
  if (e.group === "weekly") return limit(now, { id: "seven_day", label: "week", kind: "weekly", percentUsed: percent, resetsAt, windowSeconds: SEVEN_DAYS });
  const kind = plain(e.kind);
  return limit(now, { id: kind ?? "limit", label: kind ?? "limit", kind: "unknown", percentUsed: percent, resetsAt });
}
function fixed(raw, id, label, kind, now) {
  const w = obj(raw);
  if (typeof w?.utilization !== "number") return undefined;
  return limit(now, { id, label, kind, percentUsed: clampPercent(w.utilization), resetsAt: str(w.resets_at) ?? str(w.reset_at),
    windowSeconds: id === "five_hour" ? FIVE_HOURS : SEVEN_DAYS });
}
function extra(raw, now) {
  const x = obj(raw);
  if (x?.is_enabled !== true) return undefined;
  const divisor = 10 ** (typeof x.decimal_places === "number" ? x.decimal_places : 2);
  const spent = typeof x.used_credits === "number" ? x.used_credits / divisor : undefined;
  const cap = typeof x.monthly_limit === "number" ? x.monthly_limit / divisor : undefined;
  const percentUsed = typeof x.utilization === "number" ? clampPercent(x.utilization) : spent !== undefined && cap > 0 ? clampPercent(spent / cap * 100) : undefined;
  return limit(now, { id: "extra_usage", label: "extra usage", kind: "credits", percentUsed });
}
export function usageWindows(raw, now) {
  const data = obj(raw);
  if (!data) return [];
  const list = Array.isArray(data.limits) ? data.limits.map(e => scoped(e, now)).filter(Boolean) : [];
  const windows = list.length ? list : [fixed(data.five_hour, "five_hour", "session", "session", now),
    fixed(data.seven_day, "seven_day", "week", "weekly", now), fixed(data.seven_day_opus, "seven_day_opus", "opus week", "model", now)].filter(Boolean);
  const credits = extra(data.extra_usage, now);
  return credits ? [...windows, credits] : windows;
}

export async function read(io) {
  const now = io.now, signedOut = plan => lane(id, label, now, { status: "auth_required", plan });
  const sign = await signIn(io);
  if (!sign) return signedOut(null);
  const answer = await getJson(io, USAGE, { ...HEADERS, authorization: `Bearer ${sign.token}` });
  // A stored expiry is advisory, so the endpoint decides. A token that expired and was refused is
  // never refreshed here (Claude Code renews it on its next start): earlier readings stay, stale.
  if (answer.auth && sign.expiresAt !== undefined && sign.expiresAt <= now) throw new ReadFailure("expired");
  if (answer.auth) return signedOut(sign.plan);
  const windows = usageWindows(answer.body, now);
  if (!windows.length) throw new ReadFailure("malformed");
  return lane(id, label, now, { plan: sign.plan, windows });
}
