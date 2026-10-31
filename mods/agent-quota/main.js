import { View, div, svg, image, PathBuilder, Background } from "gpui-kit";
import { Button, h_flex, v_flex } from "gpui-base";
import {
  exec, appHome, readTextFile, knownAgents, agents, spaces, panes,
  theme, settings, shared, setShared, props, openOverlay, closeOverlay, nextCommand, run,
} from "herdr";
import {
  PREFIX, options, providerId, catalog, visibleWindows, shows, reading, windowState,
  elapsed, pace, resetLabel, shortLabel, redlines, ageLabel, remoteAgent, QuotaError,
  CADENCE, schedule, needsSweep, resetDue, targets, mergeReport,
} from "./core.js";
import { collect } from "./collector.js";

const key = suffix => `${PREFIX}.${suffix}`;
/** @returns {any} Application-owned, normalized shared state. */
const get = suffix => shared(key(suffix));
// setShared re-renders every mod in the window, so an unchanged value is never rewritten.
const put = (suffix, value) => {
  if (JSON.stringify(get(suffix) ?? null) !== JSON.stringify(value ?? null)) setShared(key(suffix), value);
};
const GENERIC_ERROR = "Quota collection failed. Run quota-axi in a terminal to check it.";
const STATE_LABEL = { working: "Working", blocked: "Needs you", done: "Finished", idle: "Idle" };
const STATE_MARK = { working: "●", blocked: "▲", done: "✓", idle: "○" };
const ICONS = { claude: "claude", codex: "codex", grok: "grok", cursor: "cursor", copilot: "copilot", kimi: "kimi" };
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// One read at a time per runtime; quota-axi also merges simultaneous reads across processes.
// A timestamp, not a flag: a task cancelled when its copy closes can't wedge later reads.
let inFlight = 0;
const CLASSIC = { dark: ["#80c9ae", "#e1bc75", "#f48e83"], light: ["#226b50", "#79530c", "#ad302d"] };

// Health follows the terminal's own ANSI green/yellow/red unless the classic palette is chosen.
export function colors(t, dark, palette = "terminal") {
  const ansi = palette === "terminal" && t.ansi1 && t.ansi2 && t.ansi3;
  const [healthy, warning, redline] = ansi ? [t.ansi2, t.ansi3, t.ansi1] : CLASSIC[dark ? "dark" : "light"];
  return { ...t, healthy, warning, redline };
}
const colorFor = (used, o, t) => used >= o.redline ? t.redline : used >= o.redline - 15 ? t.warning : t.healthy;
const tint = (color, alpha) => /^#[0-9a-f]{6}$/i.test(color ?? "") ? `${color}${alpha}` : null;
const label = (s, size, color) => div().text_size(size).text_color(color).child(s);
const rule = t => div().h(1).w_full().flex_none().bg(t.border);

// One native path per color: a meter costs three draws, not one element per cell.
const quad = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
function painted(width, height, groups) {
  const el = div().relative().w(width).h(height).flex_none();
  for (const [fill, polygons, alpha] of groups) {
    if (!polygons.length) continue;
    let path = PathBuilder.fill();
    for (const points of polygons) path = path.add_polygon(points, true);
    el.child(window.paint_path(path.build(), alpha === undefined ? fill : Background.solid(fill).opacity(alpha))
      .absolute().top(0).left(0).size_full());
  }
  return el;
}

export default class AgentQuota extends View {
  init(_props, cx) {
    this.id = `${Date.now()}-${Math.random()}`;
    this.mode = props()?.mode ?? "strip";
    this.page = props()?.page === "configure" ? "configure" : "overview";
    this.width = this.mode === "dashboard" ? 850 : 600;
    // One view-owned handle, created here: the strip takes Enter/Space, the dashboard Escape.
    this.keys = cx.focus_handle();
    this.runtime = {};
    this.pending = false;
    this.statuses = null;
    this.finishedAt = 0;
    // Pane headers, one per pane, only display. The strip schedules reads; the dashboard reads
    // when opened. The 10 s check is in-memory: it runs a read only when one is due.
    if (this.mode !== "header") cx.spawn(async cx => {
      try { this.runtime = JSON.parse(await readTextFile(`${appHome()}/mods/agent-quota/runtime.json`) || "{}"); } catch { /* PATH fallback */ }
      this.tick(cx, { looking: this.mode === "dashboard" });
    });
    if (this.mode === "strip") cx.timer.every(10000, cx => this.tick(cx));
    if (this.mode === "dashboard") cx.timer.every(60000, cx => cx.notify());
    if (this.mode === "strip") cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        // Herdr ends a replaced build's loop at its next cx use; without one, a retired
        // copy whose nextCommand() resolves at once would spin the main thread forever.
        cx.notify();
        if (typeof command !== "string") return;
        if (command === "menu" || command === "open") this.open();
        if (command === "settings") this.open(null, "configure");
        if (command === "refresh") this.refresh(cx);
      }
    });
  }

  opts() { return options(props()?.start ?? props() ?? {}, get("options") ?? {}); }
  save(change) {
    const current = this.opts(), next = { ...current, ...change };
    if (JSON.stringify(options(props()?.start ?? props() ?? {}, next)) !== JSON.stringify(current)) put("options", next);
  }
  // Everything one render needs, computed once rather than per gauge or row. Pane headers,
  // one copy per pane, read only their provider's limits, so they skip live agents and spaces.
  frame() {
    const o = this.opts(), header = this.mode === "header";
    const live = header ? [] : agents(), places = header ? [] : spaces();
    const all = catalog(get("data"), get("discovered") ?? [], live, places, o);
    // Overview lists what can be read or acted on; Settings lists everything.
    const useful = p => p.windows.length || p.sessions.length || p.status === "auth_required" || o.signedOut;
    return { o, all, shown: all.filter(p => !o.hidden.includes(p.id) && useful(p)), now: Date.now(), failed: Boolean(get("error")),
      agents: live, spaces: places, t: colors(theme(), settings().dark !== false, o.palette), mono: settings().font_family ?? "JetBrains Mono" };
  }
  state(w, p) { return windowState(w, p, this.f.now, this.f.failed); }

  // Size reports arrive during layout, where Herdr interrupts a re-render. Repaint from a task
  // instead, and only when the width changes what is drawn.
  resized(size, cx) {
    const step = this.mode === "strip" ? 24 : 8;
    if (Math.abs(size.width - this.width) < step) return;
    this.width = size.width;
    cx.spawn(async cx => cx.notify());
  }

  refresh(cx) { this.tick(cx, { force: true }); }

  // A turn has finished when an agent that was working no longer is (or has gone).
  observe(now) {
    const live = agents(), next = new Map(live.map(a => [a.address, a.status]));
    if (this.statuses) for (const [address, status] of this.statuses) {
      if (status === "working" && next.get(address) !== "working" && !this.finishedAt) this.finishedAt = now;
    }
    this.statuses = next;
    return live;
  }

  tick(cx, { force = false, looking = false } = {}) {
    const now = Date.now(), control = get("control") ?? null, data = get("data") ?? null;
    const live = this.mode === "strip" ? this.observe(now) : agents();
    if (this.finishedAt && this.finishedAt <= (control?.attempt ?? 0)) this.finishedAt = 0;
    if (this.pending || now - inFlight < 45000) return;
    const reason = schedule({ now, control, hasData: Boolean(data), force, looking,
      working: live.some(a => a.status === "working"), finished: this.finishedAt > 0, resetDue: resetDue(data, control, now) });
    if (!reason) return;
    const sweep = needsSweep(control, now, reason);
    const ids = sweep ? null : targets(data, get("discovered") ?? [], live);
    this.pending = true;
    inFlight = now;
    if (force || looking) cx.notify();
    cx.spawn(async cx => {
      const next = { attempt: now, failures: 0, sweptAt: control?.sweptAt ?? 0, discoveredAt: control?.discoveredAt ?? 0, reason };
      try {
        if (now - next.discoveredAt >= CADENCE.discover || reason === "manual") {
          try {
            const list = await knownAgents();
            put("discovered", list.map(a => ({ key: a.key, name: a.name, icon: a.icon, tint: a.tint, installed: a.installed })));
            next.discoveredAt = now;
          } catch { /* quota still works when discovery fails */ }
        }
        const { report, swept } = await collect(exec, this.runtime, Date.now(), ids);
        put("data", mergeReport(get("data"), report, swept));
        if (swept) next.sweptAt = now;
        put("error", null);
      } catch (e) {
        // Only this mod's own messages are kept; anything else could echo subprocess output.
        put("error", e instanceof QuotaError ? e.message.slice(0, 160) : GENERIC_ERROR);
        next.failures = (control?.failures ?? 0) + 1;
      } finally {
        put("control", next);
        this.pending = false;
        inFlight = 0;
        cx.notify();
      }
    });
  }

  open(provider = null, page = "overview") {
    openOverlay({ mod: "agent-quota", kind: "window", key: "agent-quota-dashboard", width: 850, height: 660,
      props: { mode: "dashboard", provider, page, start: this.opts() } });
  }
  close() { if (props()?.overlay) closeOverlay(props().overlay); }

  // ── controls ─────────────────────────────────────────────

  button(id, title, action, t, { active = false, small = false, a11y = title } = {}) {
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
  switchRow(id, title, hint, on, action, t) {
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
  segmented(id, items, current, pick, t) {
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

  chip(id, text, on, action, t) {
    return Button.new(id).flex().h(24).px(8).gap(6).items_center().rounded(4).flex_none()
      .role("button").accessibility_label(`${text}: ${on ? "shown" : "hidden"}`).selected(on).tab_stop(true).tab_index(0)
      .border(1).border_color(on ? t.input : t.border).bg(on ? t.selected : t.popover)
      .text_size(11).text_color(on ? t.foreground : t.muted)
      .focus(s => s.border_color(t.accent)).cursor_pointer().hover(s => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(); })
      .child(div().size(8).rounded(2).border(1).border_color(on ? t.accent : t.muted).when(on, el => el.bg(t.accent)))
      .child(text);
  }

  glyph(p, size, t) {
    const icon = p.program?.icon ?? (ICONS[p.id] ? `icons/${ICONS[p.id]}.svg` : null);
    if (!icon) return label(p.label.slice(0, 1).toUpperCase(), size, t.muted).w(size).flex_none();
    return p.program?.tint === false ? image(icon).size(size).flex_none() : svg(icon).size(size).flex_none().text_color(t.foreground);
  }

  // ── instruments ──────────────────────────────────────────

  // Which cells are lit, in the redline zone, or idle. "Left" fills with headroom instead.
  cells(n, w, state) {
    const o = this.f.o, measured = state === "fresh" || state === "stale";
    const lit = measured ? Math.min(n, Math.ceil(reading(w, o) / 100 * n - 1e-9)) : 0;
    return Array.from({ length: n }, (_, i) => {
      if (i < lit) return "lit";
      const danger = o.metric === "left" ? (i + 1) * 100 / n <= 100 - o.redline + 1e-9 : i * 100 / n >= o.redline - 1e-9;
      return danger ? "danger" : "off";
    });
  }
  marker(w, state) {
    const e = state === "fresh" ? elapsed(w, this.f.now) : null;
    return e === null ? null : this.f.o.metric === "left" ? 1 - e : e;
  }
  fill(w, state) { return state === "fresh" ? colorFor(w.percentUsed, this.f.o, this.f.t) : this.f.t.muted; }
  value(w, state) {
    if (state !== "fresh" && state !== "stale") return "—";
    return `${state === "stale" ? "~" : ""}${Math.round(reading(w, this.f.o))}%`;
  }

  // A segmented bar; the foreground tick marks how much of the window has elapsed.
  meter(w, p, width, height, cell = 5, gap = 2) {
    const t = this.f.t, state = this.state(w, p);
    const n = Math.max(4, Math.floor((width + gap) / (cell + gap)));
    const size = (width - gap * (n - 1)) / n;
    const groups = { lit: [], danger: [], off: [] };
    this.cells(n, w, state).forEach((kind, i) => groups[kind].push(quad(i * (size + gap), 0, size, height)));
    const m = this.marker(w, state);
    return painted(width, height, [[t.border, groups.off], [t.redline, groups.danger, .2], [this.fill(w, state), groups.lit],
      [t.foreground, m === null ? [] : [quad(Math.min(width - 2, Math.max(0, m * width - 1)), 0, 2, height)], .85]]);
  }

  // A solid 240° speedometer in 30 segments, clockwise from lower left.
  arc(w, p, size) {
    const t = this.f.t, state = this.state(w, p), n = 30;
    const c = size / 2, outer = size / 2 - 5, inner = outer - 11, height = Math.round(c + outer * .5 + 6);
    const at = (deg, r) => [c + r * Math.cos(deg * Math.PI / 180), c + r * Math.sin(deg * Math.PI / 180)];
    const groups = { lit: [], danger: [], off: [] };
    this.cells(n, w, state).forEach((kind, i) => {
      const a = 150 + 240 * i / n + 1.4, b = 150 + 240 * (i + 1) / n - 1.4;
      groups[kind].push([at(a, outer), at(b, outer), at(b, inner), at(a, inner)]);
    });
    const m = this.marker(w, state), mark = [];
    if (m !== null) { const d = 150 + 240 * m; mark.push([at(d - .9, outer + 4), at(d + .9, outer + 4), at(d + .9, inner - 3), at(d - .9, inner - 3)]); }
    const sub = ({ fresh: this.f.o.metric, stale: "last reading", reset: "awaiting reset", unknown: "not reported", untrusted: "unverified", share: "share of parent" })[state];
    return painted(size, height, [[t.border, groups.off], [t.redline, groups.danger, .2], [this.fill(w, state), groups.lit], [t.foreground, mark, .85]])
      .child(div().absolute().left(0).top(c - 20).w(size).text_center().text_size(24).font_semibold().text_color(this.fill(w, state)).child(this.value(w, state)))
      .child(div().absolute().left(0).top(c + 10).w(size).text_center().text_size(10).text_color(t.muted).child(sub));
  }

  // ── status strip ─────────────────────────────────────────

  stripWindow(w, p) {
    const { o, t } = this.f, state = this.state(w, p);
    const value = label(this.value(w, state), 11, state === "fresh" ? this.fill(w, state) : t.muted);
    const row = h_flex().gap(5).items_center().flex_none()
      .tooltip(`${p.label} · ${w.label}\n${state === "fresh" ? `${Math.round(w.percentUsed)}% used · ${Math.round(100 - w.percentUsed)}% left` : state}\n${resetLabel(w, this.f.now)}`)
      .child(label(shortLabel(w, p.windows), 10, t.muted).max_w(64).truncate());
    if (o.strip === "meter") return row.child(this.meter(w, p, 34, 8, 3, 1)).child(value);
    if (o.strip === "blocks") {
      const cells = this.cells(8, w, state);
      const lit = cells.filter(c => c === "lit").length;
      return row.child(h_flex().text_size(11)
        .child(label("▕", 11, t.border))
        .child(label("█".repeat(lit), 11, this.fill(w, state)))
        .child(label("░".repeat(8 - lit), 11, t.border))
        .child(label("▏", 11, t.border))).child(value);
    }
    return row.child(value);
  }
  stripWidth(p, ws) {
    const { o } = this.f, per = { meter: 78, blocks: 98, numbers: 36 }[o.strip];
    return 24 + (o.names ? Math.min(90, p.label.length * 7) : 0) + ws.reduce((n, w) => n + per + Math.min(64, shortLabel(w, p.windows).length * 6.5), 0);
  }
  stripItems(width) {
    const { o, t, shown } = this.f;
    // Quiet by default: only providers with something to read or something running.
    const candidates = shown.filter(p => visibleWindows(p, o).length || p.sessions.length);
    const maxWindows = width < 320 ? 1 : 2;
    let budget = width - 50;
    const fits = [];
    for (const p of candidates) {
      const estimate = this.stripWidth(p, visibleWindows(p, o).slice(0, maxWindows));
      if (fits.length && estimate > budget) break;
      fits.push(p); budget -= estimate + 14;
    }
    const items = fits.map(p => {
      const ws = visibleWindows(p, o).slice(0, maxWindows);
      return h_flex().gap(7).items_center().flex_none().child(this.glyph(p, 12, t))
        .when(o.names, el => el.child(label(p.label, 11, t.foreground).max_w(90).truncate()))
        .when(p.multiAccount, el => el.child(label(`[${p.account}]`, 10, t.muted).max_w(60).truncate()))
        .when(!ws.length, el => el.child(label("—", 11, t.muted)))
        .children(ws.map(w => this.stripWindow(w, p)));
    });
    return { items, hidden: candidates.length - fits.length };
  }

  strip() {
    const { t, failed } = this.f, { items, hidden } = this.stripItems(this.width);
    return h_flex().id("agent-quota-strip").size_full().px(12).gap(14).items_center().justify_end().overflow_hidden()
      .font_family(this.f.mono)
      .on_size_change((s, cx) => this.resized(s, cx))
      .bg(t.chrome).border(1).border_color(t.chrome).cursor_pointer()
      .hover(s => s.bg(t.hover))
      .focus(s => s.border_color(t.accent).bg(t.selected))
      .track_focus(this.keys).tab_stop(true).tab_index(0)
      .role("button").accessibility_label("Open agent quota dashboard")
      .tooltip("Agent quota · click for details")
      .on_click(() => this.open()).on_mouse_down("right", () => this.open())
      .on_key_down(e => { if (e.key === "enter" || e.key === "space") this.open(); })
      .when(!items.length, el => el.child(label(failed ? "quota · setup needed" : "quota · waiting for agents", 11, t.muted)))
      .children(items)
      .when(hidden > 0, el => el.child(label(`+${hidden}`, 11, t.muted)))
      .when(failed && items.length > 0, el => el.child(label("stale", 10, t.warning)));
  }

  // ── dashboard ────────────────────────────────────────────

  barRow(w, p, width) {
    const { t } = this.f, state = this.state(w, p), wide = width >= 640;
    const meterWidth = Math.max(60, Math.min(520, width - (wide ? 430 : 320)));
    const note = state === "fresh" ? pace(w, this.f.now) : state === "stale" ? "Stale · refresh" : state === "share" ? `Share of ${w.shareOf}` : "";
    return h_flex().gap(12).h(24).items_center()
      .child(label(shortLabel(w, p.windows), 12, t.foreground).w(72).flex_none().truncate().tooltip(w.label))
      .child(this.meter(w, p, meterWidth, 10))
      .child(h_flex().w(76).flex_none().gap(4).items_baseline()
        .child(label(this.value(w, state), 13, this.fill(w, state)).font_semibold())
        .when(state === "fresh" || state === "stale", el => el.child(label(this.f.o.metric, 10, t.muted))))
      .child(label(resetLabel(w, this.f.now), 11, t.muted).w(130).flex_none().truncate()
        .tooltip(w.resetsAt ? new Date(w.resetsAt).toLocaleString() : "Reset time was not reported"))
      .when(wide, el => el.child(label(note, 11, state === "fresh" && w.percentUsed >= this.f.o.redline ? t.redline : t.muted).w(100).flex_none().truncate()));
  }

  gauge(w, p) {
    const { t } = this.f, state = this.state(w, p);
    const note = state === "fresh" ? pace(w, this.f.now) : state === "stale" ? "Stale · refresh" : state === "share" ? `Share of ${w.shareOf}` : "";
    return v_flex().w(156).flex_none().items_center().gap(2)
      .child(this.arc(w, p, 140))
      .child(label(shortLabel(w, p.windows), 12, t.foreground).font_medium().max_w(150).truncate().tooltip(w.label))
      .child(label(resetLabel(w, this.f.now), 11, t.muted).max_w(150).truncate()
        .tooltip(w.resetsAt ? new Date(w.resetsAt).toLocaleString() : "Reset time was not reported"))
      .child(label(note, 11, state === "fresh" && w.percentUsed >= this.f.o.redline ? t.redline : t.muted));
  }

  sessions(p) {
    const { t } = this.f;
    return v_flex().gap(1).children(p.sessions.map(a => {
      const machine = this.f.spaces.find(s => s.id === a.space)?.machine;
      const remote = remoteAgent(a, this.f.spaces);
      const where = `${a.space_name} / ${a.tab_name}`;
      return Button.new(`focus-${p.key}-${a.address}`).flex().w_full().h(26).px(8).gap(10).items_center().rounded(4)
        .role("button").accessibility_label(`Go to ${p.label} in ${where}`).tab_stop(true).tab_index(0)
        .border(1).border_color(t.popover).focus(s => s.border_color(t.accent)).cursor_pointer().hover(s => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.close(); run("agent.focus", { terminal: a.address }); })
        .child(label(STATE_MARK[a.status] ?? "·", 11, t[a.status] ?? t.muted).w(12).flex_none())
        .child(label(STATE_LABEL[a.status] ?? a.status, 11, t[a.status] ?? t.muted).w(72).flex_none())
        .child(label(where, 11, t.foreground).flex_1().min_w(0).truncate())
        .when(remote, el => el.child(label(machine ? `on ${machine}` : "remote", 10, t.muted).flex_none()
          .tooltip("Runs on another machine. Its quota is not linked to this computer's sign-ins.")))
        .child(label("go to →", 10, t.muted).flex_none());
    }));
  }

  provider(p) {
    const { o, t } = this.f, ws = visibleWindows(p, o), content = this.width - 48;
    const working = p.sessions.filter(a => a.status === "working").length;
    const blocked = p.sessions.filter(a => a.status === "blocked").length;
    const activity = blocked ? [`▲ ${blocked} needs you`, t.blocked] : working ? [`● ${working} working`, t.working] : p.sessions.length ? [`○ ${p.sessions.length} open`, t.muted] : ["not running", t.dim ?? t.muted];
    const status = p.remote ? "Remote activity only" : p.windows.length && (p.stale || p.status !== "fresh") ? "Stale reading · refresh to verify" : p.reused ? "Recent cached reading" : null;
    const empty = !p.windows.length
      ? [p.status === "auth_required" ? `Sign in to ${p.label} to read its quota.` : p.remote ? "Quota for remote machines is not collected." : `${p.label} reported no quota.`, null]
      : !ws.length ? ["All limits are hidden.", "Choose limits"] : null;
    let body;
    if (ws.length && o.dash === "gauges") {
      const columns = Math.max(1, Math.floor((content + 10) / 166));
      body = v_flex().gap(10);
      for (let i = 0; i < ws.length; i += columns) body.child(h_flex().gap(10).items_start().children(ws.slice(i, i + columns).map(w => this.gauge(w, p))));
    } else if (ws.length) body = v_flex().gap(4).children(ws.map(w => this.barRow(w, p, content)));
    return v_flex().gap(10).py(16).flex_none()
      .child(h_flex().gap(8).items_center()
        .child(this.glyph(p, 16, t))
        .child(label(p.label, 14, t.foreground).font_semibold().flex_none())
        .when(Boolean(p.plan), el => el.child(label(`[${p.plan}]`, 11, t.muted).flex_none()))
        .when(p.multiAccount, el => el.child(label(`account ${p.account}`, 11, t.muted).max_w(160).truncate().tooltip(p.account)))
        .child(div().flex_1().min_w(12).h(1).bg(t.border))
        .child(label(activity[0], 11, activity[1]).flex_none()))
      .when(Boolean(status), el => el.child(label(status, 11, t.warning)))
      .when(Boolean(body), el => el.child(body))
      .when(Boolean(empty), el => el.child(h_flex().gap(10).items_center()
        .child(label(`— ${empty[0]}`, 12, t.muted))
        .when(Boolean(empty[1]), el => el.child(this.button(`limits-${p.key}`, empty[1], (_e, cx) => { this.page = "configure"; cx.notify(); }, t, { small: true })))))
      .when(p.sessions.length > 0, el => el.child(this.sessions(p)))
      .when(p.multiAccount && p.sessions.length > 0, el => el.child(label("Sessions are listed by provider; their account is not inferred.", 11, t.muted)));
  }

  section(title, t) {
    return h_flex().gap(8).items_center().pt(18).pb(6)
      .child(label(title, 11, t.muted).flex_none())
      .child(div().flex_1().h(1).bg(t.border));
  }
  setting(title, hint, control, t) {
    return h_flex().gap(14).px(10).py(6).items_center()
      .child(v_flex().flex_1().min_w(0).gap(2).child(label(title, 12, t.foreground)).when(Boolean(hint), el => el.child(label(hint, 11, t.muted))))
      .child(control);
  }

  configure() {
    const { o, t, all } = this.f;
    const set = change => this.save(change);
    const flip = field => () => set({ [field]: !this.opts()[field] });
    const preview = this.stripItems(this.width - 48);
    return v_flex().pb(20)
      .child(this.section("── status bar", t))
      .child(h_flex().h(30).mx(10).mb(6).px(12).gap(14).items_center().justify_end().overflow_hidden().rounded(4)
        .bg(t.chrome).border(1).border_color(t.border)
        .children(preview.items.length ? preview.items : [label("Nothing to show yet", 11, t.muted)]))
      .child(this.setting("Style", "How each limit looks at the bottom of the window.",
        this.segmented("strip-style", [["meter", "Meter"], ["blocks", "Blocks"], ["numbers", "Numbers"]], o.strip, v => set({ strip: v }), t), t))
      .child(this.setting("Show", "Count what you've used, or what you have left.",
        this.segmented("metric", [["used", "Used"], ["left", "Left"]], o.metric, v => set({ metric: v }), t), t))
      .child(this.switchRow("provider-names", "Provider names", "Show “Claude”, “Codex” beside their icons.", o.names, flip("names"), t))
      .child(this.section("── dashboard", t))
      .child(this.setting("Layout", "Meter rows are dense; gauges are larger.",
        this.segmented("dash-style", [["bars", "Meters"], ["gauges", "Gauges"]], o.dash, v => set({ dash: v }), t), t))
      .child(this.setting("Colors", "Terminal uses your theme's green, yellow and red.",
        this.segmented("palette", [["terminal", "Terminal"], ["classic", "Classic"]], o.palette, v => set({ palette: v }), t), t))
      .child(this.section("── redline", t))
      .child(this.setting("Warn at", "Limits turn red and are called out at this much use.",
        this.segmented("redline", [60, 70, 80, 90].map(n => [n, `${n}%`]), o.redline, v => set({ redline: v }), t), t))
      .child(this.section("── providers", t))
      .child(this.switchRow("active-first", "Running agents first", "Agents you're using sort to the front.", o.activeFirst, flip("activeFirst"), t))
      .child(this.switchRow("signed-out", "Providers without quota", "List signed-out and unsupported providers too.", o.signedOut, flip("signedOut"), t))
      .children(all.map(p => {
        const visible = !o.hidden.includes(p.id);
        const hint = p.windows.length ? `${visibleWindows(p, o).length} of ${p.windows.length} limits shown` : p.status === "auth_required" ? "Sign-in needed" : p.remote ? "Remote activity only" : "No quota reported";
        return v_flex().gap(6)
          .child(this.switchRow(`provider-${p.key}`, `${p.label}${p.multiAccount ? ` · ${p.account}` : ""}`, hint, visible, () => {
            const hidden = this.opts().hidden;
            set({ hidden: hidden.includes(p.id) ? hidden.filter(id => id !== p.id) : [...hidden, p.id] });
          }, t))
          .when(visible && p.windows.length > 0, el => el.child(h_flex().pl(10).pb(6).gap(6).flex_wrap().children(p.windows.map(w =>
            this.chip(`window-${w.key}`, shortLabel(w, p.windows), shows(w, o), () => {
              const current = this.opts();
              set({ windows: { ...current.windows, [w.key]: !shows(w, current) } });
            }, t)))));
      }))
      .child(this.section("── about this data", t))
      .child(v_flex().px(10).gap(4)
        .child(label("Reads after an agent finishes a turn (at most once a minute), every 3 minutes while agents work, and every 10 minutes otherwise. Never makes inference requests.", 11, t.muted))
        .child(label("Reads local CLI sign-ins through quota-axi. Stores only percentages, reset times and your choices here.", 11, t.muted))
        .child(label("Token counts are unavailable unless a provider reports them.", 11, t.muted)));
  }

  dashboard() {
    const { o, t, now, shown, failed } = this.f;
    const selected = props()?.provider;
    const list = selected ? shown.filter(p => p.id === selected) : shown;
    const lines = redlines(shown, o, now, failed);
    const busy = this.pending;
    const count = this.f.agents.length;
    const toSettings = (_e, cx) => { this.page = "configure"; cx.notify(); };
    const body = this.page === "configure" ? this.configure() : v_flex()
      .when(Boolean(selected), el => el.child(h_flex().pt(14).child(this.button("show-all", "← All providers", () => this.open(), t, { small: true }))))
      .when(lines.length > 0, el => el.child(h_flex().mt(14).px(12).py(8).gap(10).items_center().rounded(4)
        .border(1).border_color(t.redline).when(Boolean(tint(t.redline, "1a")), el => el.bg(tint(t.redline, "1a")))
        .child(label("▲", 12, t.redline))
        .child(label(`Over redline · ${lines.map(x => `${x.p.label} ${shortLabel(x.w, x.p.windows)} ${Math.round(x.w.percentUsed)}%`).join(", ")}`, 12, t.redline).flex_1().min_w(0).truncate())))
      .when(!list.length, el => el.child(v_flex().gap(10).py(30).items_start()
        .child(label("No providers to show", 15, t.foreground))
        .child(label("Start an agent in Herdr, or show hidden providers in Settings.", 12, t.muted))
        .child(this.button("empty-settings", "Open settings", toSettings, t))))
      .children(list.map(p => this.provider(p)));
    return v_flex().id("agent-quota-dashboard").size_full().bg(t.popover).text_color(t.foreground).font_family(this.f.mono)
      .on_size_change((s, cx) => this.resized(s, cx))
      .track_focus(this.keys).on_key_down(e => { if (e.key === "escape") this.close(); })
      .child(h_flex().px(24).pt(18).pb(12).gap(8).items_center().flex_none()
        .child(v_flex().gap(4).flex_1().min_w(0)
          .child(label("Agent quota", 17, t.foreground).font_semibold())
          .child(label(`${count} ${count === 1 ? "agent" : "agents"} · ${this.f.spaces.length} spaces · ${ageLabel(get("data")?.at, now).toLowerCase()}`, 11, t.muted).truncate()))
        .child(this.button("refresh", busy ? "Refreshing" : "↻ Refresh", (_e, cx) => this.refresh(cx), t, { a11y: busy ? "Refreshing quota" : "Refresh quota" })
          .when(busy, el => el.child(div().w(10).text_color(t.muted).frames(SPINNER, 90).child(SPINNER[0]))))
        .when(Boolean(props()?.overlay), el => el.child(this.button("close", "✕", () => this.close(), t, { a11y: "Close" }))))
      .child(h_flex().px(24).pb(12).gap(8).items_center().flex_none()
        .child(this.segmented("page", [["overview", "Overview"], ["configure", "Settings"]], this.page, (v, cx) => { this.page = v; cx.notify(); }, t))
        .child(div().flex_1())
        .child(label(`redline ${o.redline}%`, 11, t.redline)))
      .child(rule(t))
      .child(v_flex().id(`quota-scroll-${this.page}`).flex_1().min_h(0).px(24).overflow_y_scrollbar()
        .when(failed, el => el.child(v_flex().mt(14).px(12).py(10).gap(4).rounded(4).border(1).border_color(t.warning)
          .child(label("Quota needs attention", 12, t.warning).font_medium())
          .child(label(get("error"), 11, t.foreground))
          .child(label("Earlier readings stay marked stale until collection works again.", 11, t.muted))))
        .child(body))
      .child(rule(t))
      .child(h_flex().px(24).py(10).flex_none()
        .child(label("Quota is per account and shared across spaces · remote sessions show activity only", 10, t.muted).truncate()));
  }

  // ── pane header ──────────────────────────────────────────

  header() {
    const { o, t } = this.f;
    const p = panes().find(p => p.pane === props()?.pane);
    if (!p) return div();
    const id = providerId(p.program?.key || p.app);
    const lanes = this.f.all.filter(a => a.id === id);
    const single = lanes.length === 1 ? lanes[0] : null;
    const ws = single ? visibleWindows(single, o).slice(0, 2) : [];
    const remote = Boolean(p.terminal?.includes("/"));
    const quota = remote ? "remote · quota not linked" : lanes.length > 1 ? "choose account"
      : ws.length ? `${ws.map(w => `${shortLabel(w, single.windows)} ${this.value(w, this.state(w, single))}`).join(" · ")}${o.metric === "left" ? " left" : ""}` : "quota —";
    return h_flex().id(`quota-pane-${p.pane}`).size_full().px(10).gap(8).items_center().bg(t.background).border_b(1).border_color(t.border)
      .on_click(() => run("pane.focus", { pane: p.pane }))
      .child(this.glyph({ id, label: p.program?.name ?? p.title, program: p.program }, 13, t))
      .child(label(p.program?.name ?? p.title, 12, t.foreground).max_w(150).truncate())
      .child(label(p.cwd ?? "", 11, t.muted).flex_1().min_w(0).truncate())
      .when(Boolean(p.status), el => el.child(label(STATE_LABEL[p.status] ?? p.status, 11, t[p.status] ?? t.muted)))
      .when(p.program?.agent === true, el => el.child(this.button(`quota-for-${p.pane}`, quota, () => this.open(id), t, { small: true, a11y: `Open ${p.program?.name ?? "agent"} quota` }).font_family(this.f.mono)))
      .child(this.button(`split-${p.pane}`, "Split", () => run("pane.split", { pane: p.pane, direction: "right" }), t, { small: true }))
      .child(this.button(`zoom-${p.pane}`, p.zoomed ? "Restore" : "Zoom", () => run("pane.zoom", { pane: p.pane }), t, { small: true }))
      .child(this.button(`close-${p.pane}`, "Close", () => run("pane.close", { pane: p.pane }), t, { small: true }));
  }

  render(cx) {
    this.f = this.frame();
    if (this.mode === "dashboard") return this.dashboard();
    if (this.mode === "header") return this.header();
    return this.strip();
  }
}
