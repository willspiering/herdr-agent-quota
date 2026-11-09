// The dashboard: a column beside the terminals (or a window, in a layout without the column).
// Overview lists each provider's limits and running agents; Settings is in ui/settings.js.
import { div } from "gpui-kit";
import { Button, h_flex, v_flex } from "gpui-base";
import { props, run } from "herdr";
import { visibleWindows, pace, resetLabel, shortLabel, redlines, ageLabel } from "../core.js";
import { get } from "../state.js";
import { label, rule, tint, glyph, button, segmented, pageItems, pager, PAGE } from "./parts.js";
import { limitState, fill, value, meter, arc, timeNote } from "./instruments.js";
import { configure } from "./settings.js";

const STATE_LABEL = { working: "Working", blocked: "Needs you", done: "Finished", idle: "Idle" };
const STATE_MARK = { working: "●", blocked: "▲", done: "✓", idle: "○" };
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// The column is narrower than the window: tighter margins, and the legend on its own row.
export const pad = view => view.docked ? 16 : 24;

// The words beside a limit: its pace, or why it has none.
function note(f, w, state) {
  return state === "fresh" ? pace(w, f.now) : state === "stale" ? "Stale · refresh" : state === "share" ? `Share of ${w.shareOf}` : "";
}
const resetTooltip = w => w.resetsAt ? new Date(w.resetsAt).toLocaleString() : "Reset time was not reported";

function barRow(f, w, p, width) {
  const { t } = f, state = limitState(f, w, p), wide = width >= 640;
  const meterWidth = Math.max(60, Math.min(520, width - (wide ? 430 : 320)));
  return h_flex().gap(12).h(24).items_center()
    .child(label(shortLabel(w, p.windows), 12, t.foreground).w(72).flex_none().truncate().tooltip(w.label))
    .child(meter(f, w, p, meterWidth, 10).tooltip(timeNote(f, w, state)))
    .child(h_flex().w(76).flex_none().gap(4).items_baseline()
      .child(label(value(f, w, state), 13, fill(f, w, state)).font_semibold())
      .when(state === "fresh" || state === "stale", el => el.child(label(f.o.metric, 10, t.muted))))
    .child(label(resetLabel(w, f.now), 11, t.muted).w(130).flex_none().truncate().tooltip(resetTooltip(w)))
    .when(wide, el => el.child(label(note(f, w, state), 11, state === "fresh" && w.percentUsed >= f.o.redline ? t.redline : t.muted).w(100).flex_none().truncate()));
}

function gauge(f, w, p) {
  const { t } = f, state = limitState(f, w, p);
  return v_flex().w(156).flex_none().items_center().gap(2)
    .child(arc(f, w, p, 140))
    .child(label(shortLabel(w, p.windows), 12, t.foreground).font_medium().max_w(150).truncate().tooltip(w.label))
    .child(label(resetLabel(w, f.now), 11, t.muted).max_w(150).truncate().tooltip(resetTooltip(w)))
    .child(label(note(f, w, state), 11, state === "fresh" && w.percentUsed >= f.o.redline ? t.redline : t.muted));
}

// The provider's running agents, each a button that goes to its terminal.
function sessions(view, p) {
  const { t } = view.f;
  const id = `sessions-${p.key}`, page = pageItems(view, id, p.sessions, PAGE.sessions);
  return v_flex().gap(1).children(page.items.map(a => {
    const where = `${a.space_name} / ${a.tab_name}`;
    return Button.new(`focus-${p.key}-${a.address}`).flex().w_full().h(26).px(8).gap(10).items_center().rounded(4)
      .role("button").accessibility_label(`Go to ${p.label} in ${where}`).tab_stop(true).tab_index(0)
      .border(1).border_color(t.popover).focus(s => s.border_color(t.accent)).cursor_pointer().hover(s => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      // The window covers the terminals, so it closes; the column sits beside them and stays.
      .on_click((_e, cx) => { cx.stop_propagation(); if (!view.docked) view.dismiss(); run("agent.focus", { terminal: a.address }); })
      .child(label(STATE_MARK[a.status] ?? "·", 11, t[a.status] ?? t.muted).w(12).flex_none())
      .child(label(STATE_LABEL[a.status] ?? a.status, 11, t[a.status] ?? t.muted).w(72).flex_none())
      .child(label(where, 11, t.foreground).flex_1().min_w(0).truncate())
      .child(label("go to →", 10, t.muted).flex_none());
  })).children(pager(view, id, page, t));
}

// One provider: its name, plan and activity, then its limits as meter rows or gauges.
function provider(view, p) {
  const f = view.f, { o, t } = f, limits = visibleWindows(p, o), content = view.width - 2 * pad(view);
  const limitId = `limits-${p.key}`, limitPage = pageItems(view, limitId, limits, PAGE.limits), ws = limitPage.items;
  const working = p.sessions.filter(a => a.status === "working").length;
  const blocked = p.sessions.filter(a => a.status === "blocked").length;
  const activity = blocked ? [`▲ ${blocked} needs you`, t.blocked] : working ? [`● ${working} working`, t.working] : p.sessions.length ? [`○ ${p.sessions.length} open`, t.muted] : ["not running", t.dim ?? t.muted];
  const status = p.windows.length && (p.stale || p.status !== "fresh") ? "Stale reading · refresh to verify" : p.reused ? "Recent cached reading" : null;
  const empty = !p.windows.length
    ? [p.status === "auth_required" ? `Sign in to ${p.label} to read its quota.` : `${p.label} reported no quota.`, null]
    : !ws.length ? ["All limits are hidden.", "Choose limits"] : null;
  let body;
  if (ws.length && o.dash === "gauges") {
    const columns = Math.max(1, Math.floor((content + 10) / 166));
    body = v_flex().gap(10);
    for (let i = 0; i < ws.length; i += columns) body.child(h_flex().gap(10).items_start().children(ws.slice(i, i + columns).map(w => gauge(f, w, p))));
  } else if (ws.length) body = v_flex().gap(4).children(ws.map(w => barRow(f, w, p, content)));
  return v_flex().gap(10).py(16).flex_none()
    .child(h_flex().gap(8).items_center()
      .child(glyph(p, 16, t))
      .child(label(p.label, 14, t.foreground).font_semibold().flex_none())
      .when(Boolean(p.plan), el => el.child(label(`[${p.plan}]`, 11, t.muted).flex_none()))
      .when(p.multiAccount, el => el.child(label(`account ${p.account}`, 11, t.muted).max_w(160).truncate().tooltip(p.account)))
      .child(div().flex_1().min_w(12).h(1).bg(t.border))
      .child(label(activity[0], 11, activity[1]).flex_none()))
    .when(Boolean(status), el => el.child(label(status, 11, t.warning)))
    .when(Boolean(body), el => el.child(body))
    .children(pager(view, limitId, limitPage, t))
    .when(Boolean(empty), el => el.child(h_flex().gap(10).items_center()
      .child(label(`— ${empty[0]}`, 12, t.muted))
      .when(Boolean(empty[1]), el => el.child(button(`limits-${p.key}`, empty[1], (_e, cx) => { view.page = "configure"; cx.notify(); }, t, { small: true })))))
    .when(p.sessions.length > 0, el => el.child(sessions(view, p)))
    .when(p.multiAccount && p.sessions.length > 0, el => el.child(label("Sessions are listed by provider; their account is not inferred.", 11, t.muted)));
}

// Teaches the meter once: what fills, where redline starts, and what the white tick is.
function legend(f) {
  const { o, t } = f;
  const swatch = (color, alpha) => div().w(8).h(8).flex_none().bg(alpha ? tint(color, alpha) ?? color : color);
  const item = (mark, text, color = t.muted) => h_flex().gap(5).items_center().flex_none().child(mark).child(label(text, 10, color));
  return h_flex().id("quota-legend").gap(12).items_center().min_w(0).overflow_hidden()
    .child(item(swatch(t.healthy), o.metric))
    .child(item(swatch(t.redline, "59"), o.metric === "left" ? `redline ≤${100 - o.redline}% left` : `redline ${o.redline}%+`, t.redline))
    .child(item(div().w(2).h(10).flex_none().bg(t.foreground), "time elapsed"))
    .tooltip("Cells fill with usage. The dim red cells are the redline zone; reaching them turns the meter red.\nThe white tick shows how much of the limit's window has passed: fill past the tick means you are using quota faster than time.");
}

// The Overview page: an over-redline callout, then one section per provider.
function overview(view) {
  const f = view.f, { o, t, now, shown } = f, selected = view.selected;
  const list = selected ? shown.filter(p => p.id === selected) : shown;
  const providerPage = pageItems(view, "overview-providers", list, PAGE.providers);
  const lines = redlines(shown, o, now, f.stale);
  const toSettings = (_e, cx) => { view.page = "configure"; cx.notify(); };
  return v_flex()
    .when(Boolean(selected), el => el.child(h_flex().pt(14).child(button("show-all", "← All providers", (_e, cx) => { view.selected = null; cx.notify(); }, t, { small: true }))))
    .when(lines.length > 0, el => el.child(h_flex().mt(14).px(12).py(8).gap(10).items_center().rounded(4)
      .border(1).border_color(t.redline).when(Boolean(tint(t.redline, "1a")), el => el.bg(tint(t.redline, "1a")))
      .child(label("▲", 12, t.redline))
      .child(label(`Over redline · ${lines.slice(0, 3).map(x => `${x.p.label} ${shortLabel(x.w, x.p.windows)} ${Math.round(x.w.percentUsed)}%`).join(", ")}${lines.length > 3 ? ` · +${lines.length - 3} limits` : ""}`, 12, t.redline).flex_1().min_w(0).truncate())))
    .when(!list.length, el => el.child(v_flex().gap(10).py(30).items_start()
      .child(label("No providers to show", 15, t.foreground))
      .child(label("Start an agent in Herdr, or show hidden providers in Settings.", 12, t.muted))
      .child(button("empty-settings", "Open settings", toSettings, t))))
    .children(providerPage.items.map(p => provider(view, p)))
    .children(pager(view, "overview-providers", providerPage, t));
}

export function dashboard(view) {
  const f = view.f, { t, now, failed } = f, p = pad(view), narrow = view.width < 600;
  // Busy is shared: another copy's read shows here too.
  const busy = view.pending || get("control")?.busyUntil > now, queued = !busy && view.queued;
  const count = f.agents.length, here = f.spaces.filter(s => !s.machine).length;
  const body = view.page === "configure" ? configure(view, view.width - 2 * p) : overview(view);
  return v_flex().id("agent-quota-dashboard").size_full().bg(t.popover).text_color(t.foreground).font_family(f.mono)
    // Docked, it matches the pane frames beside it (the layout's radius 10 and border).
    .when(view.docked, el => el.rounded(10).border(1).border_color(t.border).overflow_hidden())
    .on_size_change((s, cx) => view.resized(s, cx))
    .track_focus(view.keys).on_key_down(e => { if (e.key === "escape") view.dismiss(); })
    .child(h_flex().px(p).pt(18).pb(12).gap(8).items_center().flex_none()
      .child(v_flex().gap(4).flex_1().min_w(0)
        .child(label("Agent quota", 17, t.foreground).font_semibold())
        .child(label(`${count} ${count === 1 ? "agent" : "agents"} · ${here} ${here === 1 ? "space" : "spaces"} · ${ageLabel(get("data")?.at, now).toLowerCase()}`, 11, t.muted).truncate()))
      .child(button("refresh", busy ? "Refreshing" : queued ? "Queued" : "↻ Refresh", (_e, cx) => view.refresh(cx), t,
        { a11y: busy ? "Refreshing quota" : queued ? "Refresh queued" : "Refresh quota" })
        .when(queued, el => el.tooltip("Read moments ago. Reading again when the 10-second cooldown ends."))
        .when(busy, el => el.child(div().w(10).text_color(t.muted).frames(SPINNER, 90).child(SPINNER[0]))))
      .when(view.docked || Boolean(props()?.overlay), el => el.child(button("close", "✕", () => view.dismiss(), t, { a11y: "Close" }))))
    .child(h_flex().px(p).pb(12).gap(8).items_center().flex_none()
      .child(segmented("page", [["overview", "Overview"], ["configure", "Settings"]], view.page, (v, cx) => { view.page = v; cx.notify(); }, t))
      .when(!narrow, el => el.child(div().flex_1()).child(legend(f))))
    .when(narrow, el => el.child(h_flex().px(p).pb(10).flex_none().child(legend(f))))
    .child(rule(t))
    .child(v_flex().id(`quota-scroll-${view.page}`).flex_1().min_h(0).px(p).overflow_y_scrollbar()
      .when(failed, el => el.child(v_flex().mt(14).px(12).py(10).gap(4).rounded(4).border(1).border_color(t.warning)
        .child(label("Quota needs attention", 12, t.warning).font_medium())
        .child(label(f.error.message, 11, t.foreground))
        .child(label("Earlier readings stay marked stale until collection works again.", 11, t.muted))))
      .child(body))
    .child(rule(t))
    .child(h_flex().px(p).py(10).flex_none()
      .child(label("Quota is per account, read from this computer's sign-ins", 10, t.muted).truncate()));
}
