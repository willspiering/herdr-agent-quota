# Herdr Agent Quota

A quiet, terminal-styled quota readout at the right end of Herdr's status bar
opens a view of account limits and agent activity. Each limit is a segmented
meter (or optional 240° gauge) with a dim red zone from 70% used and a white
tick for how much of its window has passed, named by a legend in the header. Codex, Claude and Grok lead when
no active agent takes priority. A publication screenshot is pending broader
native validation; no synthetic image is represented as a live capture.

## What you see

Keep Herdr's original status readout at left and put the quota strip beside
it in the same 28px row. All surfaces use the terminal font
(`settings().font_family`, else JetBrains Mono) and Herdr's chrome, popover,
foreground, muted and border tokens. The strip has 12px padding, 14px gaps and
12px icons; each limit is a 10px label, then a 34×8 meter of 3px cells, an
8-cell `▕███░░░░░▏` block bar, or nothing, then its percentage. Show fewer
providers when space is tight, with a `+N` overflow count.

The full view is a named 850×660 native window: a 17px title with agent,
space and update counts, `↻ Refresh` (a braille spinner while collecting) and
`✕`; an Overview/Settings segmented control and `redline N%`. Each provider
section is a 16px glyph, 14px name, `[plan]`, a 1px rule and its activity
(`● 2 working`, `▲ 1 needs you`). Meter rows: 72px label, a painted meter of
5×10 cells with 2px gaps, 76px value with `used`/`left`, 130px reset, 100px
pace. Gauges: 30 segments on a 240° arc, 140px, 24px value. Sessions are whole
rows: mark, status, `space / tab`, `on <machine>` for remote, `go to →`.
Settings: `── status bar` (live strip preview, Style, Show, names switch),
`── dashboard` (Meters/Gauges, Terminal/Classic), `── redline` (60–90%),
`── providers` (switches, per-limit chips), `── about this data`.

## How it behaves

Provider quota and agent status are separate. Herdr statuses show Working,
Needs you, Finished and Idle in their existing theme colors. Gauge color is
green below caution, yellow in the 15 points before redline, then red. Dark
colors: #80c9ae, #e1bc75, #f48e83. Light: #226b50, #79530c, #ad302d.

Prefer focused agents, then working agents, then those needing attention,
then other open agents; use the saved favorite order afterward. Configuration
can hide providers, limit kinds or individual limits, toggle names and active
ordering, and change redline to 60, 70, 80 or 90%. Save immediately in shared
state. A click/right-click on the strip opens the window. Go to agent focuses
its precise terminal. Buttons support keyboard focus and activation. The
window can be repositioned without interrupting the shell.

## Built from

One mod, `mods/agent-quota`, with `place: none`. The same View renders strip,
dashboard or optional header using `props().mode`. Use Herdr's `knownAgents`,
`agents`, `spaces` and `panes`; never scrape terminals. `core.js` handles
quota schema 3–5, account lanes, visibility, activity ranking and freshness.
`collector.js` executes quota-axi. Only the strip schedules reads: an in-memory
check every 10 s compares agent statuses and runs `quota-axi` only when
`schedule()` in `core.js` says one is due. Triggers: an agent finishing a turn
(working → anything else), a limit reset passing, the dashboard opening on
data over 60 s old, Refresh, a 3-minute backstop while any agent works and a
10-minute one otherwise. Reads are at least 60 s apart; failures back off from
60 s to 10 minutes. Routine reads pass `--provider` for providers with limits
or local agents (0.07 s versus 0.6 s for all 19); every provider is swept
hourly, on Refresh and after a failure. Pane headers only display. Paint meters
with `window.paint_path`: each run of same-colored cells is one
`PathBuilder.stroke(h)` line (or `arc_to`) with `dash_array([cell, gap])`. Use native motion (`frames`, `transition`); no animation polling.

Collection always runs through `scripts/collect.mjs`, whose supervisor limits
the quota subprocess to 30 seconds and 1 MiB stdout and reaps its process group
on macOS/Linux. Raw audit JSON is reduced outside Herdr. Setup records the
absolute Node, supervisor and quota-axi paths. A 45-second shared claim prevents
competing copies/builds from reading concurrently; retired and late results are
discarded. Discovery runs separately, hourly or on manual refresh (at most once
a minute). Headers cache their provider's lanes until collection revision changes.
Activity is grouped once per provider using a space map, independent of account count.

Ordinary scroll areas eagerly build their offscreen content. Bound the dashboard
and Settings to four provider/account sections per page, eight limit instruments
or chips per account, and eight agent rows per account. Previous/Next controls
keep every item reachable. Keep redline summary text bounded, with an overflow count.

The installer clones through `layout.clone` to retain click state, changes
only its clone, preserves the existing status mod and refuses unfamiliar
headers or name collisions. Runtime paths are generated separately, never
hardcoded to a particular user's home.

## Watch out

Every path command is a separate call into the host. A polygon per cell (five
calls) over a full dashboard ran past Herdr's render budget and showed
`could not be re-rendered · interrupted`; keep calls independent of cell count.

Test with as few hot reloads as possible. After ~20 reloads on Herdr 0.1.10,
samples showed QuickJS JIT maintenance dominating the main thread. This suggests
a runtime interaction; it does not establish a sole cause or rule out mod defects.
Measure on a fresh window and compare against a matched baseline. Every `for (;;)`
in a task must use `cx` each turn; `cx.phase()` checks lifecycle without a redraw.
See `PERFORMANCE_REVIEW.md` for the review, regression tests and native acceptance gates.

`on_size_change` runs during layout; a `cx.notify()` there re-renders inside
layout and Herdr interrupts it (`could not be re-rendered · interrupted`).
Repaint from `cx.spawn`. `setShared` re-renders every mod, so skip unchanged
writes. Short limit names must stay unique per provider (Copilot has three
monthly pools). An explicit per-limit choice overrides its kind default.

Quota is per account, never per pane. Keep multiple accounts separate and
do not infer a terminal's account. Remote activity is unlinked to local quota.
Unknown percentages stay unknown. A past reset suppresses the old value;
stale values are historical and never count toward redline alerts. Used-share
windows are not independent quota pools. Provider durations and limits vary.

The Dock can have a different PATH. Use the setup-generated absolute paths;
if unavailable, show setup instructions. Unbounded PATH/login-shell fallbacks
defeat the supervisor and must not return. Do not display subprocess stderr or persist raw reports. Collector
auth setup may need a one-time secure-store grant; do not trigger that from
background polling. No inference requests. CLI execution and quota availability
are different capabilities.

## Done when

- `npm test` passes.
- `herdr-app check mods/agent-quota` passes on a normal desktop session.
- Installed percentages match local quota-axi readings.
- The native dashboard renders correctly in both themes and at increased zoom.
- Window dragging, keyboard focus, Escape, Settings and Go to agent work in Herdr.
- Restarting preserves settings; multiple surfaces still share one collector.
- Remote activity is explicitly unlinked and expired data never looks fresh.
- A real `preview.png` from Herdr is available before sharing publicly.
