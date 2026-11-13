// Small building blocks every surface shares: colors, text, controls and paging. Each control
// is a native Herdr button, so it takes Tab, Enter and Space and is named for screen readers.
import { div, svg, image } from "gpui-kit";
import { Button, h_flex, v_flex } from "gpui-base";
import { ICONS } from "../providers/index.js";

const CLASSIC = { dark: ["#80c9ae", "#e1bc75", "#f48e83"], light: ["#226b50", "#79530c", "#ad302d"] };

// Health follows the terminal's own ANSI green/yellow/red unless the classic palette is chosen.
export function colors(t, dark, palette = "terminal") {
  const ansi = palette === "terminal" && t.ansi1 && t.ansi2 && t.ansi3;
  const [healthy, warning, redline] = ansi ? [t.ansi2, t.ansi3, t.ansi1] : CLASSIC[dark ? "dark" : "light"];
  return { ...t, healthy, warning, redline };
}
export const colorFor = (used, o, t) => used >= o.redline ? t.redline : used >= o.redline - 15 ? t.warning : t.healthy;
/** @returns {import("gpui-kit").Color | null} */
export const tint = (color, alpha) => /^#[0-9a-f]{6}$/i.test(color ?? "") ? /** @type {import("gpui-kit").Color} */ (`${color}${alpha}`) : null;
export const label = (s, size, color) => div().text_size(size).text_color(color).child(s);
export const rule = t => div().h(1).w_full().flex_none().bg(t.border);

// A provider's icon: Herdr's own for a running program, else the provider's (providers/index.js),
// else its initial.
export function glyph(p, size, t) {
  const icon = p.program?.icon ?? ICONS[p.id] ?? null;
  if (!icon) return label(p.label.slice(0, 1).toUpperCase(), size, t.muted).w(size).flex_none();
  return p.program?.tint === false ? image(icon).size(size).flex_none() : svg(icon).size(size).flex_none().text_color(t.foreground);
}

// ── controls ─────────────────────────────────────────────

export function button(id, title, action, t, { active = false, small = false, a11y = title } = {}) {
  const invoke = (event, eventCx) => { eventCx.stop_propagation(); action(event, eventCx); };
  // Native buttons retain focus and keyboard activation by stable component ID.
  return Button.new(id).flex().h(small ? 24 : 28).px(small ? 8 : 10).gap(6).items_center().justify_center().flex_none().rounded(5)
    .role("button").accessibility_label(a11y).selected(active)
    .tab_stop(true).tab_index(0)
    .border(1).border_color(active ? t.input : t.border)
    .bg(active ? t.selected : t.popover).text_size(small ? 11 : 12).text_color(t.foreground)
    .focus(s => s.border_color(t.accent))
    .cursor_pointer().hover(s => s.bg(t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click(invoke)
    .child(title);
}

// A row that is one big target: title and hint at left, a drawn switch at right.
export function switchRow(id, title, hint, on, action, t) {
  return Button.new(id).flex().w_full().gap(14).px(10).py(10).items_center().rounded(6)
    .role("button").accessibility_label(`${title}: ${on ? "on" : "off"}`).selected(on)
    .tab_stop(true).tab_index(0).border(1).border_color(t.popover)
    .focus(s => s.border_color(t.accent)).cursor_pointer().hover(s => s.bg(t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); action(); })
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(label(title, 12, t.foreground))
      .when(Boolean(hint), el => el.child(label(hint, 11, t.muted).truncate())))
    .child(div().relative().w(30).h(16).flex_none().rounded(8).bg(on ? t.accent : t.border)
      .child(div().id(`${id}-knob`).absolute().top(2).left(on ? 16 : 2).size(12).rounded(6).bg(on ? t.accent_foreground ?? t.popover : t.muted)
        .transition("left", { duration: 120, easing: "ease-out" })));
}

// A single choice, all options visible: no menus to open.
export function segmented(id, items, current, pick, t) {
  return h_flex().p(2).gap(2).rounded(6).bg(t.chrome).border(1).border_color(t.border).flex_none()
    .children(items.map(([value, text]) => {
      const on = value === current;
      return Button.new(`${id}-${value}`).flex().h(24).px(12).items_center().rounded(4)
        .role("button").accessibility_label(text).selected(on).tab_stop(true).tab_index(0)
        .border(1).border_color(on ? t.input : t.chrome).bg(on ? t.selected : t.chrome)
        .text_size(12).text_color(on ? t.foreground : t.muted)
        .focus(s => s.border_color(t.accent)).cursor_pointer().hover(s => s.text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); pick(value, cx); })
        .child(text);
    }));
}

// An on/off choice among several: a square mark and its name.
export function chip(id, text, on, action, t, name = text) {
  return Button.new(id).flex().h(24).px(8).gap(6).items_center().rounded(4).flex_none()
    .role("button").accessibility_label(`${name}: ${on ? "shown" : "hidden"}`).selected(on).tab_stop(true).tab_index(0)
    .border(1).border_color(on ? t.input : t.border).bg(on ? t.selected : t.popover)
    .text_size(11).text_color(on ? t.foreground : t.muted)
    .focus(s => s.border_color(t.accent)).cursor_pointer().hover(s => s.bg(t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); action(); })
    .child(div().size(8).rounded(2).border(1).border_color(on ? t.accent : t.muted).when(on, el => el.bg(t.accent)))
    .child(text);
}

// ── paging ───────────────────────────────────────────────

// Bound eager native builders. Ordinary scroll areas still build offscreen children;
// pagination keeps every account/limit/session accessible without unbounded host calls.
export const PAGE = { providers: 4, limits: 8, sessions: 8 };
// One page of `items`; the copy remembers each list's page in `view.pages`.
export function pageItems(view, id, items, size) {
  const total = Math.max(1, Math.ceil(items.length / size));
  let page = Math.min(view.pages[id] ?? 0, total - 1);
  // A page command (agent-quota.next-page / prev-page, main.js turnPage) for this list: wraps.
  if (view.turn?.list === id) { page = (page + view.turn.delta + total) % total; view.pages[id] = page; view.turn = null; }
  return { items: items.slice(page * size, (page + 1) * size), page, total };
}
// An array to pass to .children(): Herdr's .child() rejects null, so one page adds nothing.
export function pager(view, id, { page, total }, t) {
  if (total <= 1) return [];
  const change = delta => (_e, cx) => { view.pages[id] = page + delta; cx.notify(); };
  return [h_flex().gap(8).py(6).items_center()
    .when(page > 0, el => el.child(button(`${id}-prev`, "← Previous", change(-1), t, { small: true })))
    .child(label(`Page ${page + 1} of ${total}`, 11, t.muted))
    .when(page + 1 < total, el => el.child(button(`${id}-next`, "Next →", change(1), t, { small: true })))];
}
