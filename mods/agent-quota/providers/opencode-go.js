// OpenCode Go's plan caps ($12 per rolling 5 hours, $30 per week, $60 per month), from the usage
// endpoint OpenCode reads. Ported from quota-axi 0.1.69 providers/opencode-go.js (MIT).
// The key is a plain API key: there is nothing to refresh.
import { ReadFailure, obj, num, name as plain, clampPercent, limit, lane, getJson, within } from "./common.js";

export const id = "opencode-go";
export const label = "OpenCode Go";
const USAGE = "https://opencode.ai/zen/go/v1/usage";
const FIVE_HOURS = 18000, WEEK = 604800;
// The plan's three stacked caps: the payload fields that carry each, its slot and kind.
const CAPS = [
  { fields: ["rollingUsage", "rolling"], slot: "five_hour", kind: "session" },
  { fields: ["weeklyUsage", "weekly"], slot: "weekly", kind: "weekly" },
  { fields: ["monthlyUsage", "monthly"], slot: "monthly", kind: "monthly" },
];
// OpenCode 2.x's login lives in its SQLite database; `sqlite3 -readonly` is the only program a
// read runs, and only here. macOS ships it; elsewhere it is looked for in the usual places.
const SQLITE = { macos: ["/usr/bin/sqlite3"], linux: ["/usr/bin/sqlite3", "/usr/local/bin/sqlite3"] };
const SQLITE_MS = 5000;
const QUERY = "select 'v' || value from credential where integration_id = 'opencode-go' order by active desc, time_created desc, id desc limit 1;";

// quota-axi's usableLiteralSecret: sent verbatim in a header, never a `$VAR` or `!command`.
function literal(value) {
  if (typeof value !== "string" || !value.trim() || value.startsWith("!") || value.includes("$")) return undefined;
  return [...value].some(c => c.charCodeAt(0) <= 0x1f || c.charCodeAt(0) === 0x7f) ? undefined : value;
}

// quota-axi's data folder: XDG_DATA_HOME and LOCALAPPDATA aren't visible here, so their defaults.
const dataDir = io => io.platform === "windows" ? `${io.home()}/AppData/Local/opencode` : `${io.home()}/.local/share/opencode`;

// Each source answers { status: "available", key } | { status: "missing" | "invalid" | "error" }.
async function fromDatabase(io) {
  const bins = SQLITE[io.platform];
  if (!bins) return { status: "missing" };
  const path = `${dataDir(io)}/opencode.db`;
  for (const bin of bins) {
    let result;
    try { result = await within(io, SQLITE_MS, io.exec(bin, ["-readonly", "-init", "/dev/null", "-list", "-noheader", path, QUERY])); }
    catch (error) {
      if (error instanceof ReadFailure) return { status: "error" };
      continue; // not installed here
    }
    if (result?.code !== 0) {
      const why = String(result?.stderr ?? "");
      // No file, or a 1.x database without the table: nothing was stored here.
      return /no such table|unable to open database/i.test(why) ? { status: "missing" } : { status: "error" };
    }
    const line = String(result.stdout ?? "").replace(/\r?\n$/, "");
    if (!line.startsWith("v")) return { status: "missing" };
    let value;
    try { value = JSON.parse(line.slice(1)); } catch { return { status: "invalid" }; }
    const key = obj(value)?.type === "key" ? literal(value.key) : undefined;
    return key ? { status: "available", key } : { status: "invalid" };
  }
  // Without sqlite3 the database can't be checked; quota-axi would skip an existing one.
  return { status: "missing" };
}

async function fromAuthFile(io) {
  let text;
  try { text = await io.readTextFile(`${dataDir(io)}/auth.json`); } catch { return { status: "error" }; }
  if (text === null || text === undefined) return { status: "missing" };
  let root;
  try { root = obj(JSON.parse(text)); } catch { return { status: "invalid" }; }
  if (!root) return { status: "missing" };
  let entry = false;
  for (const name of ["opencode-go", "opencode"]) {
    const e = obj(root[name]);
    if (!e) continue;
    entry = true;
    const key = [e.key, e.apiKey, e.api_key, e.access, e.token].map(literal).find(k => k !== undefined);
    if (key) return { status: "available", key };
  }
  return { status: entry ? "invalid" : "missing" };
}

// quota-axi's parseEpochOrIso, guarded: epoch seconds or a date string, else unknown.
const isoAt = ms => { const date = new Date(ms); return Number.isNaN(date.getTime()) ? undefined : date.toISOString(); };
const resetTime = value => isoAt(typeof value === "number" && Number.isFinite(value) ? value * 1000 : typeof value === "string" && value.trim() ? Date.parse(value) : NaN);
const first = (record, keys, read) => keys.map(k => read(record[k])).find(v => v !== undefined);

function window(record, slot, kind, now) {
  const used = first(record, ["percent", "percentUsed", "usedPercent", "usagePercent"], num);
  const remainingRaw = first(record, ["percentRemaining", "remainingPercent"], num);
  const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : undefined;
  const remaining = remainingRaw !== undefined ? clampPercent(remainingRaw) : used !== undefined ? clampPercent(100 - used) : status === "rate-limited" ? 0 : undefined;
  if (remaining === undefined) return undefined;
  // The first reset field present decides, even when it doesn't parse (as quota-axi does).
  const reset = first(record, ["resetsAt", "resetAt", "reset_at", "nextResetTime"], v => v ?? undefined);
  const seconds = first(record, ["windowSeconds", "window_seconds", "cycleSeconds", "cycle_seconds", "durationSeconds", "duration_seconds", "periodSeconds", "period_seconds"], num);
  const after = first(record, ["resetInSec", "reset_in_sec"], num);
  const resetsAt = resetTime(reset) ?? (after !== undefined && after >= 0 ? isoAt(now + after * 1000) : undefined);
  // A payload duration wins; the plan's own lengths fill in only beside a known reset. Monthly
  // caps are calendar months, so they carry no fixed length.
  const windowSeconds = seconds !== undefined && seconds > 0 ? seconds
    : resetsAt === undefined ? undefined : slot === "five_hour" ? FIVE_HOURS : slot === "weekly" ? WEEK : undefined;
  // Only a reported 18,000 s duration makes the rolling cap the `five_hour` session.
  const name = slot === "five_hour" ? (seconds === FIVE_HOURS ? { id: "five_hour", label: "session", kind } : { id: "rolling", label: "rolling", kind: "unknown" })
    : { id: slot, label: slot, kind };
  return limit(now, { ...name, percentUsed: clampPercent(100 - remaining), resetsAt, windowSeconds });
}

export function usageWindows(raw, now) {
  const root = obj(raw), nested = obj(root?.usage);
  return CAPS.map(({ fields, slot, kind }) => {
    const record = fields.map(n => obj(nested?.[n]) ?? obj(root?.[n])).find(Boolean);
    return record ? window(record, slot, kind, now) : undefined;
  }).filter(Boolean);
}
export function planName(raw) {
  const root = obj(raw);
  const found = ["planName", "plan_name", "plan"].map(k => typeof root?.[k] === "string" && root[k].trim() ? root[k].trim() : undefined).find(Boolean);
  return found === undefined ? "OpenCode Go" : plain(found) ?? null;
}

export async function read(io) {
  const now = io.now;
  // OpenCode 2.x's database holds a current login; 1.x's auth.json is the fallback. A refused
  // key moves on to the next source; any other failure ends the read.
  const results = [];
  for (const source of [fromDatabase, fromAuthFile]) {
    const found = await source(io);
    results.push(found.status);
    if (found.status !== "available") continue;
    const answer = await getJson(io, USAGE, { authorization: `Bearer ${found.key}`, accept: "application/json" });
    if (answer.auth) continue;
    const windows = usageWindows(answer.body, now);
    if (!windows.length) throw new ReadFailure("malformed");
    return lane(id, label, now, { plan: planName(answer.body), windows });
  }
  // A sign-in that is present but unreadable is not a sign-out.
  if (results.some(s => s === "invalid" || s === "error")) throw new ReadFailure("credential");
  return lane(id, label, now, { status: "auth_required" });
}
