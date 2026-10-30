# Herdr Agent Quota development

Read `PRODUCT.md`, `DESIGN.md` and the installed Herdr
`~/.config/herdr-app/AGENTS.md` before changing this mod.

- `mods/agent-quota/main.js` is native GPUI UI; no DOM, Node APIs, or webview.
- `core.js` is the pure schema/freshness/identity boundary. Keep stable account
  and limit identities; missing usage is never zero.
- `collector.js` runs quota-axi without inference or optional credential refresh.
  Never persist raw reports, subprocess diagnostics, credentials or account PII.
- Use Herdr reactive agent data. Do not scrape terminals or conversation logs.
- Preserve shipped Herdr files; install into a cloned layout.
- Run `npm test`, and type-check against the installed Herdr declarations when
  tooling is available. Run `npm run check` and inspect the live native UI
  before declaring a mod ready. A browser approximation is not native evidence.
- If native checks are blocked, state the blocker and leave release readiness
  pending. The initial implementation was created in a restricted session.
- Keep `README.md`, `RECIPE.md`, and the design record aligned with behavior.
