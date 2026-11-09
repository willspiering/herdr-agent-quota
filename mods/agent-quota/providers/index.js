// Every provider the mod reads. To add one, see docs/adding-a-provider.md. Each module exports:
//
//   id          quota-axi's provider id: stored readings and saved choices are keyed by it.
//   label       its display name.
//   agents      other Herdr agent keys or names that mean this provider ("claude-code"); an
//               agent whose key equals `id` needs no entry.
//   icon        its icon, a path Herdr resolves ("icons/claude.svg" is Herdr's shipped one).
//   platforms   { macos, linux, windows }: where its sign-in is read on each system, or null
//               where it isn't supported. The README's platform table is checked against these.
//   read(io)    one read: resolves with an account lane (common.js `lane`), or throws
//               ReadFailure. See collector.js for `io`.
import * as claude from "./claude.js";
import * as codex from "./codex.js";
import * as copilot from "./copilot.js";
import * as cursor from "./cursor.js";
import * as opencodeGo from "./opencode-go.js";
import * as kimi from "./kimi.js";
import * as agy from "./agy.js";
import * as grok from "./grok.js";

export const ADAPTERS = [claude, codex, copilot, cursor, opencodeGo, kimi, agy, grok];

// Herdr agent key or name (lowercase) → provider id.
export const ALIASES = Object.fromEntries(ADAPTERS.flatMap(a => a.agents.map(name => [name, a.id])));
// Provider id → icon.
export const ICONS = Object.fromEntries(ADAPTERS.map(a => [a.id, a.icon]));
