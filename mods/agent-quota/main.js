import { View, div, svg, image } from "gpui-kit";
import { Button, h_flex, v_flex } from "gpui-base";
import {
  exec, appHome, readTextFile, knownAgents, agents, spaces, panes,
  theme, settings, shared, setShared, props, openOverlay, closeOverlay, nextCommand, run,
} from "herdr";
import {
  PREFIX, POLL_MS, options, providerId, catalog, visibleWindows, windowState,
  elapsed, pace, resetLabel, shortLabel, redlines, ageLabel, remoteAgent,
} from "./core.js";
import { collect, canCollect } from "./collector.js";

const key = suffix => `${PREFIX}.${suffix}`;
/** @returns {any} Application-owned, normalized shared state. */
const get = suffix => shared(key(suffix));
const put = (suffix, value) => setShared(key(suffix), value);
const safe = value => String(value ?? "").slice(0, 120);
const STATE_LABEL = { working: "Working", blocked: "Needs you", done: "Finished", idle: "Idle" };
const ICONS = { claude: "claude", codex: "codex", grok: "grok", cursor: "cursor", copilot: "copilot", kimi: "kimi" };

export function colors(t, dark) {
  return { ...t, healthy: dark ? "#80c9ae" : "#226b50", warning: dark ? "#e1bc75" : "#79530c", redline: dark ? "#f48e83" : "#ad302d" };
}
const colorFor = (value, o, t) => value >= o.redline ? t.redline : value >= o.redline - 15 ? t.warning : t.healthy;
const label = (s, size, color) => div().text_size(size).text_color(color).child(s);
const rule = t => div().h(1).w_full().flex_none().bg(t.border);

export default class AgentQuota extends View {
  init(_props, cx) {
    this.id = `${Date.now()}-${Math.random()}`;
    this.mode = props()?.mode ?? "strip";
    this.page = "overview";
    this.width = 850;
    this.stripFocus = cx.focus_handle();
    this.runtime = {};
    this.pending = false;
    this.discoveryAt = 0;
    this.nextAsk = get("refresh") ?? 0;
    cx.spawn(async cx => {
      try { this.runtime = JSON.parse(await readTextFile(`${appHome()}/mods/agent-quota/runtime.json`) || "{}"); } catch { /* PATH fallback */ }
      this.tick(cx);
    });
    // No high-frequency animation or terminal polling. All copies use a shared lease.
    cx.timer.every(15000, cx => this.tick(cx));
    if (this.mode === "dashboard") cx.timer.every(60000, cx => cx.notify());
    if (this.mode === "strip") cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "menu" || command === "open") this.open();
        if (command === "refresh") { put("refresh", (get("refresh") ?? 0) + 1); this.tick(cx); }
      }
    });
  }

  opts() { return options(props()?.start ?? props() ?? {}, get("options") ?? {}); }
  save(change) { put("options", { ...this.opts(), ...change }); }
  all() { return catalog(get("data"), get("discovered") ?? [], agents(), spaces(), this.opts()); }
  shown() { const o = this.opts(); return this.all().filter(p => !o.hidden.includes(p.id)); }

  tick(cx) {
    const now = Date.now(), control = get("control");
    const ask = get("refresh") ?? 0;
    const force = ask !== this.nextAsk;
    if (this.pending || !canCollect(control, now, force)) return;
    this.nextAsk = ask;
    this.pending = true;
    put("control", { ...control, owner: this.id, attempt: now, until: now + 45000 });
    cx.spawn(async cx => {
      try {
        if (now - (get("discoveryAt") ?? 0) > 300000) {
          try {
            const list = await knownAgents();
            put("discovered", list.map(a => ({ key: a.key, name: a.name, icon: a.icon, tint: a.tint, installed: a.installed })));
            put("discoveryAt", now);
          } catch { /* quota still works when discovery fails */ }
        }
        const report = await collect(exec, this.runtime);
        if (get("control")?.owner !== this.id) return;
        put("data", report);
        put("error", null);
        put("control", { owner: this.id, attempt: now, until: 0, failures: 0 });
      } catch (e) {
        if (get("control")?.owner === this.id) {
          // Only our own static collector messages; raw subprocess errors are never exposed.
          put("error", safe(e.message));
          put("control", { owner: this.id, attempt: now, until: 0, failures: (control?.failures ?? 0) + 1 });
        }
      } finally { this.pending = false; cx.notify(); }
    });
  }

  open(provider = null) {
    openOverlay({ mod: "agent-quota", kind: "window", key: "agent-quota-dashboard", width: 850, height: 660,
      props: { mode: "dashboard", provider, start: this.opts() } });
  }

  button(id, title, action, t, cx, active = false) {
    const invoke = (event, eventCx) => { eventCx.stop_propagation(); action(event, eventCx); };
    // Native buttons retain focus and keyboard activation by stable component ID.
    return Button.new(id).flex().h(30).px(10).gap(6).items_center().flex_none().rounded(5)
      .role("button").accessibility_label(title)
      .tab_stop(true).tab_index(0)
      .border(1).border_color(active ? t.input : t.border)
      .bg(active ? t.selected : t.popover).text_size(12).text_color(t.foreground)
      .focus(s => s.border_color(t.accent).bg(t.selected))
      .cursor_pointer().hover(s => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(invoke)
      .child(title);
  }

  toggle(id, title, on, action, t, cx) {
    return this.button(id, `${on ? "On" : "Off"} · ${title}`, action, t, cx, on);
  }

  glyph(p, size, t) {
    const icon = p.program?.icon ?? (ICONS[p.id] ? `icons/${ICONS[p.id]}.svg` : null);
    if (!icon) return label(p.label.slice(0, 1).toUpperCase(), size, t.muted).w(size).flex_none();
    return p.program?.tint === false ? image(icon).size(size).flex_none() : svg(icon).size(size).flex_none().text_color(t.foreground);
  }

  bar(w, p, width, t, now) {
    const o = this.opts(), state = windowState(w, p, now, Boolean(get("error")));
    const measured = ["fresh", "stale"].includes(state);
    const used = measured ? w.percentUsed : 0, e = elapsed(w, now);
    return div().relative().w(width).h(5).flex_none().rounded(2).bg(t.border)
      .when(used > 0, el => el.child(div().absolute().top(0).left(0).h(5).w(width * used / 100).rounded(2).bg(state === "fresh" ? colorFor(used, o, t) : t.muted)))
      .child(div().absolute().top(-2).left(width * o.redline / 100).h(9).w(1).bg(t.redline).opacity(.6))
      .when(e !== null && state === "fresh", el => el.child(div().absolute().top(-2).left(width * e).h(9).w(1).bg(t.foreground)));
  }

  gauge(w, p, t, now) {
    const o = this.opts(), state = windowState(w, p, now, Boolean(get("error")));
    const measured = state === "fresh" || state === "stale";
    const color = state === "fresh" ? colorFor(w.percentUsed, o, t) : t.muted;
    // A 240 degree sweep, increasing clockwise; the last 30% is a visible red zone.
    const marks = Array.from({ length: 41 }, (_, i) => {
      const theta = (150 + 240 * i / 40) * Math.PI / 180;
      const used = measured && i / 40 * 100 <= w.percentUsed;
      const danger = i / 40 * 100 >= o.redline;
      return div().absolute().left(82 + 64 * Math.cos(theta)).top(78 + 64 * Math.sin(theta))
        .w(i % 5 === 0 ? 5 : 3).h(i % 5 === 0 ? 5 : 3).rounded(2)
        .bg(used ? color : danger ? t.redline : t.border).opacity(used ? 1 : danger ? .5 : 1);
    });
    const center = measured ? `${Math.round(w.percentUsed)}%` : "—";
    const sub = ({ fresh: "used", stale: "last reading", reset: "awaiting reset reading", unknown: "not reported", untrusted: "unverified", share: "share of parent" })[state];
    return v_flex().w(176).flex_none().items_center().gap(3)
      .child(div().relative().w(170).h(130).children(marks)
        .child(div().absolute().left(0).top(57).w(170).text_center().text_size(30).font_semibold().text_color(color).child(center))
        .child(div().absolute().left(0).top(94).w(170).text_center().text_size(10).text_color(t.muted).child(sub))
        .child(label("0", 10, t.muted).absolute().left(24).top(117))
        .child(label("100", 10, t.muted).absolute().right(15).top(117)))
      .child(label(shortLabel(w), 13, t.foreground).font_medium().max_w(172).truncate().tooltip(w.label))
      .child(label(resetLabel(w, now), 11, t.muted).max_w(172).truncate().tooltip(w.resetsAt ? new Date(w.resetsAt).toLocaleString() : "Reset time was not reported"))
      .child(label(state === "fresh" ? pace(w, now) : state === "stale" ? "Stale · refresh to verify" : state === "share" ? `${w.percentUsed ?? "?"}% of ${w.shareOf}` : "", 11, state === "fresh" && w.percentUsed >= o.redline ? t.redline : t.muted));
  }

  strip(t, cx) {
    const now = Date.now(), o = this.opts(), all = this.shown();
    const candidates = all.filter(p => visibleWindows(p, o).length || p.sessions.length || p.installed);
    const maxWindows = this.width < 300 ? 1 : 2;
    let budget = this.width - 50;
    const shown = [];
    for (const p of candidates) {
      const ws = visibleWindows(p, o).slice(0, maxWindows);
      const estimate = 32 + (o.names ? Math.min(80, p.label.length * 6) : 0) + ws.reduce((n, w) => n + 78 + Math.min(45, shortLabel(w).length * 5), 0);
      if (shown.length && estimate > budget) break;
      shown.push(p); budget -= estimate;
    }
    const hidden = candidates.length - shown.length;
    const items = shown.map(p => {
      const ws = visibleWindows(p, o).slice(0, maxWindows);
      return h_flex().gap(7).items_center().flex_none().child(this.glyph(p, 12, t))
        .when(o.names, el => el.child(label(p.label, 11, t.muted).max_w(80).truncate()))
        .when(p.multiAccount, el => el.child(label("Account", 10, t.muted)))
        .when(!ws.length, el => el.child(label("—", 11, t.muted)))
        .children(ws.map(w => {
          const state = windowState(w, p, now, Boolean(get("error")));
          return h_flex().gap(5).items_center().tooltip(`${p.label} · ${w.label}\n${state === "fresh" ? `${w.percentUsed}% used` : state}\n${resetLabel(w, now)}`)
            .child(label(shortLabel(w), 10, t.muted).max_w(45).truncate())
            .child(this.bar(w, p, 28, t, now))
            .child(label(["fresh", "stale"].includes(state) ? `${state === "stale" ? "~" : ""}${Math.round(w.percentUsed)}%` : "—", 11, state === "fresh" ? colorFor(w.percentUsed, o, t) : t.muted));
        }));
    });
    return h_flex().id("agent-quota-strip").size_full().px(12).gap(12).items_center().justify_end().overflow_hidden()
      .on_size_change((s, cx) => { this.width = s.width; cx.notify(); })
      .bg(t.chrome).border(1).border_color(t.border).cursor_pointer()
      .focus(s => s.border_color(t.accent).bg(t.selected))
      .track_focus(this.stripFocus).tab_stop(true).tab_index(0)
      .role("button").accessibility_label("Open agent quota dashboard")
      .tooltip("Agent quota · click for dashboard")
      .on_click(() => this.open()).on_mouse_down("right", () => this.open())
      .on_key_down(e => { if (e.key === "enter" || e.key === "space") this.open(); })
      .when(!items.length, el => el.child(label(get("error") ? "Quota · setup needed" : "Quota · detecting agents", 11, t.muted)))
      .children(items)
      .when(hidden > 0, el => el.child(label(`+${hidden}`, 11, t.muted)))
      .when(Boolean(get("error")) && items.length > 0, el => el.child(label("Stale", 10, t.warning)));
  }

  sessions(p, t, cx) {
    const list = p.sessions;
    if (!list.length) return label("No open sessions", 11, t.muted);
    return v_flex().gap(5).children(list.map(a => {
      const remote = remoteAgent(a, spaces());
      return h_flex().gap(8).items_center()
        .child(div().size(5).rounded(3).bg(t[a.status] ?? t.muted).flex_none())
        .child(label(`${STATE_LABEL[a.status] ?? a.status} · ${a.space_name} / ${a.tab_name}`, 11, t.foreground).flex_1().min_w(0).truncate())
        .when(remote, el => el.child(label("Remote · quota not linked", 10, t.muted)))
        .child(this.button(`focus-${p.key}-${a.address}`, "Go to agent", () => {
          if (props()?.overlay) closeOverlay(props().overlay);
          run("agent.focus", { terminal: a.address });
        }, t, cx));
    }));
  }

  provider(p, t, cx, now) {
    const ws = visibleWindows(p, this.opts());
    const columns = Math.max(1, Math.floor((this.width - 90) / 184));
    const rows = [];
    for (let i = 0; i < ws.length; i += columns) rows.push(h_flex().gap(8).items_start().children(ws.slice(i, i + columns).map(w => this.gauge(w, p, t, now))));
    const active = p.sessions.filter(a => a.status === "working").length;
    const status = p.remote ? "Remote activity only" : !p.windows.length ? p.installed ? "Installed · quota unavailable" : p.status.replaceAll("_", " ") : p.stale || p.status !== "fresh" ? "Stale reading" : p.reused ? "Recent cached reading" : "Account quota";
    return v_flex().gap(14).py(20).flex_none()
      .child(h_flex().gap(10).items_center()
        .child(this.glyph(p, 20, t))
        .child(label(p.label, 17, t.foreground).font_semibold())
        .when(Boolean(p.plan), el => el.child(label(p.plan, 11, t.muted)))
        .child(div().flex_1())
        .child(label(active ? `${active} working` : p.sessions.length ? `${p.sessions.length} open` : "Not running", 11, active ? t.working : t.muted)))
      .child(label(`${status}${p.multiAccount ? ` · Account ${p.account}` : ""}`, 11, t.muted).truncate().tooltip(p.multiAccount ? p.account : status))
      .when(rows.length > 0, el => el.children(rows))
      .when(!ws.length, el => el.child(v_flex().gap(5).py(8)
        .child(label(p.windows.length ? "All limit windows are hidden" : "No measurable quota reported", 14, t.foreground))
        .child(label(p.windows.length ? "Choose which limits to show in Configure." : "Check the provider sign-in and quota-axi. Installation alone does not expose a quota.", 12, t.muted))))
      .child(this.sessions(p, t, cx))
      .when(p.multiAccount && p.sessions.length > 0, el => el.child(label("Sessions are listed by provider; their account is not inferred.", 11, t.muted)));
  }

  configure(t, cx) {
    const o = this.opts();
    const update = (id, field, value) => { const current = this.opts(); this.save({ [field]: { ...current[field], [id]: value } }); };
    return v_flex().gap(14).py(20)
      .child(label("Display", 17, t.foreground).font_semibold())
      .child(label("Choices apply immediately and are saved across Herdr restarts.", 12, t.muted))
      .child(h_flex().gap(8).flex_wrap()
        .child(this.toggle("active-first", "Running agents first", o.activeFirst, () => this.save({ activeFirst: !this.opts().activeFirst }), t, cx))
        .child(this.toggle("provider-names", "Provider names", o.names, () => this.save({ names: !this.opts().names }), t, cx))
        .child(this.toggle("signed-out", "Unavailable providers", o.signedOut, () => this.save({ signedOut: !this.opts().signedOut }), t, cx)))
      .child(label("Limit windows", 14, t.foreground).font_medium())
      .child(h_flex().gap(8).flex_wrap().children(Object.keys(o.kinds).map(kind => this.toggle(`kind-${kind}`, kind, o.kinds[kind], () => update(kind, "kinds", !this.opts().kinds[kind]), t, cx))))
      .child(label("Redline begins at", 14, t.foreground).font_medium())
      .child(h_flex().gap(8).children([60, 70, 80, 90].map(n => this.button(`redline-${n}`, `${n}% used`, () => this.save({ redline: n }), t, cx, o.redline === n))))
      .child(label("Providers and individual limits", 14, t.foreground).font_medium())
      .children(this.all().map(p => v_flex().gap(8).py(7)
        .child(this.toggle(`provider-${p.key}`, `${p.label}${p.multiAccount ? ` · ${p.account}` : ""}`, !o.hidden.includes(p.id), () => {
          const hidden = this.opts().hidden;
          this.save({ hidden: hidden.includes(p.id) ? hidden.filter(id => id !== p.id) : [...hidden, p.id] });
        }, t, cx))
        .child(h_flex().gap(8).flex_wrap().children(p.windows.map(w => this.toggle(`window-${w.key}`, w.label, o.windows[w.key] !== false, () => update(w.key, "windows", this.opts().windows[w.key] === false), t, cx))))))
      .child(rule(t))
      .child(label("Collection", 14, t.foreground).font_medium())
      .child(label("Quota refreshes every 2 minutes, with backoff after failures. All surfaces share one collector. No inference requests are made.", 12, t.muted))
      .child(label("The collector reads local CLI sign-ins and calls provider usage services. This mod stores only normalized quota data and display choices.", 12, t.muted))
      .child(label("Secure-store access may need a one-time grant in quota-axi. Run its setup command in your terminal when a provider requests access.", 12, t.muted));
  }

  dashboard(t, cx) {
    const now = Date.now(), o = this.opts(), all = this.shown();
    const selected = props()?.provider;
    const list = selected ? all.filter(p => p.id === selected) : all;
    const lines = redlines(all, o, now, Boolean(get("error")));
    const busy = (get("control")?.until ?? 0) > now;
    const count = agents().length;
    const body = this.page === "configure" ? this.configure(t, cx) : v_flex().gap(0)
      .when(Boolean(selected), el => el.child(this.button("show-all", "Show all providers", () => this.open(), t, cx)))
      .when(lines.length > 0, el => el.child(h_flex().gap(8).py(14).items_center()
        .child(div().size(6).rounded(3).bg(t.redline))
        .child(label(`${lines.length} ${lines.length === 1 ? "limit is" : "limits are"} redlining · ${lines.map(x => `${x.p.label} ${shortLabel(x.w)}`).join(", ")}`, 12, t.redline).flex_1())))
      .when(!list.length, el => el.child(v_flex().gap(12).py(30)
        .child(label("No providers to show", 19, t.foreground))
        .child(label("Open Configure to restore hidden providers, or start an agent in Herdr.", 13, t.muted))))
      .children(list.flatMap(p => [this.provider(p, t, cx, now), rule(t)]));
    return v_flex().id("agent-quota-dashboard").size_full().bg(t.popover).text_color(t.foreground)
      .on_size_change((s, cx) => { this.width = s.width; cx.notify(); })
      .child(h_flex().px(24).py(18).gap(8).items_center().flex_none()
        .child(v_flex().gap(5).flex_1().min_w(0)
          .child(label("Agent quota", 23, t.foreground).font_semibold())
          .child(label(`${count} open ${count === 1 ? "agent" : "agents"} · ${spaces().length} spaces · ${ageLabel(get("data")?.at, now)}`, 12, t.muted).truncate()))
        .child(this.button("refresh", busy ? "Refreshing…" : "Refresh", (_e, cx) => { put("refresh", (get("refresh") ?? 0) + 1); this.tick(cx); }, t, cx))
        .when(Boolean(props()?.overlay), el => el.child(this.button("close", "Close", () => closeOverlay(props().overlay), t, cx))))
      .child(h_flex().px(24).pb(14).gap(8).flex_none()
        .child(this.button("overview", "Overview", (_e, cx) => { this.page = "overview"; cx.notify(); }, t, cx, this.page === "overview"))
        .child(this.button("configure", "Configure", (_e, cx) => { this.page = "configure"; cx.notify(); }, t, cx, this.page === "configure"))
        .child(div().flex_1())
        .child(label(`Redline ${o.redline}%`, 11, t.redline).items_center()))
      .child(rule(t))
      .child(v_flex().id("quota-scroll").flex_1().min_h(0).px(24).overflow_y_scrollbar()
        .when(Boolean(get("error")), el => el.child(v_flex().py(16).gap(6)
          .child(label("Quota needs attention", 14, t.warning).font_medium())
          .child(label(get("error"), 12, t.foreground))
          .child(label("Previous readings stay marked stale until collection succeeds.", 11, t.muted))))
        .child(body))
      .child(rule(t))
      .child(v_flex().px(24).py(12).gap(4).flex_none()
        .child(label("Quotas are per account, shared across spaces. Remote sessions show activity only.", 11, t.muted))
        .child(label("Percentages measure provider quota. Token counts are unavailable unless reported by the provider.", 11, t.muted)));
  }

  header(t, cx) {
    const p = panes().find(p => p.pane === props()?.pane);
    if (!p) return div();
    const id = providerId(p.program?.key || p.app), now = Date.now(), o = this.opts();
    const lanes = this.all().filter(a => a.id === id);
    const single = lanes.length === 1 ? lanes[0] : null;
    const ws = single ? visibleWindows(single, o).slice(0, 2) : [];
    const remote = Boolean(p.terminal?.includes("/"));
    return h_flex().id(`quota-pane-${p.pane}`).size_full().px(10).gap(8).items_center().bg(t.background).border_b(1).border_color(t.border)
      .on_click(() => run("pane.focus", { pane: p.pane }))
      .child(this.glyph({ id, label: p.program?.name ?? p.title, program: p.program }, 13, t))
      .child(label(p.program?.name ?? p.title, 12, t.foreground).max_w(150).truncate())
      .child(label(p.cwd ?? "", 11, t.muted).flex_1().min_w(0).truncate())
      .when(Boolean(p.status), el => el.child(label(STATE_LABEL[p.status] ?? p.status, 11, t[p.status] ?? t.muted)))
      .when(p.program?.agent === true, el => el.child(this.button(`quota-for-${p.pane}`, remote ? "Remote quota —" : lanes.length > 1 ? "Quota · choose account" : ws.length ? ws.map(w => `${shortLabel(w)} ${windowState(w, single, now, Boolean(get("error"))) === "fresh" ? `${Math.round(w.percentUsed)}%` : "—"}`).join(" · ") : "Quota —", () => this.open(id), t, cx)))
      .child(this.button(`split-${p.pane}`, "Split", () => run("pane.split", { pane: p.pane, direction: "right" }), t, cx))
      .child(this.button(`zoom-${p.pane}`, p.zoomed ? "Restore" : "Zoom", () => run("pane.zoom", { pane: p.pane }), t, cx))
      .child(this.button(`close-${p.pane}`, "Close", () => run("pane.close", { pane: p.pane }), t, cx));
  }

  render(cx) {
    const t = colors(theme(), settings().dark !== false);
    if (this.mode === "dashboard") return this.dashboard(t, cx);
    if (this.mode === "header") return this.header(t, cx);
    return this.strip(t, cx);
  }
}
