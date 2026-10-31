# Herdr Agent Quota

A [Herdr](https://herdr.dev) mod for monitoring agent quotas across your spaces.
A terminal-styled status strip opens a dashboard of segmented usage meters or
gauges, reset countdowns, pace and live agent activity, with a configurable
redline that starts at 70% used. Colors follow your terminal theme.

## Setup

Requires Herdr and Node.js 22.19 or newer.

```sh
git clone https://github.com/willspiering/herdr-agent-quota.git
cd herdr-agent-quota
npm run setup
```

For quota details in pane headers, use `npm run setup:headers` instead.
Setup installs the collector and adds the mod to a cloned Herdr layout.
Click the quota strip to open the dashboard. Settings, in the same window,
chooses the strip style (Meter, Blocks, Numbers), Used or Left, the dashboard
layout, colors, redline, and which providers and limits show. Changes apply
immediately with a live preview. Quota availability depends on each provider
and your sign-in.

Optional keys in `keys.json`: `"agent-quota.open"`, `"agent-quota.settings"`
and `"agent-quota.refresh"`.

For Claude on macOS, you may need a one-time Keychain grant:

```sh
./node_modules/.bin/quota-axi --provider claude --allow-keychain-prompt --no-credential-refresh
```

## Development

```sh
npm ci --ignore-scripts
npm test
npm run check
```

This is an early v1. Remote-account quota collection and absolute token counts
are not implemented. Known issues and validation notes are in
[VALIDATION.md](VALIDATION.md).

## Credits

Inspired by [Lakris2407/herdr-quota](https://github.com/Lakris2407/herdr-quota).
Quota data comes from [quota-axi](https://github.com/kunchenguid/quota-axi).
Licensed under [MIT](LICENSE); see [third-party notices](THIRD_PARTY_NOTICES.md).
