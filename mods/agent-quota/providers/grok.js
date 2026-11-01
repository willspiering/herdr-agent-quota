// Grok's consumer credits, from the grok.com billing call the Grok web app makes.
// Ported from quota-axi 0.1.69 providers/grok.js and pi-xai-credential.js (MIT). Never refreshes a
// token and never runs the Grok CLI (quota-axi's `grok models` refresh is off in this mod's mode).
//
// The call is gRPC-web. Herdr's fetch hands back text only, which would mangle a binary protobuf,
// so the request asks for gRPC-web's text encoding (base64) and decodes it here; the protobuf
// reading below follows quota-axi's field by field.
import { ReadFailure, obj, str, limit, lane, hostOf, parseJson, within, REQUEST_MS } from "./common.js";

export const id = "grok";
export const label = "Grok";
const QUOTA = "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";
// Read-only model catalogs: only asked whether a token the billing call refused is still live.
const GROK_BUILD_MODELS = "https://cli-chat-proxy.grok.com/v1/models";
const XAI_MODELS = "https://api.x.ai/v1/models";
const QUOTA_HEADERS = { accept: "application/grpc-web-text+proto", "content-type": "application/grpc-web-text+proto",
  Origin: "https://grok.com", Referer: "https://grok.com/?_s=usage", "x-grpc-web": "1", "x-user-agent": "connect-es/2.1.1" };
const EMPTY_REQUEST = "AAAAAAA="; // one empty gRPC-web data frame, base64
const LIMIT_BYTES = 64 * 1024;
const PRODUCTS = { 0: ["unspecified", "Other"], 1: ["api", "API"], 2: ["grok_build", "Grok Build"], 3: ["grok_plugins", "Grok Plugins"],
  4: ["chat", "Chat"], 5: ["imagine", "Imagine"], 6: ["voice", "Voice"] };

// ---- Sign-ins: the Grok CLI's ~/.grok/auth.json, then Pi's xAI entry in ~/.pi/agent/auth.json.

// A scope's host and path (Herdr has no global URL). Unparseable: undefined.
function scopeOf(value) {
  if (!value) return undefined;
  const s = value.replace(/::[^/]*$/, ""), m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?([^:/?#]*)(?::\d*)?([^?#]*)/i.exec(s.includes("://") ? s : `https://${s}`);
  if (!m || !/^[a-z0-9.-]+$/i.test(m[2])) return undefined;
  return { host: m[2].toLowerCase(), path: m[3] || "/" };
}
function candidate(item, scope, now) {
  const key = str(item.key);
  if (!key) return undefined;
  const authMode = (str(item.auth_mode) ?? str(item.authMode))?.toLowerCase(), type = (str(item.type) ?? str(item.kind))?.toLowerCase();
  const scoped = str(item.scope) ?? str(item.url) ?? str(item.audience) ?? scope, where = scopeOf(scoped), lowered = scoped?.toLowerCase() ?? "";
  const apiKey = type === "api-key" || type === "api_key" || lowered.includes("api-key") || lowered.includes("api_key") || where?.host === "api.x.ai" || where?.host === "api.grok.com";
  const oidc = where?.host === "auth.x.ai" && authMode === "oidc";
  const session = !apiKey && !!where && (oidc || (where.host === "accounts.x.ai" && where.path.startsWith("/sign-in")) || where.host === "grok.com" || where.host === "www.grok.com");
  const expires = Date.parse(str(item.expires_at) ?? str(item.expiresAt) ?? "");
  // Only whether a refresh token exists is noted; its value is never read.
  return { key, apiKey, session, probe: oidc ? GROK_BUILD_MODELS : undefined, expired: Number.isFinite(expires) && expires <= now,
    refreshable: Object.hasOwn(item, "refresh_token") || Object.hasOwn(item, "refreshToken") };
}
function cliCandidates(text, now) {
  const data = obj(parseJson(text ?? ""));
  if (!data) return [];
  const direct = candidate(data, str(data.scope), now);
  const all = direct ? [direct] : Object.entries(data).map(([scope, value]) => obj(value) && candidate(value, scope, now)).filter(Boolean);
  const sessions = all.filter(c => c.session);
  return sessions.length ? sessions : all.filter(c => !c.apiKey);
}
// Pi's literal secrets only: an environment, template or command reference is never resolved.
const literal = v => typeof v === "string" && v.trim() && !v.startsWith("!") && !v.includes("$") && ![...v].some(c => c.charCodeAt(0) <= 0x1f || c.charCodeAt(0) === 0x7f) ? v : undefined;
function piMs(v) {
  const n = typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined;
  if (n !== undefined) return n < 1e12 ? n * 1000 : n;
  const parsed = typeof v === "string" && v.trim() !== "" ? Date.parse(v) : NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
}
// { status: "missing" | "invalid" | "error" | "api_key" | "oauth" | "expired", key?, refreshable? }
async function piSignIn(io) {
  let text;
  try { text = await io.readTextFile(`${io.home()}/.pi/agent/auth.json`); } catch { return { status: "error" }; }
  if (text === null || text === undefined) return { status: "missing" };
  if (text.length > LIMIT_BYTES) return { status: "invalid" };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { status: "invalid" }; }
  if (!obj(parsed)) return { status: "invalid" };
  if (!Object.hasOwn(parsed, "xai")) return { status: "missing" };
  const entry = obj(parsed.xai), type = str(entry?.type)?.toLowerCase();
  if (type === "api_key") return literal(entry.key) ? { status: "api_key" } : { status: "invalid" };
  if (type !== "oauth") return { status: "invalid" }; // unsupported types end the same way: no candidate
  const key = literal(entry.access), expires = piMs(entry.expires);
  if (!key || (Object.hasOwn(entry, "expires") && expires === undefined)) return { status: "invalid" };
  if (expires !== undefined && expires <= io.now) return { status: "expired", key, refreshable: !!literal(entry.refresh) };
  return { status: "oauth", key };
}

// ---- The billing answer: base64 gRPC-web frames around one protobuf message.

class Protocol extends ReadFailure { constructor() { super("malformed"); } }
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function bytesOf(text) {
  const raw = typeof text === "string" ? text : "", t = raw.replace(/\s+/g, "");
  // Plain ASCII is a binary answer the text decoding could not have changed.
  if (!/^[A-Za-z0-9+/=_-]*$/.test(t)) {
    if ([...raw].some(c => c.charCodeAt(0) > 0x7f)) throw new Protocol();
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }
  if (t.length % 4) throw new Protocol();
  const out = [];
  // gRPC-web-text may concatenate separately padded frames, so padding can appear mid-stream.
  for (let i = 0; i < t.length; i += 4) {
    const q = [...t.slice(i, i + 4)].map(c => c === "=" ? -1 : B64.indexOf(c === "-" ? "+" : c === "_" ? "/" : c));
    if (q[0] < 0 || q[1] < 0 || (q[2] < 0 && q[3] >= 0)) throw new Protocol();
    const n = (q[0] << 18) | (q[1] << 12) | (Math.max(q[2], 0) << 6) | Math.max(q[3], 0);
    out.push(n >> 16 & 255);
    if (q[2] >= 0) out.push(n >> 8 & 255);
    if (q[3] >= 0) out.push(n & 255);
  }
  return Uint8Array.from(out);
}
// A non-OK gRPC status. 16 and an auth-worded 7 are a refused sign-in; 8 is rate limiting.
class Refused extends Error {}
function grpcStatus(value, message) {
  if (value === undefined) return;
  if (!/^(?:[0-9]|1[0-6])$/.test(value)) throw new Protocol();
  const status = Number(value);
  if (status === 0) return;
  if (status === 16 || (status === 7 && authWorded(message))) throw new Refused();
  if (status === 8) throw new ReadFailure("rate-limited");
  throw new ReadFailure("server");
}
function authWorded(value) {
  if (!value || value.length > 1024) return false;
  let m;
  try { m = decodeURIComponent(value); } catch { return false; }
  return m.length <= 1024 && (/\b(?:unauthenticated|authentication required|sign[ -]?in required)\b/i.test(m) || /\bbad[ -]credentials\b/i.test(m) ||
    /\b(?:oauth2|access token)\b[\s\S]{0,128}\bcould not be validated\b/i.test(m) ||
    /\b(?:invalid|expired|missing|revoked)\s+(?:(?:oauth|access|auth(?:entication)?|bearer)\s+)*(?:token|credentials?|jwt)\b/i.test(m) ||
    /\b(?:token|credentials?|jwt)\s+(?:is |are )?(?:invalid|expired|missing|revoked)\b/i.test(m));
}
function unframe(bytes) {
  if (!bytes.length) throw new Protocol();
  if (!(bytes[0] === 0 || bytes[0] === 1 || (bytes[0] & 0x80))) return bytes;
  const data = [];
  let trailer = false, i = 0;
  while (i < bytes.length) {
    if (i + 5 > bytes.length) throw new Protocol();
    const flags = bytes[i], length = ((bytes[i + 1] << 24) >>> 0) + (bytes[i + 2] << 16) + (bytes[i + 3] << 8) + bytes[i + 4];
    if ((flags & 1) || (flags !== 0 && flags !== 0x80) || length > LIMIT_BYTES || i + 5 + length > bytes.length) throw new Protocol();
    const frame = bytes.subarray(i + 5, i + 5 + length);
    if (flags === 0x80) {
      if (trailer) throw new Protocol();
      trailer = true;
      const fields = new Map();
      for (const line of String.fromCharCode(...frame).split(/\r?\n/)) {
        const at = line.indexOf(":");
        if (at > 0) fields.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
      }
      grpcStatus(fields.get("grpc-status"), fields.get("grpc-message"));
    } else {
      if (trailer || data.length) throw new Protocol();
      data.push(frame);
    }
    i += 5 + length;
  }
  if (data.length !== 1) throw new Protocol();
  return data[0];
}

// Protobuf, read without a schema. Numbers stay exact up to 2^53; larger counts as unsafe.
function varint(bytes, start) {
  let value = 0, i = start;
  for (let count = 0; count < 10 && i < bytes.length; count++) {
    const b = bytes[i++];
    if (count === 9 && b > 1) throw new Protocol();
    value += (b & 0x7f) * 2 ** (count * 7);
    if (!(b & 0x80)) return { value, i };
  }
  throw new Protocol();
}
function scan(bytes) {
  const fields = [];
  let i = 0;
  while (i < bytes.length) {
    const key = varint(bytes, i), field = Math.floor(key.value / 8), wire = key.value % 8;
    i = key.i;
    if (field <= 0 || field > 0x1fffffff) throw new Protocol();
    if (wire === 0) { const v = varint(bytes, i); fields.push({ field, wire, value: v.value }); i = v.i; continue; }
    if (wire === 1 || wire === 5) {
      const n = wire === 1 ? 8 : 4;
      if (i + n > bytes.length) throw new Protocol();
      fields.push({ field, wire, value: bytes.subarray(i, i + n) }); i += n; continue;
    }
    if (wire === 2) {
      const n = varint(bytes, i);
      i = n.i;
      if (n.value > LIMIT_BYTES || i + n.value > bytes.length) throw new Protocol();
      fields.push({ field, wire, value: bytes.subarray(i, i + n.value) }); i += n.value; continue;
    }
    throw new Protocol();
  }
  return fields;
}
const messages = (fields, field) => fields.filter(e => e.field === field && e.wire === 2).map(e => e.value);
const first = (fields, field) => { const b = messages(fields, field)[0]; return b ? scan(b) : undefined; };
const varintAt = (fields, field) => fields.find(e => e.field === field && e.wire === 0)?.value;
const safe = v => v === undefined || v > Number.MAX_SAFE_INTEGER ? undefined : v;
function floatAt(fields, field) {
  const found = fields.find(e => e.field === field && e.wire === 5);
  if (!found) return undefined;
  const v = new DataView(found.value.buffer, found.value.byteOffset, 4).getFloat32(0, true);
  if (!Number.isFinite(v)) throw new Protocol();
  return v;
}
function timestampAt(fields, field) {
  const t = first(fields, field), seconds = t && safe(varintAt(t, 1));
  if (seconds === undefined) return undefined;
  const ms = seconds * 1000, date = new Date(ms);
  return Number.isSafeInteger(ms) && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
}
// quota-axi keeps Grok's float percentages exact (clamped, not rounded).
const exact = v => Math.min(100, Math.max(0, v));

// quota-axi measures pace against the billing period's own start, not a fixed length.
function periodPace(w, startsAt, now) {
  const unknown = { status: "unknown", timeRemainingPercent: null };
  const end = Date.parse(w.resetsAt ?? ""), start = Date.parse(startsAt ?? "");
  if (!Number.isFinite(end) || end <= now || !Number.isFinite(start) || start >= end || start > now) return unknown;
  const remaining = 100 * (end - now) / (end - start), reserve = (100 - w.percentUsed) - remaining;
  return { status: Math.abs(reserve) <= 1 ? "on_pace" : reserve < 0 ? "ahead" : "behind", timeRemainingPercent: Number(remaining.toFixed(4)) };
}

/** The windows in one GetGrokCreditsConfig protobuf message (gRPC frames removed). */
export function usageWindows(payload, now) {
  const config = first(scan(payload), 1);
  if (!config) throw new Protocol();
  const period = first(config, 8), type = period ? varintAt(period, 1) : undefined;
  const periodType = type === 2 ? "weekly" : type === 1 ? "monthly" : "unspecified";
  const startsAt = period ? timestampAt(period, 2) : undefined, resetsAt = period ? timestampAt(period, 3) : undefined;
  const validPeriod = periodType !== "unspecified" && startsAt !== undefined && resetsAt !== undefined;
  const kind = periodType === "unspecified" ? "credits" : periodType;
  const make = (wid, wlabel, used) => {
    const w = limit(now, { id: wid, label: wlabel, kind, percentUsed: exact(used ?? 0), resetsAt });
    return { ...w, pace: periodPace(w, startsAt, now) };
  };
  const windows = [];
  const shared = floatAt(config, 1);
  if (shared !== undefined || validPeriod) windows.push(make("credits", { weekly: "week", monthly: "month" }[periodType] ?? "credits", shared));
  for (const raw of messages(config, 7)) {
    const product = scan(raw), used = floatAt(product, 2);
    if (used === undefined && !validPeriod) continue;
    const n = safe(varintAt(product, 1) ?? 0);
    if (n === undefined) continue;
    const [pid, plabel] = PRODUCTS[n] ?? [`unknown_${n}`, `Product ${n}`];
    windows.push(make(`product:${pid}`, plabel, used));
  }
  if (!windows.length) throw new Protocol();
  // A prepaid balance quota-axi can't read makes the whole answer invalid there too.
  const prepaid = first(config, 12);
  if (prepaid && safe(varintAt(prepaid, 1) ?? 0) === undefined) throw new Protocol();
  return windows;
}

// ---- Requests. Only xAI's own hosts ever see a token.

async function send(io, url, init) {
  let response;
  try { response = await within(io, REQUEST_MS, io.fetch(url, init)); }
  catch { throw new ReadFailure("unreachable"); }
  if (hostOf(response.url || url) !== hostOf(url)) throw new ReadFailure("redirected");
  return response;
}
// { windows } or { refused: true }; anything else throws a ReadFailure (transient).
async function consumerQuota(io, token, now) {
  const response = await send(io, QUOTA, { method: "POST", headers: { ...QUOTA_HEADERS, Authorization: `Bearer ${token}` }, body: EMPTY_REQUEST });
  if (response.status === 401 || response.status === 403) return { refused: true };
  if (response.status === 429) throw new ReadFailure("rate-limited");
  if (!response.ok) throw new ReadFailure("server");
  let text;
  try { text = await within(io, REQUEST_MS, response.text()); } catch { throw new ReadFailure("malformed"); }
  if (typeof text === "string" && text.length > LIMIT_BYTES * 4 / 3 + 8) throw new ReadFailure("malformed");
  try { return { windows: usageWindows(unframe(bytesOf(text)), now) }; }
  catch (error) {
    if (error instanceof Refused) return { refused: true };
    throw error instanceof ReadFailure ? error : new Protocol();
  }
}
// The billing call can refuse a token that still works for models; ask the catalog, discard the body.
async function live(io, url, token) {
  const response = await send(io, url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (response.ok) return true;
  if (response.status === 401 || response.status === 403) return false;
  throw new ReadFailure(response.status === 429 ? "rate-limited" : "server");
}
// "quota" (with windows), "live" (works, no quota), or "rejected". Transient trouble throws.
async function attempt(io, token, probe, now) {
  const answer = await consumerQuota(io, token, now);
  if (answer.windows) return answer;
  return { outcome: probe && await live(io, probe, token) ? "live" : "rejected" };
}

export async function read(io) {
  const now = io.now;
  let text = null;
  try { text = await io.readTextFile(`${io.home()}/.grok/auth.json`); } catch { /* unreadable counts as absent */ }
  const cli = cliCandidates(text, now);
  const pi = await piSignIn(io);
  let anyLive = false;
  // Stored expiry only orders the tries: sign-ins it calls valid go first, then the rest.
  for (const c of [...cli.filter(c => !c.expired), ...cli.filter(c => c.expired)]) {
    const result = await attempt(io, c.key, c.probe, now);
    if (result.windows) return lane(id, label, now, { windows: result.windows });
    anyLive ||= result.outcome === "live";
  }
  if (pi.status === "api_key") anyLive = true; // an xAI API key works for models but carries no consumer credits
  else if (pi.status === "oauth" || pi.status === "expired") {
    const result = await attempt(io, pi.key, XAI_MODELS, now);
    if (result.windows) return lane(id, label, now, { windows: result.windows });
    anyLive ||= result.outcome === "live";
  }
  // A working sign-in without credits windows is not a sign-out.
  if (anyLive) throw new ReadFailure("no-quota");
  // An expired sign-in its own tool can renew: earlier readings stay, stale, until it does.
  if (cli.some(c => c.expired && c.refreshable) || (pi.status === "expired" && pi.refreshable)) throw new ReadFailure("expired");
  if (pi.status === "error") throw new ReadFailure("credentials");
  return lane(id, label, now, { status: "auth_required" });
}
