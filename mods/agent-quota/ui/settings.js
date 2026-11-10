// The dashboard's Settings page. Every change saves at once (main.js `save`) and redraws every
// copy, so the status-bar preview at the top shows the result live.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { visibleWindows, shows, shortLabel } from "../core.js";
import { label, switchRow, segmented, chip, pageItems, pager, PAGE } from "./parts.js";
import { stripItems } from "./strip.js";

function section(title, t) {
  return h_flex().gap(8).items_center().pt(18).pb(6)
    .child(label(title, 11, t.muted).flex_none())
    .child(div().flex_1().h(1).bg(t.border));
}
function setting(title, hint, control, t) {
  return h_flex().gap(14).px(10).py(6).items_center()
    .child(v_flex().flex_1().min_w(0).gap(2).child(label(title, 12, t.foreground)).when(Boolean(hint), el => el.child(label(hint, 11, t.muted))))
    .child(control);
}

// One provider: its switch (hidden everywhere when off), then two labeled rows so neither reads
// as the other's: where it shows (off the status bar only; the dashboard and pane headers keep
// it), and which of its limits show wherever it does.
function providerSettings(view, p) {
  const { o, t } = view.f, set = change => view.save(change);
  const visible = !o.hidden.includes(p.id);
  const limitId = `choices-${p.key}`, limits = pageItems(view, limitId, p.windows, PAGE.limits);
  const inStrip = !o.offStrip.includes(p.id);
  const hint = `${visible ? "" : "Hidden · "}${p.windows.length ? `${visibleWindows(p, o).length} of ${p.windows.length} limits ${visible ? "shown" : "selected"}` : p.status === "auth_required" ? "Sign-in needed" : "No quota reported"}${visible && !inStrip ? " · not in the status bar" : ""}`;
  return v_flex().gap(6)
    .child(switchRow(`provider-${p.key}`, `${p.label}${p.multiAccount ? ` · ${p.account}` : ""}`, hint, visible, () => {
      const hidden = view.opts().hidden;
      set({ hidden: hidden.includes(p.id) ? hidden.filter(id => id !== p.id) : [...hidden, p.id] });
    }, t))
    .when(visible, el => el.child(h_flex().pl(10).pb(p.windows.length ? 0 : 6).gap(6).items_center().flex_wrap()
      .child(label("Show in", 11, t.muted).w(56).flex_none())
      .child(chip(`strip-${p.key}`, "Status bar", inStrip, () => {
        const off = view.opts().offStrip;
        set({ offStrip: off.includes(p.id) ? off.filter(id => id !== p.id) : [...off, p.id] });
      }, t, `${p.label} in the status bar`))))
    .when(visible && p.windows.length > 0, el => el.child(h_flex().pl(10).pb(6).gap(6).items_center().flex_wrap()
      .child(label("Limits", 11, t.muted).w(56).flex_none()
        .tooltip("Which limits show, in the status bar, the dashboard and pane headers."))
      .children(limits.items.map(w =>
        chip(`window-${w.key}`, shortLabel(w, p.windows), shows(w, o), () => {
          const current = view.opts();
          set({ windows: { ...current.windows, [w.key]: !shows(w, current) } });
        }, t, `${p.label} ${shortLabel(w, p.windows)} limit`)))).children(pager(view, limitId, limits, t)));
}

export function configure(view, contentWidth) {
  const { o, t, all } = view.f;
  const set = change => view.save(change);
  const flip = field => () => set({ [field]: !view.opts()[field] });
  const preview = stripItems(view.f, contentWidth);
  const providerPage = pageItems(view, "configure-providers", all, PAGE.providers);
  return v_flex().pb(20)
    .child(section("── status bar", t))
    .child(h_flex().h(30).mx(10).mb(6).px(12).gap(14).items_center().justify_end().overflow_hidden().rounded(4)
      .bg(t.chrome).border(1).border_color(t.border)
      .children(preview.items.length ? preview.items : [label(preview.chosen ? "No providers in the status bar" : "Nothing to show yet", 11, t.muted)])
      .when(preview.hidden > 0, el => el.child(label(`+${preview.hidden}`, 11, t.muted))))
    .child(setting("Style", "How each limit looks at the bottom of the window.",
      segmented("strip-style", [["meter", "Meter"], ["blocks", "Blocks"], ["numbers", "Numbers"]], o.strip, v => set({ strip: v }), t), t))
    .child(setting("Show", "Count what you've used, or what you have left.",
      segmented("metric", [["used", "Used"], ["left", "Left"]], o.metric, v => set({ metric: v }), t), t))
    .child(switchRow("provider-names", "Provider names", "Show “Claude”, “Codex” beside their icons.", o.names, flip("names"), t))
    .child(section("── dashboard", t))
    .child(setting("Layout", "Meter rows are dense; gauges are larger.",
      segmented("dash-style", [["bars", "Meters"], ["gauges", "Gauges"]], o.dash, v => set({ dash: v }), t), t))
    .child(setting("Colors", "Terminal uses your theme's green, yellow and red.",
      segmented("palette", [["terminal", "Terminal"], ["classic", "Classic"]], o.palette, v => set({ palette: v }), t), t))
    .child(section("── redline", t))
    .child(setting("Warn at", "Limits turn red and are called out at this much use.",
      segmented("redline", [60, 70, 80, 90].map(n => [n, `${n}%`]), o.redline, v => set({ redline: v }), t), t))
    .child(section("── providers", t))
    .child(switchRow("active-first", "Running agents first", "Agents you're using sort to the front.", o.activeFirst, flip("activeFirst"), t))
    .child(switchRow("signed-out", "Providers without quota", "List signed-out and unsupported providers too.", o.signedOut, flip("signedOut"), t))
    .children(providerPage.items.map(p => providerSettings(view, p)))
    .children(pager(view, "configure-providers", providerPage, t))
    .child(section("── about this data", t))
    .child(v_flex().px(10).gap(4)
      .child(label("Reads after an agent finishes a turn (at most once a minute), every 3 minutes while agents work, and every 10 minutes otherwise. Never makes inference requests.", 11, t.muted))
      .child(label("Reads each agent's existing sign-in and asks only its own usage service, directly. Never refreshes a sign-in. Stores only percentages, reset times and your choices here.", 11, t.muted))
      .child(label("Token counts are unavailable unless a provider reports them.", 11, t.muted)));
}
