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

## Open issues

- Remote account quota and absolute token-count telemetry are not implemented.

## Remaining native checks

- Compare measurements directly against provider data and test authentication
  recovery without exposing credentials.
- Exercise a scheduled refresh with the dashboard open, recording any repeated
  `interrupted` banner and its trigger.
- Verify settings persistence across a restart and keyboard-only navigation.
- Inspect light theme, increased zoom, narrow widths, remote activity and
  stale/reset/partial-provider failures.
- Capture an approved publication image without unrelated workspace content.
