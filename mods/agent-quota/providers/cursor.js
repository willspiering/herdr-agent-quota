// Cursor's plan usage, from the DashboardService RPCs the Cursor editor reads.
// Ported from quota-axi 0.1.69 providers/cursor.js and cursor-cli-credential.js (MIT). Never
// refreshes a token: neither Cursor refresh token is read, and a refused token is signed out.
import { ReadFailure, REQUEST_MS, within, hostOf, obj, str, num, name as plain, clampPercent, limit, lane, parseJson } from "./common.js";

export const id = "cursor";
export const label = "Cursor";
const API = "https://api2.cursor.sh/aiserver.v1.DashboardService/";
const KEYCHAIN = ["-a", "cursor-user", "-s", "cursor-access-token"];
const SQLITE = "/usr/bin/sqlite3";
const TOKEN_KEY = "cursorAuth/accessToken", PLAN_KEY = "cursorAuth/stripeMembershipType";

// The editor keeps its sign-in in a SQLite database (state.vscdb), which only sqlite3 can open:
// a read-only query for the token and plan, never the cached email. Without sqlite3 (Windows, a
// Linux without it) the editor store reads as absent, and the CLI store is the only source.
function editorDb(io) {
  const home = io.home();
  if (io.platform === "macos") return `${home}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
  if (io.platform === "linux") return `${home}/.config/Cursor/User/globalStorage/state.vscdb`;
  return null;
}
async function editorSignIn(io) {
  const path = editorDb(io);
  if (!path) return { missing: true };
  let result;
  try {
    // -init /dev/null: never run the user's ~/.sqliterc, which could redirect the token's output.
    result = await within(io, 5000, io.exec(SQLITE, ["-readonly", "-init", "/dev/null", "-ascii", path,
      `select key, value from ItemTable where key in ('${TOKEN_KEY}', '${PLAN_KEY}');`]));
  } catch { return { missing: true }; } // no sqlite3 to run
  if (result?.code !== 0) {
    // A database that isn't there is a sign-out; one that won't open may still hold a sign-in.
    return /no such file|unable to open database/i.test(result?.stderr ?? "") ? { missing: true } : { unreadable: true };
  }
  const values = {};
  for (const row of String(result.stdout ?? "").split("\x1e")) {
    const [key, value] = row.split("\x1f");
    if (key && value !== undefined) values[key.trim()] = stateValue(value);
  }
  const token = values[TOKEN_KEY];
  return token ? { token, membership: values[PLAN_KEY] } : { missing: true };
}
// Values are JSON strings or bare text, as quota-axi reads them.
function stateValue(raw) {
  const value = raw.trim();
  if (!value) return undefined;
  try { const parsed = JSON.parse(value); return typeof parsed === "string" && parsed.length > 0 ? parsed : undefined; }
  catch { return value; }
}

// The Cursor CLI (cursor-agent): on Linux a plain auth.json; on macOS the token sits in the login
// Keychain, read only when cli-config.json says the CLI is signed in. `security` is the only
// program this runs there. With `io.keychain.allowed` false, a presence check (no -w, so no
// prompt and no secret) tells a missing item from one that needs an approval.
async function cliSignIn(io) {
  const home = io.home();
  if (io.platform === "linux") {
    let text = null;
    try { text = await io.readTextFile(`${home}/.config/cursor/auth.json`); } catch { /* absent */ }
    const token = str(parseJson(text ?? "")?.accessToken)?.trim();
    return token ? { token } : { missing: true };
  }
  if (io.platform !== "macos") return { missing: true };
  let config = null;
  try { config = await io.readTextFile(`${home}/.cursor/cli-config.json`); } catch { /* absent */ }
  if (config) {
    const data = parseJson(config);
    if (!data) return { unreadable: true };
    const auth = obj(data.authInfo);
    if (!(str(auth?.email) || str(auth?.userId) || str(auth?.authId))) return { missing: true };
  } else return { missing: true };
  if (io.keychain && !io.keychain.allowed) {
    let probe;
    try { probe = await io.exec("/usr/bin/security", ["find-generic-password", ...KEYCHAIN]); } catch { probe = null; }
    if (probe?.code === 44) return { missing: true };
    throw new ReadFailure("keychain");
  }
  let result;
  try { result = await io.exec("/usr/bin/security", ["find-generic-password", ...KEYCHAIN, "-w"]); } catch { throw new ReadFailure("keychain"); }
  if (result?.code === 44) return { missing: true };
  if (result?.code !== 0) { if (io.keychain) io.keychain.denied = true; throw new ReadFailure("keychain"); } // denied or timed out
  if (io.keychain) io.keychain.granted = true;
  const token = String(result.stdout ?? "").trim();
  return token ? { token } : { unreadable: true };
}

// POST a Connect RPC. A refused credential is an answer ({ auth: true }), not a failure.
async function rpc(io, method, token) {
  const url = `${API}${method}`;
  let response;
  try {
    response = await within(io, REQUEST_MS, io.fetch(url, { method: "POST", body: "{}", headers: {
      authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json", "connect-protocol-version": "1" } }));
  } catch { throw new ReadFailure("unreachable"); }
  // Only Cursor's own host may answer; an answer redirected elsewhere is discarded.
  if (hostOf(response.url || url) !== hostOf(url)) throw new ReadFailure("redirected");
  if (response.status === 401 || response.status === 403) return { auth: true };
  if (response.status === 429) throw new ReadFailure("rate-limited");
  if (!response.ok) throw new ReadFailure("server");
  try { return { body: await within(io, REQUEST_MS, response.json()) }; }
  catch { throw new ReadFailure("malformed"); }
}

// Epoch milliseconds, epoch seconds or an ISO string, as quota-axi's parseEpochMillisOrIso.
function time(value) {
  const n = num(value);
  if (n !== undefined) { const d = new Date(n > 10000000000 ? n : n * 1000); return Number.isFinite(d.getTime()) ? d.toISOString() : undefined; }
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}
// quota-axi's calendarMonthsBefore: the previous renewal, one calendar month back.
function monthBefore(iso) {
  const reset = new Date(iso), at = reset.getTime();
  if (!Number.isFinite(at)) return undefined;
  const day = reset.getUTCDate(), start = new Date(at);
  start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() - 1);
  start.setUTCDate(Math.min(day, new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate()));
  return Number.isFinite(start.getTime()) && start.getTime() < at ? start.toISOString() : undefined;
}

// Cursor windows carry no fixed length (windowSeconds stays unknown, as in quota-axi); pace is
// measured over the billing cycle from its start to its reset, as quota-axi's starts_at basis.
function cycleWindow(now, w, startsAt) {
  const out = limit(now, w), start = Date.parse(startsAt ?? ""), reset = Date.parse(out.resetsAt ?? "");
  if (out.percentUsed === null || !Number.isFinite(start) || !Number.isFinite(reset) || reset <= now || start >= reset || start > now) return out;
  const remaining = 100 * (reset - now) / (reset - start), reserve = (100 - out.percentUsed) - remaining;
  return { ...out, pace: { status: Math.abs(reserve) <= 1 ? "on_pace" : reserve < 0 ? "ahead" : "behind", timeRemainingPercent: Math.round(remaining * 1e4) / 1e4 } };
}

const pick = (data, camel, snake) => data[camel] !== undefined ? data[camel] : data[snake];
function grokBot(raw, now) {
  const data = obj(raw);
  if (!data || pick(data, "usesPooledEnterpriseAllowance", "uses_pooled_enterprise_allowance") === true) return undefined;
  const percent = num(pick(data, "usagePercent", "usage_percent"));
  if (percent === undefined) return undefined;
  return cycleWindow(now, { id: "grok_bot", label: "Grok Bot", kind: "weekly", percentUsed: clampPercent(percent),
    resetsAt: time(pick(data, "nextResetTimestampUtc", "next_reset_timestamp_utc")) }, time(pick(data, "currentPeriodStart", "current_period_start")));
}

// Ids, labels and kinds match quota-axi's, so saved per-limit choices still apply.
export function usageWindows(usage, planInfo, sand, now) {
  const data = obj(usage) ?? {}, info = obj(obj(planInfo)?.planInfo);
  const reset = time(data.billingCycleEnd) ?? time(info?.billingCycleEnd);
  const start = time(data.billingCycleStart) ?? time(info?.billingCycleStart) ?? (reset === undefined ? undefined : monthBefore(reset));
  const pools = obj(data.planUsage), windows = [];
  for (const [field, wid, wlabel] of [["totalPercentUsed", "included_usage", "included usage"], ["autoPercentUsed", "auto_usage", "auto usage"], ["apiPercentUsed", "api_usage", "API usage"]]) {
    const used = num(pools?.[field]);
    if (used !== undefined) windows.push(cycleWindow(now, { id: wid, label: wlabel, kind: "monthly", percentUsed: clampPercent(used), resetsAt: reset }, start));
  }
  const spend = obj(data.spendLimitUsage), cap = num(spend?.individualLimit), left = num(spend?.individualRemaining);
  const spent = num(spend?.individualUsed) ?? (cap !== undefined && left !== undefined ? cap - left : undefined);
  if (cap > 0) windows.push(limit(now, { id: "spend_limit", label: "spend limit", kind: "credits", percentUsed: spent === undefined ? undefined : clampPercent(spent / cap * 100), resetsAt: reset }));
  const bot = grokBot(sand, now);
  if (bot) windows.push(bot);
  return windows;
}
// The plan quota-axi names: the plan info's name or price, else the editor's stored membership.
export function planName(planInfo, membership) {
  const info = obj(obj(planInfo)?.planInfo);
  return plain(str(info?.planName) ?? str(info?.price) ?? membership) ?? null;
}

async function usage(io, sign, now) {
  const [current, plan, sand] = await Promise.allSettled(["GetCurrentPeriodUsage", "GetPlanInfo", "GetSandUsageStatus"].map(m => rpc(io, m, sign.token)));
  if (current.status === "rejected") throw current.reason;
  if (current.value.auth) return null;
  const body = r => r.status === "fulfilled" && !r.value.auth ? r.value.body : undefined;
  const windows = usageWindows(current.value.body, body(plan), body(sand), now);
  if (!windows.length) throw new ReadFailure("malformed");
  return lane(id, label, now, { plan: planName(body(plan), sign.membership), windows });
}

// The editor store comes first (it never prompts); the CLI store is read when the editor's is
// absent, unreadable, or its token was refused. Only the endpoint decides whether a token works.
export async function read(io) {
  const now = io.now, signedOut = () => lane(id, label, now, { status: "auth_required" });
  const editor = await editorSignIn(io);
  if (editor.token) {
    const answer = await usage(io, editor, now);
    if (answer) return answer;
    if (io.platform !== "macos" && io.platform !== "linux") return signedOut();
    const cli = await cliSignIn(io);
    if (cli.unreadable) throw new ReadFailure("unreadable");
    return cli.token ? (await usage(io, cli, now)) ?? signedOut() : signedOut();
  }
  const cli = await cliSignIn(io);
  if (cli.token) return (await usage(io, cli, now)) ?? signedOut();
  // A store that holds a sign-in it couldn't give up is not a sign-out: earlier readings stay.
  if (editor.unreadable || cli.unreadable) throw new ReadFailure("unreadable");
  return signedOut();
}
