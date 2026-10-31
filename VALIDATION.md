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

## Open issues

- On the first dashboard opening, Herdr showed a re-render failure with the
  detail `interrupted`, retaining the last successful view. Closing and reopening
  produced a working dashboard; Configure and Overview then worked. Cause is
  unconfirmed. Do not describe this as fixed or assume a performance cause.
- The collector reports `auth_required` for Claude, with no quota windows.
  Herdr detects Claude as installed; running sessions do not prove quota access.
  Its authentication/secure-store setup needs a separate check.
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
