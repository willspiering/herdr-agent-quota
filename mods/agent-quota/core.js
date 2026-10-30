// Pure data boundary. Only these allowlisted fields reach Herdr's shared state.
export const PREFIX = "agent-quota.v1";
export const POLL_MS = 120000;
export const STALE_MS = 600000;
export const DEFAULTS = {
  hidden: [], kinds: { session: true, weekly: true, monthly: true, model: false, credits: true, unknown: true },
  windows: {}, signedOut: false, names: true, activeFirst: true,
  favorites: ["codex", "claude", "grok"], redline: 70,
};
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
    windows: { ...start.windows, ...saved.windows },
    redline: [60, 70, 80, 90].includes(o.redline) ? o.redline : 70,
  };
}

// Parse a complete JSON object, even after shell banners or ANSI status lines.
// Never echo a malformed report or a subprocess error: it could contain credentials.
export function parseReport(stdout, now = Date.now()) {
  if (typeof stdout !== "string" || stdout.length > 8 * 1024 * 1024) throw new Error("Quota report is missing or too large.");
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
  if (!report) throw new Error("Collector returned an unreadable quota report.");
  if (![3, 4, 5].includes(report.schemaVersion)) throw new Error("Unsupported quota schema. This version supports schemas 3–5.");
  const generated = stamp(report.generatedAt);
  const at = generated !== null && generated <= now + 60000 ? Math.min(generated, now) : now;
  const lanes = new Set();
  const providers = [];
  for (const p of report.providers.slice(0, 200)) {
    if (!p || typeof p.provider !== "string") continue;
    const id = providerId(p.provider);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) continue;
    const account = text(p.accountKey, "", 160) || (Array.isArray(p.accountKeys) ? p.accountKeys.map(x => text(x, "", 160)).filter(Boolean).sort().join("+") : "") || "default";
    const key = JSON.stringify([id, account]);
    if (lanes.has(key)) throw new Error("Collector returned duplicate account lanes.");
    lanes.add(key);
    const untrusted = new Set(Array.isArray(p.untrustedWindowIds) ? p.untrustedWindowIds : []);
    const windowIds = new Set();
    const windows = (Array.isArray(p.windows) ? p.windows : []).slice(0, 100).filter(Boolean).map(w => {
      const wid = text(w.id) || JSON.stringify([text(w.kind, "unknown"), text(w.label, "Unnamed limit")]);
      if (windowIds.has(wid)) throw new Error("Collector returned duplicate limit identities.");
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
export function shortLabel(w) {
  if (w.kind === "session") return w.windowSeconds ? `${Math.round(w.windowSeconds / 360) / 10}h` : w.label || "Session";
  return ({ weekly: "Week", monthly: "Month" })[w.kind] ?? w.label;
}
export function visibleWindows(p, o) { return p.windows.filter(w => o.kinds[w.kind] !== false && o.windows[w.key] !== false); }
export function activeProvider(a) { return providerId(a.program?.key || a.app); }
export function remoteAgent(a, spaces) { return a.address?.includes("/") || Boolean(spaces.find(s => s.id === a.space)?.machine); }

export function catalog(report, discovered, live, spaces, o) {
  const list = (report?.providers ?? []).map(p => ({ ...p, installed: false, sessions: [], remote: false }));
  const byId = new Map();
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
    const lanes = ensure(id, a.program?.name || id);
    // Associate activity with the provider, never claim a particular account.
    for (const p of lanes) { p.sessions.push(a); p.program ??= a.program; }
  }
  for (const p of list) {
    p.localSessions = p.sessions.filter(a => !remoteAgent(a, spaces));
    p.remoteSessions = p.sessions.filter(a => remoteAgent(a, spaces));
    p.remote = p.sessions.length > 0 && p.localSessions.length === 0 && !p.installed && !p.windows.length;
    p.multiAccount = (byId.get(p.id)?.length ?? 0) > 1;
  }
  const fav = id => { const i = o.favorites.indexOf(id); return i < 0 ? 1000 : i; };
  const urgency = p => p.sessions.some(a => a.focused) ? 4 : p.sessions.some(a => a.status === "working") ? 3 : p.sessions.some(a => a.status === "blocked") ? 2 : p.sessions.length ? 1 : 0;
  return list.filter(p => p.installed || p.sessions.length || p.windows.length || o.signedOut)
    .sort((a, b) => (o.activeFirst ? urgency(b) - urgency(a) : 0) || fav(a.id) - fav(b.id) || a.label.localeCompare(b.label) || a.account.localeCompare(b.account));
}

export function redlines(list, o, now, failed = false) {
  return list.flatMap(p => visibleWindows(p, o).filter(w => windowState(w, p, now, failed) === "fresh" && w.percentUsed >= o.redline).map(w => ({ p, w })));
}
export function ageLabel(at, now) {
  if (!at) return "Not read yet";
  const m = Math.max(0, Math.floor((now - at) / 60000));
  return m < 1 ? "Updated just now" : m < 60 ? `Updated ${m}m ago` : `Updated ${Math.floor(m / 60)}h ${m % 60}m ago`;
}
