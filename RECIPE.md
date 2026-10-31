# Herdr Agent Quota

A quiet quota readout at the right end of Herdr's status bar opens a graphical
view of account limits and agent activity. Each limit has a speedometer-like
gauge and a visible red zone from 70% used. Codex, Claude and Grok lead when
no active agent takes priority. A publication screenshot is pending broader
native validation; no synthetic image is represented as a live capture.

## What you see

Keep Herdr's original status readout at left and put the quota strip beside
it in the same 28px row. Use the current Herdr chrome, popover, foreground,
muted and border tokens. The strip has 12px horizontal padding, 12px provider
gaps, 12px icons and 28×5px quota tracks. Show fewer providers when space is
tight, with an overflow count opening the full view.

The full view is a named 850×660 native floating window. Its header has a
23px title, global activity counts, update age, Refresh and Close. Overview
and Configure sit beneath it. A scrolling body contains one horizontal
section per provider account, a 17px provider name, plan and activity count,
wrapping 176px-wide gauges, then sessions and navigation controls. Each
gauge uses 41 native marks on a 240° arc, a 30px percentage, its actual limit
label, reset countdown and pace. The footer explains account sharing,
remote activity and unavailable absolute token counts.

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
`collector.js` executes quota-axi. A shared 45-second lease prevents duplicate
reads across copies. Normal quota reads are every 120 seconds, discovery
every 300 seconds, and failures back off to 600 seconds. Use native static
geometry; no animation polling.

The installer clones through `layout.clone` to retain click state, changes
only its clone, preserves the existing status mod and refuses unfamiliar
headers or name collisions. Runtime paths are generated separately, never
hardcoded to a particular user's home.

## Watch out

Quota is per account, never per pane. Keep multiple accounts separate and
do not infer a terminal's account. Remote activity is unlinked to local quota.
Unknown percentages stay unknown. A past reset suppresses the old value;
stale values are historical and never count toward redline alerts. Used-share
windows are not independent quota pools. Provider durations and limits vary.

The Dock can have a different PATH. Try a packaged absolute collector, then
PATH, then a fixed login-shell command. Do not insert report text into shell
commands. Do not display subprocess stderr or persist raw reports. Collector
auth setup may need a one-time secure-store grant; do not trigger that from
background polling. No inference requests. CLI execution and quota availability
are different capabilities.

## Done when

- `npm test` passes.
- `herdr-app check mods/agent-quota` passes on a normal desktop session.
- Installed percentages match local quota-axi readings.
- The native dashboard renders correctly in both themes and at increased zoom.
- Window dragging, keyboard focus, Configure and Go to agent work in Herdr.
- Restarting preserves settings; multiple surfaces still share one collector.
- Remote activity is explicitly unlinked and expired data never looks fresh.
- A real `preview.png` from Herdr is available before sharing publicly.
