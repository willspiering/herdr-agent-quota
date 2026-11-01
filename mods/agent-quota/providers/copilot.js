// GitHub Copilot's monthly quotas, from the Copilot user endpoint the Copilot CLI reads.
// Ported from quota-axi 0.1.69 providers/copilot.js and its credential readers (MIT). Never
// refreshes or exchanges a token, and only sends one to GitHub's own API host.
import { ReadFailure, str, num, name as plain, clampPercent, limit, lane, getJson, parseJson } from "./common.js";

export const id = "copilot";
export const label = "GitHub Copilot";
// quota-axi reads github.com unless QUOTA_AXI_COPILOT_HOST names a *.ghe.com host; Herdr can't
// see that variable, so only the public host is read here.
const USER = "https://api.github.com/copilot_internal/user";
const HEADERS = { accept: "application/json", "user-agent": "GitHubCopilotCLI/1.0" };
const SERVICE = "copilot-cli";
const HOSTS_LIMIT = 64 * 1024, TOKEN_LIMIT = 16 * 1024;

// quota-axi's object test: arrays count, so a list of snapshots is read the same way.
const loose = v => v && typeof v === "object" ? v : undefined;
const controls = v => [...v].some(c => c.charCodeAt(0) <= 0x1f || c.charCodeAt(0) === 0x7f);
function utf8Length(text) {
  let n = 0;
  for (const c of text) { const p = c.codePointAt(0) ?? 0; n += p < 0x80 ? 1 : p < 0x800 ? 2 : p < 0x10000 ? 3 : 4; }
  return n;
}
async function readFile(io, path) {
  try { return { text: await io.readTextFile(path) }; } catch { return { error: true }; }
}

// --- Copilot's legacy store: github-copilot/apps.json -------------------------------------

// A host name from a key or a URL-ish value, without the global URL Herdr's runtime lacks.
function normalizeHost(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return undefined;
  const authority = trimmed.replace(/^[a-z][a-z\d+.-]*:\/\//i, "").split(/[/?#]/, 1)[0] ?? "";
  const host = authority.slice(authority.lastIndexOf("@") + 1).split(":", 1)[0]?.toLowerCase();
  return host && /^[a-z0-9.-]+$/.test(host) && host.includes(".") ? host : undefined;
}
function appsToken(text) {
  const data = loose(parseJson(text ?? ""));
  if (!data) return undefined;
  const candidates = [];
  for (const [key, value] of Object.entries(data)) {
    const item = loose(value), token = str(item?.oauth_token);
    if (!token) continue;
    const host = [item.host, item.hostname, item.github_host, item.githubHost, item.server_uri, item.serverUri]
      .map(v => normalizeHost(str(v))).find(Boolean) ?? normalizeHost(key);
    candidates.push({ token, host });
  }
  // A token for github.com (or its API host) answers; one with no recorded host only when no
  // token names a host at all.
  const chosen = candidates.find(c => c.host === "api.github.com" || c.host === "github.com") ?? (candidates.some(c => c.host) ? undefined : candidates[0]);
  // A control character could not go in a header; such a token is not a credential.
  return chosen && !controls(chosen.token) ? chosen.token : undefined;
}
function appsPath(io) {
  return io.platform === "windows" ? `${io.home()}/AppData/Local/github-copilot/apps.json` : `${io.home()}/.config/github-copilot/apps.json`;
}

// --- The Copilot CLI's sign-in: ~/.copilot/config.json names a macOS Keychain item ----------

// Only full-line comments are removed, so an https:// host survives.
function selectedAccount(text) {
  let data;
  try { data = JSON.parse(text.split(/\r?\n/).filter(line => !line.trimStart().startsWith("//")).join("\n")); }
  catch { return { invalid: true }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { invalid: true };
  const selected = data.lastLoggedInUser;
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) return {};
  const { host, login } = selected;
  if (typeof host !== "string" || typeof login !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login)) return {};
  return { host, account: `${host}:${login}` };
}

// The outcome: { token } | { silent: true } (this store could not have named an account) |
// { unavailable: true } (an account is named but its secret couldn't be read) | { consent: true }.
// The Keychain item belongs to the Copilot CLI (service copilot-cli, account `${host}:${login}`);
// the secret is read only when `io.keychain` allows it. Windows' Credential Manager is not read.
async function cliToken(io) {
  if (io.platform !== "macos") return { silent: true };
  const path = `${io.home()}/.copilot/config.json`;
  const first = await readFile(io, path);
  if (first.error) return { unavailable: true };
  if (first.text == null) return { silent: true };
  const selected = selectedAccount(first.text);
  if (selected.invalid) return { unavailable: true };
  if (!selected.account) return { silent: true };
  if (selected.host !== "https://github.com") return { unavailable: true };
  const args = ["find-generic-password", "-s", SERVICE, "-a", selected.account];
  const allowed = !io.keychain || io.keychain.allowed;
  let result;
  // Without consent only the item's presence is checked, which never shows a prompt.
  try { result = await io.exec("/usr/bin/security", allowed ? [...args, "-w"] : args); } catch { return { unavailable: true }; }
  if (result?.code !== 0) return { unavailable: true };
  if (!allowed) return { consent: true };
  const token = String(result.stdout ?? "").replace(/[\r\n]+$/, "");
  if (token.length > TOKEN_LIMIT || !/^(?:gho_|ghu_|github_pat_)[A-Za-z0-9_]+$/.test(token)) return { unavailable: true };
  if (io.keychain) io.keychain.granted = true;
  // A profile switch while the prompt was open invalidates this reading.
  const again = await readFile(io, path);
  if (again.error || again.text == null || selectedAccount(again.text).account !== selected.account) return { unavailable: true };
  return { token };
}

// --- The GitHub CLI's plain-text login: gh/hosts.yml -----------------------------------------

// quota-axi's narrow reader of the block mappings `gh` writes. It keeps only github.com's own
// oauth_token; anything outside that plain shape makes the file unreadable rather than guessed.
function readQuoted(text) {
  const quote = text[0];
  let value = "";
  for (let i = 1; i < text.length; i += 1) {
    const c = text[i];
    if (quote === '"' && c === "\\") return undefined;
    if (c !== quote) { value += c; continue; }
    if (quote === "'" && text[i + 1] === "'") { value += "'"; i += 1; continue; }
    return { value, rest: text.slice(i + 1) };
  }
  return undefined;
}
function parseEntry(content) {
  let key, rest;
  if (content.startsWith("'") || content.startsWith('"')) {
    const quoted = readQuoted(content);
    if (!quoted || !quoted.rest.startsWith(":")) return undefined;
    key = quoted.value; rest = quoted.rest.slice(1);
  } else {
    if (/^[-?:,[\]{}#&*!|>%@`]/.test(content)) return undefined;
    const separator = /:(?=\s|$)/.exec(content);
    if (!separator) return undefined;
    key = content.slice(0, separator.index).trimEnd(); rest = content.slice(separator.index + 1);
  }
  if (key === "" || (rest !== "" && !/^\s/.test(rest))) return undefined;
  const value = rest.trim();
  return value === "" || value.startsWith("#") ? { key, value: undefined } : { key, value };
}
function scalarValue(value) {
  if (value.startsWith("'") || value.startsWith('"')) {
    const quoted = readQuoted(value);
    if (!quoted) return undefined;
    const trailing = quoted.rest.trim();
    return trailing === "" || trailing.startsWith("#") ? quoted.value : undefined;
  }
  if (/^[-?:,[\]{}&*!|>%@`]/.test(value)) return undefined;
  const comment = /\s#/.exec(value);
  return (comment ? value.slice(0, comment.index) : value).trimEnd();
}
/** @returns {{ invalid?: boolean, host?: string, token?: string }} */
function scanHosts(text, target) {
  const isHost = path => path.length === 1 && path[0] === target;
  const isToken = path => path.length === 2 && path[0] === target && path[1] === "oauth_token";
  /** @type {{ host: string, token?: string }} */
  const result = { host: "absent" };
  /** @type {{ indent: number, path: string[], seen: Set<string>, shadowed: boolean }[]} */
  const stack = [];
  /** @type {{ indent: number, path: string[], shadowed: boolean } | null} */
  let pending = null;
  let sawContent = false;
  const recordEmpty = key => {
    if (key.shadowed) return;
    if (isHost(key.path)) result.host = "other";
    if (isToken(key.path)) result.token = "";
  };
  for (const rawLine of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const leading = /^[ \t]*/.exec(rawLine)?.[0] ?? "";
    const content = rawLine.slice(leading.length);
    if (content === "" || content.startsWith("#")) continue;
    if (leading.includes("\t")) return { invalid: true };
    if (!sawContent && leading === "" && /^---\s*(#.*)?$/.test(content)) { sawContent = true; continue; }
    sawContent = true;
    const indent = leading.length;
    if (pending && indent > pending.indent) {
      stack.push({ indent, path: pending.path, seen: new Set(), shadowed: pending.shadowed });
      if (!pending.shadowed) {
        if (isHost(pending.path)) result.host = "mapping";
        if (isToken(pending.path)) result.token = "non_scalar";
      }
    } else if (pending) recordEmpty(pending);
    pending = null;
    if (stack.length === 0) stack.push({ indent, path: [], seen: new Set(), shadowed: false });
    while (stack.length > 1 && stack[stack.length - 1].indent > indent) stack.pop();
    const frame = stack[stack.length - 1];
    if (frame.indent !== indent) return { invalid: true };
    const entry = parseEntry(content);
    if (!entry) return { invalid: true };
    const path = [...frame.path, entry.key];
    const shadowed = frame.shadowed || frame.seen.has(entry.key);
    frame.seen.add(entry.key);
    if (entry.value === undefined) { pending = { indent, path, shadowed }; continue; }
    if (shadowed) continue;
    if (isHost(path)) result.host = "other";
    if (isToken(path)) {
      const token = scalarValue(entry.value);
      if (token === undefined) return { invalid: true };
      result.token = token;
    }
  }
  if (pending) recordEmpty(pending);
  return result;
}
// A keyring login (no token in the file) is never read: `gh` is not launched for a token.
function ghToken(text) {
  if (text == null || utf8Length(text) > HOSTS_LIMIT) return undefined;
  const scanned = scanHosts(text, "github.com");
  if (scanned.invalid || scanned.host !== "mapping" || scanned.token === "non_scalar" || !scanned.token) return undefined;
  const token = scanned.token;
  // Only a literal secret: never a $reference or !command, never a control character.
  return token.trim() && !token.startsWith("!") && !token.includes("$") && !controls(token) ? token : undefined;
}
function ghPath(io) {
  return io.platform === "windows" ? `${io.home()}/AppData/Roaming/GitHub CLI/hosts.yml` : `${io.home()}/.config/gh/hosts.yml`;
}

// --- The quota ------------------------------------------------------------------------------

// Epoch seconds or milliseconds, or a date string; anything else is unknown.
function epochOrDate(value) {
  const n = num(value);
  if (n !== undefined) { const d = new Date(n > 10_000_000_000 ? n : n * 1000); return Number.isNaN(d.getTime()) ? undefined : d.toISOString(); }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
const snapshotReset = value => { const n = num(value); return n !== undefined && n <= 0 ? undefined : epochOrDate(value); };

// Each quota snapshot is a monthly window named by its key; no window length is reported, as
// in quota-axi. A key that isn't a plain short name is left out of shared state.
export function usageWindows(raw, now) {
  const data = loose(raw), snapshots = loose(data?.quota_snapshots);
  if (!snapshots) return [];
  const windows = [];
  for (const [key, value] of Object.entries(snapshots)) {
    const item = loose(value), remaining = num(item?.percent_remaining);
    if (remaining === undefined || !plain(key)) continue;
    windows.push(limit(now, { id: key, label: key.replace(/_/g, " "), kind: "monthly", percentUsed: clampPercent(100 - remaining),
      resetsAt: snapshotReset(item.quota_reset_at) ?? epochOrDate(data.quota_reset_date_utc) }));
  }
  return windows;
}
// quota-axi accepts an answer with windows, a plan or a login; anything else is unrecognized.
function quota(raw, now) {
  const data = loose(raw);
  if (!data) return undefined;
  const windows = usageWindows(data, now), plan = str(data.copilot_plan) ?? str(data.access_type_sku) ?? str(data.sku);
  if (!windows.length && !plan && !str(data.login)) return undefined;
  return { windows, plan: plain(plan) ?? null };
}

// quota-axi's source order: apps.json, the Copilot CLI's Keychain item, then the GitHub CLI's
// login. A rejected token hands over to the next store; any other failure stops the read.
export async function read(io) {
  const now = io.now;
  let unavailable = false, consent = false;
  const sources = [
    async () => appsToken((await readFile(io, appsPath(io))).text),
    async () => {
      const cli = await cliToken(io);
      if (cli.unavailable) unavailable = true;
      if (cli.consent) consent = true;
      return cli.token;
    },
    async () => ghToken((await readFile(io, ghPath(io))).text),
  ];
  for (const source of sources) {
    const token = await source();
    if (!token) continue;
    const answer = await getJson(io, USER, { ...HEADERS, authorization: `Bearer ${token}` });
    if (answer.auth) continue;
    const found = quota(answer.body, now);
    if (!found) throw new ReadFailure("malformed");
    return lane(id, label, now, { plan: found.plan, windows: found.windows });
  }
  // A Copilot CLI account whose Keychain item awaits approval: not signed out, just unread.
  if (consent) throw new ReadFailure("keychain");
  return lane(id, label, now, { status: unavailable ? "unavailable" : "auth_required" });
}
