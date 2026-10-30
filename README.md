# Herdr Agent Quota

Account quota gauges and live agent activity across Herdr spaces. A compact
status strip opens a graphical dashboard. Limits redline at **70% used**.

Version **0.1.0 — native validation pending**. The source and installer are
ready for a local trial. This development session could not connect to macOS
UI services or write Herdr's configuration, so the mod has **not been installed
or verified in a running Herdr window**. Do not describe this as a completed
release until the native checks below pass.

## What v1 includes

- A status strip beside Herdr's existing status bar, with one bar per limit.
- A persistent-position dashboard with 240° quota gauges, reset
  countdowns, pace, and a clear 70% red zone. No animation timers.
- Herdr agent discovery, with focused and running agents first. Default
  provider priority: Codex, Claude, Grok.
- Session, weekly, monthly, model, credits and unknown window types; global
  and individual-window visibility, provider visibility, names and threshold
  controls. Display choices survive restarts.
- Agent status and navigation across every space, including remote activity.
- Optional pane headers showing the local provider's current limits.
- Schema 3–5 normalization, separate account lanes, stale-data labeling,
  partial-provider failures, and collection backoff.

## Install for a local trial

Requires Herdr and Node.js **22.19+**. Run from a regular terminal, outside
the restricted Codex session used for development:

```sh
cd ~/DEV/Personal/herdr-agent-quota
npm run setup
```

For the optional quota readout in each agent's pane header:

```sh
npm run setup:headers
```

Or run the installer directly, without npm argument forwarding:

```sh
node ~/DEV/Personal/herdr-agent-quota/scripts/install.mjs --headers
```

Setup installs **quota-axi 0.1.69** locally from npm with package lifecycle
scripts disabled, runs `herdr-app check`, copies `mods/agent-quota` into
Herdr, clones the current layout as **agent-quota**, adds the status strip,
and switches to the clone. It preserves the original layout and existing
status block. A custom pane header is never replaced. Existing unrelated
mod or layout names are refused.

The collector **runs a local program**, **reads local agent authentication
sources**, and **calls first-party provider usage services** using those
sign-ins. This mod does not issue inference requests or store credentials.
It persists allowlisted quota readings and display choices in Herdr's shared
state. Review the [quota-axi documentation](https://github.com/kunchenguid/quota-axi)
for provider-specific behavior.

Preview setup without changing Herdr:

```sh
npm run setup -- --plan
```

The plan writes `artifacts/layout-preview.json`. To install with dependencies
already installed, use `npm run setup -- --no-deps`.

On macOS, Claude or Grok quota may need authentication setup. If the collector
reports that secure-store access is required, grant access interactively:

```sh
./node_modules/.bin/quota-axi --provider claude --allow-keychain-prompt
```

The OS owns that approval. Background collection never adds the prompt flag
or `--allow-claude-inference`. Collection uses `--no-credential-refresh` to
avoid launching optional vendor refresh commands alongside working agents.

## Use

Click or right-click the quota strip to open the dashboard. **Overview** shows
gauges and agent activity; **Configure** changes the display. **Go to agent**
focuses the corresponding terminal, including agents in other spaces.

The dashboard is a native floating window, so work remains accessible. Drag
its empty header area to reposition it. Close dismisses it. Opening the strip
again reuses its named position. Native controls support Tab and Enter/Space.

Quota belongs to the **provider account**, shared by all its sessions. Quotas
are never summed across spaces. Multiple account readings stay separate;
sessions are grouped by provider because Herdr does not report their auth
identity. With several accounts, the pane header asks you to choose an account
instead of guessing which account owns a session.

Remote agents show activity and navigation, with **Remote · quota not linked**.
This release collects quota on the local machine only. A local Codex account
reading does not describe a Codex account on another machine.

Unknown, expired or untrusted windows show a dash, never an invented 0%.
Stale values remain visible as a last reading and do not count toward the
current redline summary. The status strip uses `~` for stale percentages.
When a reset passes, the old percentage is withheld until a new reading.

**Token counts:** this release displays provider quota percentages. It does
not scrape terminal output or scan conversation logs to estimate tokens.
Absolute token consumption and context-window telemetry are not implemented.

## Configuration

The UI saves under `agent-quota.v1.options` in Herdr shared state. Layout
props supply starting choices, and saved choices take precedence:

```json
{
  "content": {
    "mod": "agent-quota",
    "props": {
      "names": true,
      "hidden": ["cursor"],
      "activeFirst": true,
      "favorites": ["codex", "claude", "grok"],
      "redline": 70,
      "kinds": { "session": true, "weekly": true, "monthly": true, "model": false }
    }
  }
}
```

Threshold choices are 60, 70, 80 and 90% used. The yellow caution band starts
15 percentage points below the threshold. A session is labeled by its actual
reported duration; an absent duration is never assumed to be five hours.

Optional key actions, merged manually into unused bindings in `keys.json`:

```text
agent-quota.menu       Open dashboard
agent-quota.refresh    Request a new reading
```

Herdr's action syntax is a dot between the mod name and command. No keys are
installed automatically. Key commands require the status-strip copy to be
present in the shown layout.

## Performance and data handling

- One shared lease coordinates strip, dashboard and header copies.
- Quota reads happen at most every 2 minutes normally, with a 90-second backend
  reuse window, a 10-second manual-refresh cooldown, and backoff to 10 minutes.
- Herdr's execution API limits each subprocess to 30 seconds. Agent discovery
  refreshes at most every 5 minutes. Live statuses use Herdr's reactive data.
- Lease checks run every 15 seconds without requesting redraws. The open
  dashboard refreshes countdown text once a minute. There are no terminal
  reads, log scans, inference calls, or polling animations.
- Provider errors and raw subprocess output are never saved or displayed.
  The parser keeps only allowlisted normalized fields. Quota-axi's own
  credential/cache handling remains the backend's responsibility.
- Herdr's shared state is per app home/window. Separate Herdr windows with
  separate app homes can collect independently; quota-axi provides additional
  cache reuse. Cross-window lease coordination is not guaranteed.

## Development and checks

```sh
npm test
npm run check
npm run setup -- --plan
npm run preview
```

`npm test` uses synthetic provider reports and a lightweight host to check
data normalization, configuration actions, navigation and collection leases.
It does not touch real auth, invoke agents or make provider calls.

`npm run check` runs the real `herdr-app check` with a 30-second bound.
**This check must pass before treating an installed mod as ready.** It must
also be opened in Herdr to verify deferred UI and asynchronous states.

`npm run preview` creates `artifacts/preview.html`, an interactive **synthetic**
browser approximation built from the same UI source. Open the file yourself
to inspect layout, configuration, dark/light and failure states. It is not
proof of native rendering. This session's browser policy blocked opening
local files, so the preview has not been visually verified here.

Before release:

1. Run `npm run setup` and verify the native check passes.
2. Compare each visible percentage with the local quota-axi output.
3. Verify gauges, overflow, scrollbar, keyboard focus and window dragging in
   Herdr at normal and increased zoom, and in light and dark themes.
4. Open Configure, toggle a window, restart Herdr and confirm it stays saved.
5. Test two local spaces and a remote agent; verify account data is not
   attributed to the remote terminal.
6. Disable collection temporarily; verify stale and expired readings are clear.
7. Capture a real `herdr-app shot preview.png` for publication.
8. Commit a dependency lockfile after a successful npm installation.

## Return to your original layout

For an installation cloned from main:

```sh
herdr-app do layout.switch '{"name":"main"}'
```

The installer prints the actual original layout name and records it in
`~/.config/herdr-app/mods/agent-quota/installation.json`. After switching away,
you can remove the installed mod and its **personal** layout to uninstall.
The source repo and dependencies stay in this directory. No shipped files or
keybindings are modified.

## Credits and license

The status-strip interaction, configuration vocabulary, and collector workflow
are inspired by [Lakris2407/herdr-quota](https://github.com/Lakris2407/herdr-quota)
(MIT, copyright 2026 Lakris2407). This is a separate implementation with a
graphical view, activity/discovery model, schema boundary and collection lease.
The reference's notice is preserved in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Quota data comes from [kunchenguid/quota-axi](https://github.com/kunchenguid/quota-axi)
(MIT). Herdr supplies native UI APIs and installed provider icons; no Herdr
icons are redistributed here. Project code is MIT licensed.
