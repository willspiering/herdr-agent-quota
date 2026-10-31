export const MOD = "agent-quota";
export const PANEL = "agent-quota-panel";
// The dashboard docks as a hidden column beside the terminals. Herdr builds a layout block's copy
// the first time it shows and keeps it, so toggling it allocates nothing, unlike a window overlay,
// which builds a new copy on every open. Hidden until opened: a never-opened panel costs nothing.
const panel = () => ({ id: PANEL, type: "block", content: { mod: MOD, props: { mode: "panel" } },
  size: { px: 460 }, min: 380, max: 900, hidden: true });
export function integrateLayout(original, { headers = false } = {}) {
  const tree = structuredClone(original);
  let found = false, docked = false, row = null;
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (node.id === "status" && node.type === "block" && node.content?.mod === "workspace-status") {
      const stock = { ...node, id: "quota-original-status", size: { weight: 1 }, min: 100 };
      delete stock.hidden;
      Object.assign(node, {
        type: "row", size: { px: 28 }, resizable: false,
        children: [stock, { id: "agent-quota-status", type: "block", size: { weight: 1 }, min: 180, content: { mod: MOD } }],
      });
      delete node.content;
      found = true;
    }
    if (node.content?.mod === MOD) found = true;
    if (node.id === PANEL) docked = true;
    if (!row && node.type === "row" && node.children?.some(c => c?.type === "block" && c.content?.tab)) row = node;
    if (headers && node.content?.tab) {
      node.content.pane ??= {};
      const header = node.content.pane.header;
      if (header && !["pane", MOD].includes(header.content?.mod)) throw new Error("Custom pane header found. Keep it and add quota manually.");
      node.content.pane.header = { ...header, content: { mod: MOD, props: { mode: "header" } }, height: 34, position: header?.position ?? "top", reveal: header?.reveal ?? "always" };
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  // Beside the row that holds the terminals; elsewhere the window dashboard remains.
  if (!docked && row) row.children.push(panel());
  if (!found) throw new Error("No standard Herdr status bar found. Add the quota block manually; this layout was not changed.");
  return tree;
}

// One key toggles the panel, bound only while the quota layout shows (keys.json
// `layout:agent-quota`). Returns the new keys, or null when the key is taken: an existing binding
// is never replaced. `terminal` bindings win while a terminal has focus, so they count as taken.
export function bindToggle(keys, platform = process.platform) {
  const key = platform === "darwin" ? "cmd-shift-u" : "ctrl-shift-u", action = `${MOD}.open`, section = `layout:${MOD}`;
  const next = structuredClone(keys ?? {});
  if (next[section]?.[key] === action) return next;
  if ([next.global, next.terminal, next[section]].some(s => s && key in s)) return null;
  next[section] = { ...next[section], [key]: action };
  return next;
}
