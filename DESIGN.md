---
name: Herdr Agent Quota
description: Native Herdr quota instruments that stay quiet during work and reveal detail on demand.
colors:
  healthy-dark: "#80c9ae"
  healthy-light: "#226b50"
  warning-dark: "#e1bc75"
  warning-light: "#79530c"
  redline-dark: "#f48e83"
  redline-light: "#ad302d"
typography:
  display:
    fontSize: "30px"
    fontWeight: 600
  headline:
    fontSize: "23px"
    fontWeight: 600
  provider-title:
    fontSize: "17px"
    fontWeight: 600
  section-title:
    fontSize: "14px"
    fontWeight: 500
  limit-title:
    fontSize: "13px"
    fontWeight: 500
  body:
    fontSize: "12px"
  label:
    fontSize: "11px"
  caption:
    fontSize: "10px"
rounded:
  instrument: "2px"
  status-dot: "3px"
  control: "5px"
spacing:
  compact: "5px"
  controls: "8px"
  strip: "12px"
  section: "14px"
  provider-block: "20px"
  dashboard-inset: "24px"
components:
  button:
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    height: "30px"
    padding: "0 10px"
  gauge:
    width: "176px"
  gauge-face:
    width: "170px"
    height: "130px"
  quota-bar:
    width: "28px"
    height: "5px"
    rounded: "{rounded.instrument}"
  provider-section:
    padding: "20px 0"
---

# Design System: Herdr Agent Quota

## Overview

**Creative North Star: "Herdr's quota instrument panel"**

The installed Herdr theme is the visual authority. This native GPUI mod follows the compact status-bar-to-dashboard workflow of Lakris2407/herdr-quota, with graphical instruments for quota pressure. It adds health colors and gauge geometry without introducing a separate web identity.

The strip is dense and quiet; the dashboard provides provider limits and session activity in a scrollable native window. Account quota and session activity remain visually distinct. This record comes from `mods/agent-quota/main.js` and `core.js`, with product constraints from `PRODUCT.md`. A subsequent dark-theme native spot check is recorded in `VALIDATION.md`; broader native verification remains open.

**Key Characteristics:**
- Native theme inheritance for surfaces, text, focus and agent activity.
- A compact strip opens a detailed quota dashboard.
- A clockwise 240° gauge makes remaining headroom visible.
- Unknown, stale and remote information retain explicit labels.

## Colors

Herdr supplies the neutral surfaces and interaction accent; the mod supplies paired dark/light health colors in the frontmatter.

The sidecar's tonal ramps are synthesized panel swatches, unused by the native mod. Its five component samples translate native source geometry to HTML/SVG with the preview script's sample dark palette; they are reference illustrations, not a browser implementation contract or verified native output.

### Primary
- **Herdr interaction accent:** inherited `theme().accent`; keyboard focus borders use this role. Its value depends on the installed theme and is deliberately not frozen as a primitive here.

### Secondary
- **Healthy mint / forest:** `healthy-dark` and `healthy-light`; fresh measurements below the warning range.
- **Warning sand / ochre:** `warning-dark` and `warning-light`; fresh measurements from 15 percentage points below the configured redline up to the redline. Also used for collector attention.
- **Redline coral / brick:** `redline-dark` and `redline-light`; fresh measurements at or above the threshold, threshold markers, unused danger ticks and redline summaries.

### Neutral
- **Foreground and muted:** inherited `foreground` and `muted`; primary labels versus metadata, unknown measurements and stale readings.
- **Chrome and background:** inherited `chrome` for the status strip; `background` for the optional pane header.
- **Popover:** inherited `popover`; dashboard and ordinary button backgrounds.
- **Border and input:** inherited `border` for separators, instrument tracks and ordinary control borders; `input` for selected control borders.
- **Selected and hover:** inherited `selected` for selected/focused controls and focused strip; `hover` for button hover.
- **Activity:** inherited `working`, `blocked`, `done` and `idle`; session dots and status labels. Activity color is separate from the mod's quota health calculation.

**The Theme Inheritance Rule.** Resolve native surface, text, interaction and activity roles from Herdr on render. The fixed colors in `scripts/preview.mjs` are sample preview values, not the installed theme or native design tokens.

## Typography

**Font:** inherited from Herdr. The native mod does not specify a family, fallback stack, letter spacing or line height; the browser preview's system stack is not a native font contract.

### Hierarchy
- **Display:** gauge percentage, semibold.
- **Headline:** dashboard title, semibold.
- **Provider title:** provider name and Configure's Display heading, semibold.
- **Section title:** configuration groups and attention headings, medium.
- **Limit title:** gauge window name, medium.
- **Body:** buttons, supporting explanations and redline summary.
- **Label:** reset/pace details, session rows, activity counts, footer and strip values.
- **Caption:** strip window names, gauge endpoint labels and state subtitles.

The frontmatter records the corresponding sizes. The no-provider dashboard message additionally uses a regular 19px title. Names and metadata truncate where source constraints require it; tooltips preserve longer limit names, accounts and reset timestamps.

## Layout

The dashboard opens at 850 × 660 native layout units. Header, tab row and footer do not flex; the central body scrolls vertically with a minimum height of zero. Horizontal dashboard insets follow `dashboard-inset`; header vertical padding is 18, tab bottom padding is 14, and footer vertical padding is 12. Provider sections use the recorded vertical padding and section gap, separated by 1-unit theme-colored rules. They are sections rather than individually boxed cards.

Gauge rows use `max(1, floor((width - 90) / 184))` columns, with 8-unit gaps. Each gauge reserves its recorded width; face labels are capped at 172. Configuration groups wrap their controls with the same control gap. This is native width-responsive layout; there are no CSS media breakpoints in the shipped mod.

The strip measures its available width. Below 300 units it allows one visible limit per provider; otherwise up to two. Provider content is budgeted against `width - 50`; a `+N` suffix reports omitted providers. Labels have bounded widths and truncate. The strip uses 12-unit horizontal padding and gaps and aligns content to the end. It does not define its own height.

By default, focused agents sort before working, blocked, other open and inactive agents. Within that ordering, the provider preference is Codex, Claude, Grok. Configure can disable activity ordering or hide providers and individual limits.

## Elevation & Depth

The mod defines no shadows, gradients, blur or lift animations. Theme surfaces, selected fills, 1-unit borders and separators establish hierarchy. The native overlay window's outer chrome and any host elevation belong to Herdr, not this mod. The preview frame's rounded outer shell is only a browser presentation aid.

## Shapes

Controls have compact rounded corners; instrument dots and bars use the smaller recorded radii. Session dots are 5 units square, while the redline summary dot is 6. Provider glyphs use shipped Herdr agent assets at 12 units in the strip, 20 in provider headings and 13 in pane headers; the fallback is a provider initial. The browser preview's substitute glyph characters are not the native icon system.

The signature gauge is a dotted 240° clockwise arc, from 150° to 390°, with 41 marks. Marks lie at radius 64 around `(82, 78)` in the face. Every fifth mark is 5 units square; other marks are 3. A centered percentage and state subtitle sit inside the arc; endpoints read 0 and 100.

## Components

### Buttons and toggles

Compact native buttons share the frontmatter geometry, a 1-unit border, a 6-unit internal gap and foreground text. Ordinary buttons use popover/border; selected buttons use selected/input. Hover changes the fill to hover. Focus changes border/fill to accent/selected. Herdr's native `Button` retains focus and keyboard activation by stable component ID; view-owned focus handles are created only in `init()`. Buttons support Tab, Enter and Space. Toggles express their state in text as `On · …` or `Off · …`, in addition to selected styling. The same primitive supplies dashboard tabs, refresh, configuration choices, session navigation and pane controls.

### Status strip and quota bars

The entire strip is a focusable button that opens the dashboard on click, right mouse down, Enter or Space. It uses chrome/border at rest and selected/accent on focus. Each small bar has a border-colored track, a health-colored fresh fill or muted stale fill, a redline tick at 60% opacity and, when available and fresh, a foreground elapsed-time tick. The markers extend 2 units above the bar and have height 9. Stale percentages carry a `~`; unmeasured states display a dash.

### Quota gauge

Fresh measurements color the used arc and center value by health. Unused marks at or beyond the threshold stay redline-colored at 50% opacity; earlier unused marks use border. Stale values are muted and labeled `last reading`, with a refresh prompt. Unknown, unverified, reset-passed and share-of-parent states use a dash with an explicit subtitle. The window name, reset label and pace detail sit below the face.

**The Honest Reading Rule.** Only fresh account quota contributes to redline alerts. Unknown usage is never rendered as a measured zero; stale usage never carries fresh health color.

### Provider sections and sessions

Each provider section has a glyph/name/plan header and a right-aligned running count, followed by account/status metadata, wrapped gauge rows and session activity. Unavailable limits get a plain explanatory state. Session rows have a small activity dot, a truncated space/tab label and a `Go to agent` button. Remote activity is explicitly labeled `Remote · quota not linked`; multiple account lanes retain an account label and do not assign sessions to an inferred account.

### Dashboard shell and configuration

The header pairs the title and data age with Refresh and optional Close buttons. Overview/Configure are selected-state buttons, with the current redline text aligned at the other end. Redline and collector-attention messages appear in the body; the footer explains account sharing and provider-reported measurements. Configuration reuses toggles and buttons rather than adding inputs or custom switches. The default redline is 70%; supported selections are 60, 70, 80 and 90% used.

### Optional pane header

The native background/bottom border frame a provider glyph, name, truncated working directory, status and quota button alongside Split, Zoom/Restore and Close. Quota opens the provider dashboard; the surrounding header focuses its pane. A remote or ambiguous-account quota button states that condition rather than claiming a local session measurement.

## Do's and Don'ts

### Do:
- **Do** inherit Herdr's theme and font at render time.
- **Do** keep the strip compact and reveal detailed gauges in the dashboard.
- **Do** preserve the 240° gauge geometry and configurable redline, defaulting to 70% used.
- **Do** accompany color with percentages, status words and explicit unknown/stale labels.
- **Do** keep provider account quota separate from session and remote activity.
- **Do** preserve focus borders and keyboard activation on native controls.

### Don't:
- **Don't** promote the browser preview palette, system font, frame or substitute glyphs into native tokens.
- **Don't** invent percentages, reset times, quota windows or token counts.
- **Don't** sum account quota across spaces or infer a session's account from its provider.
- **Don't** describe source extraction or synthetic browser approximations as native visual verification.
