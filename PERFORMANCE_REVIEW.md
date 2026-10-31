# Performance review — 2026-10-30

Reviewed `5633193`, `f3ce421` and `fbb7f2b` against the installed Herdr
`AGENTS.md`, `gpui-kit.d.ts` and `herdr.d.ts`. The follow-up changes below
are a follow-up to those commits. **Native release approval remains pending.**

## Findings and changes

| Priority | Finding in the committed version | Follow-up |
| --- | --- | --- |
| P1 | The 45-second module-local guard could expire while `exec` still ran. Herdr exposes no subprocess timeout, and module sharing between copies was assumed rather than tested. Login-shell fallback also ran arbitrary startup profiles. | Every quota read now uses a Node supervisor with a 30-second subprocess deadline, 250 ms termination grace, 1 MiB stdout cap and discarded stderr. On macOS/Linux it terminates the process group, including inherited helpers. A synchronous shared claim coordinates independent copies/builds; late or retired tasks cannot overwrite newer data. Unsupervised fallbacks were removed. |
| P1 | Dashed strokes bounded each instrument's path commands, but every offscreen provider, limit and session was still built eagerly. A valid large report generated thousands of native descriptions. | Page at four account/provider sections, eight limits per account and eight sessions per account. Settings limit chips are paged too. Every item remains reachable. Redline text previews three entries and counts the rest. |
| P1 | `catalog()` classified sessions separately for each account, using a linear space search twice per session, and repeated urgency scans during sorting. Cost grew with accounts × agents × spaces. | Classify sessions once using a space map, share provider activity arrays across account lanes, and precompute urgency/favorite ranks. |
| P2 | Headers claimed to read only their provider, but constructed and sorted the complete catalog on every render. They also called `props()` from inside a pane search. | Headers filter their own provider without catalog construction, cache those lanes until the collection revision/program changes, and read props once before the search. No live agent/space reads, timers, discovery or collection in headers. |
| P2 | Observing agent transitions only every ten seconds missed complete short turns between checks. | Also observe Herdr's reactive agent snapshots during strip renders, updating in-memory state only. Collection keeps its one-minute minimum gap. |
| P2 | The command loop used `cx.notify()` only as a lifecycle check, requesting a redraw for every command, including unknown/end commands. UI `close()` also occupied Herdr's lifecycle cleanup method name. | Use the documented `cx.phase()` to reject retired contexts without requesting a redraw. Rename the UI action to `dismiss()`. |
| P2 | A slow discovery call held the quota collection pending. Failed discovery could be repeated on subsequent reads. | Discovery runs separately after the result is published and is rate-limited on failures as well as successes. |
| P2 | The parser silently truncated reports above 200 account lanes or 100 limits per account. | Reject explicitly and retain previous readings, rather than presenting an incomplete report as complete. |

Raw quota parsing/projection now runs in the supervised Node process. Herdr
receives only allowlisted fields, revalidates them, and retains existing account
and limit identities. No credential refresh, inference request, terminal scraping
or new runtime dependency was added. The supervisor is loaded from the project
path recorded by setup; moving the project requires setup again.

The shared claim also supplies an absolute deadline to the supervisor. Work
delayed in Herdr/core's launch queue cannot restart a fresh thirty-second budget
after its claim expires; expired launches exit before starting quota-axi.

## Existing fixes that are sound

- `fbb7f2b` replaced a polygon per cell with dashed lines/arcs. The path-command
  count is independent of cell count. Tessellation still depends on the number
  of visible segments; this is not a claim of constant GPU work.
- The command loop now touches `cx` after every await and exits on end-of-stream.
  Every other asynchronous publication now checks its own context too.
- Focus handles are created in `init`, native controls have stable IDs, and
  size-triggered repaint is deferred with a width threshold.
- Animation uses native `frames`/`transition`; no animation timers were added.
- Headers schedule no work. The strip's ten-second check makes no shared write
  or redraw when nothing is due. The open dashboard updates its clock once a minute.
- Scheduled reads have a one-minute gap, three-/ten-minute working/idle backstops,
  and exponential failure backoff. Provider filtering and hourly sweeps remain.
- Unchanged shared values are skipped. A shared claim adds one deliberate
  broadcast per actual collection, rather than a heartbeat write on every check.

## Evidence

`npm test`: **78 passing**, including real child-process tests for hangs,
stdout overflow, ignored SIGTERM and inherited-pipe descendants. The descendant
test checks that the recorded child PID actually exits. Lifecycle tests use
independent module evaluations with common shared state, simulated cancellation
and a controllable clock. Tests also cover page navigation, short turns and
linear activity classification.

Type checking passes against the installed Herdr declarations. Tests were run
with Node **24.11.1**, the Node executable recorded in the installed runtime.
The shell defaults to Node 21.3.0, below the project's required 22.19; do not
use that shell default as evidence of supported-runtime compatibility.

Synthetic before/after results, Node 24.11.1, baseline `fbb7f2b`:

| Scenario | Before | After |
| --- | ---: | ---: |
| 40 accounts × 20 limits, Overview nodes | 9,147 | 426 |
| Same scenario, painted paths | 2,400 | 96 |
| Same scenario, path commands | 7,200 | 288 |
| Same scenario, description p95 | 8.947 ms | 0.438 ms |
| Same scenario, Settings nodes | 2,059 | 250 |
| Same scenario, Settings description p95 | 2.410 ms | 0.316 ms |
| 100 accounts / 1,000 agents / 1,000 spaces: space-property reads | 100,100,000 | 1,000 |
| Same activity classification, one sample | 1,264.031 ms | 1.026 ms |

The ordinary three-account/two-limit case keeps the same number of UI nodes.
Reproduce with `npm run benchmark -- fbb7f2b` on supported Node. Local raw
results are in ignored `artifacts/performance-review-node24.json`.

These are Node/V8 host-proxy measurements. They measure description construction
and algorithmic work; they exclude QuickJS, native builder serialization, GPUI
layout, tessellation, GPU rendering and terminal workloads. Path-command counts
exclude path construction/painting and other native builder calls. None of
these numbers establishes a native frame time, CPU percentage or memory budget.

## Native verification still required

This session cannot access the macOS UI services: `herdr-app check` times out
after XPC errors, process inspection (`ps`) is denied, and desktop-tool startup
fails. The follow-up build was not installed into the live configuration. The
earlier native screenshots and CPU observations apply to earlier builds.

From a regular terminal on supported Node, install once:

```sh
node ~/DEV/Personal/herdr-agent-quota/scripts/install.mjs --headers --no-deps
```

This updates `runtime.json` with the supervisor path. Copying just `main.js` is
insufficient. Avoid iterative live copying while diagnosing this incident.

Before calling this release-ready:

1. Pass the repository and installed native checks. Restart the Herdr window
   gracefully after the single install, without killing herdr-core terminals.
2. With the same agents/spaces and terminal activity, compare a warmed-up original
   layout against the quota layout for at least 60 seconds each. Record app CPU,
   RSS and responsiveness; whole-app CPU alone cannot identify the mod's cost.
3. Measure strip, both dashboard layouts, Settings and pane headers. Target
   less than one additional percentage point of an idle CPU core, no periodic
   repaint from the strip check, and p95 aggregate mod description work below
   8 ms. These are acceptance targets, not measured results.
4. Observe a scheduled read with the dashboard open and perform one manual read.
   Closing/reopening the window must not multiply collection or leave a spinner
   running indefinitely. Verify quota/auth failures keep historical data marked
   stale and normal retries remain bounded.
5. Open/close the dashboard ten times without hot reloads. Check for interrupted
   renders, accumulating timers/tasks and sustained memory growth. Use a native
   profiler/sample if a spike persists; stop the trial on a sustained regression.
6. Check page controls with real accounts, gauges, light theme, increased zoom,
   narrow widths, keyboard navigation and preference persistence.

The past samples contain QuickJS JIT-maintenance frames after repeated reloads.
That supports a runtime-interaction hypothesis; it does **not** establish that
Herdr alone caused the hang or rule out mod contributions. The previous
retired-loop bug and unbounded rendering were mod defects. A controlled native
profile is still required to establish the remaining incident cause.

Windows descendant cleanup and supported-minimum Node 22.19 were not exercised.
Discovery is provided by Herdr's `knownAgents`; its internal subprocess/time
limits are outside this mod's supervisor and were not profiled in this session.

## Design tooling notes

The Impeccable context loader misclassifies this GPUI desktop project as web;
the review follows Herdr's installed API instead. The design sidecar predates
the terminal redesign and can be refreshed separately with `document`.
The loader also reports Impeccable v4.7.0 available; no skill update or design
metadata migration was performed during the performance review.
