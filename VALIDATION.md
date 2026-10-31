# Local trial validation

## Observed on 2026-10-30

- The user completed setup from a normal terminal after the focus-lifecycle fix.
- `artifacts/install-status.txt`, written after the installed native check,
  reports layout `agent-quota` and `errors: []`.
- Installed mod source files match the repository copies.
- The live strip and Codex pane header displayed the same five-hour and weekly
  readings. During inspection these updated from 33% / 7% to 35% / 8%.
- The graphical dashboard opened with corresponding gauges, reset countdowns,
  agent activity and a redline summary.
- Configure opened with provider, limit-kind, individual-window and threshold
  controls. No saved preferences were changed during inspection.
- Overview and Close worked, and the workspace was restored afterward.
- The dependency lockfile records quota-axi 0.1.69.

The live CLI socket remains inaccessible to the restricted agent session.
The status snapshot was produced by the user's installer; live UI inspection
used the desktop computer-use tool. This is a dark-theme spot check, not a
full native release verification.

## Redesign session, 2026-10-30

Evidence from `herdr-app shot` captures of the live app (Herdr 0.1.10, dark
theme), with the build installed into the existing local trial:

- The `interrupted` banner reproduced on 3 of 3 dashboard openings with no
  collection due. Removing the `cx.notify()` from `on_size_change` cleared it
  on 2 of 2; the shipped fix (repaint from a spawned task, width-thresholded)
  was clean on 3 of 3, including one opening during a live collection.
- Painted meter rows, segmented gauges, the Blocks strip, Settings (preview,
  switches, segmented controls, limit chips) and Copilot's three distinct
  monthly limit names were inspected natively. Gauges, Blocks and the providers
  section were captured with a temporary build forcing those options; the
  installed copy was restored to the repository source afterward.
- Claude now reports `fresh` quota; the earlier `auth_required` state is gone.
- `herdr-app check` passes for the repository and installed copies, and
  `herdr-app status` reports no errors. `npm test`: 43 passing.
- Not done: TypeScript checking against the Herdr declarations (no compiler
  installed), clicking controls natively (no pointer automation was used),
  light theme, zoom, narrow widths and restart persistence.

## Performance pass, 2026-10-30

A temporary instrumented build timed every render on the live app while many
agents ran. Over ~1 minute with Settings open: Settings 1.7 ms (0.4 ms data),
strip 1.0 ms, each of 7 pane headers 0.4 ms; each copy rendered 0–1 times idle.
A fresh `quota-axi` read of all providers took 0.64 s wall time.
The 5 s timers fired about every 7.5 s, indicating general script-thread load.

After repeated hot reloads during testing, the Herdr window hung at 100% CPU.
A `sample` of the main thread showed it inside `JS_ExecutePendingJob` resuming
one async function in a hot loop, matching the strip's `cx`-free command loop.
That loop is fixed. Reverting the installed file did not unhang it; the window
recovered by itself within minutes without a restart, and why it stopped is
unconfirmed. Afterwards the main thread sampled idle and the fixed build was
running. Terminals in herdr-core stayed live throughout.

## Collection and runtime pass, 2026-10-30

- A targeted read (`--provider codex,claude,copilot`) took 0.07 s against 0.6 s
  for all 19 providers, returning fresh readings for each.
- Installing this build into a window that had hot-reloaded the mod ~20 times
  pinned Herdr's main thread at ~100%. Bisection: an empty stub mod returned it
  to ~12%; stubbing every render (keeping `init`) or removing the command loop
  did not. `sample` showed all main-thread time in one render, inside an
  `Array.find` callback, in `rquickjs_jit::maintenance` building feedback
  snapshots. The previous round's hang showed the same `record_hot →
  maintenance_if_due` path. These samples suggest a runtime interaction after
  reload churn; they do not establish Herdr as the sole cause or rule out mod
  defects. The performance review found additional mod scaling/lifecycle issues.
- After a graceful window restart (all 7 terminals stayed live), the same build
  measured 7–8% CPU with no JIT maintenance frames; the startup read was a
  targeted `working` read with no error.
- Protocol from now on: unit and host tests first; one ordered install
  (`core`, `collector`, then `main`); `herdr-app check`; then measure only on a
  freshly restarted window, without further reloads.

## Open issues

- Remote account quota and absolute token-count telemetry are not implemented.

## Render budget and time legend, 2026-10-30

- The user saw `interrupted` on opening the dashboard. The trace ended in
  Herdr's `add_polygon` shim, which issues one host call per point. Meters
  now use one dashed stroke per run of cells.
- Native `herdr-app shot`: the dashed meters, the 35% redline zone, the white
  tick and the header legend render correctly in the strip and the meter-row
  dashboard (dark theme). Five dashboard opens, four with a forced refresh,
  showed no banner and `herdr-app status` reported no errors. CPU spiked once
  during the forced refreshes and settled at 5–14% within seconds.
- Not inspected natively: the gauge layout's dashed arcs and tooltip hover
  (no pointer automation). `npm test`: 64 passing.

## Remaining native checks

The subsequent review and follow-up fixes are documented in
`PERFORMANCE_REVIEW.md`. That build has not been installed or approved natively.
Its regression suite passes on Node 24.11.1 and its source type-checks against
the installed declarations. `herdr-app check` is blocked in this session by
macOS UI/XPC access and reaches the check script's timeout; desktop access also
failed to start. Earlier native observations above do not validate the follow-up.

- Compare measurements directly against provider data and test authentication
  recovery without exposing credentials.
- Exercise a scheduled refresh with the dashboard open, recording any repeated
  `interrupted` banner and its trigger.
- Verify settings persistence across a restart and keyboard-only navigation.
- Inspect light theme, increased zoom, narrow widths, remote activity and
  stale/reset/partial-provider failures.
- Capture an approved publication image without unrelated workspace content.
