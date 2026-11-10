// The optional pane header (npm run setup:headers): Herdr's own header (its shipped `pane` mod),
// drawn the same way with the same icons, plus one quiet quota figure before the buttons.
// Nothing else is added or restyled, so the mod stays out of the way: hover shows split right,
// split down, zoom and close, as stock does.
import { div, svg, image } from "gpui-kit";
import { Button, h_flex } from "gpui-base";
import { home, theme, run } from "herdr";
import { providerId, visibleWindows, shortLabel } from "../core.js";
import { limitState, value } from "./instruments.js";

// The quota figure for this pane's agent: its first two limits ("5h 28% · Week 40%"), "choose
// account" when several accounts could be the one, or null when there's nothing to show.
function figure(f, id) {
  const { o } = f;
  // Hidden everywhere means here too; the status bar choice doesn't apply to headers.
  const lanes = o.hidden.includes(id) ? [] : f.all.filter(a => a.id === id);
  const single = lanes.length === 1 ? lanes[0] : null;
  const ws = single ? visibleWindows(single, o).slice(0, 2) : [];
  // No reading, no figure: several accounts are offered only when one of them has something.
  const quota = lanes.length > 1 ? (lanes.some(l => visibleWindows(l, o).length) ? "choose account" : null)
    : ws.length ? `${ws.map(w => `${shortLabel(w, single.windows)} ${value(f, w, limitState(f, w, single))}`).join(" · ")}${o.metric === "left" ? " left" : ""}` : null;
  const hot = ws.some(w => limitState(f, w, single) === "fresh" && w.percentUsed >= o.redline);
  return { quota, hot };
}

export function header(view) {
  // Herdr's theme, as its own header reads it.
  const f = view.f, t = /** @type {any} */ (theme()), p = f.pane;
  if (!p) return div();
  const pane = p.pane;
  const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
  const icon = !p.program?.icon ? null : p.program.tint ? svg(p.program.icon).size(14).flex_none().text_color(t.dim) : image(p.program.icon).w(14).h(14).flex_none();
  const h = home(), cwd = p.cwd ?? "";
  const folder = !cwd ? "" : cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
  const id = providerId(p.program?.key || p.app);
  // A terminal on another machine spends that machine's sign-in, which this computer doesn't
  // read: no figure there.
  const remote = Boolean(p.terminal?.includes("/"));
  const { quota, hot } = figure(f, id);
  const button = (key, file, command, args) => div().id(`ph-${key}-${pane}`).p(3).rounded(4).text_color(t.dim)
    .hover(st => st.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => { cx.stop_propagation(); run(command, args); })
    .child(svg(`mods/pane/${file}.svg`).size(14));
  const st = p.status;
  return h_flex().id(`pane-head-${pane}`).size_full().px(10).gap(8).items_center()
    .bg(t.background).border_b(1).border_color(t.border).text_size(12)
    .on_hover((hovered, cx) => { view.hovered = hovered; cx.notify(); })
    .on_click(() => run("pane.focus", { pane }))
    .when(Boolean(icon), el => el.child(icon))
    .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
    .child(div().flex_1().truncate().text_color(t.dim).child(folder))
    .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
    .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(/** @type {any} */ (t.blocked + "26")).text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
    .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
    // A native button, so it takes Tab, Enter and Space and is named for screen readers; it
    // looks like quiet text. Bounded and shrinking, so the stock buttons always keep their room
    // in a narrow pane; the tooltip has the whole figure.
    .when(p.program?.agent === true && !remote && Boolean(quota), el => el.child(Button.new(`quota-for-${pane}`)
      .role("button").accessibility_label(`Open ${name} quota${quota === "choose account" ? "" : `: ${quota}`}${hot ? ", over redline" : ""}`)
      .tab_stop(true).tab_index(0)
      .flex_shrink(1).min_w(0).max_w(200).truncate().px(4).py(1).rounded(4)
      .border(1).border_color(t.background).focus(s => s.border_color(t.accent))
      .font_family(f.mono).text_size(11).text_color(/** @type {any} */ (hot ? f.t.redline : t.dim))
      .cursor_pointer().hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); view.open(id); })
      .tooltip(`${name} quota: ${quota}${hot ? " · over redline" : ""}. Click for details.`)
      .child(div().flex_1().min_w(0).truncate().child(quota))))
    .when(Boolean(view.hovered), el => el
      .child(button("r", "split-right", "pane.split", { direction: "right", pane }))
      .child(button("d", "split-down", "pane.split", { direction: "down", pane }))
      .child(button("z", p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
      .child(button("x", "close", "pane.close", { pane })));
}
