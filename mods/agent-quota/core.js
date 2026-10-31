// Pure data boundary. Only these allowlisted fields reach Herdr's shared state.
export const PREFIX = "agent-quota.v1";
// When to read quota. Agents finishing a turn drive reads; timers are only a backstop.
export const CADENCE = {
  gap: 60000,        // never closer together, however many agents finish
  working: 180000,   // backstop while any agent works
  idle: 600000,      // quota is also spent outside Herdr
  look: 60000,       // opening the dashboard reads anything older
  sweep: 3600000,    // every provider, to notice new sign-ins
  discover: 3600000, // installed agents
  retry: 60000,      // first retry after a failure, doubling to 10 minutes
  manual: 10000,     // Refresh cooldown
};
export const STALE_MS = 900000;
export const DEFAULTS = {
  hidden: [], kinds: { session: true, weekly: true, monthly: true, model: false, credits: true, unknown: true },
  windows: {}, signedOut: false, names: true, activeFirst: true,
  favorites: ["codex", "claude", "grok"], redline: 70,
  strip: "meter", dash: "bars", metric: "used", palette: "terminal",
};
export const CHOICES = {
  strip: ["meter", "blocks", "numbers"], dash: ["bars", "gauges"],
  metric: ["used", "left"], palette: ["terminal", "classic"],
};
// Messages written by this mod. Anything else is replaced before it is stored or shown.
export class QuotaError extends Error {}
const text = (v, fallback = "", max = 120) => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : fallback;
const number = v => typeof v === "number" && Number.isFinite(v) ? v : null;
const percent = v => number(v) === null || v < 0 ? null : Math.min(100, v);
export const stamp = v => typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
export function providerId(value) {
  const id = text(value).toLowerCase();
  return ({ "claude-code": "claude", "claude code": "claude", "openai-codex": "codex", "cursor-agent": "cursor", "github-copilot": "copilot", "grok-code": "grok" })[id] ?? id;
}
export function options(start = {}, saved = {}) {
  const o = { ...DEFAULTS, ...start, ...saved };
  return { ...o,
    hidden: Array.isArray(o.hidden) ? o.hidden.filter(x => typeof x === "string") : [],
    favorites: Array.isArray(o.favorites) ? o.favorites.filter(x => typeof x === "string") : DEFAULTS.favorites,
    kinds: { ...DEFAULTS.kinds, ...start.kinds, ...saved.kinds },
    windows: Object.fromEntries(Object.entries({ ...start.windows, ...saved.windows }).filter(([, v]) => typeof v === "boolean")),
    redline: [60, 70, 80, 90].includes(o.redline) ? o.redline : 70,
    ...Object.fromEntries(Object.entries(CHOICES).map(([k, list]) => [k, list.includes(o[k]) ? o[k] : DEFAULTS[k]])),
  };
}

// Parse a complete JSON object, even after shell banners or ANSI status lines.
// Never echo a malformed report or a subprocess error: it could contain credentials.
export function parseReport(stdout, now = Date.now()) {
  if (typeof stdout !== "string" || stdout.length > 8 * 1024 * 1024) throw new QuotaError("Quota report is missing or too large.");
  let report;
  let attempts = 0;
  for (let start = stdout.indexOf("{"); start >= 0 && attempts++ < 32; start = stdout.indexOf("{", start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let end = start; end < stdout.length; end++) {
      const c = stdout[end];
      if (quoted) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') quoted = false; }
      else if (c === '"') quoted = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { const candidate = JSON.parse(stdout.slice(start, end + 1)); if (Array.isArray(candidate.providers)) report = candidate; } catch { /* banner */ }
        break;
      }
    }
    if (report) break;
  }
  if (!report) throw new QuotaError("Collector returned an unreadable quota report.");
  if (![3, 4, 5].includes(report.schemaVersion)) throw new QuotaError("Unsupported quota schema. This version supports schemas 3–5.");
  const generated = stamp(report.generatedAt);
  const at = generated !== null && generated <= now + 60000 ? Math.min(generated, now) : now;
  const lanes = new Set();
  const providers = [];
  if (report.providers.length > 200) throw new QuotaError("Quota report has too many account lanes. Previous readings were kept.");
  for (const p of report.providers) {
    if (!p || typeof p.provider !== "string") continue;
    const id = providerId(p.provider);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) continue;
    const account = text(p.accountKey, "", 160) || (Array.isArray(p.accountKeys) ? p.accountKeys.map(x => text(x, "", 160)).filter(Boolean).sort().join("+") : "") || "default";
    const key = JSON.stringify([id, account]);
    if (lanes.has(key)) throw new QuotaError("Collector returned duplicate account lanes.");
    lanes.add(key);
    const untrusted = new Set(Array.isArray(p.untrustedWindowIds) ? p.untrustedWindowIds : []);
    const windowIds = new Set();
    if (Array.isArray(p.windows) && p.windows.length > 100) throw new QuotaError("Quota report has too many limits in an account. Previous readings were kept.");
    const windows = (Array.isArray(p.windows) ? p.windows : []).filter(Boolean).map(w => {
      // Ids round-trip through the supervisor's projection and are parsed twice, so the bound must
      // hold a fallback id whole (kind and label, 120 each, JSON-escaped): truncating it on the
      // second parse once collapsed long labels into "duplicate" limits. Same formula as fbb7f2b,
      // so saved per-limit choices keep their keys.
      const wid = text(w.id, "", 512) || JSON.stringify([text(w.kind, "unknown"), text(w.label, "Unnamed limit")]);
      if (windowIds.has(wid)) throw new QuotaError("Collector returned duplicate limit identities.");
      windowIds.add(wid);
      const shareOf = text(w.shareOf) || null;
      const remaining = percent(w.percentRemaining);
      const used = percent(w.percentUsed);
      const valid = !untrusted.has(wid);
      const pct = valid ? (used ?? (remaining === null ? null : 100 - remaining)) : null;
      return {
        id: wid, key: JSON.stringify([key, wid]), label: text(w.label, wid),
        kind: text(w.kind, "unknown"), percentUsed: pct, shareOf,
        resetsAt: stamp(w.resetsAt), windowSeconds: number(w.windowSeconds) > 0 ? w.windowSeconds : null,
        trusted: valid, paceStatus: text(w.pace?.status) || null,
        elapsedPercent: number(w.pace?.timeRemainingPercent) === null ? null : Math.max(0, Math.min(100, 100 - w.pace.timeRemainingPercent)),
      };
    });
    const refreshed = stamp(p.state?.refreshedAt);
    const name = ({ codex: "Codex", claude: "Claude", grok: "Grok", cursor: "Cursor", copilot: "GitHub Copilot", kimi: "Kimi", "opencode-go": "OpenCode Go" })[id] ?? id;
    providers.push({ id, key, account, label: text(p.label, name), plan: text(p.plan) || null,
      status: text(p.state?.status, "unknown"), stale: p.state?.stale === true,
      at: refreshed !== null ? Math.min(refreshed, at) : at,
      reused: p.state?.reused === true, windows,
      // quota-axi's own id, for targeted reads. Validated, never shell text.
      axi: /^[a-z0-9][a-z0-9_-]{0,63}$/.test(p.provider) ? p.provider : null,
    });
  }
  return { schema: report.schemaVersion, at, providers };
}

export function windowState(w, p, now, failed = false) {
  if (!w.trusted) return "untrusted";
  if (w.resetsAt !== null && w.resetsAt <= now) return "reset";
  if (w.shareOf) return "share";
  if (w.percentUsed === null) return "unknown";
  if (failed || p.stale || p.status !== "fresh" || now - p.at > STALE_MS) return "stale";
  return "fresh";
}
export function elapsed(w, now) {
  if (w.resetsAt !== null && w.resetsAt <= now) return null;
  if (w.elapsedPercent !== null) return w.elapsedPercent / 100;
  if (w.resetsAt === null || !w.windowSeconds) return null;
  return Math.max(0, Math.min(1, 1 - (w.resetsAt - now) / (w.windowSeconds * 1000)));
}
export function pace(w, now) {
  if (w.percentUsed === null || w.shareOf || !w.trusted) return "Pace unavailable";
  if (w.resetsAt !== null && w.resetsAt <= now) return "Awaiting next reading";
  if (w.paceStatus === "ahead") return "Ahead of pace";
  if (w.paceStatus === "behind") return "Under pace";
  const e = elapsed(w, now);
  if (e === null || e < .03) return "Pace unavailable";
  const diff = Math.round(w.percentUsed - e * 100);
  return Math.abs(diff) < 5 ? "On pace" : diff > 0 ? "Ahead of pace" : "Under pace";
}
export function resetLabel(w, now) {
  if (w.resetsAt === null) return "Reset not reported";
  if (w.resetsAt <= now) return "Reset passed · refresh needed";
  const mins = Math.ceil((w.resetsAt - now) / 60000), h = Math.floor(mins / 60);
  return `Resets in ${h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : h ? `${h}h ${mins % 60}m` : `${mins}m`}`;
}
const brief = w => w.kind === "session" && w.windowSeconds ? `${Math.round(w.windowSeconds / 360) / 10}h` : ({ weekly: "Week", monthly: "Month" })[w.kind] ?? w.label;
// Short names stay distinct within a provider: three monthly pools keep their own labels.
export function shortLabel(w, siblings = []) {
  const short = brief(w);
  if (!siblings.some(x => x !== w && brief(x) === short)) return short;
  return w.label ? w.label[0].toUpperCase() + w.label.slice(1) : short;
}
// An explicit per-limit choice wins over its kind's default.
export function shows(w, o) { return o.windows[w.key] ?? o.kinds[w.kind] !== false; }
export function visibleWindows(p, o) { return p.windows.filter(w => shows(w, o)); }
// The figure shown: used, or the remaining headroom. Health always follows usage.
export function reading(w, o) { return o.metric === "left" ? 100 - w.percentUsed : w.percentUsed; }
export function activeProvider(a) { return providerId(a.program?.key || a.app); }
export function remoteAgent(a, spaces) { return a.address?.includes("/") || Boolean(spaces.find(s => s.id === a.space)?.machine); }

export function catalog(report, discovered, live, spaces, o) {
  const list = (report?.providers ?? []).map(p => ({ ...p, installed: false, sessions: [], remote: false }));
  const byId = new Map();
  const machines = new Map(spaces.map(s => [s.id, s.machine]));
  const activity = new Map();
  for (const p of list) { if (!byId.has(p.id)) byId.set(p.id, []); byId.get(p.id).push(p); }
  const ensure = (id, label) => {
    if (!byId.has(id)) {
      const p = { id, key: JSON.stringify([id, "default"]), account: "default", label, windows: [], status: "unavailable", at: 0, installed: false, sessions: [], remote: false };
      list.push(p); byId.set(id, [p]);
    }
    return byId.get(id);
  };
  for (const a of discovered) {
    if (!a.installed) continue;
    const id = providerId(a.key);
    for (const p of ensure(id, a.name || id)) { p.installed = true; p.program = a; }
  }
  for (const a of live) {
    const id = activeProvider(a);
    if (!id) continue;
    if (!activity.has(id)) activity.set(id, { sessions: [], local: [], remote: [], program: a.program, urgency: 0 });
    const group = activity.get(id);
    group.sessions.push(a);
    (a.address?.includes("/") || machines.get(a.space) ? group.remote : group.local).push(a);
    group.urgency = Math.max(group.urgency, a.focused ? 4 : a.status === "working" ? 3 : a.status === "blocked" ? 2 : 1);
    ensure(id, a.program?.name || id);
  }
  for (const p of list) {
    const group = activity.get(p.id);
    // The activity belongs to a provider, never a particular account. Classify once,
    // then share read-only arrays across its lanes instead of scanning spaces per lane.
    p.sessions = group?.sessions ?? [];
    p.localSessions = group?.local ?? [];
    p.remoteSessions = group?.remote ?? [];
    p.program ??= group?.program;
    p.remote = p.sessions.length > 0 && p.localSessions.length === 0 && !p.installed && !p.windows.length;
    p.multiAccount = (byId.get(p.id)?.length ?? 0) > 1;
  }
  const favorites = new Map();
  o.favorites.forEach((id, i) => { if (!favorites.has(id)) favorites.set(id, i); });
  const fav = id => favorites.get(id) ?? 1000;
  const urgency = p => activity.get(p.id)?.urgency ?? 0;
  return list.filter(p => p.installed || p.sessions.length || p.windows.length || o.signedOut)
    .sort((a, b) => (o.activeFirst ? urgency(b) - urgency(a) : 0) || fav(a.id) - fav(b.id) || a.label.localeCompare(b.label) || a.account.localeCompare(b.account));
}

/** @param {boolean | ((p: any) => boolean)} [failed] Whether a provider's last read failed. */
export function redlines(list, o, now, failed = false) {
  const stale = typeof failed === "function" ? failed : () => failed;
  return list.flatMap(p => visibleWindows(p, o).filter(w => windowState(w, p, now, stale(p)) === "fresh" && w.percentUsed >= o.redline).map(w => ({ p, w })));
}

// A collection failure, normalized: the message and the quota-axi ids it left stale (null: all).
// Builds before this one stored only the message, which meant every provider.
export function failure(value) {
  if (typeof value === "string") return value ? { message: value, providers: null } : null;
  if (!value || typeof value.message !== "string" || !value.message) return null;
  return { message: value.message, providers: Array.isArray(value.providers) ? value.providers.filter(x => typeof x === "string") : null };
}
// Which providers stay stale after a read of `ids` (null: a sweep of every provider) that failed
// with `message`, or succeeded when message is null. `known`: the ids that currently have data.
export function failureAfter(previous, { message = null, ids = null, known = [] }) {
  const before = failure(previous);
  if (message) {
    if (ids === null || (before && before.providers === null)) return { message, providers: null };
    return { message, providers: [...new Set([...(before?.providers ?? []), ...ids])].sort() };
  }
  if (!before || ids === null) return null;
  const read = new Set(ids), left = (before.providers ?? known).filter(id => !read.has(id));
  return left.length ? { message: before.message, providers: [...new Set(left)].sort() } : null;
}
export function ageLabel(at, now) {
  if (!at) return "Not read yet";
  const m = Math.max(0, Math.floor((now - at) / 60000));
  return m < 1 ? "Updated just now" : m < 60 ? `Updated ${m}m ago` : `Updated ${Math.floor(m / 60)}h ${m % 60}m ago`;
}

// Why to read quota now, or null. Pure: every input is passed in.
export function schedule({ now, control = null, hasData = false, force = false, looking = false, working = false, finished = false, resetDue = false }) {
  const since = now - (control?.attempt ?? 0), failures = control?.failures ?? 0;
  if (force) return since >= CADENCE.manual ? "manual" : null;
  if (failures) return since >= Math.min(600000, CADENCE.retry * 2 ** Math.min(failures - 1, 4)) ? "retry" : null;
  if (!hasData) return "first";
  if (since < CADENCE.gap) return null;
  if (finished) return "turn";
  if (resetDue) return "reset";
  if (looking && since >= CADENCE.look) return "look";
  return since >= (working ? CADENCE.working : CADENCE.idle) ? (working ? "working" : "idle") : null;
}
export function needsSweep(control, now, reason) {
  return ["manual", "first", "retry"].includes(reason) || now - (control?.sweptAt ?? 0) >= CADENCE.sweep;
}
// A limit reset after the last reading, so the shown value is known to be old.
export function resetDue(data, control, now) {
  const last = control?.attempt ?? 0;
  return (data?.providers ?? []).some(p => p.windows.some(w => w.resetsAt !== null && w.resetsAt > last && w.resetsAt <= now - 15000));
}
// Providers worth a routine read: anything with limits, or an agent installed or running here.
export function targets(data, discovered = [], live = []) {
  const wanted = new Set([...discovered.filter(a => a.installed).map(a => providerId(a.key)), ...live.map(activeProvider)]);
  const ids = (data?.providers ?? []).filter(p => p.axi && (p.windows.length || wanted.has(p.id))).map(p => p.axi);
  return ids.length ? [...new Set(ids)].sort() : null;
}
// A targeted read replaces only the providers it covers; a sweep replaces everything.
export function mergeReport(previous, next, swept) {
  if (swept || !previous) return next;
  const read = new Set(next.providers.map(p => p.id));
  return { ...next, providers: [...previous.providers.filter(p => !read.has(p.id)), ...next.providers] };
}
