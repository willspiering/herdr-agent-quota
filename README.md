# Herdr Agent Quota

A [Herdr](https://herdr.dev) mod for monitoring agent quotas across your spaces.
A compact status strip opens a graphical dashboard with usage gauges, reset
countdowns, and a configurable redline that starts at 70% used.

## Setup

Requires Herdr and Node.js 22.19 or newer.

```sh
git clone https://github.com/willspiering/herdr-agent-quota.git
cd herdr-agent-quota
npm run setup
```

For quota details in pane headers, use `npm run setup:headers` instead.
Setup installs the collector and adds the mod to a cloned Herdr layout.
Click the quota strip to open the dashboard and configure visible providers
and limits. Quota availability depends on each provider and your sign-in.

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
