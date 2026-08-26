---
name: od-deck-framework
description: |
  Fixed slide-deck HTML framework (1920×1080 canvas, scale-to-fit, keyboard
  nav, print-to-PDF) plus density, chart, and diagram discipline. Use for ANY
  deck / slides / pitch / 幻灯片 / PPT-style HTML output: copy the canonical
  skeleton verbatim and fill content slots only — never rewrite the nav,
  scaling, or print machinery.
whenToUse: |
  The user asks for a slide deck, pitch deck, presentation, slideshow, or
  multi-slide HTML artifact (deck, slides, 幻灯片, 演示文稿, PPT). Also load
  when an existing deck needs new slides or content edits.
---

# Slide deck — fixed framework

Decks regress when each turn re-authors the scale-to-fit logic, the keyboard
handler, the slide visibility toggle, the counter, and the print rules. This
skill ships a **fixed framework**: 1920×1080 canvas, scale-to-fit, hidden
programmatic prev/next + counter, capture-phase keyboard with R
reset-to-first-slide, half-slide click navigation, localStorage position
restore, and a print stylesheet that emits a multi-page vertical PDF on
browser Print / Save-as-PDF — all baked in.

**You do not write any of that. You do not modify any of that.** Your job is
to fill content slots only.

## Workflow — copy framework first, then fill content

1. Bind the chosen direction's palette + fonts to `:root` in the framework.
2. Copy `references/skeleton.html` verbatim into a semantically named deck
   file, such as `investor-pitch-deck.html` (not `index.html` unless the user
   is editing an existing `index.html` deck).
3. Plan the slide arc and theme rhythm (state it aloud before writing).
4. Add per-deck classes inside the second `<style>` block.
5. Replace each `<section class="slide">` SLOT with real content.
6. Self-check (no rewriting framework chrome / `@media print` / nav script).
7. Summarize the written or changed deck file in a short ordinary reply.

If you find yourself writing `<style>` rules for `.deck-shell`, `.deck-stage`,
`.slide`, `fit()`, `@media print`, or a keyboard handler — STOP. The framework
already has them.

## The contract

You may edit only inside slots marked `SLOT:`:

- `SLOT: deck title` — the `<title>` element.
- `SLOT: theme tokens` — the `:root` CSS custom properties (`--bg`, `--fg`,
  `--accent`, `--shell`, …). Add new tokens here if needed.
- `SLOT: per-deck styles` — the second `<style>` block. Define classes used by
  your slide content (`.title`, `.big-stat`, `.grid-3`, custom typography).
  **Never redefine** `.deck-shell`, `.deck-stage`, `.slide`, `.deck-counter`,
  `.deck-hint`, or anything inside `@media print`.
- `SLOT: slides` — the `<section class="slide">` blocks. Add as many as the
  brief calls for. The first slide MUST be
  `<section class="slide active" …>`; the rest are `<section class="slide" …>`
  (no `active`). The script auto-counts them.
- `SLOT: slide N content` — content inside each `<section>`.

Each `<section class="slide" data-screen-label="NN Title">` is one slide on
the 1920×1080 canvas. Slide labels are 1-indexed (`01 Title`, `02 Problem`…).

## Common drift modes — DO NOT DO THESE

- ❌ Don't write your own `fit()` or `transform: scale()` script.
- ❌ Don't use `transform-origin: center center` on the stage — the framework
  uses `top left` plus an explicit translate.
- ❌ Don't replace `document.addEventListener('keydown', …)` with a single
  listener — the framework listens on **both** window and document in capture
  phase so iframe focus quirks can't swallow arrow keys.
- ❌ Don't replace the localStorage key, the `.slide.active` toggle, or the
  element IDs (`#deck-cur`, `#deck-total`, `#deck-prev`, `#deck-next`).
- ❌ Don't put the prev/next buttons or counter **inside** `.deck-stage` —
  they live outside the scaled element.
- ❌ Don't redefine `.slide`, `.slide.active`, or `.slide:not(.active)`. For a
  non-flex layout on one slide, add a variant class to the same `<section>`
  (e.g. `.s-cold`) and declare `display: grid` / `display: block` on the
  variant; the active default is wrapped in `:where(...)` so the variant wins.
- ❌ Don't strip or "tidy" the `@media print` block — it is how Print → Save
  as PDF stitches every slide into a multi-page document.

If the user asks for something the framework genuinely doesn't support
(vertical decks, custom transitions, simultaneous multi-column slides), say so
and ask before forking. **Default answer: keep the framework, change the slide
content.**

## Density and overflow discipline (the #1 cause of ugly decks)

- ❌ Title slides with a display headline ≥ 160px **plus** multi-line subtitle
  **plus** an absolutely-positioned `.footer` — flow content and the footer
  collide in the bottom ~100px.
- ❌ Stat slides with three numbers + three captions + a footer — split into
  three stat slides; more slides cost nothing.
- ❌ "Magazine spreads" packing masthead + display headline + body grid +
  sidebar + absolute footer into one 1080px slide.

Rules — non-negotiable:

1. **Display headlines on cover/title slides: max ~140px font-size, max 8
   words, max 3 lines.** If it doesn't fit, split the slide — don't shrink the
   font and pack more in.
2. **Reserve a footer safe-zone.** With `.footer { position: absolute; bottom:
   Npx; }`, flow content must stop at least 80px before `1080 − footer_height
   − N`. Easiest enforcement: give the main content area its own
   `max-height: 760px`.
3. **Body slides: ≤ 3 paragraphs, ≤ 56ch lead width, ≤ 12 words per line.**
4. **One idea per slide.** Two ideas = two slides.

## Data chart discipline (hand-written bar charts)

Hand-written div/CSS charts "lie" when bar lengths are eyeballed magic numbers
or value labels get clipped. Build from this skeleton:

```html
<div class="chart" style="--max: 5.0">
  <div class="bar-row">
    <span class="bar-label">2024</span>
    <div class="bar-track"><div class="bar" style="--v: 5.0"></div></div>
    <span class="bar-value">5.0 万亿</span>
  </div>
  <!-- one .bar-row per data point; put the REAL numeric value in --v -->
</div>
```

```css
.bar { width: calc(var(--v) / var(--max) * 100%); }
```

1. **Bar lengths are computed, never eyeballed.** Every bar carries its value
   as inline `--v`; declare `--max` ONCE per chart so all bars share one
   baseline. `--v` / `--max` must be unitless numbers; units ("万亿", "%", "$")
   live only in the `.bar-value` text. Vertical variant:
   `.bar { height: calc(var(--v) / var(--max) * 100%); }` with an explicit
   height on `.bar-track` (a percentage height inside an auto-height parent
   collapses to 0).
2. **Every data point gets a visible category label AND value label**, the
   value rendered outside the bar, never inside a clipping `overflow: hidden`
   bar.
3. One `--max` per chart; never imply different baselines in one chart.

## Nested / concentric diagram discipline

Nested shapes may share a center; their text blocks may not.

- At most one short KPI in the shared center; never a label/value/description
  stack inside two or more concentric layers.
- Every other label goes in a separate legend, external callout, or visibly
  reserved non-overlapping region; otherwise use a stacked comparison, flow,
  or table instead.

## Mermaid diagram theme discipline (dark decks)

Mermaid's default theme is built for white pages; embedded in a dark deck it
produces unreadable dark-on-dark labels. Prefer a hand-written HTML/CSS/SVG
diagram styled with the deck's own tokens. When you do embed Mermaid, theme it
from the slide background at initialize time — never leave the default on a
dark deck, and pass literal colors (`themeVariables` cannot resolve CSS
`var()`):

```js
mermaid.initialize({
  startOnLoad: true,
  theme: 'base',
  themeVariables: {
    darkMode: true,            // match the slide background
    background: '#101014',     // the deck's --bg value, as a literal
    primaryColor: '#1c1c24',   // node fill — dark surface, not the cream default
    primaryTextColor: '#e8e8ec',
    primaryBorderColor: '#8a8a94',
    lineColor: '#8a8a94',
  },
});
```

`darkMode: true` alone does NOT darken node fills — always set `primaryColor`
to a dark surface tone alongside light text. Give the diagram container an
explicit light plate if you cannot theme it.

## Pre-handoff self-check

For every `<section class="slide">`, mentally render at 1920×1080:

- [ ] Content fits without clipping or overflowing the bottom?
- [ ] Absolute footer/header: does flow content stop before its reserved band?
- [ ] Display headline ≤ 140px and ≤ 8 words?
- [ ] ≤ one big idea per slide?
- [ ] Charts: every data point labeled, bar lengths computed from `--v`/`--max`?
- [ ] Mermaid: themed to the slide background, no dark-on-dark labels?

If any answer is "no", redesign the slide BEFORE handoff.

## Canonical skeleton

`references/skeleton.html` is exactly what the file you write looks like.
When the brief is "make me a deck", your output is that skeleton with theme
tokens tuned, per-deck classes added, and slide sections filled in — nothing
more, nothing less. Skill-specific guidance (typography, theme presets,
layout vocabulary) layers *on top of* this framework, not in place of it.
