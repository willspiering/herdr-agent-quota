// The mod's shared state: every copy (status bar, dashboard, pane headers) reads and writes the
// same `agent-quota.v1.*` keys, so copies coordinate through these rather than module variables.
//
//   data        the latest readings (core.js normalizeReport/mergeReport)
//   error       which providers failed their last read, and the message
//   control     the read schedule: attempt, claim (busyUntil, token), back-off, grants
//   options     the person's Settings
//   discovered  the agents installed here (Herdr's knownAgents)
//   view        a request to show a provider or page in the docked dashboard
import { shared, setShared, layout } from "herdr";
import { PREFIX } from "./core.js";

const key = suffix => `${PREFIX}.${suffix}`;
/** @returns {any} Application-owned, normalized shared state. */
export const get = suffix => shared(key(suffix));
// setShared re-renders every mod in the window, so an unchanged value is never rewritten.
export const put = (suffix, value) => {
  if (JSON.stringify(get(suffix) ?? null) !== JSON.stringify(value ?? null)) setShared(key(suffix), value);
};

// The dashboard's column in the layout (scripts/layout.mjs). Herdr builds a layout block's copy the
// first time it shows and keeps it while hidden, so opening and closing it allocates nothing. A
// window overlay builds a new copy on every open; it is kept for layouts without the column.
export const PANEL = "agent-quota-panel";
// The panel node in the shown layout, with its clicks applied, or null.
export function panelNode() {
  let found = null;
  const visit = node => {
    if (found || !node || typeof node !== "object") return;
    if (node.id === PANEL && node.content?.mod === "agent-quota") { found = node; return; }
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  try { visit(layout()); } catch { /* no layout: the window dashboard */ }
  return found;
}
