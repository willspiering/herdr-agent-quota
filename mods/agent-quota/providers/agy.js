// Antigravity's Gemini and Claude/GPT limits, from the language server an already running
// Antigravity app or `agy` CLI serves on 127.0.0.1. Ported from quota-axi 0.1.69
// providers/agy.js (MIT). There is no credential file and no vendor host: the read finds the
// user's own Antigravity processes (`ps`), their listening ports (`lsof`) and asks that local
// server. The CSRF token an app process carries on its command line is sent only to that
// process's own loopback port and stays in this read's local variables.
//
// Not ported: quota-axi first runs `agy -p /quota`, with a PATH that denies the desktop openers
// so a signed-out CLI can't open a sign-in browser. Herdr's exec can't set PATH or find `agy`,
// so only the running-process read is here. With nothing running there is nothing to read.
import { ReadFailure, obj, str, num, name as plain, clampPercent, isoTime, limit, lane, within } from "./common.js";

export const id = "agy";
export const label = "Antigravity";
const SERVICE = "/exa.language_server_pb.LanguageServerService/";
const QUOTA_SUMMARY = `${SERVICE}RetrieveUserQuotaSummary`, USER_STATUS = `${SERVICE}GetUserStatus`;
const MODEL_CONFIGS = `${SERVICE}GetCommandModelConfigs`, UNLEASH = `${SERVICE}GetUnleashData`;
// quota-axi's bounds: the process list, each port lookup, each request, and the whole probe.
const PROCESS_MS = 5000, PORT_MS = 2000, REQUEST_MS = 3000, PROBE_MS = 10000;
const MAX_BYTES = 1024 * 1024;
const FIVE_HOURS = 18000, WEEK = 604800;

// Which failure a read reports when several endpoints fail: quota-axi's ranking. A refused
// sign-in outranks a rate limit, which outranks an error (a redirect too: quota-axi never follows
// one), which outranks "not reachable".
const RANK = { auth: 4, "rate-limited": 3, csrf: 2, server: 2, malformed: 2, discovery: 2, redirected: 2, unreachable: 1, timeout: 1 };
const stronger = (current, next) => !current || (RANK[next.message] ?? 0) > (RANK[current.message] ?? 0) ? next : current;

// ---- Vendor answers -> limits (quota-axi's normalizeAgyQuotaSummary / normalizeAgyUserStatus).

const slug = v => v.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const fraction = v => Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
function remaining(data) {
  const direct = num(data.remainingFraction) ?? num(data.remaining_fraction);
  if (direct !== undefined) return direct;
  const raw = data.remaining, value = num(raw);
  if (value !== undefined) return value;
  const oneof = obj(raw);
  if (!oneof) return undefined;
  return num(oneof.remainingFraction) ?? num(oneof.remaining_fraction) ??
    (oneof.case === "remainingFraction" || oneof.case === "remaining_fraction" ? num(oneof.value) : undefined);
}
// quota-axi's parseEpochOrIso keeps a string it can't parse, so such a reset still counts as
// reported (it reaches the dashboard as unknown either way).
const reported = v => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.trim() !== "");

// Argon is its own quota on paid plans, so it never shares the Gemini ids or bound.
function group(name, bucket) {
  const text = `${name} ${bucket}`.toLowerCase();
  if (text.includes("gemini") && text.includes("argon")) return { id: "gemini_argon", label: "Gemini Argon" };
  if (text.includes("gemini")) return { id: "gemini", label: "Gemini" };
  if (text.includes("claude") || text.includes("gpt") || text.includes("3p")) return { id: "claude_gpt", label: "Claude/GPT" };
  // A vendor group name becomes the label; one that isn't a plain short name never does.
  const own = plain(name) ?? "Quota";
  return { id: slug(own) || "quota", label: own };
}
function span(bucket) {
  const names = [bucket.window, bucket.bucketId, bucket.bucket_id, bucket.displayName, bucket.name].map(str).filter(Boolean).map(v => v.toLowerCase());
  if (names.some(v => /^(?:(?:gemini|3p|third-party)[-_])?(?:5h|5-hour|five[ _-]hour)(?: limit)?$/.test(v))) return { id: "5h", label: "5-hour", kind: "session", windowSeconds: FIVE_HOURS };
  if (names.some(v => /^(?:(?:gemini|3p|third-party)[-_])?weekly(?: limit)?$/.test(v))) return { id: "weekly", label: "weekly", kind: "weekly", windowSeconds: WEEK };
  return { id: "unknown", label: "quota", kind: "unknown", windowSeconds: undefined };
}
function bucketWindow(name, raw, now) {
  const bucket = obj(raw);
  if (!bucket || bucket.disabled === true) return undefined;
  const bucketId = str(bucket.bucketId) ?? str(bucket.bucket_id) ?? str(bucket.id);
  if (!bucketId) return undefined;
  const g = group(name, bucketId), k = span(bucket), left = remaining(bucket);
  const percentUsed = left === undefined ? undefined : clampPercent((1 - fraction(left)) * 100);
  const reset = reported(bucket.resetTime) ? bucket.resetTime : bucket.reset_time;
  if (percentUsed === undefined && !reported(reset) && !str(bucket.description)) return undefined;
  return limit(now, { id: `${g.id}_${k.id}`, label: `${g.label} ${k.label}`, kind: k.kind, percentUsed, resetsAt: isoTime(reset), windowSeconds: k.windowSeconds });
}
const groupRank = id => id.startsWith("gemini_") ? 0 : id.startsWith("claude_gpt_") ? 1 : 2;
const kindRank = w => w.kind === "session" ? 0 : w.kind === "weekly" ? 1 : 2;

/** The quota summary's buckets as limits: Gemini first, then Claude/GPT, 5-hour before weekly. */
export function summaryWindows(raw, now) {
  const data = obj(raw);
  const payload = obj(data?.response) ?? obj(data?.summary) ?? (Array.isArray(data?.groups) ? data : undefined);
  const groups = Array.isArray(payload?.groups) ? payload.groups : [];
  return groups.flatMap(entry => {
    const g = obj(entry);
    if (!g) return [];
    const name = str(g.displayName) ?? str(g.name) ?? "Quota";
    return (Array.isArray(g.buckets) ? g.buckets : []).map(b => bucketWindow(name, b, now)).filter(Boolean);
  }).sort((a, b) => groupRank(a.id) - groupRank(b.id) || kindRank(a) - kindRank(b));
}

/** The user status: the plan, and per-model limits when the server has no quota summary. */
export function userStatus(raw, now) {
  const data = obj(raw), status = obj(data?.userStatus) ?? data;
  if (!status) return undefined;
  const plan = plain(obj(status.userTier)?.name) ?? plain(obj(obj(status.planStatus)?.planInfo)?.planName) ?? null;
  const config = obj(status.cascadeModelConfigData) ?? obj(data.cascadeModelConfigData) ?? data;
  const windows = (Array.isArray(config.clientModelConfigs) ? config.clientModelConfigs : []).map(entry => {
    const c = obj(entry), name = str(c?.label), quota = obj(c?.quotaInfo), model = obj(c?.modelOrAlias);
    const key = str(model?.model) ?? str(model?.alias) ?? (name ? slug(name) : undefined);
    if (!name || !key || !quota) return undefined;
    const left = remaining(quota), percentUsed = left === undefined ? undefined : clampPercent((1 - fraction(left)) * 100);
    const reset = reported(quota.resetTime) ? quota.resetTime : quota.reset_time;
    if (percentUsed === undefined && !reported(reset)) return undefined;
    const id = `model:${slug(key)}`;
    return limit(now, { id, label: plain(name) ?? id, kind: "model", percentUsed, resetsAt: isoTime(reset) });
  }).filter(Boolean);
  // quota-axi also counts an account email as a usable answer; the email itself is never kept.
  if (!windows.length && !plan && !str(status.email)) return undefined;
  return { plan, windows };
}

// ---- Finding the local server (quota-axi's processInfosFromPs / portsFromLsof).

const tokens = command => [...command.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
const lower = v => v.replace(/\\/g, "/").toLowerCase();
function executable(command) {
  const token = command.trim().split(/\s+/, 1)[0];
  return token ? token.replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.exe$/, "") : undefined;
}
function mcpScript(token) {
  if (!token) return false;
  const parts = lower(token).split("/");
  return parts[parts.length - 1] === "mcp-server.cjs" && parts.includes("antigravity-cli");
}
function appServer(command) {
  const path = lower(command).split(/\s+--/, 1)[0];
  if (/^\/applications\/(?:[^/\n]+\/)*[^/\n]*antigravity[^/\n]*\.app\/contents\/[^\n]*\/language[-_]server(?:_[a-z0-9_]+)?$/.test(path)) return true;
  const first = tokens(command)[0];
  if (!first) return false;
  const p = lower(first);
  return p.includes("antigravity") && /(?:^|\/)language[-_]server(?:_[a-z0-9_]+)?(?:\.exe)?$/.test(p);
}
function source(command) {
  const parts = tokens(command), exe = executable(parts[0] ?? "");
  if (exe === "agy") return "agy";
  if (exe && /^(?:node|nodejs|bun|mcp-server(?:\.cjs)?)$/.test(exe) && mcpScript(exe.startsWith("mcp-server") ? parts[0] : parts[1])) return "agy";
  return appServer(command) ? "app" : undefined;
}
function flag(command, key) {
  const m = command.match(new RegExp(`(?:^|\\s)--${key}(?:=([^\\s]+)|\\s+([^\\s]+))`));
  return m?.[1] ?? m?.[2];
}
/** Antigravity processes in `ps -o pid=,command=` output, with their loopback flags. */
export function processes(output) {
  const found = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = Number(m[1]), command = m[2].trim(), kind = source(command);
    if (!Number.isInteger(pid) || !command || !kind) continue;
    found.push({ pid, source: kind, csrf: flag(command, "csrf_token"), extensionPort: num(flag(command, "extension_server_port")),
      extensionCsrf: flag(command, "extension_server_csrf_token") });
  }
  return found;
}
/** Listening TCP ports in `lsof -iTCP -sTCP:LISTEN` output. */
export function ports(output) {
  const found = new Set();
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/TCP\s+(?:\[[^\]]+\]|[^:]+):(\d+)\s+\(LISTEN\)/), port = m ? Number(m[1]) : 0;
    if (port > 0 && port <= 65535) found.add(port);
  }
  return [...found];
}

async function run(io, ms, cmd, args) {
  let result;
  try { result = await within(io, ms, io.exec(cmd, args)); } catch { throw new ReadFailure("discovery"); }
  if (result?.code !== 0 || typeof result.stdout !== "string") throw new ReadFailure("discovery");
  return result.stdout;
}

// The endpoints to try, in quota-axi's order: `agy` before the app, low ports first, https first.
// null: no Antigravity process runs for this user.
async function endpoints(io) {
  const uid = (await run(io, PROCESS_MS, "/usr/bin/id", ["-u"])).trim();
  if (!/^\d+$/.test(uid)) throw new ReadFailure("discovery");
  const list = processes(await run(io, PROCESS_MS, "/bin/ps", [...(io.platform === "linux" ? [] : ["-x"]), "-u", uid, "-o", "pid=,command="]));
  if (!list.length) return null;
  const lsof = io.platform === "linux" ? "/usr/bin/lsof" : "/usr/sbin/lsof";
  const found = [];
  let failure = null;
  for (const p of list) {
    let open;
    try { open = ports(await run(io, PORT_MS, lsof, ["-nP", "-a", "-p", String(p.pid), "-iTCP", "-sTCP:LISTEN"])); }
    catch (error) { failure = stronger(failure, error); continue; }
    const add = (scheme, port, csrf, probe) => found.push({ scheme, port, source: p.source, csrf, probe });
    if (p.source === "agy") { for (const port of open) { add("https", port); add("http", port); } continue; }
    if (p.csrf) for (const port of open) { add("https", port, p.csrf, true); add("http", port, p.csrf, true); }
    const extension = p.extensionCsrf ?? p.csrf;
    if (p.extensionPort && open.includes(p.extensionPort) && extension) add("http", p.extensionPort, extension, true);
  }
  if (!found.length && failure) throw failure;
  const rank = e => (e.source === "agy" ? 0 : 1);
  return found.sort((a, b) => rank(a) - rank(b) || a.port - b.port || (a.scheme === "https" ? 0 : 1) - (b.scheme === "https" ? 0 : 1));
}

// ---- Asking it.

const csrfRefusal = text => {
  if (/missing\s+CSRF\s+token/i.test(text)) return true;
  try { return /^(?:missing|invalid) CSRF token$/i.test(str(obj(JSON.parse(text))?.message) ?? ""); } catch { return false; }
};
const METADATA = { metadata: { ideName: "antigravity", extensionName: "antigravity", ideVersion: "unknown", locale: "en" } };
async function call(io, endpoint, path) {
  const origin = `${endpoint.scheme}://127.0.0.1:${endpoint.port}`;
  const headers = { accept: "application/json", "content-type": "application/json", "connect-protocol-version": "1",
    ...(endpoint.csrf ? { "x-codeium-csrf-token": endpoint.csrf } : {}) };
  const body = JSON.stringify(path === QUOTA_SUMMARY ? { request: {}, forceRefresh: false } : METADATA);
  let response, text;
  try {
    response = await within(io, REQUEST_MS, io.fetch(origin + path, { method: "POST", headers, body }));
    text = await within(io, REQUEST_MS, response.text());
  } catch { throw new ReadFailure("unreachable"); }
  // Only the process asked may answer: a redirect anywhere else is discarded.
  if (response.url && !response.url.startsWith(`${origin}/`)) throw new ReadFailure("redirected");
  const status = response.status;
  if (status === 401 || status === 403) throw new ReadFailure(csrfRefusal(String(text ?? "")) ? "csrf" : "auth");
  if (status === 429) throw new ReadFailure("rate-limited");
  if (!(status >= 200 && status < 300)) throw new ReadFailure("server");
  if (typeof text !== "string" || text.length > MAX_BYTES) throw new ReadFailure("malformed");
  try { return JSON.parse(text); } catch { throw new ReadFailure("malformed"); }
}
const failure = error => error instanceof ReadFailure ? error : new ReadFailure("unreachable");

// One endpoint: the quota summary (plus the plan), else per-model limits from the user status.
async function fromEndpoint(io, endpoint, now) {
  let error = null;
  try {
    const windows = summaryWindows(await call(io, endpoint, QUOTA_SUMMARY), now);
    if (windows.length) {
      let plan = null;
      try { plan = userStatus(await call(io, endpoint, USER_STATUS), now)?.plan ?? null; } catch { /* the plan is optional */ }
      return { plan, windows };
    }
    error = new ReadFailure("malformed");
  } catch (e) { error = stronger(error, failure(e)); }
  for (const path of [USER_STATUS, MODEL_CONFIGS]) {
    try {
      const status = userStatus(await call(io, endpoint, path), now);
      if (status?.windows.length) return status;
    } catch (e) { error = stronger(error, failure(e)); }
  }
  throw error;
}

async function probe(io, now) {
  const list = await endpoints(io);
  if (!list) return null;
  if (!list.length) throw new ReadFailure("no-endpoint"); // running, but no port it can be asked on
  let error = null;
  for (const endpoint of list) {
    try {
      // The app's server answers its feature-flag call first, as Antigravity's own client does.
      if (endpoint.probe) await call(io, endpoint, UNLEASH);
      return await fromEndpoint(io, endpoint, now);
    } catch (e) { error = stronger(error, failure(e)); }
  }
  throw error ?? new ReadFailure("unreachable");
}

export async function read(io) {
  const now = io.now, unavailable = () => lane(id, label, now, { status: "unavailable" });
  // quota-axi has no process discovery on Windows.
  if (io.platform === "windows") return unavailable();
  let found;
  try { found = await within(io, PROBE_MS, probe(io, now)); }
  catch (error) {
    const e = failure(error);
    if (e.message === "auth") return lane(id, label, now, { status: "auth_required" });
    // The app refused for want of a CSRF token it doesn't expose: quota-axi reports it unavailable.
    if (e.message === "csrf") return unavailable();
    throw e;
  }
  // Nothing running: Antigravity isn't open (or isn't installed), so there is nothing to read.
  if (!found) return unavailable();
  const result = lane(id, label, now, { plan: found.plan, windows: found.windows });
  // quota-axi marks a reading whose reset has already passed as stale.
  if (found.windows.some(w => w.resetsAt && Date.parse(w.resetsAt) <= now)) result.state = { ...result.state, status: "stale", stale: true };
  return result;
}
