// Herdr Agent Quota. One class, four kinds of copy, chosen by the layout's `mode` prop:
//
//   strip      the status-bar readout (ui/strip.js). The one long-lived copy: it runs the read
//              schedule (reads.js) and handles the mod's commands.
//   panel      the dashboard docked as a layout column (ui/dashboard.js, ui/settings.js).
//   dashboard  the same dashboard as a window, for a layout without the column.
//   header     a pane header (ui/header.js), one copy per pane, display only.
//
// Copies share state through Herdr (state.js), never module variables. The data itself comes
// from core.js (validation, identities, options) and collector.js + providers/ (the reads).
import { View } from "gpui-kit";
import { agents, spaces, panes, theme, settings, props, openOverlay, closeOverlay, nextCommand, run } from "herdr";
import { options, providerId, catalog, localAgents, forgetOtherMachines, failure } from "./core.js";
import { get, put, PANEL, panelNode } from "./state.js";
import { tick, refresh, requestRead, observe } from "./reads.js";
import { colors } from "./ui/parts.js";
import { strip, stripItems } from "./ui/strip.js";
import { dashboard, pad } from "./ui/dashboard.js";
import { header } from "./ui/header.js";

export default class AgentQuota extends View {
  init(_props, cx) {
    this.id = `${Date.now()}-${Math.random()}`;
    this.mode = props()?.mode ?? "strip";
    // The panel is the dashboard docked in its layout column: one copy for the window's life.
    this.docked = this.mode === "panel";
    if (this.docked) this.mode = "dashboard";
    this.page = props()?.page === "configure" ? "configure" : "overview";
    this.selected = props()?.provider ?? null;
    // The opener writes before showing the column. Honor that request when this copy starts,
    // but don't replay an old target after a layout switch or reload.
    const request = this.docked ? get("view") : null;
    this.viewAt = request?.at ?? 0;
    const requestAge = Date.now() - this.viewAt;
    if (request && requestAge >= 0 && requestAge <= 2000) {
      this.selected = typeof request.provider === "string" ? request.provider : null;
      this.page = request.page === "configure" ? "configure" : "overview";
    }
    this.drawn = false;
    this.width = this.docked ? 460 : this.mode === "dashboard" ? 850 : 600;
    // One view-owned handle, created here: the strip takes Enter/Space, the dashboard Escape.
    this.keys = cx.focus_handle();
    // Read state (reads.js): a read in flight, a queued Refresh, agents' last statuses, and when
    // an agent last finished a turn.
    this.pending = false;
    this.queued = false;
    this.statuses = null;
    this.finishedAt = 0;
    // Each paged list's current page (ui/parts.js pageItems).
    this.pages = {};
    // Pane headers, one per pane, only display. The strip schedules and runs reads; an opened
    // dashboard asks it for one. The 10 s check is in-memory: it reads only when one is due.
    if (this.mode !== "header") cx.spawn(async cx => {
      cx.phase(); // End retired tasks before they read or publish state.
      if (this.mode === "strip") {
        // Left by a build that read other machines: their readings and its on/off record.
        put("data", forgetOtherMachines(get("data") ?? null)); put("remote", null);
        this.tick(cx);
      }
    });
    // The window reads when it opens; the panel's opener asks the strip instead (see open()).
    if (this.mode === "dashboard" && !this.docked) this.read(cx, "look");
    if (this.mode === "strip") cx.timer.every(10000, cx => this.tick(cx));
    // Age labels change once a minute. A hidden panel is not drawn, so repaint only after a draw:
    // a hidden panel stops asking after one tick instead of redrawing the window every minute.
    if (this.mode === "dashboard") cx.timer.every(60000, cx => { if (this.drawn) { this.drawn = false; cx.notify(); } });
    if (this.mode === "strip") cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        // Herdr ends a replaced build's loop at its next cx use; without one, a retired
        // copy whose nextCommand() resolves at once would spin the main thread forever.
        cx.phase();
        if (typeof command !== "string") return;
        if (command === "menu" || command === "open") this.open(null, "overview", true);
        if (command === "settings") this.open(null, "configure");
        if (command === "refresh") this.refresh(cx);
        if (command === "look") this.tick(cx, { looking: true });
      }
    });
  }

  // ── reads (reads.js) ─────────────────────────────────────
  tick(cx, opts) { tick(this, cx, opts); }
  refresh(cx) { refresh(this, cx); }
  read(cx, why) { requestRead(this, cx, why); }
  observe(now, live) { return observe(this, now, live); }

  // ── options ──────────────────────────────────────────────
  opts() { const p = props() ?? {}; return options(p.start ?? p, get("options") ?? {}); }
  save(change) {
    const current = this.opts(), next = { ...current, ...change };
    if (JSON.stringify(options(props()?.start ?? props() ?? {}, next)) !== JSON.stringify(current)) put("options", next);
  }

  // Everything one render needs, computed once rather than per gauge or row. Pane headers,
  // one copy per pane, read only their provider's limits, so they skip live agents and spaces.
  frame() {
    const o = this.opts(), isHeader = this.mode === "header";
    const places = isHeader ? [] : spaces(), live = isHeader ? [] : localAgents(agents(), places);
    if (this.mode === "strip") this.observe(Date.now(), live);
    const paneId = isHeader ? props()?.pane : null;
    const pane = isHeader ? panes().find(p => p.pane === paneId) : null;
    const id = pane ? providerId(pane.program?.key || pane.app) : null;
    let report;
    if (isHeader) {
      // Live terminal changes can repaint every header. Read the small control record first;
      // only deserialize quota again when a collection starts/completes or the program changes.
      const c = get("control"), revision = `${id}/${c?.attempt ?? 0}/${c?.token ?? ""}`;
      if (this.headerRevision !== revision) {
        // Never another machine's lane, even one the strip hasn't dropped yet (see init).
        this.headerReport = { providers: (get("data")?.providers ?? []).filter(p => p.id === id && !p.machine) };
        this.headerRevision = revision;
      }
      report = this.headerReport;
    } else report = get("data");
    const all = isHeader ? report.providers : catalog(report, get("discovered") ?? [], live, places, o);
    // Overview lists what can be read or acted on; Settings lists everything. A refused sign-in
    // (auth_required) is something to act on; never signing in here (signed_out) is not.
    // Pane headers skip the catalog, so their lanes have no sessions.
    const useful = p => p.windows.length || p.sessions?.length || p.status === "auth_required" || o.signedOut;
    const config = settings(), font = config.font_family;
    // A failure leaves only the providers its read covered stale.
    const error = failure(get("error"));
    const stale = p => Boolean(error) && (error.providers === null || error.providers.includes(p.axi ?? p.id));
    return { o, all, shown: all.filter(p => !o.hidden.includes(p.id) && useful(p)), now: Date.now(), failed: Boolean(error), error, stale,
      agents: live, spaces: places, pane, t: colors(theme(), config.dark !== false, o.palette), mono: typeof font === "string" ? font : "JetBrains Mono" };
  }

  // Size reports arrive during layout, where Herdr interrupts a re-render. Repaint from a task
  // instead, and only when the width changes what is drawn.
  resized(size, cx) {
    const step = this.mode === "strip" ? 24 : 8;
    if (Math.abs(size.width - this.width) < step) return;
    this.width = size.width;
    cx.spawn(async cx => cx.notify());
  }

  // ── opening and closing the dashboard ────────────────────
  // `toggle` (the strip, its key and the open command) closes a shown panel; a targeted open
  // (a provider, Settings) always shows it. Without the column in the layout: the window.
  open(provider = null, page = "overview", toggle = false) {
    const node = panelNode();
    if (node) {
      const hidden = node.hidden === true; // layout() drops the key on a shown node
      if (provider || page !== "overview") put("view", { provider, page, at: Date.now() });
      run(toggle ? "layout.toggle" : "layout.show", { id: PANEL });
      // As the window did on open: read if the last reading is over a minute old. Never on close.
      if (hidden || !toggle) run("agent-quota.look");
      return;
    }
    openOverlay({ mod: "agent-quota", kind: "window", key: "agent-quota-dashboard", width: 850, height: 660,
      props: { mode: "dashboard", provider, page, start: this.opts() } });
  }
  dismiss() {
    if (this.docked) run("layout.hide", { id: PANEL });
    else if (props()?.overlay) closeOverlay(props().overlay);
  }
  // A newer request from the strip or a pane header: show that provider or page.
  follow() {
    const view = get("view");
    if (!(view?.at > this.viewAt)) return;
    this.viewAt = view.at;
    this.selected = typeof view.provider === "string" ? view.provider : null;
    this.page = view.page === "configure" ? "configure" : "overview";
  }

  // ── drawing ──────────────────────────────────────────────
  pad() { return pad(this); }
  stripItems(width) { return stripItems(this.f, width); }
  render(_cx) {
    if (this.docked) this.follow();
    this.drawn = true;
    this.f = this.frame();
    if (this.mode === "dashboard") return dashboard(this);
    if (this.mode === "header") return header(this);
    return strip(this);
  }
}
