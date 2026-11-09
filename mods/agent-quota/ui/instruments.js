// How one limit is drawn: its value, the segmented meter, the 240° gauge, and the words for its
// tooltip. Every function takes the render's frame `f` (main.js `frame()`): options, colors,
// the clock and which providers are stale.
import { div, PathBuilder, Background } from "gpui-kit";
import { reading, windowState, elapsed, pace, resetLabel } from "../core.js";
import { colorFor } from "./parts.js";

const PACE_NOTE = {
  "Ahead of pace": "Using faster than time is passing; at this rate it runs out before the reset",
  "Under pace": "Using slower than time is passing; it should last until the reset",
  "On pace": "Using about as fast as time is passing",
};

// fresh, stale, reset, unknown, untrusted or share (core.js windowState).
export const limitState = (f, w, p) => windowState(w, p, f.now, f.stale(p));

// Which cells are lit, in the redline zone, or idle. "Left" fills with headroom instead.
export function cells(f, n, w, state) {
  const o = f.o, measured = state === "fresh" || state === "stale";
  const lit = measured ? Math.min(n, Math.ceil(reading(w, o) / 100 * n - 1e-9)) : 0;
  return Array.from({ length: n }, (_, i) => {
    if (i < lit) return "lit";
    const danger = o.metric === "left" ? (i + 1) * 100 / n <= 100 - o.redline + 1e-9 : i * 100 / n >= o.redline - 1e-9;
    return danger ? "danger" : "off";
  });
}
// Where the time tick goes: how much of the window has passed (or is left, for "Left").
function marker(f, w, state) {
  const e = state === "fresh" ? elapsed(w, f.now) : null;
  return e === null ? null : f.o.metric === "left" ? 1 - e : e;
}
export function fill(f, w, state) { return state === "fresh" ? colorFor(w.percentUsed, f.o, f.t) : f.t.muted; }
export function value(f, w, state) {
  if (state !== "fresh" && state !== "stale") return "—";
  return `${state === "stale" ? "~" : ""}${Math.round(reading(w, f.o))}%`;
}

// What the meter and its time tick mean for this limit, in words.
export function timeNote(f, w, state) {
  const now = f.now, lines = [];
  if (state !== "fresh") lines.push(({ stale: "Last reading; may be out of date", reset: "Reset passed; awaiting a new reading", unknown: "Usage not reported", untrusted: "Unverified reading", share: `Share of ${w.shareOf}` })[state] ?? state);
  else {
    lines.push(`${Math.round(w.percentUsed)}% used · ${Math.round(100 - w.percentUsed)}% left`);
    const e = elapsed(w, now);
    if (e !== null) lines.push(`│ ${Math.round(e * 100)}% of this window has passed`);
    const verdict = PACE_NOTE[pace(w, now)];
    if (verdict) lines.push(verdict);
  }
  lines.push(resetLabel(w, now));
  return lines.join("\n");
}

// ── painting ─────────────────────────────────────────────

// Each run of same-colored cells is one dashed stroke: three path commands however many cells
// it holds. A polygon per cell cost five calls each, and a dashboard full of them ran past
// Herdr's render budget ("could not be re-rendered · interrupted").
const ZONE = .35;
function runs(kinds) {
  const out = [];
  kinds.forEach((kind, i) => { const last = out[out.length - 1]; if (last?.kind === kind) last.end = i + 1; else out.push({ kind, start: i, end: i + 1 }); });
  return out;
}
const layer = (path, [color, alpha]) => window.paint_path(path, alpha === undefined ? color : Background.solid(color).opacity(alpha))
  .absolute().top(0).left(0).size_full();
const painted = (width, height, layers) => div().relative().w(width).h(height).flex_none().children(layers);
const paints = (f, w, state) => ({ off: [f.t.border], danger: [f.t.redline, ZONE], lit: [fill(f, w, state)] });

// A segmented bar; the foreground tick marks how much of the window has elapsed.
export function meter(f, w, p, width, height, cell = 5, gap = 2) {
  const t = f.t, state = limitState(f, w, p), paint = paints(f, w, state), y = height / 2;
  const n = Math.max(4, Math.floor((width + gap) / (cell + gap)));
  const size = (width - gap * (n - 1)) / n, step = size + gap;
  const layers = runs(cells(f, n, w, state)).map(r => layer(PathBuilder.stroke(height)
    .move_to(r.start * step, y).line_to(r.end * step - gap, y).dash_array([size, gap]).build(), paint[r.kind]));
  const m = marker(f, w, state);
  if (m !== null) {
    const x = Math.min(width - 1, Math.max(1, m * width));
    layers.push(layer(PathBuilder.stroke(2).move_to(x, 0).line_to(x, height).build(), [t.foreground, .85]));
  }
  return painted(width, height, layers);
}

// A solid 240° speedometer in 30 segments, clockwise from lower left.
export function arc(f, w, p, size) {
  const t = f.t, state = limitState(f, w, p), paint = paints(f, w, state), n = 30, span = 240 / n, gap = 2.8;
  const c = size / 2, outer = size / 2 - 5, inner = outer - 11, mid = outer - 5.5, height = Math.round(c + outer * .5 + 6);
  const at = (deg, r) => [c + r * Math.cos(deg * Math.PI / 180), c + r * Math.sin(deg * Math.PI / 180)];
  const arcLength = deg => mid * deg * Math.PI / 180;
  const layers = runs(cells(f, n, w, state)).map(r => {
    const a = 150 + span * r.start + gap / 2, b = 150 + span * r.end - gap / 2, [x0, y0] = at(a, mid), [x1, y1] = at(b, mid);
    return layer(PathBuilder.stroke(11).move_to(x0, y0).arc_to(mid, mid, 0, b - a > 180, true, x1, y1)
      .dash_array([arcLength(span - gap), arcLength(gap)]).build(), paint[r.kind]);
  });
  const m = marker(f, w, state);
  if (m !== null) {
    const d = 150 + 240 * m, [x0, y0] = at(d, outer + 4), [x1, y1] = at(d, inner - 3);
    layers.push(layer(PathBuilder.stroke(2).move_to(x0, y0).line_to(x1, y1).build(), [t.foreground, .85]));
  }
  const sub = ({ fresh: f.o.metric, stale: "last reading", reset: "awaiting reset", unknown: "not reported", untrusted: "unverified", share: "share of parent" })[state];
  return painted(size, height, layers).tooltip(timeNote(f, w, state))
    .child(div().absolute().left(0).top(c - 20).w(size).text_center().text_size(24).font_semibold().text_color(fill(f, w, state)).child(value(f, w, state)))
    .child(div().absolute().left(0).top(c + 10).w(size).text_center().text_size(10).text_color(t.muted).child(sub));
}
