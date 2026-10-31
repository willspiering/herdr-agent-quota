---
name: Herdr Agent Quota
description: Terminal-styled native quota instruments that stay quiet during work and reveal detail on demand.
colors:
  healthy-dark: "#80c9ae"
  healthy-light: "#226b50"
  warning-dark: "#e1bc75"
  warning-light: "#79530c"
  redline-dark: "#f48e83"
  redline-light: "#ad302d"
typography:
  headline:
    fontSize: "17px"
    fontWeight: 600
  gauge-value:
    fontSize: "24px"
    fontWeight: 600
  provider-title:
    fontSize: "14px"
    fontWeight: 600
  meter-value:
    fontSize: "13px"
    fontWeight: 600
  body:
    fontSize: "12px"
  label:
    fontSize: "11px"
  caption:
    fontSize: "10px"
rounded:
  cell: "0px"
  chip: "4px"
  control: "5px"
  segmented: "6px"
  switch: "8px"
spacing:
  strip: "14px"
  controls: "8px"
  provider-block: "16px"
  dashboard-inset: "24px"
components:
  button:
    height: "28px (24px small)"
    padding: "0 10px"
  meter-cell:
    width: "5px (strip 3px)"
    height: "10px (strip 8px)"
    gap: "2px (strip 1px)"
  gauge:
    width: "140px"
    segments: 30
  switch:
    width: "30px"
    height: "16px"
---

# Design System: Herdr Agent Quota

## Overview

**Creative North Star: "a btop panel that lives in Herdr"**

Terminal-native instruments: monospace type, `──` section rules, segmented
cell meters and the user's own ANSI palette. The installed Herdr theme remains
the authority for surfaces and text. This record is derived from
`mods/agent-quota/main.js` and `core.js`; native captures are in
`VALIDATION.md`.

**Key characteristics:**
- Every surface uses the terminal font (`settings().font_family`, else JetBrains Mono).
- Usage is drawn as discrete cells, painted natively one path per color.
- Health follows the terminal's green/yellow/red; a dim red zone shows where redline begins.
- Unknown, stale, reset and remote states keep explicit words and a `—`.

## Colors

- **Health (default "Terminal"):** `ansi2` healthy, `ansi3` warning, `ansi1`
  redline. "Classic" uses the frontmatter pairs by appearance; Terminal falls
  back to them when a theme lacks ANSI colors.
- **Thresholds:** warning from 15 points below the redline; redline at or above it.
- **Zone and marks:** unlit cells use `border`; unlit cells inside the redline
  zone use `redline` at 20% opacity; the elapsed-time tick is `foreground` at 85%.
- **Inherited:** `chrome` (strip, segmented track, preview), `popover`
  (dashboard), `selected`/`input` (chosen controls), `hover`, `accent`
  (focus borders, switch on), `muted`/`dim` (metadata), and `working`,
  `blocked`, `done`, `idle` for activity, independent of quota health.

**The Honest Reading Rule.** Only fresh quota gets health color. Stale values
are muted and prefixed `~`; unmeasured values show `—`. Used and Left are the
same measurement, and color always follows usage.

## Typography

Terminal monospace throughout. Title 17 semibold; gauge value 24 semibold;
provider 14 semibold; meter value 13 semibold; body and controls 12; labels,
resets and sessions 11; strip limit names, captions and footer 10.

## Layout

The dashboard is an 850 × 660 native window: header (24 inset, 18 top),
Overview/Settings segmented control with `redline N%`, a 1px rule, the
scrolling body and a one-line footer. Provider sections are 16 vertical
padding with a `glyph name [plan] ───── activity` heading.

Meter rows: label 72, meter `width − 430` (min 60, max 520), value 76,
reset 130, pace 100; below 640 content width the pace column drops. Gauges
wrap at `floor((width + 10) / 166)` columns.

The strip is end-aligned, 12 padding and 14 gaps. Below 320 width each
provider shows one limit, else two, budgeted by style; a `+N` reports the rest.
It lists providers with readable limits or running sessions only.

## Instruments

- **Meter:** `n = floor((width + gap) / (cell + gap))` cells; lit cells =
  `ceil(value / 100 × n)`. With Left, lit cells are remaining headroom and the
  red zone sits at the empty end.
- **Gauge:** 30 quads on a 240° clockwise arc from 150°, outer radius
  `size/2 − 5`, 11 thick, 1.4° gaps; centered value with `used`/`left` or state word.
- **Blocks:** 8 characters, `▕` + `█` lit + `░` unlit + `▏`.

## Components

- **Buttons:** 1px border, `popover` → `hover`; selected uses `selected`/`input`;
  focus border `accent`. All are native `Button`s with stable IDs and Tab/Enter/Space.
- **Segmented control:** `chrome` track, 2 padding; the chosen option is
  `selected` with `input` border and foreground text. Used for page, style,
  metric, layout, palette and redline.
- **Switch row:** the whole row is one target; title, muted hint, and a
  30 × 16 track (`accent` on, `border` off) whose 12px knob slides 120ms.
- **Chip:** 24 tall, an 8px square mark filled with `accent` when shown.
- **Session row:** whole-row button: status mark, status word, `space / tab`,
  `on <machine>` for remote, `go to →`.
- **Callouts:** redline (`▲ Over redline · …`, redline border with 10% tint)
  and collector attention (warning border).
- **Pane header:** glyph, name, folder, status, monospace quota button and
  small Split/Zoom/Close.

## Do's and Don'ts

- **Do** inherit theme, font and ANSI colors at render time.
- **Do** paint instruments with native paths, never one element per cell.
- **Do** keep every choice visible (segmented, switches, chips) with a live preview.
- **Don't** invent percentages, reset times or token counts, or sum quota across spaces.
- **Don't** call `cx.notify()` from `on_size_change`; repaint from a task.
- **Don't** treat the browser preview (painted meters are blank there) as native evidence.
