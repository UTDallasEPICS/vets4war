# Vets4Warriors Staffing: design brief

A single-screen operations console that tells a peer-support phone line how
many people to schedule each hour, and whether a supervisor's planned roster
is enough. This file is self-contained: paste it into Figma AI (or any design
agent) to generate the UI. Everything a designer needs is here: the product,
the people, the data, every component and state, the visual system, and the
copy.

---

## 1. Prompt to paste into Figma AI

> Design a desktop web app (1600 × 1000 frame, plus a 420 px phone frame and
> a dark-mode variant) called **Vets4Warriors Staffing**. It is an operations
> console for supervisors of a veterans' peer-support phone line. The main
> object is a heat grid: one row per date (30 rows), one column per hour
> (24 columns), grouped into three overlapping work tours (Overnight 00:00 to
> 08:30, Day 08:00 to 16:30, Evening 16:00 to 00:30). Each hour cell shows a
> whole number, the people to schedule. After each tour's hour columns there
> is one **Roster** cell where the supervisor can type their planned number.
> Use an Apple "liquid glass" style **only on floating chrome** (top bar,
> control dock, slide-over detail sheet, toast): frosted translucent panels,
> 1 px light borders, top-edge highlight, large radii, pill buttons, over a
> soft static colour field of blue, lavender and mint. The grid itself sits
> on a near-opaque white surface so the numbers stay crisp. Follow the
> components, states, tokens and copy in the rest of this document exactly.

---

## 2. Product

| | |
|---|---|
| Who uses it | Shift supervisors and the operations lead at Vets4Warriors, a 24/7 peer-support line for veterans and service members. Not data scientists. |
| The job | Decide how many peers to put on each tour of each day for the next month, and see straight away whether a planned roster is under, on or over what is needed. |
| Where the numbers come from | A LightGBM model forecasts calls per hour from 5.5 years of real call history. Average handle time comes from recent calls for that weekday and hour. Erlang A queueing maths turns calls + handle time into the people needed so a target share of callers is answered within a target number of seconds, accounting for callers who hang up. |
| Hard constraint | The line can roster **at most 7 people per tour**. Numbers above 7 are shown, never clamped, so the gap is visible. |
| Most important outcome | **Expected hang-ups**: callers who give up before a peer answers. It gets the largest number on the page. |

### Vocabulary (use these words in the UI)

- **People to schedule**: the number in each hour cell.
- **Tour**: Overnight, Day, Evening. Not "shift" in visible copy except where it is unavoidable.
- **Roster**: the number to staff a tour with = the busiest hour inside the tour.
- **Efficiency**: share of a shift a person is free for inbound calls (default 65%).
- **Answered in time / service level**: share of callers answered within the target seconds (default 80% within 30 s).
- **Hang-ups**: callers who give up before a peer answers.
- **The cap**: 7 people.

---

## 3. What changed from the previous version

Removed from the UI (the backend still supports them; the page uses fixed defaults):

- Queue model switch (Erlang A / Erlang C). Always Erlang A.
- Caller patience input and "reset to data". Always the measured value (about 256 s, from 35,413 past hang-ups).
- Handle-time weighting (Equal / Weighted / Recent). Always "weighted" (one-year halflife).
- The "How much to trust these numbers" model-credibility footer.
- The day-total person-hours column at the end of each row.
- In the hour detail: load (erlangs), agents required, staff to schedule (as a row), effective agents, and the "÷ efficiency" step.
- The collapsible control bar (the dock is one compact row now).
- The always-visible docked detail panel and its date picker. It is now a slide-over sheet that opens on click.

Merged:

- **Peak** and **Planned** columns became one **Roster** cell per tour.

Added:

- **Hours** slider: a two-thumb range (00 to 23) that limits which hour columns the grid shows. A tour with no visible hours disappears, roster cell included.
- Click a date to open that day's summary.
- A floating toast that says how many hours changed after a slider move.

Kept (all still present): data-source badge, CSV and image export, date range,
efficiency slider with the 0 to 20% "not actionable" hatch, service-level
slider with the 80 to 85% "current performance" band and 90% industry tick,
answer-time seconds, holiday-effects toggle, holiday-calendar warning, error
banner, window summary with hang-ups largest, the slack sentence ("what one
fewer person costs"), the talk-time caveat, the heat grid with three cap
states, peak-hour markers, the 00/06/12/18 emphasis, weekend/today/holiday
row markers, drag-to-select totals, hour detail, day detail, the legend and
the tour-overlap note, planned values saved in the browser.

---

## 4. Screen anatomy (desktop, 1600 px)

```
┌───────────────────────────────────────────────────────────────────────────┐
│ (pill top bar, glass, sticky)                                              │
│ ▮▮▮ Vets4Warriors Staffing  ● Partner data, Jan 1 2021 to Aug 31 2026      │
│                                              [Export CSV] [Export image]   │
├───────────────────────────────────────────────────────────────────────────┤
│ (control dock, glass, sticky, one row)                                     │
│ Dates [10/17/2026]–[11/15/2026] | Efficiency ━━●── [65]% | Answered ●━┃─ [80]% │
│ within [30] s | Hours ●━━━━━● All day | (◉) Holiday effects                │
├───────────────────────────────────────────────────────────────────────────┤
│ (summary, glass)                                                           │
│ Expected hang-ups    Predicted calls   Expected talk time  Person-hours    │
│ 368  7.2% of calls   5,109             865h 6m             3,495           │
│ ───────────────────────────────────────────────────────────────────────── │
│ Scheduled hours exceed expected talk time by 2,629h 54m (4.0×)… one fewer  │
│ person every hour, hang-ups would rise from 368 to 1,147.                  │
├───────────────────────────────────────────────────────────────────────────┤
│ (grid board, near-opaque surface)                                          │
│          Overnight 00:00 to 08:30        Day 08:00 to 16:30   Evening …    │
│          00 01 02 … 07  Roster           08 … 15  Roster      16 … 23 Roster│
│ Sat Oct 17 [5][5][5]…[4] [ 5 ]           …                                │
│ Today                    Peak · 80%                                        │
│ Sun Oct 18 [7]…          [ 7 ]                                            │
│ …30 rows                                                                   │
│ legend: ▭▭ under (4 to 5) · ▢ at the cap · ■ over the cap · ▢ yours · ● holiday│
│ tour-overlap note · talk-time caveat                                       │
└───────────────────────────────────────────────────────────────────────────┘
                                   ┌──────────────── slide-over sheet ─────┐
                                   │ Sun, Oct 18, 16:00               (×) │
                                   │ 5  people to schedule                 │
                                   │ ┌───────────────────────────────────┐ │
                                   │ │ Predicted calls              8.6  │ │
                                   │ │ Handle time                  10m  │ │
                                   │ │ Expected talk time        1h 22m  │ │
                                   │ │ Answered in time           86.9%  │ │
                                   │ │ Hang-ups                    6.9%  │ │
                                   │ └───────────────────────────────────┘ │
                                   │ (See the whole day)                   │
                                   └───────────────────────────────────────┘
```

When the sheet is open on a wide screen, the page content shifts left by the
sheet's width so nothing is covered. Under 1180 px the sheet becomes a
bottom sheet (full width, up to 72% of the height).

Phone (420 px): the top bar wraps into a rounded card, the dock stacks its
controls and stops being sticky, the summary stacks to one column, and the
grid scrolls sideways with the date column pinned.

---

## 5. Components

### 5.1 Top bar (glass, pill, sticky 12 px from the top)

- **Mark**: three rising rounded bars in the accent colour (a small bar chart), then "Vets4Warriors" (semibold) and "Staffing" (muted).
- **Data-source badge** (pill, 26 px): dot + text.
  - Partner data: accent-soft background, accent text. "Partner data, Jan 1 2021 to Aug 31 2026".
  - Synthetic or not set: amber-soft background, amber text. "Synthetic data, …" or "Data source not set (V4W_DATA_SOURCE)". Its job is to stop anyone presenting synthetic numbers as real.
- **Export CSV** (glass pill): every hour with all values, planned staff and verdicts.
- **Export image** (primary accent pill, soft blue glow): a PNG redrawn from the numbers, not a screenshot, in the light palette, showing the hours currently shown.

### 5.2 Control dock (glass, radius 28, sticky under the top bar)

Order is left to right, grouped by what triggers a reload:

1. **Dates**: two native date fields, "to" between. Default today to today + 29. Changing them reloads from the server (max 366 days).
2. Thin vertical divider.
3. **Efficiency**: slider 0 to 100 + numeric field + "%". The first 20% of the track is hatched (diagonal stripes) because those values are not actionable. Tooltip explains.
4. **Answered**: slider 80 to 95 + numeric field + "% within" + seconds field + "s". On the track: an amber translucent band from 80 to 85 (where the line performs today) and a thin dark tick at 90 (industry standard). Tooltip explains both.
5. **Hours** (new): two thumbs on one track, 00 to 23; the segment between them is accent. Value label: "All day" or "08:00 to 17:59". Only changes which columns are visible, never the numbers.
6. **Holiday effects**: iOS-style switch, green when on. Off predicts every day as an ordinary weekday. Reloads from the server.

Sliders: 6 px track, 20 px white thumb with a soft shadow that grows slightly while dragging; filled part in accent.

Efficiency, Answered and seconds recompute in the browser instantly (no
loading). Dates and holidays fetch from the server (the summary and grid fade
to 50% while loading).

### 5.3 Toast (glass pill, bottom centre)

After any slider or field change: "37 hours changed" or "No hours changed".
Fades and slides away after 2.5 s. Never shown on first load.

### 5.4 Banners

- Error (red-soft, red text): "The forecast did not load (503: …). Check that the server is running and V4W_DATABASE_URL is set, then change a date to retry."
- Holiday calendar (amber-soft, amber text): "Holiday calendar ends 2026-12-25. Holidays after that date are not reflected in this forecast; load them into the holidays table." Only when the date range runs past the calendar.

### 5.5 Window summary (glass, radius 28)

Four stats in one row, bottom-aligned, then a divider and one sentence.

| Stat | Example | Detail line |
|---|---|---|
| **Expected hang-ups** (lead, 40 px, red) | 368 *7.2% of calls* | Before a peer answers, at the recommended staffing, Oct 17 to Nov 15 |
| Predicted calls (30 px) | 5,109 | 720 hours |
| Expected talk time | 865h 6m | Average call 10.2 min |
| Person-hours to schedule | 3,495 | Every hour, added up |

Sentence below (the "slack" story): "Scheduled hours exceed expected talk time
by **2,629h 54m** (4.0×). That gap is the efficiency setting (65% of a shift
on inbound) plus the queue slack needed to answer 80% within 30 s. With one
fewer person every hour, hang-ups would rise from **368** to **1,147**."

At 0% efficiency the numbers are undefined: show "-" and "Undefined at 0% efficiency".

### 5.6 The grid (the main object)

Surface: near-opaque white (86%), radius 28, no blur behind numbers.
Cells are separate rounded tiles (radius 7) with 3 px gaps, 36 × 44 px.

**Header, two sticky rows**
- Row 1: tour name (semibold) + span ("00:00 to 08:30", muted), spanning that tour's columns.
- Row 2: hour labels "00" to "23", 11 px muted. 00, 06, 12 and 18 are darker and semibold (quarter-day anchors). The four busiest hours in the window are accent-coloured with a small accent dot under them. Then "Roster".

**Date column** (sticky left, 116 px). Each date is a button:
- "Sat" semibold + "Oct 17" regular; a second line for "Today" or the holiday name.
- Weekend rows: faint tint. Today: accent text. Holiday: small accent dot in the corner. Picked day (its sheet is open): accent-soft fill + 3 px accent bar on the left.
- Clicking it opens the day sheet.

**Hour cell, the three cap states.** This distinction is the most important visual rule in the product. Each state must be readable without colour as well.

| State | When | Look |
|---|---|---|
| Under the cap | 0 to 6 people | Blue fill whose strength steps up one shade per person across the range on screen (e.g. 4 = pale, 5 = mid blue). Discrete steps, never a smooth gradient. Dark numeral. |
| At the cap | exactly 7 | Amber-soft fill, 2 px amber inner ring, amber numeral. Means "no headroom". |
| Over the cap | 8+ | Solid red fill, white numeral, a small white corner wedge (top right), and a tiny second line "71% at 7" = the service level you would get if only 7 could be staffed. The number itself is never reduced to 7. |
| Undefined | efficiency 0 | "-" in muted text. |
| Implausible | > 50 people | Numeral with a dotted underline. |

Interaction: hover lifts the tile (scale 1.08 + shadow). Click opens the hour
sheet and outlines the tile in accent. Click and drag across tiles selects a
rectangle (accent outline on each) and opens the selection sheet. Keyboard:
tiles are focusable; Enter or Space opens the sheet; Esc closes it.

**Roster cell** (one per tour per day, 84 × 44, light grey tile with hairline ring).
This merges the old "peak" and "planned" columns:

- Big number (15 px semibold) = an editable field.
  - Empty field shows the recommendation as its placeholder, coloured by cap state (dark / amber / red).
  - Typing a number makes it **your** plan: the tile gets a 1.5 px accent ring.
- Line under it (10 px):
  - Following the recommendation: "Peak · 92%" (muted) = the weakest hour's answered-in-time at that number.
  - Your own number: the verdict + difference, coloured: "On target" (green), "Under -1" (red), "Over +2" (amber), "Exceeds cap" (red, bold, when you type more than 7).
- Tooltip with the full sentence: "understaffed: 4 planned vs 5 recommended. 2 on inbound after efficiency; the weakest hour answers 61.2% in time and loses 14.0% of callers."
- Plans are saved in the browser and survive reloads.

**Legend** (under the grid, 12 px): swatches for "Under the cap, one shade per
person (4 to 5)", "At the cap of 7", "Over the cap; small line is service
level with only 7", "Your planned number", "Holiday". Then the tour-overlap
note and the talk-time caveat in muted 12 px text.

### 5.7 Detail sheet (glass, slides in from the right, 380 px, radius 28)

Header: title + round close button (×). Esc closes. Three views:

**Hour view** (click an hour tile). Title "Sun, Oct 18, 16:00".
- Chips when relevant: "Over the cap" (red), "At the cap" (amber), holiday name (accent-soft).
- Hero number: "5" at 56 px + "people to schedule" (red or amber when over or at the cap).
- Grouped list (inset rounded card, hairline separators), label left, value right, explanation under it:
  - Predicted calls: 8.6, "Forecast for this hour"
  - Handle time: 10m, "Average for this weekday and hour, recent calls weighted more"
  - Expected talk time: 1h 22m, "8.6 calls × 10m"
  - Answered in time: 86.9%, "Target 80% within 30 s"
  - Hang-ups: 6.9%, "Callers who give up before a peer answers"
  - Over the cap only: "With only 7 people": 71.0% (red), "Answered in time if you can't staff above the cap"
- Button: "See the whole day".

**Day view** (click a date, or "See the whole day"). Title "Saturday, October 17".
- 2 × 2 tiles: Predicted calls 177 · Busiest hour 00:00 · Peak staff 5 · Expected hang-ups 13.
- Tour table: Tour | Need | Planned (with "following" under it when not your own) | Verdict (coloured) with "80% in time" under it.
- List: At the cap: "21:00, 22:00" or "None". Over the cap: hours or "None" (red when any).

**Selection view** (drag across tiles). Title "Selection".
- "3 days, 08:00 to 11:59, 12 hours".
- Tiles: Person-hours, Peak staff, Predicted calls, Expected hang-ups.
- Button: "Clear selection".

---

## 6. Visual system

### 6.1 Direction

Calm, precise, Apple-native. Glass is used only where something floats above
the work (top bar, dock, sheet, toast). The work surface (grid) is
near-opaque so 720 numbers stay legible. One accent colour. Semantic colours
(amber, red, green) mean exactly one thing each and never decorate.

Deliberately **not** used from the generic liquid-glass landing-page recipe:
no hero, testimonials or pricing (this is a tool, not a marketing page); no
fade-up-on-scroll; no drifting blobs (they force the blur to repaint on every
frame and distract from the data); no glass behind the grid.

### 6.2 Colour tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| field | #EEF2FB | #0B1020 | page background |
| blob A / B / C | #7AA7FF / #B9A6FF / #A8F0E0 | #1E3A8A / #4C1D95 / #134E4A | three static blurred blobs (blur 90, 55% opacity) |
| ink | #0F172A | #E2E8F0 | headings, numbers |
| ink-2 | #475569 | #A3B0C4 | body, labels |
| ink-3 | #64748B | #8391A7 | hints, captions |
| accent | #3B82F6 | #60A5FA | primary button, slider fill, focus, selection, peaks |
| accent-ink | #1D4ED8 | #93C5FD | accent text on light surfaces |
| accent-soft | rgba(59,130,246,.14) | rgba(96,165,250,.16) | badges, hover, picked row |
| glass | rgba(255,255,255,.55) | rgba(20,28,52,.55) | floating chrome |
| glass-strong | rgba(255,255,255,.86) | rgba(17,24,45,.90) | grid surface, inset lists |
| glass-edge | rgba(255,255,255,.70) | rgba(255,255,255,.12) | 1 px borders |
| heat-lo → heat-hi | #F3F6FD → #3B82F6 at 55% max | #172036 → #3B82F6 at 70% max | under-cap steps |
| amber / amber-ink / amber-soft | #F59E0B / #B45309 / #FEF3C7 | #FBBF24 / #FBBF24 / rgba(251,191,36,.14) | at the cap, overstaffed, warnings |
| red / red-ink / red-soft | #DC2626 / #B91C1C / #FEE2E2 | #DC2626 / #F87171 / rgba(248,113,113,.14) | over the cap, hang-ups, understaffed, errors |
| green-ink / green-soft | #047857 / #D1FAE5 | #34D399 / rgba(52,211,153,.14) | on target |
| switch on | #34C759 | #34C759 | iOS green |

Glass recipe: `backdrop-filter: blur(20px) saturate(180%)`, 1 px glass-edge
border, inset 0 1px 0 highlight, a diagonal shine gradient (white 45% → 0 at
42%), and a three-layer soft shadow (0 1 2, 0 8 24 -8, 0 24 48 -24 in navy at
6 to 18%).

### 6.3 Type

SF Pro (Text / Display) on Apple devices, Inter everywhere else, system-ui
fallback. Tabular numerals everywhere. Sentence case everywhere: no all-caps
labels, no tracked-out eyebrows.

| Role | Size / weight |
|---|---|
| Sheet hero number | 56 / 600, -3% tracking |
| Summary lead (hang-ups) | 40 / 600 |
| Summary stats | 30 / 600 |
| Tile values | 24 / 600 |
| Sheet title | 17 / 600 |
| Body, controls | 13 to 14 / 400 to 500 |
| Grid numerals | 14 / 600 |
| Hour labels, captions | 11 to 12 / 400 to 500 |
| Verdict line | 10 / 500 |

### 6.4 Shape, space, motion

- Radii: 28 for panels and sheet, 20 for inset cards, 12 for fields, 7 for grid tiles, pill (999) for buttons, badges, chips and the top bar.
- Spacing: 4 px base (4, 8, 12, 16, 24, 32, 48). Page gutter max(16 px, 2vw).
- Motion: 180 ms ease-out curve cubic-bezier(.2,.8,.2,1). Sheet slides 260 ms. Buttons press to 97%. Tile hover scale 1.08. Toast fades and rises. All motion off under prefers-reduced-motion.
- Focus: 2 px accent outline, 2 px offset, on every interactive element.

---

## 7. Data the UI shows (per hour, from the API)

`date, hour, predicted_calls, aht_sec (handle time), staff_to_schedule,
service_level_delivered, abandon_share (hang-ups), cap_state
(under/at/over/undef), service_level_if_capped`, plus per day: `is_weekend,
holiday`, and per tour: `staff_needed (roster), planned, verdict, delta,
service_level at planned`. Window: `expected_calls, expected_talk,
expected_abandoned_calls, expected_abandoned_one_fewer, caveat`. Source:
`kind, label, start, end`.

Realistic sample values for mock-ups: hours mostly 4 or 5 people, the 00:00
hour and 21:00 to 22:00 often at 7, about 177 calls a day, handle time about
10 minutes, about 7% hang-ups.

---

## 8. References

- **Apple Liquid Glass (iOS / macOS 26)**: floating glass chrome over content, pill controls, iOS switch, grouped inset lists in the sheet.
- **Assembled, Calabrio, NICE CXone WFM, Playvox**: workforce-management grids by interval, required vs scheduled comparisons, over/under colouring.
- **Google Calendar / GitHub contributions**: discrete-step heat tiles with gaps.
- **Linear**: quiet density, one accent, keyboard-first detail sheets.

---

## 9. Frames to produce in Figma

1. Desktop light, sheet closed (default state above).
2. Desktop light, hour sheet open on an over-the-cap hour.
3. Desktop light, day sheet open with one tour planned by the user (understaffed).
4. Desktop light, drag selection with selection sheet.
5. Desktop light, Hours slider at 08 to 17 (only Day + part of Evening visible).
6. Desktop dark, sheet closed.
7. Phone light, stacked layout, bottom sheet open.
8. Component sheet: cap-state tiles (under steps 0 to 6, at, over, undefined, implausible), roster cell (following / on target / under / over / exceeds cap), badge variants, sliders (efficiency hatch, service-level band + tick, dual hours), switch, pills, toast, banners.
