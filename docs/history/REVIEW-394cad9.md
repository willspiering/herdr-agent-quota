# Independent review of 394cad9 — fix brief

Reviewed 2026-10-31 on branch `terminal-redesign`, commit `394cad9` (previous
implementation `fbb7f2b`; also `f3ce421`, `5633193`). Read-only review: nothing
was installed, reloaded or committed.

**Verdict: needs fixes; native evidence insufficient.** Rendering and scaling
work is sound. The process-lifecycle fix rests on a false premise (Herdr's
`exec` already has a 30 s cap), and `394cad9` has never run inside Herdr: the
installed `main.js`, `core.js`, `collector.js` are byte-identical to `fbb7f2b`,
and the installed `runtime.json` has no `runner` key.

Treat `PERFORMANCE_REVIEW.md` as superseded where it conflicts with this file.

## How to use this document

1. Fix the confirmed defects in order (F1 → F5). Each has a trigger, evidence,
   and the expected correction.
2. Add the regression tests listed under each finding *before* the fix, and
   watch them fail.
3. Follow the Herdr rules section; it is quoted/derived from
   `~/.config/herdr-app/AGENTS.md` and `herdr.d.ts` (the authority).
4. Do the native verification protocol at the end. Do not declare the mod ready
   without it.

---

## Confirmed defects

### F1 (P1) — Herdr's 30 s exec cap kills the supervisor first; quota-axi is orphaned with no limit

**Where:** `mods/agent-quota/collector.js:7-8,16-19`,
`scripts/collect.mjs:10-12`, `scripts/collector-process.mjs:27-29`,
`mods/agent-quota/main.js:31-34,175`.

**False premise.** `collector.js:7` says "Herdr's exec has no
timeout/cancellation option". But:

- `~/.config/herdr-app/herdr.d.ts:10`: *"Runs a program with the user's real
  environment (HOME, PATH, auth). 30 s limit, 8 MiB output."* The same text is in
  the mod's own `gpui-kit.d.ts:22200`.
- The Herdr binary contains `"took longer than 30 s and was stopped"`.

**Why the supervisor loses the race.** `collect.mjs` arms
`Math.min(30000, remaining)` *after* Node startup and imports, then
`runBounded` waits another 250 ms grace. With the default deadline
(claim + 40 s) the supervisor can never finish before Herdr's 30 s cap. Because
quota-axi is spawned `detached: true` (own session/process group), killing the
supervisor — by SIGTERM, SIGKILL, or a process-group kill of the supervisor's
group — never reaches quota-axi.

**Evidence (fake collectors, Node 24.11.1, no credentials):**

| Scenario | Result |
| --- | --- |
| Supervisor SIGKILLed at 1.5 s, collector ignores SIGTERM | collector still alive |
| Supervisor SIGTERMed at 1.5 s | collector still alive |
| Supervisor unbounded, hung collector | self-terminates at **30,328 ms** (code 124) |
| Same with a Herdr-style 30 s cap | stopped at 30,012 ms; collector left running |

**Impact.** In exactly the hang case the supervisor exists for: each retry
(backoff 1, 2, 4, 8, 10 min) can leave another hung process tree; after the
45 s claim expires a new read can overlap a still-running orphan; the user sees
a misleading "could not start. Run npm run setup" (`collector.js:16`) or
"Collector failed. Run npm run setup" (`collector.js:19`).

**Correction.**

- Budget the supervisor so it *always* finishes before Herdr's cap, measured
  from the supervisor's own start: e.g. child timeout ≤ 20 s, grace 250 ms,
  total well under 30 s. Pass a relative budget rather than relying on a 40 s
  absolute deadline. Keep the "expired claim never launches" behavior.
- Trap SIGTERM, SIGHUP and SIGINT in the supervisor and kill the child's
  process group before exiting.
- SIGKILL can't be trapped: record the child's process-group id in a pidfile
  (under the project or `~/.config/herdr-app/mods/agent-quota/`, hidden or
  non-`.js` so it does not trigger mod reloads — verify) and reap a stale,
  still-alive group at the start of the next read.
- Make `CLAIM_MS` consistent with the real maximum (the Herdr cap), and fix the
  comment at `main.js:32`.
- Distinguish "Herdr stopped the read" (exec rejection or non-supervisor exit
  code) from "could not start / setup needed" in user-facing messages.

**Regression test to add.** Spawn `scripts/collect.mjs` with a fake collector
that writes its pid and ignores SIGTERM; stop the *supervisor* from outside
(SIGTERM, then separately SIGKILL) before its own timer; assert the collector
pid is gone within a bounded time (for SIGKILL: after the next read's reaping
step). Also assert the supervisor's own worst-case runtime is < 30 s.

### F2 (P2) — A successful read becomes a timeout if any helper keeps stdout open

**Where:** `scripts/collector-process.mjs:37` resolves on `close` (all stdio
closed), not `exit`.

**Evidence.** Fake collector prints valid JSON, exits 0, leaves a same-group
helper holding stdout → supervisor returns code **124 after 2,516 ms**, data
discarded. The existing test "supervisor reaps inherited-pipe descendants"
(`test/performance.test.js:182`) asserts 124 for this shape, i.e. it encodes
the bug as intended behavior. In Herdr, combined with F1, the cap kills the
supervisor first and the helper is never reaped.

**Correction.** On `exit` with code 0/1, allow a short drain (≈100–250 ms),
then kill the group, destroy `child.stdout`, and resolve with collected output.
Update the test to expect the data plus a reaped helper.

### F3 (P3) — Long limit labels can make every collection fail permanently

**Where:** `mods/agent-quota/core.js:86` plus the second parse of the
supervisor's projection.

**Cause.** A window without an `id` gets a fallback id
`JSON.stringify([kind, label])`, which can exceed 120 characters. The supervisor
re-serializes it as `id`; the Herdr-side parse truncates `text(w.id)` to 120.

**Repro.** Two monthly windows without ids, labels ≈119 chars sharing a prefix:
first pass ids have length 133; second pass throws *"Collector returned
duplicate limit identities."* — deterministically, on every read. Even without
a collision, fallback ids now differ from `fbb7f2b`, so saved per-limit choices
(`options.windows`, keyed by `w.key`) for such windows reset after upgrade.

```js
import { parseReport } from "./mods/agent-quota/core.js";
const L = "Premium requests for model family ".padEnd(118, "x");
const raw = { schemaVersion: 5, generatedAt: new Date().toISOString(), providers: [{ provider: "copilot", state: { status: "fresh" },
  windows: [{ kind: "monthly", label: L + "A", percentUsed: 1 }, { kind: "monthly", label: L + "B", percentUsed: 2 }] }] };
const first = parseReport(JSON.stringify(raw));
const projected = { ...raw, providers: [{ ...raw.providers[0], windows: first.providers[0].windows.map(w => ({ id: w.id, label: w.label, kind: w.kind, percentUsed: w.percentUsed })) }] };
parseReport(JSON.stringify(projected)); // throws: duplicate limit identities
```

**Correction.** Make ids round-trip exactly: either don't truncate ids that
came from the supervisor, or derive a bounded fallback id (e.g. a stable short
hash of kind + full label) in one place. Add the repro as a test.

### F4 (P3) — Refresh and error-state feedback are misleading

- Spinner shows only this dashboard copy's own `this.pending`
  (`main.js:582`). A Refresh click is silently dropped while another copy holds
  the claim (`main.js:158`) or during the 10 s manual cooldown (`core.js:219`).
  Derive "busy" from shared `control.busyUntil` and say when a refresh was
  deferred.
- Any error marks *every* provider stale (`failed` is global, `main.js:128`,
  `core.js:120`), even after a targeted read covering one provider. Scope
  failure to the providers the failed read covered.

### F5 (P2, documentation) — claims that are inaccurate

Correct these in `PERFORMANCE_REVIEW.md`, `VALIDATION.md`, `RECIPE.md`,
`README.md`, `DESIGN.md` and code comments:

- "Herdr exposes no subprocess timeout" — false (see F1).
- "The supervised process ends within 31 s" — false once Herdr stops it.
- "Terminates the process group, including inherited helpers" — quota-axi's own
  `claude-swap.js:129` helper uses `detached: true` (opt-in via the inherited
  `QUOTA_AXI_CLAUDE_SWAP` env var) and escapes the group kill. Either document
  it or clear that env var for the child.
- "Type checking passes against the installed Herdr declarations" — under the
  shipped `mods/agent-quota/jsconfig.json` (`strict: true`), `tsc 5.6.3`
  reports **274 errors**, almost all implicit-`any` (TS7006 ×228). It passes
  only with `--noImplicitAny false`. No Herdr API is misused. Either add JSDoc
  types until strict passes, or state the exact flags used. Note the repo's
  `mods/agent-quota/gpui-kit.d.ts` differs from
  `~/.config/herdr-app/gpui-kit.d.ts`; state which one was checked.
- The benchmark's large-scenario gains come from drawing 32 of 800 limits
  (pagination); per-visible-item cost is unchanged. Say so.

---

## Hypotheses (unproven — measure before acting)

- **H1 — Reload churn during setup.** `scripts/install.mjs:48-51` copies files
  one at a time into the live mod folder, then writes `runtime.json` and
  `installation.json`. Herdr reloads every copy whenever a file in the mod
  folder is saved (except `jsconfig.json`, `.d.ts`, hidden files,
  `node_modules`), so one setup can mean several reloads and briefly mixed
  builds (new `core.js` + old `main.js` + old `runtime.json`). Earlier JIT hangs
  correlated with reload churn. Prefer staging into a sibling temp folder and
  swapping with one atomic rename, or writing generated files as hidden files.
  Unverified whether Herdr debounces.
- **H2 — Pane headers scale O(panes²).** Each header calls `panes().find` on
  every live-data change (`main.js:111`). Fine at 7 panes; unmeasured at 50.
- **H3 — Strip has no render cache.** It rebuilds `catalog()` and re-reads
  `data` on every live-data change (`main.js:123-124`). Cheap today (7 KB,
  ~0.06 ms in V8) but render frequency under busy terminals is unmeasured.
  Consider the same revision cache the headers use, plus agent/space inputs.

## Verified sound (don't regress)

- Shared claim/token coordination; late results are discarded; an expired
  queued launch never starts a subprocess.
- Every `data` write is paired with a new `control.attempt`, so the header
  cache invalidates correctly.
- `catalog()` is linear in agents and spaces; activity arrays shared across
  account lanes.
- Account/limit identities survive the supervisor projection for normal ids
  (see F3 for the exception).
- No inference: quota-axi's Claude inference path is gated by
  `allowClaudeInference`, which the mod never passes. Keep it that way.
- stderr discarded; persisted shared state holds no email-like account values.
- The strip's 10 s check makes no redraw when nothing is due; animation is
  native (`.frames`, `.transition`); dashboard clock repaints once a minute.
- With the user's real data, Overview shows 2 providers; pagination does not
  affect them today.

---

## Herdr rules and best practices that apply

From `~/.config/herdr-app/AGENTS.md` and `herdr.d.ts`. Re-read them; they win
over this summary.

- **`exec`**: 30 s limit, 8 MiB output, user's real environment. It rejects if
  the program can't start. Design every subprocess budget under 30 s.
- **Rendering**: `render(cx)` reruns after `cx.notify()` and *whenever live data
  changes* (spaces, agents, terminals, focus, theme, shared state). Don't poll
  those; keep render pure and cheap; cache derived data by revision.
- **`setShared`** re-renders every mod in the window. Write only on real change
  (the existing `put()` does this); keep writes per collection minimal.
- **Every redraw of a mod redraws the whole window.** Never animate with
  timers; use `.frames`, `.spin`, `.loop`, `.transition`. Timers are for data,
  only as often as what they show changes.
- **Timers keep running while a copy is hidden**; poll gently.
- **Never keep a `cx`.** Use the one each callback/task receives. A replaced
  build's loop ends at its next `cx` use, so every loop body must touch `cx`.
- **No `setTimeout`/`setInterval`/top-level `await`**; use `cx.timer` and
  `cx.spawn` in `init`.
- **`close(cx)`** gets at most 250 ms shared across copies on quit; unfinished
  tasks are cancelled; an already-started `exec` keeps running. Don't start
  long-lived work in `close`.
- **Size**: `on_size_change` reports size; this mod must not `cx.notify()`
  from it directly (it caused "interrupted"); repaint from a task with a
  threshold, as now.
- **Saving any file in the mod folder reloads every copy** (except
  `jsconfig.json`, `.d.ts`, hidden files, `node_modules`). Avoid iterative live
  copying; install once, atomically.
- **Don't edit `AGENTS.md` or `.d.ts` files**; preserve shipped Herdr mods and
  layouts (install into the cloned `agent-quota` layout).
- **Always run `herdr-app check <mod folder>`**; never call a mod done without
  a passing check.

Project rules (repo `AGENTS.md`): no DOM/Node APIs in `main.js`; `core.js`
stays pure; missing usage is never zero; never persist raw reports, subprocess
diagnostics, credentials or account PII; use Herdr reactive agent data, never
terminal scraping; keep `README.md`, `RECIPE.md` and the design record aligned.

---

## Test and benchmark gaps to close

- `test/host.js` mock does not model Herdr:
  - `exec` has no 30 s cap (add one, configurable, that kills the supervisor
    the way Herdr would).
  - `shared()` returns live references with no copy/serialization, and
    `setShared` never re-renders (copy values; count re-renders).
  - `cx.phase()` never throws unless a test overrides it.
  - "Independent module copies" share one `core` module instance.
- Source-regex lint tests (`test/ui.test.js:214`) are fine as lint, not as
  behavior proof.
- `npm run benchmark -- fbb7f2b` reproduces the published table within noise.
  It runs in V8, not QuickJS, and node counts understate native builder calls.
  Approximate builder calls per render with real data: strip ≈294, pane
  header ≈140, dashboard (meters or gauges) ≈1,121, Settings ≈1,787. Track
  these as regression numbers.

## Native measurements taken (previous build `fbb7f2b` only)

Herdr 0.1.10, Apple M2 (8 cores). Workload: 7 terminals — Claude Code ×2 (one
working, one waiting on input), Codex idle, 4 shells.

- 60 s `top -pid`: 12.0–13.4% of one core, steady; 152 MB footprint, 199 MB
  RSS; ~1.1 idle wakeups/s.
- 10 s `sample` of the main thread: ≈68% idle wait, ≈24% native GPUI draw
  (layout + paint), all JS combined (every mod, including Herdr's) ≈2.6% of
  wall time. A few `rquickjs` JIT-maintenance frames still present.
- Not measured: matched baseline layout, any run of `394cad9`, both dashboard
  layouts, reopen cycles, scheduled/manual reads.

The targets in `PERFORMANCE_REVIEW.md` (< 1 percentage point idle CPU over a
matched baseline, no periodic repaint from the strip check, p95 aggregate mod
description work < 8 ms) are reasonable but unmeasured for `394cad9`. Add:
zero surviving subprocesses after any read, and no renders attributable to the
mod while idle.

## Native verification protocol (required before "ready")

Keep it bounded; no repeated hot reloads; don't alter credentials or stop agent
work.

1. `npm test` on supported Node (24.11.1 in `runtime.json`), and the chosen
   type-check configuration passing.
2. `npm run check` (repository copy).
3. Install **once** (atomic swap, see H1), `herdr-app check` the installed
   copy, `herdr-app status` with no errors, then restart the Herdr window
   gracefully without killing herdr-core terminals.
4. Matched baseline: same agents/terminal activity, original layout vs
   `agent-quota` layout, ≥ 60 s each after warm-up. Record `top -pid` CPU/RSS
   and a 10 s `sample`; attribute JS frames.
5. Exercise strip, both dashboard layouts, Settings and pane headers; open and
   close the dashboard 10 times; observe one scheduled read with the dashboard
   open and one manual Refresh. No `interrupted` banner, no stuck spinner, no
   multiplied collections, no sustained memory growth.
6. Force one hung fake collector (temporary `runtime.json` pointing at a fake,
   restored afterwards) and confirm with `ps` that nothing survives the read.
7. Record results in `VALIDATION.md` with workload and runtime details.

## Repro sketch for F1/F2 (supervisor stopped from outside)

```js
// node repro.mjs <repo>; fake collectors only.
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os"; import { join } from "node:path";
const entry = join(process.argv[2], "scripts/collect.mjs"), dir = mkdtempSync(join(tmpdir(), "quota-repro-"));
const pidFile = join(dir, "pid"), hung = join(dir, "hung.mjs");
writeFileSync(hung, `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);`);
const sup = spawn(process.execPath, [entry, hung, String(Date.now() + 40000)], { stdio: ["ignore", "pipe", "ignore"] });
setTimeout(() => sup.kill("SIGKILL"), 1500);              // Herdr's cap, scaled down
sup.on("exit", () => setTimeout(() => {
  const pid = Number(readFileSync(pidFile, "utf8"));
  let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
  console.log({ collectorAliveAfterSupervisorStopped: alive }); // today: true
  try { process.kill(-pid, "SIGKILL"); } catch {}
}, 1000));
```

For F2, replace the collector with one that prints a valid report, spawns
`spawn(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { stdio: ["ignore", 1, "ignore"] }).unref()`
and exits 0; today the supervisor returns 124.
