// When and how quota is read. Only the status bar's copy schedules reads (every 10 s it checks
// whether one is due); a dashboard asks it for one. A read claims `control` first, so two copies
// never read at once, and a late answer from a replaced claim is refused by its token.
import { exec, home, readTextFile, knownAgents, agents, spaces, run, window as appWindow } from "herdr";
import { localAgents, QuotaError, CADENCE, schedule, needsSweep, resetDue, targets, mergeReport, failureAfter, forgetUnreadable } from "./core.js";
import { collect, READ_MS } from "./collector.js";
import { ADAPTERS } from "./providers/index.js";
import { get, put } from "./state.js";

const GENERIC_ERROR = "Quota collection failed. Earlier readings were kept; retries back off.";
// Coordination is shared across copies/builds, not a module variable whose lifetime depends
// on Herdr's module cache. A read can't outlive claim + READ_MS: every provider read races that
// deadline. The claim lasts 5 s longer, so a cancelled copy's claim recovers without overlapping
// a live read.
const CLAIM_MS = READ_MS + 5000;
// How long a dashboard waits for the strip to claim a read it asked for before reading itself.
const DELEGATE_MS = 4000;

// A Refresh is never dropped silently: during a read the spinner shows it (whichever copy
// reads); inside the cooldown it is queued, shown, and run when the cooldown ends.
export function refresh(view, cx) {
  const now = Date.now(), control = get("control");
  if (view.pending || control?.busyUntil > now) { cx.notify(); return; }
  const wait = CADENCE.manual - (now - (control?.attempt ?? 0));
  if (wait <= 0) { requestRead(view, cx, "refresh"); return; }
  if (!view.queued) {
    view.queued = true;
    cx.timer.after(wait, cx => { view.queued = false; requestRead(view, cx, "refresh"); cx.notify(); });
  }
  cx.notify();
}

// A dashboard copy lives only while its window is open; a read it owned would be cancelled by
// closing it, leaving an orphaned claim and no data. So it asks the long-lived strip (claimed in
// ~0.1 s natively), and reads itself only if nothing was claimed within DELEGATE_MS (a layout
// without the strip).
export function requestRead(view, cx, why) {
  const options = why === "look" ? { looking: true } : { force: true };
  if (view.mode !== "dashboard") { tick(view, cx, options); return; }
  const asked = Date.now();
  run(`agent-quota.${why}`);
  cx.timer.after(DELEGATE_MS, cx => {
    const c = get("control");
    if ((c?.attempt ?? 0) >= asked || c?.busyUntil > Date.now()) return;
    tick(view, cx, options);
  });
}

// A turn has finished when an agent that was working no longer is (or has gone).
export function observe(view, now, live = localAgents(agents(), spaces())) {
  const next = new Map(live.map(a => [a.address, a.status]));
  if (view.statuses) for (const [address, status] of view.statuses) {
    if (status === "working" && next.get(address) !== "working" && !view.finishedAt) view.finishedAt = now;
  }
  view.statuses = next;
  return live;
}

// Read now if one is due (core.js `schedule` decides), or when forced (Refresh) or looking (the
// dashboard opened and the last reading is over a minute old).
export function tick(view, cx, { force = false, looking = false } = {}) {
  const now = Date.now(), data = get("data") ?? null;
  let control = get("control") ?? null;
  // A copy stopped mid-read (reload, quit) leaves its claim behind. Clear it once it expires,
  // so every copy's spinner stops; its late result is still refused by token.
  if (!view.pending && control?.busyUntil && control.busyUntil <= now) {
    const { busyUntil: _expired, token: _token, ...rest } = control;
    put("control", control = rest);
  }
  const live = view.mode === "strip" ? observe(view, now) : localAgents(agents(), spaces());
  if (view.finishedAt && view.finishedAt <= (control?.attempt ?? 0)) view.finishedAt = 0;
  if (view.pending || control?.busyUntil > now) return;
  const reason = schedule({ now, control, hasData: Boolean(data), force, looking,
    working: live.some(a => a.status === "working"), finished: view.finishedAt > 0, resetDue: resetDue(data, control, now) });
  if (!reason) return;
  const sweep = needsSweep(control, now, reason);
  const ids = sweep ? null : targets(data, get("discovered") ?? [], live);
  view.pending = true;
  const token = `${view.id}-${now}`;
  // Claim synchronously before yielding: a second strip/dashboard sees it immediately.
  put("control", { ...control, attempt: now, busyUntil: now + CLAIM_MS, token });
  if (force || looking) cx.notify();
  // Owned by this copy explicitly: tick() also runs inside task continuations (after init's
  // await), where TaskOptions.owner would default to "whichever view is running".
  const own = { owner: view };
  cx.spawn(async cx => {
    cx.phase();
    if (get("control")?.token !== token || Date.now() - now >= CLAIM_MS) { view.pending = false; return; }
    const next = { attempt: now, failures: 0, sweptAt: control?.sweptAt ?? 0, discoveredAt: control?.discoveredAt ?? 0, reason };
    let result, error = null;
    // A background read never raises a Keychain prompt: each provider reads its own Keychain item
    // only once that item has been read successfully before, and a Refresh, which the user asked
    // for, may prompt. Only the fact of each grant is kept. Migrating once from older builds
    // (no `keychains` yet): `keychain: true` meant Claude's, and quota-axi read Claude on macOS
    // only through its Keychain item, so a Claude reading also counts.
    const legacy = !Array.isArray(control?.keychains) && (control?.keychain === true || (data?.providers ?? []).some(p => p.id === "claude" && p.windows.length > 0));
    const before = new Set([...(Array.isArray(control?.keychains) ? control.keychains : []), ...(legacy ? ["claude"] : [])]);
    const grants = {};
    const keychain = id => (grants[id] ??= { allowed: before.has(id) || reason === "manual", granted: false, denied: false });
    // Native reads use Herdr's fetch and file reads; each request races this task's own timer.
    const io = { exec, fetch: (url, init) => fetch(url, init), readTextFile, home, platform: appWindow().platform, adapters: ADAPTERS, keychain,
      sleep: ms => new Promise(resolve => { cx.timer.after(ms, () => resolve()); }) };
    try {
      result = await collect(io, Date.now(), ids, now + READ_MS);
      // A sweep that ran is a sweep, even if one provider failed in it: that provider retries.
      if (ids === null) next.sweptAt = now;
      // A provider failing backs the schedule off, as a failed read always did; one waiting for a
      // Keychain approval doesn't, since only the user can give it.
      if (result.failed?.backoff) next.failures = (control?.failures ?? 0) + 1;
    } catch (e) {
      // Only this mod's own messages are kept; anything else could echo a vendor's answer.
      error = e instanceof QuotaError ? e.message.slice(0, 160) : GENERIC_ERROR;
      next.failures = (control?.failures ?? 0) + 1;
    }
    cx.phase();
    // A late answer from an expired/replaced claim must not clobber newer readings.
    if (get("control")?.token !== token) { view.pending = false; return; }
    const known = (get("data")?.providers ?? []).map(p => p.axi).filter(Boolean);
    // A sweep also drops what no provider can read any more (see forgetUnreadable).
    const swept = ids === null ? forgetUnreadable(get("data"), get("error"), new Set(ADAPTERS.map(a => a.id))) : { data: get("data"), error: get("error") };
    if (result) put("data", mergeReport(swept.data, result.report, result.swept));
    // What this read replaced is no longer stale; providers it couldn't read keep their earlier
    // readings and become stale. A read that failed outright leaves everything it covered stale.
    const after = result ? failureAfter(swept.error, { ids: result.cleared, known }) : failureAfter(swept.error, { message: error, ids: sweep ? null : ids, known });
    put("error", result?.failed ? failureAfter(after, { message: result.failed.message, ids: result.failed.ids, known }) : after);
    // Discovery isn't on the collection critical path and never holds its claim open.
    const discover = now - next.discoveredAt >= CADENCE.discover || (reason === "manual" && now - next.discoveredAt >= CADENCE.gap);
    if (discover) next.discoveredAt = now; // rate-limit failures too
    // A failed Keychain read forgets a grant only on a Refresh, with the user there to see the
    // prompt; in the background it may just be a locked Keychain after sleep.
    next.keychains = [...new Set([...before, ...Object.entries(grants).filter(([, g]) => g.granted).map(([id]) => id)])]
      .filter(id => !(reason === "manual" && grants[id]?.denied)).sort();
    put("control", next);
    view.pending = false;
    cx.notify();
    if (discover) cx.spawn(async cx => {
      cx.phase();
      let list;
      try { list = await knownAgents(); } catch { return; }
      cx.phase();
      put("discovered", list.map(a => ({ key: a.key, name: a.name, icon: a.icon, tint: a.tint, installed: a.installed })));
    }, own);
  }, own);
}
