import test from "node:test";
import assert from "node:assert/strict";
import { parseReport, options, windowState, catalog, redlines, pace, elapsed, resetLabel, shortLabel, visibleWindows, reading, QuotaError, CADENCE, STALE_MS, schedule, needsSweep, resetDue, targets, mergeReport } from "../mods/agent-quota/core.js";
import { collect } from "../mods/agent-quota/collector.js";
import { integrateLayout } from "../scripts/layout.mjs";

const now = Date.parse("2026-10-30T20:00:00Z");
const window = (extra = {}) => ({ id: "five_hour", kind: "session", label: "5 hours", percentRemaining: 30, resetsAt: "2026-10-30T22:00:00Z", windowSeconds: 18000, ...extra });
const provider = (extra = {}) => ({ provider: "codex", state: { status: "fresh", refreshedAt: new Date(now).toISOString() }, windows: [window()], ...extra });
const report = (providers = [provider()], schemaVersion = 5) => ({ schemaVersion, generatedAt: new Date(now).toISOString(), providers });
const parse = r => parseReport(JSON.stringify(r), now);
const opts = options();
const runtime = { node: "/node", runner: "/runner", collector: "/collector" };

test("schema 5 remaining becomes used without reversing quota", () => {
  const p = parse(report()).providers[0];
  assert.equal(p.windows[0].percentUsed, 70);
  assert.equal(redlines([p], opts, now).length, 1);
  assert.equal(redlines([p], opts, now, true).length, 0);
});
test("schema 3 used, zero and missing are different", () => {
  for (const used of [0, 19, 100]) assert.equal(parse(report([provider({ windows: [window({ percentUsed: used, percentRemaining: undefined })] })], 3)).providers[0].windows[0].percentUsed, used);
  const w = parse(report([provider({ windows: [window({ percentRemaining: undefined })] })])).providers[0].windows[0];
  assert.equal(w.percentUsed, null);
});
test("unknown and unsupported schemas fail visibly", () => {
  assert.throws(() => parse(report([], 99)), /Unsupported/);
  assert.throws(() => parseReport("error: token=SECRET", now), /unreadable/);
});
test("shell banners and trailing output do not corrupt JSON", () => {
  const data = parseReport('banner {not JSON}\n' + JSON.stringify(report()) + '\nbye', now);
  assert.equal(data.providers.length, 1);
});
test("allowlist drops secrets, identity and subprocess diagnostics", () => {
  const data = parse(report([provider({ token: "SECRET", account: { email: "PRIVATE" }, raw: "SECRET", windows: [window({ debug: "SECRET" })] })]));
  assert.doesNotMatch(JSON.stringify(data), /SECRET|PRIVATE|email|token/);
});
test("multiple account lanes never merge or sum", () => {
  const result = parse(report([provider({ accountKeys: ["a"] }), provider({ accountKeys: ["b"] })]));
  const list = catalog(result, [], [], [], opts);
  assert.equal(list.length, 2);
  assert.notEqual(list[0].key, list[1].key);
  assert.ok(list.every(p => p.multiAccount));
  assert.throws(() => parse(report([provider(), provider()])), /duplicate/);
});
test("expired, untrusted, share and stale never count as healthy headroom", () => {
  const p = parse(report()).providers[0], w = p.windows[0];
  assert.equal(windowState(w, p, now), "fresh");
  assert.equal(windowState(w, p, now, true), "stale");
  assert.equal(windowState(w, { ...p, stale: true }, now), "stale");
  assert.equal(windowState(w, p, now + STALE_MS + 1), "stale");
  assert.ok(STALE_MS > CADENCE.idle); // an idle reading is never stale before the next one
  assert.equal(windowState({ ...w, resetsAt: now }, p, now), "reset");
  assert.equal(windowState({ ...w, trusted: false }, p, now), "untrusted");
  assert.equal(windowState({ ...w, shareOf: "monthly" }, p, now), "share");
  assert.equal(redlines([{ ...p, windows: [{ ...w, shareOf: "monthly" }] }], opts, now).length, 0);
});
test("untrusted provider window IDs suppress numeric values", () => {
  const p = parse(report([provider({ untrustedWindowIds: ["five_hour"] })])).providers[0];
  assert.equal(p.windows[0].percentUsed, null);
});
test("invalid dates and negative values stay unknown", () => {
  const w = parse(report([provider({ windows: [window({ percentRemaining: -1, resetsAt: "bad", windowSeconds: -1 })] })])).providers[0].windows[0];
  assert.equal(w.percentUsed, null); assert.equal(w.resetsAt, null); assert.equal(w.windowSeconds, null);
  assert.equal(resetLabel(w, now), "Reset not reported");
  assert.equal(elapsed(w, now), null);
});
test("pace respects actual duration and does not invent five hours", () => {
  const w = parse(report()).providers[0].windows[0];
  assert.equal(elapsed(w, now), .6);
  assert.equal(pace(w, now), "Ahead of pace");
  assert.equal(pace({ ...w, windowSeconds: null }, now), "Pace unavailable");
  assert.equal(pace({ ...w, resetsAt: now }, now), "Awaiting next reading");
});
test("running and focused agents rise ahead of favorite order", () => {
  const live = [{ address: "t3", space: "s", program: { key: "claude-code", name: "Claude" }, focused: true, status: "working" }];
  const list = catalog(parse(report()), [{ key: "claude", installed: true }, { key: "grok", installed: true }], live, [], opts);
  assert.deepEqual(list.map(p => p.id), ["claude", "codex", "grok"]);
  assert.equal(list[0].sessions.length, 1);
});
test("unknown installed agents stay visible, remote activity is not local quota", () => {
  const list = catalog(null, [{ key: "opencode", installed: true, name: "OpenCode" }], [{ address: "server/t1", space: "server/s1", program: { key: "grok" }, status: "idle" }], [{ id: "server/s1", machine: "server" }], opts);
  assert.equal(list.find(p => p.id === "grok").remote, true);
  assert.equal(list.find(p => p.id === "opencode").windows.length, 0);
});
test("per-window and kind choices apply to redline summary", () => {
  const p = parse(report()).providers[0];
  assert.equal(redlines([p], options({}, { windows: { [p.windows[0].key]: false } }), now).length, 0);
  assert.equal(redlines([p], options({}, { kinds: { session: false } }), now).length, 0);
});
test("hidden individual limits keep identity after a provider reorders its windows", () => {
  const session = window(), weekly = window({ id: "weekly", kind: "weekly" });
  const initial = parse(report([provider({ windows: [session, weekly] })])).providers[0];
  const later = parse(report([provider({ windows: [weekly, session] })])).providers[0];
  assert.equal(initial.windows[0].key, later.windows[1].key);
  const o = options({}, { windows: { [initial.windows[0].key]: false } });
  assert.equal(redlines([later], o, now).length, 1);
  assert.equal(redlines([later], o, now)[0].w.id, "weekly");
});
test("ambiguous duplicate limit IDs fail rather than sharing display choices", () => {
  assert.throws(() => parse(report([provider({ windows: [window(), window()] })])), /duplicate limit/);
});
test("saved choices override props without dropping other defaults", () => {
  const o = options({ hidden: ["grok"], kinds: { monthly: false } }, { names: false, kinds: { session: false } });
  assert.deepEqual(o.hidden, ["grok"]); assert.equal(o.kinds.weekly, true); assert.equal(o.kinds.session, false); assert.equal(o.kinds.monthly, false);
});
test("collector accepts exit 1 reports and does not repeat provider calls", async () => {
  let calls = 0;
  const result = await collect(async () => { calls++; return { code: 1, stdout: JSON.stringify(report()), stderr: "SECRET" }; }, runtime, now);
  assert.equal(result.report.providers.length, 1); assert.equal(calls, 1); assert.equal(result.swept, true);
});
test("an installation without the supervisor cannot fall back to an unbounded shell", async () => {
  const calls = [];
  await assert.rejects(collect(async (...args) => { calls.push(args); }, {}, now), /needs setup/);
  await assert.rejects(collect(async () => { calls.push("once"); throw Error("SECRET"); }, runtime, now), /could not start/);
  assert.deepEqual(calls, ["once"]);
});
test("targeted reads use supervised argv and invalid provider ids cause a sweep", async () => {
  const calls = [];
  const runner = async (cmd, args) => { calls.push([cmd, args]); return { code: 0, stdout: JSON.stringify(report()) }; };
  const result = await collect(runner, runtime, now, ["claude", "codex"]);
  assert.deepEqual(calls[0], ["/node", ["/runner", "/collector", String(now + 30000), "claude", "codex"]]);
  assert.equal(result.swept, false);
  await collect(runner, runtime, now, ["bad id;rm"]);
  assert.deepEqual(calls[1][1], ["/runner", "/collector", String(now + 30000)]);
  for (const code of [124, 125, 126]) await assert.rejects(collect(async () => ({ code, stdout: "SECRET" }), runtime, now), QuotaError);
});
test("the scheduler reads after a turn, never closer than a minute", () => {
  const control = { attempt: now - 30000 };
  assert.equal(schedule({ now, control, hasData: true, finished: true }), null);
  assert.equal(schedule({ now: now + 30000, control, hasData: true, finished: true }), "turn");
  assert.equal(schedule({ now, control: { attempt: now - 5000 }, hasData: true, force: true }), null);
  assert.equal(schedule({ now, control: { attempt: now - 11000 }, hasData: true, force: true }), "manual");
  assert.equal(schedule({ now, control: null, hasData: false }), "first");
});
test("the scheduler backs off after failures and then sweeps", () => {
  const at = f => schedule({ now, control: { attempt: now - f[1], failures: f[0] }, hasData: true, finished: true });
  assert.equal(at([1, 59000]), null); assert.equal(at([1, 60000]), "retry");
  assert.equal(at([3, 239000]), null); assert.equal(at([3, 240000]), "retry");
  assert.equal(at([9, 599000]), null); assert.equal(at([9, 600000]), "retry");
  assert.equal(needsSweep({ sweptAt: now }, now, "retry"), true);
  assert.equal(needsSweep({ sweptAt: now - 1000 }, now, "turn"), false);
  assert.equal(needsSweep({ sweptAt: now - CADENCE.sweep }, now, "idle"), true);
});
// Drive the real scheduler at the strip's 10 s check for a simulated period.
function simulate({ hours, working = () => false, finishes = () => false }) {
  let control = { attempt: 0 }, finishedAt = 0, reads = [];
  for (let t = now; t < now + hours * 3600000; t += 10000) {
    if (finishes(t)) finishedAt ||= t;
    if (finishedAt && finishedAt <= control.attempt) finishedAt = 0;
    const reason = schedule({ now: t, control, hasData: true, working: working(t), finished: finishedAt > 0 });
    if (reason) { reads.push([t, reason]); control = { attempt: t }; }
  }
  return reads;
}
test("an idle day costs at most 145 reads, not 720", () => {
  const reads = simulate({ hours: 24 });
  assert.ok(reads.length <= 145, `${reads.length}`);
  assert.ok(reads.every(([, r]) => r === "idle"));
});
test("a busy hour is bounded by the one-minute gap and serves every finished turn", () => {
  // Ten agents finishing a turn every 20 seconds between them.
  const reads = simulate({ hours: 1, working: () => true, finishes: t => (t - now) % 20000 === 0 });
  assert.ok(reads.length <= 61, `${reads.length}`);
  for (let i = 1; i < reads.length; i++) assert.ok(reads[i][0] - reads[i - 1][0] >= CADENCE.gap);
});
test("a finished turn is read within the next check once the gap allows", () => {
  // Finishes 3 s after a check, 10 s after a backstop read: the worst case for both.
  const done = now + 15 * 60000 + 13000;
  const reads = simulate({ hours: 1, working: () => true, finishes: t => t >= done && t < done + 10000 });
  const turn = reads.find(([, r]) => r === "turn");
  assert.ok(turn && turn[0] - done <= CADENCE.gap + 10000, `${turn && turn[0] - done}`);
});
test("a long working turn still gets a reading every three minutes", () => {
  const reads = simulate({ hours: 1, working: () => true });
  assert.ok(reads.length >= 19 && reads.length <= 21, `${reads.length}`);
});
test("a limit that reset since the last reading is due", () => {
  const data = parse(report());
  const w = data.providers[0].windows[0];
  assert.equal(resetDue(data, { attempt: w.resetsAt - 1000 }, w.resetsAt + 20000), true);
  assert.equal(resetDue(data, { attempt: w.resetsAt + 1000 }, w.resetsAt + 20000), false); // already read since
  assert.equal(resetDue(data, { attempt: w.resetsAt - 1000 }, w.resetsAt + 5000), false);  // give the vendor 15 s
});
test("targets cover providers with limits or local agents, never unknown ids", () => {
  const data = parse(report([provider(), provider({ provider: "cursor", windows: [] }), provider({ provider: "grok", windows: [] })]));
  assert.deepEqual(targets(data, [], []), ["codex"]);
  assert.deepEqual(targets(data, [{ key: "cursor", installed: true }], [{ program: { key: "grok" } }]), ["codex", "cursor", "grok"]);
  assert.equal(targets(null, [], []), null);
});
test("a targeted read replaces only what it read", () => {
  const before = parse(report([provider(), provider({ provider: "claude" })]));
  const after = parse(report([provider({ windows: [window({ percentRemaining: 5 })] })]));
  const merged = mergeReport(before, after, false);
  assert.equal(merged.providers.length, 2);
  assert.equal(merged.providers.find(p => p.id === "codex").windows[0].percentUsed, 95);
  assert.equal(mergeReport(before, after, true).providers.length, 1);
});
test("layout integration keeps the existing status and is idempotent", () => {
  const source = { id: "root", type: "column", children: [{ id: "status", type: "block", size: { px: 28 }, content: { mod: "workspace-status" } }] };
  const next = integrateLayout(source);
  assert.equal(source.children[0].type, "block");
  assert.equal(next.children[0].children[0].content.mod, "workspace-status");
  assert.equal(next.children[0].children[1].content.mod, "agent-quota");
  assert.deepEqual(integrateLayout(next), next);
  assert.throws(() => integrateLayout({ type: "block", content: { mod: "win98" } }), /No standard/);
});
test("optional headers preserve custom headers by refusing replacement", () => {
  const source = { type: "column", children: [{ id: "status", type: "block", content: { mod: "workspace-status" } }, { type: "block", content: { tab: "active", pane: { header: { content: { mod: "custom" } } } } }] };
  assert.throws(() => integrateLayout(source, { headers: true }), /Custom pane header/);
});
test("display choices are validated and window choices must be booleans", () => {
  const o = options({}, { strip: "neon", dash: "gauges", metric: "left", palette: 3, windows: { a: false, b: "yes", c: true } });
  assert.equal(o.strip, "meter"); assert.equal(o.dash, "gauges"); assert.equal(o.metric, "left"); assert.equal(o.palette, "terminal");
  assert.deepEqual(o.windows, { a: false, c: true });
});
test("short labels stay unique within a provider", () => {
  const monthly = ["chat", "completions"].map(label => ({ kind: "monthly", label }));
  assert.deepEqual(monthly.map(w => shortLabel(w, monthly)), ["Chat", "Completions"]);
  const pair = [{ kind: "session", windowSeconds: 18000, label: "session" }, { kind: "weekly", label: "week" }];
  assert.deepEqual(pair.map(w => shortLabel(w, pair)), ["5h", "Week"]);
});
test("an explicit limit choice overrides its kind default", () => {
  const p = parse(report()).providers[0], key = p.windows[0].key;
  assert.equal(visibleWindows(p, options({}, { kinds: { session: false } })).length, 0);
  assert.equal(visibleWindows(p, options({}, { kinds: { session: false }, windows: { [key]: true } })).length, 1);
});
test("left shows headroom from the same measurement", () => {
  const w = parse(report()).providers[0].windows[0];
  assert.equal(reading(w, options()), 70); assert.equal(reading(w, options({}, { metric: "left" })), 30);
});
test("collector and parser failures are typed as this mod's own messages", async () => {
  assert.throws(() => parseReport("nope", now), QuotaError);
  await assert.rejects(collect(async () => ({ code: 2, stdout: "" }), {}, now), QuotaError);
});
