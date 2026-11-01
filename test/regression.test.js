// Regression tests for REVIEW-394cad9.md (F1–F4). Fake collectors only; no credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHost, walk, flatten } from "./host.js";
import * as core from "../mods/agent-quota/core.js";
const { parseReport, PREFIX } = core;
const failureAfter = (...args) => core.failureAfter(...args);
import { collectAxi } from "../mods/agent-quota/collector.js";
import * as supervisor from "../scripts/collector-process.mjs";

const posix = { skip: process.platform === "win32" };
const entry = fileURLToPath(new URL("../scripts/collect.mjs", import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === "ESRCH") return false; throw e; } };
async function gone(pid, ms = 2000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (!alive(pid)) return true;
  return !alive(pid);
}
async function until(fn, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) { const v = await fn().catch(() => null); if (v) return v; }
  throw Error("timed out waiting");
}
const report = (providers) => JSON.stringify({ schemaVersion: 5, generatedAt: new Date().toISOString(), providers });
const codex = { provider: "codex", state: { status: "fresh" }, windows: [{ id: "week", label: "Weekly", kind: "weekly", percentUsed: 40 }] };
const claude = { provider: "claude", state: { status: "fresh" }, windows: [{ id: "week", label: "Weekly", kind: "weekly", percentUsed: 20 }] };

// Run collect.mjs as Herdr would, with its group records in a private folder.
function supervise(dir, collector, { deadline = Date.now() + 30000, env = {} } = {}) {
  const child = spawn(process.execPath, [entry, collector, String(deadline)], { stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, HERDR_AGENT_QUOTA_STATE_DIR: join(dir, "state"), ...env } });
  let stdout = "";
  child.stdout.on("data", c => { stdout += c; });
  const done = new Promise(resolve => child.on("exit", (code, signal) => resolve({ code, signal, stdout })));
  return { child, done };
}
async function hungCollector(dir) {
  const pidFile = join(dir, "pid"), file = join(dir, "hung.mjs");
  await writeFile(file, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);`);
  return { file, pid: () => until(async () => Number(await readFile(pidFile, "utf8")) || null) };
}

// ── F1: Herdr's 30 s cap stops the supervisor; the collector must not outlive it ──

test("F1: the supervisor's worst case finishes well inside Herdr's 30 s exec cap", () => {
  assert.equal(typeof supervisor.SUPERVISOR_MS, "number");
  // Budget + kill grace + Node startup/import margin must stay under the cap.
  assert.ok(supervisor.SUPERVISOR_MS + supervisor.GRACE_MS + 2000 <= 30000, `${supervisor.SUPERVISOR_MS} ms budget`);
});

test("F1: the budget is measured from the supervisor's own start, not the claim", posix, async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-f1-budget-"));
  try {
    const hung = await hungCollector(dir);
    const start = Date.now();
    // A far-off claim deadline must not extend the supervisor beyond its own budget.
    const run = supervise(dir, hung.file, { deadline: Date.now() + 120000, env: { HERDR_AGENT_QUOTA_SUPERVISOR_MS: "1200" } });
    const pid = await hung.pid();
    const result = await run.done;
    assert.equal(result.code, 124);
    assert.ok(Date.now() - start < 1200 + supervisor.GRACE_MS + 1500, `${Date.now() - start} ms`);
    assert.ok(await gone(pid), "hung collector survived the budget");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("F1: stopping the supervisor with SIGTERM, SIGHUP or SIGINT kills the collector's group", posix, async () => {
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) {
    const dir = await mkdtemp(join(tmpdir(), "quota-f1-signal-"));
    try {
      const hung = await hungCollector(dir);
      const run = supervise(dir, hung.file);
      const pid = await hung.pid();
      run.child.kill(signal);
      await run.done;
      assert.ok(await gone(pid), `collector survived ${signal} to its supervisor`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test("F1: a group orphaned by SIGKILL is reaped by the next read", posix, async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-f1-kill-"));
  try {
    const hung = await hungCollector(dir);
    const run = supervise(dir, hung.file);
    const pid = await hung.pid();
    run.child.kill("SIGKILL"); // what Herdr's cap can do; it cannot be trapped
    await run.done;
    await sleep(100);
    assert.ok(alive(pid), "precondition: SIGKILL leaves the detached collector running");
    const quick = join(dir, "quick.mjs");
    await writeFile(quick, `console.log(${JSON.stringify(report([codex]))});`);
    const next = await supervise(dir, quick).done;
    assert.equal(next.code, 0);
    assert.ok(await gone(pid), "the next read did not reap the orphaned group");
    assert.deepEqual(await readdir(join(dir, "state", "groups")).catch(() => []), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("F1: a read stopped by Herdr says so instead of asking for setup", async () => {
  const runtime = { node: "/node", runner: "/runner", collector: "/collector" };
  const stopped = collectAxi(async () => { throw new Error("/node took longer than 30 s and was stopped"); }, runtime);
  await assert.rejects(stopped, e => /stopped/i.test(e.message) && !/setup/i.test(e.message));
  for (const code of [137, 143, -1]) {
    await assert.rejects(collectAxi(async () => ({ code, stdout: "" }), runtime), e => !/setup/i.test(e.message), `code ${code}`);
  }
  await assert.rejects(collectAxi(async () => { throw new Error("No such file or directory"); }, runtime), /could not start/);
});

test("F1: the claim outlives the longest possible read, which ends by Herdr's cap", async () => {
  const runs = [], now = Date.now();
  const host = await createHost({ data: parseReport(report([codex])), runner: async (_c, args) => { runs.push(args); return { code: 0, stdout: report([codex]) }; } });
  host.view.runtime = { node: "/node", runner: "/runner", collector: "/collector" };
  host.view.tick(host.cx, { force: true });
  const claim = host.state[`${PREFIX}.control`];
  await host.tasks.at(-1)(host.cx);
  const deadline = Number(runs[0][2]);
  assert.ok(deadline - now <= 30000 + 50, `deadline ${deadline - now} ms after the claim`);
  assert.ok(claim.busyUntil - deadline >= 2000, "claim expires before the read can have ended");
});

// ── F2: a successful read must not become a timeout because a helper holds stdout ──

test("F2: a successful collector whose helper keeps stdout open still returns its data", posix, async () => {
  const dir = await mkdtemp(join(tmpdir(), "quota-f2-"));
  try {
    const pidFile = join(dir, "pid"), file = join(dir, "helper.mjs");
    const helper = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)`;
    await writeFile(file, `import {spawn} from "node:child_process"; console.log(${JSON.stringify(report([codex]))});
spawn(process.execPath, ["-e", ${JSON.stringify(helper)}], { stdio: ["ignore", 1, "ignore"] }).unref();`);
    const start = Date.now();
    const result = await supervise(dir, file).done;
    assert.equal(result.code, 0, "a finished read was reported as a timeout");
    assert.equal(parseReport(result.stdout).providers[0].windows[0].percentUsed, 40);
    assert.ok(Date.now() - start < 2000, `${Date.now() - start} ms`);
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(await gone(pid), "the helper survived");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("F2: a finished child resolves without waiting out the kill grace", posix, async () => {
  const start = performance.now();
  const result = await supervisor.runBounded(process.execPath, ["-e", "console.log('{}')"], { grace: 2000 });
  assert.deepEqual(result, { code: 0, stdout: "{}\n" });
  assert.ok(performance.now() - start < 1500, `${Math.round(performance.now() - start)} ms`);
});

// ── F3: fallback limit ids must round-trip through the supervisor's projection ──

test("F3: long unnamed limits keep stable identities across the second parse", () => {
  const L = "Premium requests for model family ".padEnd(118, "x");
  const raw = { schemaVersion: 5, generatedAt: new Date().toISOString(), providers: [{ provider: "copilot", state: { status: "fresh" },
    untrustedWindowIds: [JSON.stringify(["monthly", L + "B"])],
    windows: [{ kind: "monthly", label: L + "A", percentUsed: 1 }, { kind: "monthly", label: L + "B", percentUsed: 2 }] }] };
  const first = parseReport(JSON.stringify(raw));
  const p = first.providers[0];
  const projected = { ...raw, providers: [{ ...raw.providers[0], untrustedWindowIds: p.windows.filter(w => !w.trusted).map(w => w.id),
    windows: p.windows.map(w => ({ id: w.id, label: w.label, kind: w.kind, percentUsed: w.percentUsed })) }] };
  const second = parseReport(JSON.stringify(projected));
  assert.deepEqual(second.providers[0].windows.map(w => w.key), p.windows.map(w => w.key));
  assert.deepEqual(second.providers[0].windows.map(w => w.trusted), [true, false]);
});

// ── F4: refresh and error feedback ──

test("F4: the spinner shows a read another copy is running", async () => {
  const now = Date.now();
  const host = await createHost({ data: parseReport(report([codex])) });
  host.state[`${PREFIX}.control`] = { attempt: now, busyUntil: now + 30000, token: "another-copy" };
  assert.match(flatten(host.tree()), /Refreshing/);
});

test("F4: a Refresh inside the cooldown is queued and says so", async () => {
  const runs = [], clock = { now: Date.now() };
  const host = await createHost({ data: parseReport(report([codex])), clock, runner: async (_c, args) => { runs.push(args); return { code: 0, stdout: report([codex]) }; } });
  host.view.runtime = { node: "/node", runner: "/runner", collector: "/collector" };
  host.state[`${PREFIX}.control`] = { attempt: clock.now - 3000, sweptAt: clock.now };
  let refresh; walk(host.tree(), n => { if (n.styles.id?.[0] === "refresh") refresh = n; });
  refresh.events.click({}, host.cx);
  assert.match(flatten(host.tree()), /Queued/);
  const queued = host.timers.filter(t => t.once).at(-1);
  assert.ok(queued, "no follow-up scheduled");
  assert.ok(queued.ms <= 7000 + 100 && queued.ms >= 6000, `${queued.ms} ms`);
  clock.now += queued.ms;
  queued.fn(host.cx);
  assert.ok(host.commands.some(c => c[0] === "agent-quota.refresh"), "queued refresh not sent to the strip");
  assert.equal(runs.length, 0);
  assert.doesNotMatch(flatten(host.tree()), /Queued/);
});

test("F4: a failure marks only the providers its read covered as stale", () => {
  const known = ["claude", "codex"], message = "x";
  assert.deepEqual(failureAfter(null, { message, ids: ["codex"], known }), { message, providers: ["codex"] });
  assert.equal(failureAfter({ message, providers: ["codex"] }, { message: null, ids: ["codex"], known }), null);
  assert.deepEqual(failureAfter(null, { message, ids: null, known }), { message, providers: null });
  // A targeted success after a failed sweep clears only what it read.
  assert.deepEqual(failureAfter({ message, providers: null }, { message: null, ids: ["codex"], known }), { message, providers: ["claude"] });
  assert.equal(failureAfter({ message, providers: null }, { message: null, ids: null, known }), null);
  // Failures accumulate until each provider is read again.
  assert.deepEqual(failureAfter({ message, providers: ["claude"] }, { message: "y", ids: ["codex"], known }), { message: "y", providers: ["claude", "codex"] });
  // Shared state written by an earlier build was a bare message: it still means every provider.
  assert.deepEqual(failureAfter("old", { message: null, ids: ["codex"], known }), { message: "old", providers: ["claude"] });
});

test("F4: the dashboard and strip mark only failed providers stale", async () => {
  const data = parseReport(report([codex, claude]));
  for (const mode of ["dashboard", "strip"]) {
    const host = await createHost({ mode, data });
    host.state[`${PREFIX}.error`] = { message: "Quota read was stopped before it finished.", providers: ["codex"] };
    const out = flatten(host.tree());
    assert.match(out, /~40%/, `${mode}: codex should be stale`);
    assert.match(out, /(^|[^~])20%/, `${mode}: claude should stay fresh`);
    assert.doesNotMatch(out, /~20%/, mode);
  }
});

// ── H1: setup swaps a build in one step and writes generated files hidden ──

test("H1: setup stages the build and swaps only changed files in one step", async () => {
  const { swapBuild } = await import("../scripts/swap.mjs");
  const dir = await mkdtemp(join(tmpdir(), "quota-swap-"));
  try {
    const source = join(dir, "src"), target = join(dir, "mod"), staging = join(dir, ".staging");
    const { mkdir: md, writeFile: wf, readFile: rf, readdir: rd } = await import("node:fs/promises");
    await md(source); await md(target);
    for (const [name, text] of [["main.js", "new"], ["core.js", "same"], ["mod.json", "{}"], ["gpui-kit.d.ts", "x"], ["jsconfig.json", "x"]]) await wf(join(source, name), text);
    for (const [name, text] of [["main.js", "old"], ["core.js", "same"], ["runtime.json", "{}"], [".runtime.json", "{}"]]) await wf(join(target, name), text);
    const changed = await swapBuild(source, target, staging, ["runtime.json", "installation.json"]);
    assert.equal(changed, 3); // main.js and mod.json moved in, legacy runtime.json removed
    assert.equal(await rf(join(target, "main.js"), "utf8"), "new");
    assert.deepEqual((await rd(target)).sort(), [".runtime.json", "core.js", "main.js", "mod.json"]);
    assert.deepEqual((await rd(dir)).sort(), ["mod", "src"]); // staging cleaned up
    assert.equal(await swapBuild(source, target, staging, ["runtime.json"]), 0); // idempotent: no writes
    // Provider modules live in a subfolder and move in with the same swap.
    await md(join(source, "providers")); await wf(join(source, "providers", "claude.js"), "x");
    assert.equal(await swapBuild(source, target, staging, []), 1);
    assert.equal(await rf(join(target, "providers", "claude.js"), "utf8"), "x");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("H1: the mod reads its runtime from a hidden file that never triggers a reload", async () => {
  const source = await readFile(new URL("../mods/agent-quota/main.js", import.meta.url), "utf8");
  assert.match(source, /mods\/agent-quota\/\.runtime\.json/);
  const install = await readFile(new URL("../scripts/install.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(install, /\bcp\(/, "setup must not copy files one by one into the live folder");
});

// ── Found natively: Herdr's child() rejects null/undefined ──

test("native: every surface renders without passing null to child()", async () => {
  // Herdr showed "child(value) expects an element…" on the dashboard: a single-page pager was null.
  const data = parseReport(report([codex, claude]));
  for (const page of ["overview", "configure"]) {
    const host = await createHost({ data }); host.view.page = page;
    assert.doesNotThrow(() => host.tree(), page);
  }
  // A pane without a program name or title must not hand label() undefined.
  const header = await createHost({ mode: "header", data, runtime: { pane: "p" }, paneList: [{ pane: "p", terminal: "t1", program: { key: "codex", agent: true } }] });
  assert.match(flatten(header.tree()), /Terminal/);
});

test("native: an orphaned claim (copy stopped mid-read) is cleared once it expires", async () => {
  // Seen natively: a copy reloaded by setup claimed a read, then the app quit; the next window
  // inherited the claim and showed "Refreshing" past its expiry.
  const clock = { now: Date.now() };
  const strip = await createHost({ mode: "strip", clock, data: parseReport(report([codex])) });
  strip.state[`${PREFIX}.control`] = { attempt: clock.now - 10000, busyUntil: clock.now + 25000, token: "gone-copy" };
  strip.timers[0].fn(strip.cx);
  assert.equal(strip.state[`${PREFIX}.control`].token, "gone-copy", "a live claim is left alone");
  clock.now += 26000;
  const writes = strip.writes.length;
  strip.timers[0].fn(strip.cx);
  const control = strip.state[`${PREFIX}.control`];
  assert.ok(!control.busyUntil && !control.token, "expired claim not cleared");
  assert.equal(control.attempt, clock.now - 36000, "the attempt time still paces the next read");
  assert.equal(strip.writes.length, writes + 1);
  strip.timers[0].fn(strip.cx);
  assert.equal(strip.writes.length, writes + 1, "cleared once, not rewritten every check");
});

test("native: a read started from a task continuation is owned by its own copy", async () => {
  // Seen natively: the dashboard's look read (spawned after `await readTextFile` in init) launched
  // the supervisor but never published; TaskOptions.owner defaults to whichever view is running.
  const host = await createHost({ mode: "strip", data: parseReport(report([codex])), runtimeFile: { node: "/n", runner: "/r", collector: "/c" } });
  host.state[`${PREFIX}.control`] = { attempt: Date.now() - 700000, sweptAt: Date.now() };
  await host.tasks[0](host.cx); // init: read the runtime, then the startup read
  assert.equal(host.tasks.length, 3, "startup read not started");
  assert.equal(host.spawns[2]?.owner, host.view, "read task must be owned by this copy");
});

test("native: a dashboard reads itself only when no strip claimed the read it asked for", async () => {
  const runs = [], clock = { now: Date.now() };
  const runner = async (_c, args) => { runs.push(args); return { code: 0, stdout: report([codex]) }; };
  const make = () => createHost({ clock, data: parseReport(report([codex])), runner, runtimeFile: { node: "/n", runner: "/r", collector: "/c" } });
  // A strip claimed it: the fallback does nothing.
  const served = await make();
  await served.tasks[0](served.cx);
  served.state[`${PREFIX}.control`] = { attempt: clock.now, busyUntil: clock.now + 35000, token: "strip" };
  served.timers.find(t => t.once).fn(served.cx);
  assert.equal(served.tasks.length, 1);
  // No strip: after DELEGATE_MS the dashboard reads data older than a minute itself.
  const alone = await make();
  await alone.tasks[0](alone.cx);
  alone.state[`${PREFIX}.control`] = { attempt: clock.now - 90000, sweptAt: clock.now };
  const fallback = alone.timers.find(t => t.once);
  assert.ok(fallback.ms <= 5000, `${fallback.ms} ms`);
  clock.now += fallback.ms;
  fallback.fn(alone.cx);
  await alone.tasks.at(-1)(alone.cx);
  assert.equal(runs.length, 1);
  assert.equal(alone.state[`${PREFIX}.control`].reason, "look");
});
