export const MOD = "agent-quota";
export function integrateLayout(original, { headers = false } = {}) {
  const tree = structuredClone(original);
  let found = false;
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
    if (headers && node.content?.tab) {
      node.content.pane ??= {};
      const header = node.content.pane.header;
      if (header && !["pane", MOD].includes(header.content?.mod)) throw new Error("Custom pane header found. Keep it and add quota manually.");
      node.content.pane.header = { ...header, content: { mod: MOD, props: { mode: "header" } }, height: 34, position: header?.position ?? "top", reveal: header?.reveal ?? "always" };
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  if (!found) throw new Error("No standard Herdr status bar found. Add the quota block manually; this layout was not changed.");
  return tree;
}
