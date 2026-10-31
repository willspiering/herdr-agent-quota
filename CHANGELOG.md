# Changelog

## Unreleased

- Performance review follow-up: supervise collection with a 30-second deadline,
  1 MiB output cap and macOS/Linux process-group cleanup; coordinate copies via
  a shared claim and discard retired/late results. Run setup again for the new
  supervisor path; unbounded executable/login-shell fallbacks were removed.
- Bound native descriptions with pages of four providers, eight limits and
  eight sessions. Classify activity once per provider using a space map.
  Headers cache only their own provider's lanes between collections.
- Observe short agent turns through reactive data. Check command-task lifecycle
  without an unnecessary redraw, and keep discovery off the collection path.
- Add synthetic before/after benchmarks and process/lifecycle/scaling regression
  tests. Follow-up native performance verification remains pending; see
  `PERFORMANCE_REVIEW.md`.

- Fix: opening the dashboard could show "could not be re-rendered ·
  interrupted". Each painted cell was its own polygon (about five host calls),
  so a full dashboard made thousands of calls in one render. A run of
  same-colored cells is now one dashed stroke (three path commands), and the
  command count no longer grows with meter width. A test caps path commands
  for an 18-limit dashboard; it does not count every native builder call.
- The time tick is explained. The dashboard header has a legend (`■ used`,
  `■ redline 70%+`, `│ time elapsed`), and each meter, gauge and strip limit has
  a tooltip with used/left, how much of the window has passed, the pace in
  words and the reset time.
- The redline zone is easier to see: unlit cells there are 35% red instead of 20%.

- Event-driven collection: read after an agent finishes a turn (at most once a
  minute), on a limit reset, on opening a stale dashboard and on Refresh, with
  3-minute (working) and 10-minute (idle) backstops. An idle day falls from 720
  full reads to at most 145 targeted ones.
- Routine reads cover only providers with limits or local agents (`--provider`,
  0.07 s versus 0.6 s); every provider is swept hourly, on Refresh and after a
  failure. Targeted results merge into the last sweep.
- Pane headers schedule nothing. The strip's 10 s check is in memory; the
  Refresh counter writes are gone. A shared claim is now written only when an
  actual read starts, for coordination across copies. Stale threshold is 15 minutes.
- Tests: a simulated idle day and busy hour drive the real scheduler; a source
  check requires `cx` in every endless loop and forbids timers under 10 s.

- Fix: the strip's command loop never used `cx`, so a hot-reloaded build's loop
  outlived its copy. One spun Herdr's main thread at 100% (sampled: a promise
  job resuming endlessly). It now calls `cx.notify()` each turn, so Herdr ends
  a retired loop, and it stops on a non-string command. The performance review
  replaces that redraw with `cx.phase()` for the same lifecycle check.
- Fix: switch knobs had no element ID, so their slide animation could transfer
  between switches when rows above them changed. Each page also keeps its own
  scroll position.
- Pane headers (one copy per pane) no longer read live agents or spaces; the
  dashboard reads each once per render.
- Terminal-styled redesign: monospace type, `──` section rules, and health
  colors from the theme's ANSI green/yellow/red (Classic palette optional).
- Meters and gauges are painted natively, one path per color, replacing 41+
  elements per gauge. Dashboard layout: dense meter rows (default) or solid
  segmented 240° gauges.
- Status strip styles: Meter, Blocks or Numbers; show usage as Used or Left.
- Settings rebuilt with a live strip preview, switches, segmented choices and
  per-limit chips. An individual limit choice now overrides its kind default.
- Overview hides providers with nothing to read unless opted in; sign-in-needed
  providers stay. Session rows are whole click targets; Escape closes the window.
- `agent-quota.settings` opens the window on Settings (bindable in keys.json).
- Fix: re-renders requested from `on_size_change` ran inside layout and were
  interrupted ("This view could not be re-rendered · interrupted"). Repaints
  now come from a task, only when the width changes the layout.
- Fix: limits sharing a kind (Copilot's chat/completions/premium) no longer
  all read "Month".
- Unchanged shared values are not rewritten; each write re-renders every mod
  in the window. Pane headers poll every 60 s instead of 15 s.
- Only this mod's own error messages are stored or shown; other exceptions are
  replaced with a generic message. Setup installs with `npm ci`.

## Earlier unreleased fixes

- Create the status-strip focus handle during initialization. Dashboard and
  pane controls use native buttons with retained focus, so rendering never
  creates view-owned focus handles. Regression tests enforce Herdr's phase rule.

## 0.1.0 — local trial, native validation pending

- Compact quota strip with graphical dashboard and a configurable 70% redline.
- Installed-agent discovery and live status/navigation across Herdr spaces.
- Codex, Claude and Grok preferred by default; running agents promoted first.
- Account-separated quota windows, reset times, pace and explicit data states.
- Persistent provider, kind and individual-window visibility settings.
- Optional quota-aware pane headers.
- Shared collector lease, bounded refresh frequency and failure backoff.
- Clone-based installer, setup plan, synthetic preview and regression suite.

Local setup has completed, including the installer's native checks. Initial
live visual inspection covered the strip, pane header, dashboard and Configure.
A transient dashboard render interruption remains open; closing and reopening
restored the view. Claude quota currently requires authentication. Remote account
collection and token-count telemetry are not implemented. No public repository
or release has been published. See VALIDATION.md for evidence and remaining checks.
