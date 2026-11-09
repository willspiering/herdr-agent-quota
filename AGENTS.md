# Working on Herdr Agent Quota

For any AI agent asked to install, diagnose, repair, update or extend this mod.
Read this first, then the file for your task below.

## Safety first

This mod reads people's sign-ins. While you work on it:

- **Never open, print or copy a credential file or Keychain item** (for example
  `~/.claude/.credentials.json`, `~/.codex/auth.json`, `hosts.yml`,
  `auth.json`). To check whether a sign-in exists, test that the file exists
  (`test -f`), nothing more. Never run `security … -w`.
- Don't print `~/.config/herdr-app/shared.json`. It holds the mod's readings and
  settings; if you must look, read one key (`agent-quota.v1.error`).
- Never send a token anywhere but the vendor's own host, never refresh one, and
  never store or log one. `docs/adding-a-provider.md` has the full rules.
- Don't edit Herdr's shipped files or the person's own layouts. Setup installs
  into a cloned layout (`agent-quota`).

## Map

```
mods/agent-quota/            the mod Herdr runs (QuickJS + native GPUI: no DOM, no Node APIs)
  main.js                    the UI and read schedule: status bar, dashboard, Settings, pane header
  core.js                    pure data: validation, freshness, account and limit identities, options
  collector.js               one read of every provider, side by side, with a deadline
  providers/index.js         the provider list and contract
  providers/platform.js      everything that differs between macOS, Linux and Windows
  providers/common.js        shared helpers: getJson, lane, limit, ReadFailure
  providers/<name>.js        one per service
scripts/install.mjs          npm run setup: copies the mod, clones the layout, binds a key
scripts/layout.mjs           how the layout is changed (strip, dashboard column, headers)
test/                        Node tests with a fake Herdr (test/host.js); no network
docs/adding-a-provider.md    contract, rules, template and test template for a provider
PRODUCT.md, DESIGN.md        what the mod is for, and how it looks (design tokens in DESIGN.md's header)
RECIPE.md                    Herdr's recipe format: the brief to rebuild the mod, with the traps found
VALIDATION.md                native checks done so far, and known issues
docs/history/                past reviews, kept for the record (superseded where they conflict)
```

Herdr's own guide for mods is `~/.config/herdr-app/AGENTS.md`, with type
declarations in `~/.config/herdr-app/herdr.d.ts` and `gpui-kit.d.ts`.

## Common tasks

**Install or update.** `npm run setup` (or `npm run setup:headers` for pane
headers). It's safe to rerun: it updates the mod files and keeps settings. Set
`HERDR_APP_HOME` if Herdr's config folder isn't `~/.config/herdr-app`.

**Diagnose.**
1. `herdr-app status`: mod and layout errors, the current layout.
2. `herdr-app check ~/.config/herdr-app/mods/agent-quota`: does the mod load.
3. `diff -rq mods/agent-quota ~/.config/herdr-app/mods/agent-quota`: is the
   installed copy this checkout (only `.installation.json` should differ).
4. `npm test`: does the code pass on this machine.
5. For a provider that shows nothing, check its row in the README's platform
   table, then whether its sign-in file exists (existence only, see above).
   `herdr-app shot <file>.png` takes a screenshot of the window.

**Connect an agent to a provider.** Find the agent's key with `hc ls` and add
it to that provider's `agents` list in `providers/<name>.js`. See
"Just connecting an agent" in `docs/adding-a-provider.md`.

**Add a provider.** Follow `docs/adding-a-provider.md`.

**Support another system for a provider.** Add the path or program to
`providers/platform.js` or the provider's per-system path table, update its
`platforms`, and update the README table (a test checks they match).

**Change the UI.** Read `PRODUCT.md` and `DESIGN.md` first. The status bar,
dashboard and pane header are native Herdr UI, so the only real evidence is the
running app: install, then look (`herdr-app shot`). A browser approximation is
not evidence.

## Rules for changes

- `core.js` stays pure. Keep account and limit ids stable: they key every saved
  choice. Missing usage is never zero.
- Providers read only through `io` and `platform.js`: no `io.platform` checks
  or program paths in a provider (a test enforces this).
- Use Herdr's reactive agent data. Don't scrape terminals or conversation logs.
- Before calling a change done: `npm test`, `npm run typecheck`,
  `npm run check`, then install and look at it in Herdr. If you can't check
  natively, say so and leave it marked unverified.
- Keep `README.md`, `RECIPE.md`, `DESIGN.md` and `CHANGELOG.md` in step with
  behavior.
