// Providers read natively with Herdr's fetch. Each exports `id` (quota-axi's provider id, so
// targeted reads and stored readings line up), `label` (its display name) and `read(io)`.
import * as claude from "./claude.js";
import * as codex from "./codex.js";
import * as copilot from "./copilot.js";
import * as cursor from "./cursor.js";
import * as opencodeGo from "./opencode-go.js";
import * as kimi from "./kimi.js";
import * as agy from "./agy.js";

export const ADAPTERS = [claude, codex, copilot, cursor, opencodeGo, kimi, agy];
