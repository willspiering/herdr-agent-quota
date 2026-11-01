// Kimi Code's membership limits, from the /usages endpoint the Kimi Code CLI reads.
// Ported from quota-axi 0.1.69 providers/kimi.js, kimi-code-config.js, kimi-code-cli-credential.js
// and pi-kimi-credential.js (MIT). Never refreshes a token: rotation stays the vendor CLI's job.
import { ReadFailure, REQUEST_MS, within, hostOf, obj, limit, lane } from "./common.js";

export const id = "kimi";
export const label = "Kimi";
const DEFAULT_BASE = "https://api.kimi.com/coding/v1";
// Kimi Code's two deployments. A config.toml only picks one; it never supplies the host, so a
// token is only ever sent to a Kimi host, and only to the deployment that issued it.
const REGIONS = [
  { oauthHost: "https://auth.kimi.com", baseUrl: DEFAULT_BASE },
  { oauthHost: "https://auth.kimi.ai", baseUrl: "https://api.kimi.ai/coding/v1" },
];
const DEFAULT_SLOT = "kimi-code";
const usagesUrl = base => `${base.replace(/\/+$/, "")}/usages`;
// The request quota-axi makes, header for header.
const USER_AGENT = "quota-axi/0.1.69";
const FIVE_HOURS = 18000, WEEK = 604800;
const CREDENTIAL_BYTES = 65536, CONFIG_BYTES = 262144, RESPONSE_BYTES = 262144;

// ---------------------------------------------------------------------------------------------
// Credentials. Two independent stores, in quota-axi's order: Pi's `kimi-coding` login, then the
// Kimi Code CLI's own. Each answers { token, url, expired, refreshable } or { failure }.

const AUTH = { kind: "auth" }, transient = reason => ({ kind: "transient", reason });

function utf8Bytes(text) {
  if (text.length * 3 <= 65536) return text.length; // a lower bound is enough to pass the small cases
  let n = 0;
  for (const c of text) { const p = c.codePointAt(0); n += p < 0x80 ? 1 : p < 0x800 ? 2 : p < 0x10000 ? 3 : 4; }
  return n;
}
// null: absent. undefined: present but unreadable.
async function readFile(io, path) {
  try { return (await io.readTextFile(path)) ?? null; } catch { return undefined; }
}

// Pi stores a literal API key or the OAuth record Kimi gave it; an expired one is reported, not
// refreshed. References ($VAR, !command) are refused, never resolved.
const literal = v => typeof v === "string" && v.trim().length > 0 && !v.startsWith("!") && !v.includes("$")
  && ![...v].some(c => c.charCodeAt(0) <= 0x1f || c.charCodeAt(0) === 0x7f) ? v : undefined;
function epochMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}
async function piCredential(io, now) {
  const text = await readFile(io, `${io.home()}/.pi/agent/auth.json`);
  if (text === undefined) return { failure: transient("unreadable") };
  if (text === null) return { failure: AUTH };
  if (utf8Bytes(text) > CREDENTIAL_BYTES) return { failure: AUTH };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { failure: AUTH }; }
  const entry = obj(obj(parsed)?.["kimi-coding"]);
  if (!entry) return { failure: AUTH };
  const type = typeof entry.type === "string" ? entry.type.toLowerCase() : undefined;
  const url = usagesUrl(DEFAULT_BASE); // Pi doesn't record a deployment, so the default is asked
  if (type === "api_key") {
    const token = literal(entry.key);
    return token ? { token, url, expired: false } : { failure: AUTH };
  }
  if (type !== "oauth") return { failure: AUTH };
  const token = literal(entry.access);
  if (!token) return { failure: AUTH };
  const expires = epochMs(entry.expires);
  if (Object.hasOwn(entry, "expires") && expires === undefined) return { failure: AUTH };
  return { token, url, expired: expires !== undefined && expires <= now, refreshable: Object.hasOwn(entry, "refresh") };
}

// The Kimi Code CLI keeps one credential per deployment; ~/.kimi-code/config.toml names the
// current slot and deployment. Without a config file the default slot and deployment apply.
async function cliCredential(io, now) {
  const home = `${io.home()}/.kimi-code`;
  const config = await readFile(io, `${home}/config.toml`);
  const env = environment(config === null ? { status: "absent" } : config === undefined || utf8Bytes(config) > CONFIG_BYTES ? { status: "unreadable" } : { status: "read", text: config });
  if (env.status !== "resolved") return { failure: transient("config") };
  // A slot nobody named is a guess: whatever sits there says nothing about the account.
  if (!env.confirmed) return { failure: transient("config") };
  const text = await readFile(io, `${home}/credentials/${env.slot}.json`);
  if (text === undefined) return { failure: transient("unreadable") };
  if (text === null || utf8Bytes(text) > CREDENTIAL_BYTES) return { failure: AUTH };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { failure: AUTH }; }
  const credential = obj(parsed);
  const token = typeof credential?.access_token === "string" ? credential.access_token.trim() : "";
  const expiresAt = seconds(credential?.expires_at);
  if (!credential || !token || expiresAt === undefined) return { failure: AUTH };
  return { token, url: usagesUrl(env.baseUrl), expired: expiresAt <= now / 1000 + 60, refreshable: Object.hasOwn(credential, "refresh_token") };
}
function seconds(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

const normalizeUrl = v => v.trim().replace(/\/+$/, "");
// Which slot and deployment a config describes (quota-axi's resolveKimiCodeEnvironment).
export function environment(source) {
  const fallback = (baseUrl, confirmed) => baseUrl !== undefined && normalizeUrl(baseUrl) !== DEFAULT_BASE
    ? { status: "unrecognized_region" } : { status: "resolved", slot: DEFAULT_SLOT, baseUrl: DEFAULT_BASE, confirmed };
  if (source.status !== "read") return fallback(undefined, source.status === "absent");
  const { provider, oauth, complete } = scanConfig(source.text);
  if (oauth === undefined) return fallback(provider?.base_url, complete);
  if ((oauth.storage ?? "file") !== "file") return { status: "unsupported_storage" };
  const slot = slotFor(oauth.key ?? "oauth/kimi-code");
  if (slot === undefined) return { status: "invalid_config" };
  const confirmed = oauth.key !== undefined || complete;
  const baseUrl = provider?.base_url, oauthHost = oauth.oauth_host;
  if (baseUrl === undefined && oauthHost === undefined) {
    // Only the unsuffixed slot implies a deployment (the default one).
    return slot === DEFAULT_SLOT ? { status: "resolved", slot, baseUrl: DEFAULT_BASE, confirmed } : { status: "invalid_config" };
  }
  const region = REGIONS.find(r => (baseUrl === undefined || normalizeUrl(r.baseUrl) === normalizeUrl(baseUrl))
    && (oauthHost === undefined || normalizeUrl(r.oauthHost) === normalizeUrl(oauthHost)));
  if (!region) return { status: "unrecognized_region" };
  // The unsuffixed slot belongs to the default deployment and only to it, both ways round.
  if ((slot === DEFAULT_SLOT) !== (region.baseUrl === DEFAULT_BASE)) return { status: "unrecognized_region" };
  return { status: "resolved", slot, baseUrl: region.baseUrl, confirmed };
}
// Kimi Code's slot-key-to-file-name rule; the name can never leave the credentials folder.
function slotFor(key) {
  const name = key === DEFAULT_SLOT || key === "oauth/kimi-code" ? DEFAULT_SLOT
    : key.startsWith("oauth/") && key.length > 6 ? key.slice(6)
    : !key.includes("/") && !key.startsWith(".") ? key : undefined;
  if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) return undefined;
  return name;
}

// A deliberately narrow TOML walk (quota-axi's scanConfig): it tracks which table each key is in
// and keeps only base_url and the OAuth reference. The provider's literal API key lives in the
// same table, so nothing else is kept. A construct it can't walk ends the scan with what it read.
const MANAGED = ["providers", "managed:kimi-code"], OAUTH = [...MANAGED, "oauth"];
const PROVIDER_KEYS = ["base_url", "baseUrl"], OAUTH_KEYS = ["storage", "key", "oauth_host", "oauthHost"];
const same = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);
const canonical = key => key === "baseUrl" ? "base_url" : key === "oauthHost" ? "oauth_host" : key;
export function scanConfig(text) {
  /** @type {{ complete: boolean, provider?: Record<string, string>, oauth?: Record<string, string> }} */
  const scanned = { complete: true };
  let i = 0, table = [];
  const end = () => i >= text.length;
  const fail = () => { throw new Error("toml"); };
  const skipInline = () => { while (!end() && (text[i] === " " || text[i] === "\t")) i++; };
  const skipIgnorable = () => {
    while (!end()) {
      const c = text[i];
      if (c === " " || c === "\t" || c === "\r" || c === "\n") i++;
      else if (c === "#") { while (!end() && text[i] !== "\n") i++; }
      else return;
    }
  };
  const unescape = () => {
    i++;
    const c = text[i++];
    const simple = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    if (c in simple) return simple[c];
    if (c === "u" || c === "U") {
      const width = c === "u" ? 4 : 8, digits = text.slice(i, i + width);
      if (!/^[0-9A-Fa-f]+$/.test(digits) || digits.length !== width) fail();
      i += width;
      return String.fromCodePoint(Number.parseInt(digits, 16));
    }
    if (c === "\n" || c === " " || c === "\r") { while (!end() && /\s/.test(text[i])) i++; return ""; }
    return fail();
  };
  const readString = () => {
    const quote = text[i], delimiter = text.startsWith(quote.repeat(3), i) ? quote.repeat(3) : quote;
    i += delimiter.length;
    let value = "";
    for (;;) {
      if (end()) fail();
      if (text.startsWith(delimiter, i)) { i += delimiter.length; return value; }
      if (quote !== "'" && text[i] === "\\") { value += unescape(); continue; }
      value += text[i++];
    }
  };
  const readKey = () => {
    if (text[i] === '"' || text[i] === "'") return readString();
    const start = i;
    while (!end() && /[A-Za-z0-9_-]/.test(text[i])) i++;
    if (i === start) fail();
    return text.slice(start, i);
  };
  const readKeyPath = () => {
    const segments = [];
    for (;;) {
      skipInline(); segments.push(readKey()); skipInline();
      if (text[i] === ".") { i++; continue; }
      return segments;
    }
  };
  const readCollection = () => {
    let depth = 0;
    do {
      if (end()) fail();
      const c = text[i];
      if (c === '"' || c === "'") { readString(); continue; }
      if (c === "#") { while (!end() && text[i] !== "\n") i++; continue; }
      if (c === "[") depth++; else if (c === "]") depth--;
      i++;
    } while (depth > 0);
  };
  const readValue = path => {
    const c = text[i];
    if (c === '"' || c === "'") return readString();
    if (c === "[") { readCollection(); return undefined; }
    if (c === "{") {
      i++;
      for (;;) {
        skipIgnorable();
        if (end()) fail();
        if (text[i] === "}") { i++; return undefined; }
        if (text[i] === ",") { i++; continue; }
        readKeyValue(path);
      }
    }
    const start = i;
    while (!end() && !"\n#,]}".includes(text[i])) i++;
    if (i === start) fail();
    return text.slice(start, i).trim();
  };
  function readKeyValue(prefix) {
    const path = readKeyPath();
    skipInline();
    if (text[i] !== "=") fail();
    i++; skipInline();
    const key = path[path.length - 1], owner = [...prefix, ...path.slice(0, -1)];
    const value = readValue([...owner, key]);
    if (value === undefined) return;
    const target = same(owner, OAUTH) ? "oauth" : same(owner, MANAGED) ? "provider" : undefined;
    if (!target || !(target === "provider" ? PROVIDER_KEYS : OAUTH_KEYS).includes(key)) return;
    (scanned[target] ??= {})[canonical(key)] = value;
  }
  try {
    for (;;) {
      skipIgnorable();
      if (end()) break;
      if (text[i] === "[") {
        const array = text.startsWith("[[", i);
        i += array ? 2 : 1;
        const segments = readKeyPath(), closing = array ? "]]" : "]";
        if (!text.startsWith(closing, i)) fail();
        i += closing.length;
        table = segments;
        continue;
      }
      readKeyValue(table);
    }
  } catch { scanned.complete = false; }
  return scanned;
}

// ---------------------------------------------------------------------------------------------
// The /usages answer. Kimi sends a `usages` map (ratios), a principal `usage` plus `limits[]`
// (counts), or both. quota-axi keeps fractional percentages here, so this port does too.

const clamp = v => Math.min(100, Math.max(0, v));
function scalar(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const t = v.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "");
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}
const nonnegative = v => { const n = scalar(v); return n !== undefined && n >= 0 ? n : undefined; };
const daysIn = (year, month) => { const d = new Date(0); d.setUTCFullYear(year, month, 0); return d.getUTCDate(); };
function rfc3339(value) {
  if (typeof value !== "string" || !value) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!m) return undefined;
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map(k => Number(m[k]));
  const ms = Number((m[7] ?? "").padEnd(3, "0").slice(0, 3)), oh = Number(m[10] ?? 0), om = Number(m[11] ?? 0);
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month) || hour > 23 || minute > 59 || second > 60 || oh > 23 || om > 59) return undefined;
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, Math.min(second, 59), ms);
  const offset = m[8] === "Z" ? 0 : (m[9] === "-" ? -1 : 1) * (oh * 60 + om) * 60000;
  const instant = local.getTime() - offset + (second === 60 ? 1000 : 0);
  if (!Number.isFinite(instant)) return undefined;
  try { return new Date(instant).toISOString(); } catch { return undefined; }
}
function reset(detail) {
  for (const key of ["resetTime", "resetAt", "reset_time", "reset_at"]) { const at = rfc3339(detail[key]); if (at) return at; }
  return undefined;
}
function ratioDetail(value) {
  const d = obj(value), ratio = nonnegative(d?.used_ratio);
  if (ratio === undefined) return undefined;
  return { percentUsed: clamp(Number((ratio * 100).toFixed(10))), resetsAt: reset(d) };
}
function countDetail(value) {
  const d = obj(value), cap = scalar(d?.limit);
  if (cap === undefined || cap <= 0) return undefined;
  const explicit = nonnegative(d.used), left = nonnegative(d.remaining);
  const used = explicit !== undefined ? explicit : left !== undefined ? Math.max(0, cap - left) : undefined;
  return used === undefined ? undefined : { percentUsed: clamp(used / cap * 100), resetsAt: reset(d) };
}
const UNITS = { TIME_UNIT_SECOND: 1, TIME_UNIT_MINUTE: 60, TIME_UNIT_HOUR: 3600, TIME_UNIT_DAY: 86400 };
function windowSeconds(value) {
  const w = obj(value);
  if (!w || typeof w.timeUnit !== "string") return undefined;
  const duration = scalar(w.duration), unit = UNITS[w.timeUnit];
  if (duration === undefined || duration <= 0 || unit === undefined) return undefined;
  const s = duration * unit;
  return Number.isFinite(s) && s > 0 ? s : undefined;
}
// The monthly code window is the code-typed share of the monthly total, not an allowance.
const MAP = [
  { key: "limit_5h", id: "five_hour", label: "session", kind: "session", windowSeconds: FIVE_HOURS },
  { key: "limit_7d", id: "weekly", label: "week", kind: "weekly", windowSeconds: WEEK },
  { key: "limit_month_total", id: "month_total", label: "month", kind: "monthly" },
  { key: "limit_month_code", id: "month_code", label: "code month", kind: "monthly", shareOf: "month_total" },
];
const NON_QUOTA = ["goods_version", "boosterWallet"];
const absentOr = (v, empty) => v === undefined || v === null || empty(v);

// { empty: true } for an account with no quota (Free tier); otherwise its windows and the ids
// quota-axi marks untrusted (a declared limit this reader couldn't parse).
export function usageWindows(payload, now) {
  const root = obj(payload);
  if (!root) throw new ReadFailure("malformed");
  /** @type {{ id: string, label: string, kind: string, percentUsed: number, windowSeconds?: number, resetsAt?: string, shareOf?: string }[]} */
  const map = [];
  const untrusted = [], usages = obj(root.usages);
  for (const spec of usages ? MAP : []) {
    if (!Object.hasOwn(usages, spec.key)) continue;
    const d = ratioDetail(usages[spec.key]);
    if (!d) { untrusted.push(`usages:${spec.key}`); continue; }
    map.push({ id: spec.id, label: spec.label, kind: spec.kind, percentUsed: d.percentUsed, windowSeconds: spec.windowSeconds, resetsAt: d.resetsAt, shareOf: spec.shareOf });
  }
  let windows = map;
  const principal = countDetail(root.usage);
  if (!principal) {
    if (!map.length) {
      const empty = absentOr(root.usages, v => obj(v) !== undefined && Object.keys(v).length === 0)
        && (root.usage === undefined || root.usage === null)
        && absentOr(root.limits, v => Array.isArray(v) && v.length === 0)
        && Object.keys(root).every(k => ["usages", "usage", "limits", ...NON_QUOTA].includes(k));
      if (empty) return { empty: true };
      throw new ReadFailure("malformed");
    }
    // A principal this reader can't parse may be the binding week.
    if (root.usage !== undefined && root.usage !== null) untrusted.push("usage");
  } else {
    const legacy = [{ id: "weekly", label: "week", kind: "weekly", percentUsed: principal.percentUsed, windowSeconds: WEEK, resetsAt: principal.resetsAt }];
    if (root.limits === undefined || root.limits === null) { if (!map.length) untrusted.push("limits"); }
    else if (!Array.isArray(root.limits)) untrusted.push("limits");
    else {
      let fiveHourSeen = false;
      root.limits.forEach((raw, offset) => {
        const index = offset + 1, entry = obj(raw), d = countDetail(entry?.detail);
        if (!entry || !d) { untrusted.push(`limit:${index}`); return; }
        const seconds = windowSeconds(entry.window), fiveHour = seconds === FIVE_HOURS && !fiveHourSeen;
        if (fiveHour) fiveHourSeen = true;
        legacy.push({ id: fiveHour ? "five_hour" : `limit:${index}`, label: fiveHour ? "session" : `limit ${index}`, kind: fiveHour ? "session" : "unknown",
          percentUsed: d.percentUsed, windowSeconds: seconds, resetsAt: d.resetsAt });
      });
    }
    // A window both shapes report takes the more-used figure (the map wins a tie), keeping the
    // other side's reset when the binding side has none.
    const byId = new Map(legacy.map(w => [w.id, w]));
    windows = map.map(w => {
      const other = byId.get(w.id);
      if (!other) return w;
      byId.delete(w.id);
      const [bound, rest] = other.percentUsed > w.percentUsed ? [other, w] : [w, other];
      return bound.resetsAt || !rest.resetsAt ? bound : { ...bound, resetsAt: rest.resetsAt };
    }).concat([...byId.values()]);
  }
  return {
    windows: windows.map(({ shareOf, ...w }) => shareOf ? { ...limit(now, w), shareOf } : limit(now, w)),
    untrusted: [...new Set(untrusted)],
  };
}

// ---------------------------------------------------------------------------------------------

async function request(io, url, token) {
  let response;
  try { response = await within(io, REQUEST_MS, io.fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": USER_AGENT } })); }
  catch { throw new ReadFailure("unreachable"); }
  // quota-axi refuses redirects; Herdr's fetch follows them, so an answer from elsewhere is dropped.
  if (hostOf(response.url || url) !== hostOf(url)) throw new ReadFailure("redirected");
  if (response.status === 401 || response.status === 403) return { auth: true };
  if (response.status === 429) throw new ReadFailure("rate-limited");
  if (response.status !== 200) throw new ReadFailure("server");
  let text;
  try { text = await within(io, REQUEST_MS, response.text()); } catch { throw new ReadFailure("unreachable"); }
  if (typeof text !== "string" || utf8Bytes(text) > RESPONSE_BYTES) throw new ReadFailure("malformed");
  try { return { body: JSON.parse(text) }; } catch { throw new ReadFailure("malformed"); }
}

export async function read(io) {
  const now = io.now, failures = [];
  let empty = false;
  // A store that can't answer hands over to the next. A request that fails for any reason but a
  // rejected token is about the request, not the credential, so it is reported as is.
  for (const source of [piCredential, cliCredential]) {
    const sign = await source(io, now);
    if (!sign.token) { failures.push(sign.failure); continue; }
    let parsed;
    try {
      const answer = await request(io, sign.url, sign.token);
      // An expired token with a refresh path just reached rotation time: not a sign-out.
      if (answer.auth) { failures.push(sign.expired && sign.refreshable ? { kind: "expired" } : AUTH); continue; }
      parsed = usageWindows(answer.body, now);
    } catch (error) {
      failures.push(transient(error instanceof ReadFailure ? error.message : "unreachable"));
      break;
    }
    if (parsed.empty) { empty = true; continue; }
    return { ...lane(id, label, now, { windows: parsed.windows }), untrustedWindowIds: parsed.untrusted };
  }
  // Signed in with nothing to report (a Free-tier account): fresh, no limits.
  if (empty) return lane(id, label, now);
  const failure = failures.find(f => f.kind === "transient") ?? failures.find(f => f.kind === "expired");
  if (failure) throw new ReadFailure(failure.kind === "expired" ? "expired" : failure.reason);
  return lane(id, label, now, { status: "auth_required" });
}
