# Herdr Agent Quota

A [Herdr](https://herdr.dev) mod for monitoring agent quotas across your spaces.
A terminal-styled status strip opens a dashboard of segmented usage meters or
gauges, reset countdowns, pace and live agent activity, with a configurable
redline that starts at 70% used. Colors follow your terminal theme.

## Setup

Requires Herdr. Setup is a small Node.js script (22.19 or newer); the mod
itself runs inside Herdr and needs no Node, no npm packages and no background
process.

```sh
git clone https://github.com/willspiering/herdr-agent-quota.git
cd herdr-agent-quota
npm run setup
```

For quota details in pane headers, use `npm run setup:headers` instead.
Setup installs nothing else: it adds the mod to a cloned Herdr layout.
Click the quota strip (or press `cmd-shift-u`, `ctrl-shift-u` off macOS) to open
the dashboard as a column beside your terminals; the same click closes it.
Setup binds that key only if it is free. Settings, in the same column,
chooses the strip style (Meter, Blocks, Numbers), Used or Left, the dashboard
layout, colors, redline, and which providers and limits show. Changes apply
immediately with a live preview. Quota availability depends on each provider
and your sign-in.

Quota is read directly with Herdr's built-in `fetch`, from the same usage
endpoints each agent's own CLI uses: Claude, Codex, GitHub Copilot, Cursor,
Grok, Kimi, OpenCode Go and Antigravity. The mod reads your existing sign-in
(for example Claude Code's Keychain item, `~/.codex/auth.json` or the gh
login), never refreshes a token, and never makes inference requests. Tokens
are used only for that request and never stored. A few sign-ins need a small
system program: `security` for macOS Keychain items, `sqlite3` for Cursor's
and OpenCode's databases, and `ps`/`lsof` to find a running Antigravity.
Sign-ins are read from their default locations; environment-variable
overrides (such as `CODEX_HOME`) aren't visible to Herdr mods. Each provider's
default sign-in is read; extra Claude profiles are not.

Optional keys in `keys.json`: `"agent-quota.open"`, `"agent-quota.settings"`
and `"agent-quota.refresh"`.

For Claude on macOS, background reads never raise a Keychain prompt. If the
dashboard asks for a Keychain approval, press Refresh once and allow access;
the mod remembers that the grant works (never the secret itself).

## Development

```sh
npm ci --ignore-scripts   # dev tools only: TypeScript, and quota-axi for the parity tests
npm test
npm run typecheck   # strict, minus implicit-any and null checks, against ~/.config/herdr-app declarations
npm run check
npm run benchmark
```

This is an early v1. Remote-account quota collection and absolute token counts
are not implemented. Known issues and validation notes are in
[VALIDATION.md](VALIDATION.md). The performance review and remaining native
checks are in [PERFORMANCE_REVIEW.md](PERFORMANCE_REVIEW.md).

## Credits

Inspired by [Lakris2407/herdr-quota](https://github.com/Lakris2407/herdr-quota).
Provider endpoints, identities and pace follow
[quota-axi](https://github.com/kunchenguid/quota-axi) 0.1.69 (MIT), which the
mod used before reading quota natively; its tests still compare against it.
Licensed under [MIT](LICENSE); see [third-party notices](THIRD_PARTY_NOTICES.md).
