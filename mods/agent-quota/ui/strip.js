// The status-bar strip: each provider's icon and its first limits, as many as fit. Clicking it,
// or Enter/Space, opens the dashboard.
import { h_flex } from "gpui-base";
import { visibleWindows, shortLabel } from "../core.js";
import { label, glyph } from "./parts.js";
import { limitState, cells, fill, value, meter, timeNote } from "./instruments.js";

function stripWindow(f, w, p) {
  const { o, t } = f, state = limitState(f, w, p);
  const figure = label(value(f, w, state), 11, state === "fresh" ? fill(f, w, state) : t.muted);
  const row = h_flex().gap(5).items_center().flex_none()
    .tooltip(`${p.label} · ${w.label}\n${timeNote(f, w, state)}`)
    .child(label(shortLabel(w, p.windows), 10, t.muted).max_w(64).truncate());
  if (o.strip === "meter") return row.child(meter(f, w, p, 34, 8, 3, 1)).child(figure);
  if (o.strip === "blocks") {
    const lit = cells(f, 8, w, state).filter(c => c === "lit").length;
    return row.child(h_flex().text_size(11)
      .child(label("▕", 11, t.border))
      .child(label("█".repeat(lit), 11, fill(f, w, state)))
      .child(label("░".repeat(8 - lit), 11, t.border))
      .child(label("▏", 11, t.border))).child(figure);
  }
  return row.child(figure);
}
// An estimate of a provider's width in the strip, to decide what fits without measuring.
function stripWidth(f, p, ws) {
  const { o } = f, per = { meter: 78, blocks: 98, numbers: 36 }[o.strip];
  return 24 + (o.names ? Math.min(90, p.label.length * 7) : 0) + ws.reduce((n, w) => n + per + Math.min(64, shortLabel(w, p.windows).length * 6.5), 0);
}

// The providers that fit in `width`, also used by Settings' preview. `hidden` counts those that
// didn't fit (the "+N"); `chosen` means every readable provider was taken off the strip on purpose.
export function stripItems(f, width) {
  const { o, t, shown } = f;
  // Quiet by default: only providers with something to read or something running.
  const candidates = shown.filter(p => !o.offStrip.includes(p.id) && (visibleWindows(p, o).length || p.sessions.length));
  const maxWindows = width < 320 ? 1 : 2;
  let budget = width - 50;
  const fits = [];
  for (const p of candidates) {
    const estimate = stripWidth(f, p, visibleWindows(p, o).slice(0, maxWindows));
    if (fits.length && estimate > budget) break;
    fits.push(p); budget -= estimate + 14;
  }
  const items = fits.map(p => {
    const ws = visibleWindows(p, o).slice(0, maxWindows);
    return h_flex().gap(7).items_center().flex_none().child(glyph(p, 12, t))
      .when(o.names, el => el.child(label(p.label, 11, t.foreground).max_w(90).truncate()))
      .when(p.multiAccount, el => el.child(label(`[${p.account}]`, 10, t.muted).max_w(60).truncate()))
      .when(!ws.length, el => el.child(label("—", 11, t.muted)))
      .children(ws.map(w => stripWindow(f, w, p)));
  });
  // Taken off the status bar on purpose (Settings), not waiting for anything.
  const chosen = !candidates.length && shown.some(p => o.offStrip.includes(p.id));
  return { items, hidden: candidates.length - fits.length, stale: fits.some(f.stale), chosen };
}

export function strip(view) {
  const f = view.f, { t, failed } = f, { items, hidden, stale, chosen } = stripItems(f, view.width);
  const open = () => view.open(null, "overview", true);
  return h_flex().id("agent-quota-strip").size_full().px(12).gap(14).items_center().justify_end().overflow_hidden()
    .font_family(f.mono)
    .on_size_change((s, cx) => view.resized(s, cx))
    .bg(t.chrome).border(1).border_color(t.chrome).cursor_pointer()
    .hover(s => s.bg(t.hover))
    .focus(s => s.border_color(t.accent).bg(t.selected))
    .track_focus(view.keys).tab_stop(true).tab_index(0)
    .role("button").accessibility_label("Open agent quota dashboard")
    .tooltip("Agent quota · click for details")
    .on_click(open).on_mouse_down("right", open)
    .on_key_down(e => { if (e.key === "enter" || e.key === "space") open(); })
    .when(!items.length, el => el.child(label(failed ? "quota · needs attention" : chosen ? "quota" : "quota · waiting for agents", 11, t.muted)))
    .children(items)
    .when(hidden > 0, el => el.child(label(`+${hidden}`, 11, t.muted)))
    .when(stale, el => el.child(label("stale", 10, t.warning)));
}
