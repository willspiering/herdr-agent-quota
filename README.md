# Herdr Agent Quota

A [Herdr](https://herdr.dev) mod that shows how much of your coding agents'
quota is left. A small status-bar strip shows each provider's limits; clicking it
opens a dashboard of usage meters or gauges, reset countdowns, pace and the
agents running now, with a configurable redline (70% used by default). Colors
follow your terminal theme.

It reads the sign-ins already on this computer, the ones your agents use, and
asks each provider's own usage service. It never refreshes a token, never
stores one, and never makes an inference request.

## Supported providers and systems

Each provider is read from where its own app or CLI keeps its sign-in:

| Provider | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Claude | Keychain, or ~/.claude/.credentials.json | ~/.claude/.credentials.json | ~/.claude/.credentials.json |
| Codex | ~/.codex/auth.json | ~/.codex/auth.json | ~/.codex/auth.json |
| GitHub Copilot | Editor sign-in (apps.json), GitHub CLI (hosts.yml), Copilot CLI (Keychain) | Editor sign-in (apps.json), GitHub CLI (hosts.yml) | Editor sign-in (apps.json), GitHub CLI (hosts.yml) |
| Cursor | Editor database (sqlite3), Cursor CLI (Keychain) | Editor database (sqlite3), Cursor CLI (~/.config/cursor/auth.json) | Not supported |
| OpenCode Go | OpenCode database (sqlite3) or auth.json | OpenCode database (sqlite3) or auth.json | auth.json only |
| Kimi | Kimi Code CLI (~/.kimi-code) or Pi (~/.pi/agent/auth.json) | Kimi Code CLI (~/.kimi-code) or Pi (~/.pi/agent/auth.json) | Kimi Code CLI (~/.kimi-code) or Pi (~/.pi/agent/auth.json) |
| Antigravity | The running app's local server (ps, lsof) | The running app's local server (ps, lsof) | Not supported |
| Grok | Grok CLI (~/.grok/auth.json) or Pi (~/.pi/agent/auth.json) | Grok CLI (~/.grok/auth.json) or Pi (~/.pi/agent/auth.json) | Grok CLI (~/.grok/auth.json) or Pi (~/.pi/agent/auth.json) |
| Grok Bot | Cursor sign-in: editor database (sqlite3), Cursor CLI (Keychain) | Cursor sign-in: editor database (sqlite3), Cursor CLI (~/.config/cursor/auth.json) | Not supported |

Grok and Grok Bot are separate allowances. Grok is the Grok CLI's grok.com
credits; Grok Bot runs on a Cursor account and has its own weekly allowance,
read with the Cursor sign-in. A Cursor account without Grok Bot shows no Grok
Bot lane.

macOS is tested natively. Linux has been run natively on Omarchy (Claude,
Codex, Cursor and Grok Bot; see VALIDATION.md). Windows follows the same code
paths but hasn't been run natively yet; please open an issue with what you see.

A few sign-ins need a system program: `security` for macOS Keychain items,
`sqlite3` for Cursor's and OpenCode's databases, and `ps`/`lsof` to find a
running Antigravity. Sign-ins are read from their default locations:
environment-variable overrides (such as `CODEX_HOME`) aren't visible to Herdr
mods, and only each provider's default profile is read.

Quota is per account and comes from this computer's sign-ins. Agents running
on other machines connected to Herdr aren't listed and their pane headers have
no quota button; install the mod on that machine to see its quota there.

Using a provider or agent that isn't listed? See
[Adding a provider](docs/adding-a-provider.md). Often it's a one-line change.

## Install

You need Herdr and Node.js 22.19 or newer, for the setup script only. The mod
itself runs inside Herdr, with no npm packages and no background process.

```sh
git clone https://github.com/willspiering/herdr-agent-quota.git
cd herdr-agent-quota
npm run setup
```

Setup copies the mod into Herdr's config folder, clones your current layout as
`agent-quota` with the quota strip and a hidden dashboard column, and switches
to it. Your own layouts aren't changed. Add `-- --plan` to see what it would do
without changing anything.

- **Quota in pane headers:** use `npm run setup:headers` instead. Each agent
  pane's header then shows its quota before Herdr's own buttons.
- **Herdr's config folder:** setup uses `~/.config/herdr-app`. If Herdr keeps it
  elsewhere (possibly on Windows), set `HERDR_APP_HOME` to that folder first.
- **Update:** `git pull` then `npm run setup` again. Your settings are kept.

## Using it

Click the quota strip in the status bar (or press `cmd-shift-u`; `ctrl-shift-u`
off macOS) to open the dashboard beside your terminals; click again to close
it. Setup binds that key only if it's free. Other keys you can bind in
`keys.json`: `"agent-quota.open"`, `"agent-quota.settings"` and
`"agent-quota.refresh"`.

Settings, in the same column, chooses the strip style (Meter, Blocks, Numbers),
Used or Left, the dashboard layout, colors, the redline, and which providers
and limits show, and where. Changes apply immediately with a live preview. A
hidden provider keeps its limit choices for when you show it again.

On macOS, a background read never raises a Keychain prompt. If the dashboard
asks for a Keychain approval, press Refresh once and allow access; the mod
remembers that the grant works, never the secret itself.

## Troubleshooting

Start with `herdr-app status`: it lists any mod or layout errors.

| What you see | What to do |
| --- | --- |
| A provider is missing | It was never signed in on this computer, so the dashboard leaves it out. Turn on Settings → "Providers without quota" to list it anyway, and check the table above for your system. |
| "Sign-in needed" | Its saved sign-in was refused. Sign in again with that agent's own app or CLI on this computer, then press Refresh. |
| "needs one Keychain approval" | Press Refresh in the dashboard and allow the prompt (macOS). |
| "quota could not be read" / "Stale · refresh" | The provider didn't answer. Earlier readings are kept and retries back off; press Refresh later. |
| Cursor or OpenCode Go missing on Linux | Install `sqlite3` (`/usr/bin` or `/usr/local/bin`). |
| No strip at all | Check the layout is `agent-quota` (`herdr-app status`), then `herdr-app check ~/.config/herdr-app/mods/agent-quota`. |
| Setup says a name is taken | Another mod or layout is already called `agent-quota`; rename or remove it, then run setup again. |

Using an AI agent? Ask it to read [AGENTS.md](AGENTS.md) first: it explains
how to diagnose, repair, update and extend the mod safely, without reading
your sign-ins.

### Uninstall

Switch back to your own layout, then remove the mod and its layout:

```sh
herdr-app do layout.switch '{"name":"main"}'
rm -r ~/.config/herdr-app/mods/agent-quota ~/.config/herdr-app/layouts/agent-quota.json
```

Use your previous layout's name instead of `main` (setup prints it). If setup
bound the dashboard key, also remove the `"layout:agent-quota"` section from
`keys.json`.

## Development

```sh
npm ci --ignore-scripts   # dev tools only: TypeScript, and quota-axi for the parity tests
npm test
npm run typecheck   # against the installed Herdr's declarations
npm run check       # Herdr's own mod check
npm run benchmark
```

[AGENTS.md](AGENTS.md) maps the code. [PRODUCT.md](PRODUCT.md) and
[DESIGN.md](DESIGN.md) describe what the mod is for and how it looks;
[VALIDATION.md](VALIDATION.md) records native checks and known issues;
[CHANGELOG.md](CHANGELOG.md) lists changes. This is an early v1: absolute token
counts aren't implemented.

## Credits

Inspired by [Lakris2407/herdr-quota](https://github.com/Lakris2407/herdr-quota).
Provider endpoints, identities and pace follow
[quota-axi](https://github.com/kunchenguid/quota-axi) 0.1.69 (MIT), which the
mod used before reading quota natively; its tests still compare against it.
Licensed under [MIT](LICENSE); see [third-party notices](THIRD_PARTY_NOTICES.md).
