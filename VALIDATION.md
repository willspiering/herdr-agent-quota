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

## Remaining native checks (superseded)

This section described `394cad9`, which was never installed. *Correction:* it
said that build "type-checks against the installed declarations". That held only
with implicit-`any` checks off; see the next section.

## Native verification of the REVIEW-394cad9 fixes, 2026-10-31

Build `90e6cae` on `terminal-redesign`, installed byte-identical (one staged swap)
over `fbb7f2b`. Herdr 0.1.10, Apple M2, Node 24.11.1, layout `agent-quota` with
pane headers. Workload throughout: 7 core terminals, namely Claude Code ×2 (one
working, one done on `splinter`), Codex idle and 4 shells. Measurement: `top -pid`
1 s samples for 60 s after a 5 s warm-up, plus a 10 s main-thread `sample`.

1. `npm test`: 97 passing. `npm run typecheck`: 0 errors (tsc 5.6.3,
   `--strict --noImplicitAny false --strictNullChecks false --skipLibCheck`,
   against `~/.config/herdr-app/gpui-kit.d.ts` with `herdr` mapped to
   `herdr.d.ts`). Full `--strict`: 359 errors. gpui-shell's `jsconfig.json`
   settings: 280. All are implicit-`any`/default-parameter inference.
2. `npm run check`: passed.
3. Installed with `scripts/install.mjs --headers --no-deps` (one swap per build;
   legacy `runtime.json`/`installation.json` replaced by hidden files).
   `herdr-app check` on the installed copy passed, `herdr-app status` showed
   no errors, and the window relaunched gracefully (`app.quit`, reopen) with all
   7 terminals kept.
4. Matched baseline, same workload:

   | Run | CPU mean / median / p90 | Footprint | RSS | Idle wakeups | JS / JIT share of main thread |
   | --- | --- | --- | --- | --- | --- |
   | Brief baseline, `fbb7f2b` | 12–13% | 152 MB | 199 MB | ~1.1/s | 2.6% all JS |
   | `fbb7f2b`, 11 h window, today | 13.0 / 12.9 / 14.3% | 173 MB | 170 MB | 1.4/s | 1.0% / 0.1% |
   | Stock `main` layout (no quota mod) | 12.3 / 12.1 / 14.0% | 176–178 MB | 163 MB | 1.3/s | 1.2% / 0.5% |
   | New build, quota layout | 12.6 / 12.5 / 14.1% | 179 MB | 160 MB | 0.9/s | 0.8% / 0.1% |
   | Final `90e6cae`, fresh window | 12.6 / 12.3 / 13.9% | 176–179 MB | 156 MB | 1.2/s | 0.7% / 0.0% |
   | Final, dashboard open (30 s) | 13.1 / 12.9 / max 15.8% | — | — | — | — |

   The mod (strip plus 7 pane headers) costs about +0.3 percentage points of one
   core over the stock layout, which is within the noise and under the < 1 pp
   target. Footprint is level with the stock layout. With JS under 1% of the
   main thread, H2 (header scans) and H3 (strip render cache) were measured and
   left unchanged: in V8 a header costs 13–17 µs at 7, 50 and 200 panes, and the
   strip 0.05 ms.
5. Surfaces: the strip, pane headers, the gauge dashboard and Settings rendered
   natively (`herdr-app shot`). The meter-row layout was not switched during
   this session, because there is no pointer automation and options can only
   change through clicks. Reads with the dashboard open, measured from shared
   state and `ps`:
   - Opening the dashboard with data older than a minute: the strip claimed
     the `look` read in 0.12 s and published it in 0.86 s.
   - Manual Refresh: claimed in 0.06 s, published and released in 0.80 s.
   - A scheduled `working` read fired 3:00 after the last read and released
     within about 1 s.
   - None left a process or a `.runtime/groups` record behind.
6. Forced failures (fake programs via the hidden `.runtime.json`, restored
   afterwards):
   - A hung collector that ignores SIGTERM: the supervisor killed its group at
     **24.3 s** and showed "ran past its 24-second budget". The group record was
     removed and no process survived.
   - A hung runner in place of the supervisor: Herdr stopped it at **30.2 s**
     with SIGKILL (no trappable signal arrived). Herdr kills only that pid: its
     same-group child survived, reparented to launchd, and was killed by hand.
     Herdr starts `exec` programs in **its own process group**. Its rejection
     produced "Herdr stopped the quota read before it finished". This confirms
     F1's premise.

Defects found only natively, all fixed with regression tests:

- **The dashboard could not render at all** ("child(value) expects an element…").
  `pager()` returned `null` for a single page. `herdr-app check` renders only the
  strip, and the Node host dropped `null` children. `394cad9` had the same
  defect. Fixed in `9334d36`; `test/host.js` now rejects non-element children.
- **An orphaned claim kept "Refreshing" up past its expiry.** A copy stopped
  mid-read (the reload during setup, then a quit) left its claim behind. Fixed in
  `1280ce7`: the strip's 10 s check clears an expired claim with one write.
- **A dashboard-owned read was lost when its copy went away.** Reads now run in
  the long-lived strip (`90e6cae`).

Open issues:

- **Window degradation after churn.** After roughly 6 hot reloads, 3 layout
  round-trips, a probe mod and about 70 dashboard copies in one window, Herdr's
  main thread reached 100% CPU and the window stopped answering commands
  (`sample`: GPUI prepaint, malloc/free, and `rquickjs_jit::ProductionBackend::
  maintenance` dropping feedback snapshots). That matches the earlier
  JIT-maintenance incidents. A graceful relaunch restored it; the final build
  then ran at 12.6%. Reads measured during the degradation published 25–35+ s
  late, which first looked like an overlay-specific delay; on a fresh window
  they publish in under 1 s. The cause is not established between Herdr's
  runtime and the mod.
- **Memory retained per dashboard reopen.** Reopening the keyed dashboard window
  70 times, each open replacing the previous copy, grew footprint 182 → 212 MB
  (malloc, about 2,300 live allocations per reopen) and it was not returned when
  idle. Controls: 20 open/close cycles of the same dashboard code as a dialog
  overlay did not grow footprint, and neither did 30 cycles of Herdr's `help`
  dialog. So the growth follows keyed-window replacement, not the dashboard's
  rendering. A true close and reopen through ✕/Escape could not be driven
  without pointer or keyboard automation (Escape could have reached an agent's
  terminal). Resolved 2026-10-31 by docking the dashboard as a column; see below.
- Not exercised natively in this session: the meter-row dashboard layout,
  Previous/Next with real multi-page data, the light theme, zoom, narrow widths,
  keyboard navigation, persistence of preferences across a restart, the
  dashboard's no-strip fallback read, and Windows.

- Compare measurements directly against provider data and test authentication
  recovery without exposing credentials.
- Exercise a scheduled refresh with the dashboard open, recording any repeated
  `interrupted` banner and its trigger.
- Verify settings persistence across a restart and keyboard-only navigation.
- Inspect light theme, increased zoom, narrow widths, remote activity and
  stale/reset/partial-provider failures.
- Capture an approved publication image without unrelated workspace content.

## Dashboard as a layout column, 2026-10-31

Native, on the running window (Herdr up about 2 h; a graceful relaunch was not
available in this session, so compare deltas, not absolute sizes). Each open/close
bench was 50 cycles, 1.5 s open and 1.5 s closed, footprint from `vmmap -summary`.
A temporary bench mod (`place: none`, removed afterwards) opened and closed the
real dashboard window by id exactly as the strip does, because the CLI cannot close
a window overlay (`overlay.close` closes only dialogs and popups).

| Run | Footprint | RSS | Retained |
|---|---|---|---|
| Window, build `90e6cae` | 180.3 → 194.6 MB (195 after 60 s) | 183 → 198 MB | about 0.29 MB per open, steady |
| Window, new build (control, same process) | 210.9 → 222.9 MB (224 after 60 s) | 219 → 231 MB | about 0.24 MB per open, steady |
| Column, opened from the strip (first run after install) | 205.0 → 210.9 MB | 213 → 219 MB | warm-up, flat from cycle 20 |
| Column, from the strip (second run) | 228.8 → 237.2, 224.5 MB after 60 s | 237 → 246 MB | none after settling |
| Column, `layout.toggle` only (no reads) | 225.7 → 226.2 MB after 60 s | 249 → 249 MB | none |
| Herdr's own Files panel, `layout.toggle` (control) | 224.5 → 225.7 MB after 60 s | 246 → 249 MB | none |
| 10 forced reads, column hidden | 226.2 → 226.1 MB | 249 → 249 MB | none |
| 10 forced reads, column shown | 226.5 → 226.5 MB | 249 → 249 MB | none |

Idle, 60 s each: build `90e6cae` 14.1% mean CPU (a stale dashboard window was open);
new build with the column hidden 13.3%, shown 13.5%; JS 2.3–2.4% of main-thread
samples, JIT maintenance about 1% (higher than the 0.7% measured on a fresh window
earlier: the session had several installs and mod reloads). CPU while cycling: the
window about 18–29% (a new copy built per open, plus reads), the column about 16%.

Found natively: Herdr's `layout()` reports a toggled node's state, but a shown node
has no `hidden` key, not `hidden: false`. The first build read the missing key as
hidden and started a read on close; fixed with a regression test using the native
shape, then confirmed: closing after 70 s open started no read; opening read the
stale quota.

Seen in screenshots: the column renders beside the terminal pane, framed like it,
with gauges, sessions and the ✕ button; hiding it gives the terminal its width back.
Checked by hand afterwards and reported working: `cmd-shift-u`, Escape and ✕ in
the column, resizing it by drag, the meter-row layout, and the light theme and zoom
at column width.

## Herdr 0.1.11, 2026-10-31

Herdr updated to 0.1.11 (herdr-core 0.9.3) after the column measurements above,
which were taken on 0.1.10. Checked on the updated, relaunched app:

- The installed mod still matches the repository, the hidden `agent-quota-panel`
  column is still in the `agent-quota` layout, and `cmd-shift-u` is still bound.
  `herdr-app status` reports no errors.
- Against the 0.1.11 declarations (changed only in one doc comment):
  typecheck 0 errors, `npm test` 114 passing, `npm run check` passes.
- Idle CPU, 25 s with the column hidden: about 13%, the same as on 0.1.10 (13.3%).

0.1.11 fixes "The window no longer freezes or spikes the CPU for seconds at a time
while mods run". That is the likeliest cause of the 100% CPU episode seen after
repeated reloads, though that episode was never attributed. 0.1.11 does not change
how window overlays live: the guide still says opening a keyed window again replaces
it, so each open builds a new mod copy, while the column builds its copy once. The
column stays. The window benchmark was not repeated on 0.1.11.

## Native collection (quota-axi removed), 2026-10-31

Every provider is now read inside Herdr with its built-in `fetch`; no Node
process runs at any time. Measured on this Mac (Herdr 0.1.11, Node 24.11.1 for
tooling only), same agents and terminals, one forced Refresh (a full sweep) in
each 60 s sample (`ps` every second; `footprint` at the end).

| | quota-axi build (`cb75a3c`) | Native build (`5f5d836`) |
| --- | --- | --- |
| Processes per read | Node supervisor + Node quota-axi | none (`security` for Claude's Keychain item) |
| One full read | 0.70 s, **123 MB peak RSS** (`/usr/bin/time -l`) | 0.52 s for all 8 providers, in Herdr |
| Collector processes seen during the sample | 1 s, 44 MB sampled | 0 |
| Herdr RSS, mean over 60 s | 177 MB | 156 MB |
| Herdr footprint, end of sample | 176 MB | 183 MB |
| Herdr CPU, mean / max | 7.1% / 14.1% | 7.8% / 15.4% |
| Runtime install | 4.8 MB node_modules (quota-axi, undici, toon, axi-sdk-js, proxy-from-env) | none |

- Footprint is within noise and follows a session of hot reloads (this session
  installed three builds); RSS fell. Herdr CPU is level within noise: the
  workload includes this session's own terminal, and a 3 s `sample` showed
  JavaScript under 1% of Herdr's main thread. A matched stock-layout A/B was not
  run in this session, so no CPU claim is made beyond "level".
- Live parity (native adapters against `quota-axi --json --full --no-credential-refresh`
  on the same sign-ins): Claude, Codex and Copilot identical (limit ids,
  percentages, plan, account keys); Cursor, Kimi, Grok and OpenCode Go both
  signed out; Antigravity not running (kept quiet natively, `unavailable` in
  quota-axi). Providers with no sign-in here were checked only by the offline
  differential tests against quota-axi's own normalizers.
- Installed with one swap; `herdr-app status` reported no errors; stored state
  showed Claude, Codex and Copilot fresh, the Claude Keychain grant carried over
  (no prompt), and no credential in `shared.json`.
- Not checked natively: Grok, Kimi, Cursor and OpenCode Go with a real sign-in
  (none here); Antigravity running; Linux and Windows; Herdr's handling of
  self-signed loopback TLS (Antigravity falls back to http as quota-axi does).
