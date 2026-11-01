// Providers read natively with Herdr's fetch. Each exports `id` (quota-axi's provider id, so
// targeted reads and stored readings line up), `label` (its display name) and `read(io)`.
import * as claude from "./claude.js";
import * as codex from "./codex.js";

export const ADAPTERS = [claude, codex];
