# First working frontend (backup)

The staffing console frontend as it was on `forecast-mvp` at commit `6dc9fbd`
("feat: operations console rebuild of the staffing forecast page"), before the
liquid-glass redesign. It ran against the same backend with no changes.

## How to bring it back

Easiest, from the repo root (git still has it):

```
git checkout 6dc9fbd -- web/index.html web/app.js web/logic.js web/erlang.js
```

Without git: copy each code block below into the file named in its heading
(under `web/`), then restart `make serve` and reload the page.

Controls this version had that the redesign removed: queue model (Erlang A / C),
caller patience with reset to data, handle-time weighting (equal / weighted /
recent), separate peak and planned columns, the day-total person-hours column,
the always-docked detail panel with a date picker, the full hour trace (load,
agents required, ÷ efficiency, effective agents), the collapsible control bar,
and the "How much to trust these numbers" model footer.

## web/index.html

````html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vets4Warriors Staffing Forecast</title>
<style>
  /* ---- tokens: Vercel-inspired, light by default, dark via prefers-color-scheme.
     Operations console: one accent, monospace numerals, no decoration. ---- */
  :root {
    color-scheme: light;
    --bg: #FAFAFA; --surface: #FFFFFF; --surface-2: #F5F5F5;
    --border: #EBEBEB; --border-strong: #A1A1A1;
    --text: #171717; --text-2: #4D4D4D; --text-3: #888888;
    --accent: #0070F3; --accent-ring: rgba(0, 112, 243, 0.28); --highlight: #D3E5FF;
    --weekend: #F5F5F5; --track: #EBEBEB; --caution: #A1A1A1;
    --heat-lo: #F5F8FD; --heat-hi: #0070F3; --heat-max-mix: 74%;
    --amber: #F5A623; --amber-text: #AB570A; --amber-bg: #FFEFCF;
    --red: #C50000; --red-soft: #EE0000; --red-bg: #F7D4D6;
    --green-text: #0A7A3B; --green-bg: #DDF5E6;
    --shadow: 0 0 0 1px rgba(0,0,0,0.08), 0 1px 1px rgba(0,0,0,0.02), 0 2px 2px rgba(0,0,0,0.04);
    --shadow-float: 0 0 0 1px rgba(0,0,0,0.08), 0 2px 2px rgba(0,0,0,0.04), 0 8px 16px -4px rgba(0,0,0,0.06);
    --pin-shadow: rgba(0,0,0,0.12);
    --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-6: 24px; --sp-8: 32px;
    --r: 6px;
    --font: Inter, "Geist", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --ease: cubic-bezier(0.16, 1, 0.3, 1); --t: 120ms;
    --rail: 340px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --bg: #0A0A0A; --surface: #111111; --surface-2: #171717;
      --border: #262626; --border-strong: #525252;
      --text: #EDEDED; --text-2: #A1A1A1; --text-3: #7A7A7A;
      --accent: #52A8FF; --accent-ring: rgba(82,168,255,0.35); --highlight: #10233F;
      --weekend: #161616; --track: #262626; --caution: #525252;
      --heat-lo: #111111; --heat-hi: #52A8FF; --heat-max-mix: 66%;
      --amber: #F5A623; --amber-text: #F5A623; --amber-bg: #2E2005;
      --red: #B3261E; --red-soft: #FF6166; --red-bg: #3A1113;
      --green-text: #4ADE80; --green-bg: #0F2A1A;
      --shadow: 0 0 0 1px rgba(255,255,255,0.08), 0 1px 1px rgba(0,0,0,0.3), 0 2px 2px rgba(0,0,0,0.3);
      --shadow-float: 0 0 0 1px rgba(255,255,255,0.08), 0 2px 2px rgba(0,0,0,0.3), 0 8px 16px -4px rgba(0,0,0,0.5);
      --pin-shadow: rgba(0,0,0,0.6);
    }
  }
  * { box-sizing: border-box; }
  html, body { background: var(--bg); }
  body { margin: 0; font: 13px/1.45 var(--font); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; color: var(--text); -webkit-font-smoothing: antialiased; }
  [hidden] { display: none !important; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button, input, select { font: inherit; color: inherit; }
  .wrap { max-width: 1800px; margin: 0 auto; padding: 0 var(--sp-4); }
  .card { background: var(--surface); border-radius: var(--r); box-shadow: var(--shadow); }
  .mono { font-family: var(--mono); letter-spacing: 0; }
  small { font-size: 11px; }
  .is-loading .grid-scroll, .is-loading .summary { opacity: 0.55; transition: opacity var(--t) var(--ease) 100ms; }

  /* ---- a. header: one line ---- */
  header.top { background: var(--surface); border-bottom: 1px solid var(--border); }
  .top-row { display: flex; align-items: center; gap: var(--sp-3); height: 44px; }
  .top-row .mark { font-size: 12px; font-weight: 500; color: var(--text-3); }
  .top-row h1 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.3px; }
  .badge { display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border-radius: 999px; font-size: 12px; font-weight: 500; background: var(--highlight); color: var(--accent); white-space: nowrap; }
  .badge.src-synthetic, .badge.src-unlabeled { background: var(--amber-bg); color: var(--amber-text); }
  .spacer { flex: 1; }
  .btn { height: 26px; padding: 0 var(--sp-2); border: 1px solid var(--border); border-radius: var(--r); background: var(--surface); cursor: pointer; font-size: 12px; font-weight: 500; }
  .btn:hover { border-color: var(--border-strong); }
  .btn.link { border: 0; background: none; color: var(--accent); padding: 0; height: auto; font-weight: 500; }

  /* ---- b. control bar: one row, sticky, collapsible ---- */
  .bar { position: sticky; top: 0; z-index: 10; margin-top: var(--sp-3); }
  .bar-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--sp-2) 14px; padding: var(--sp-2) var(--sp-3) var(--sp-3); }
  .bar.collapsed .bar-row { display: none; }
  .bar-summary { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2) var(--sp-4); font-size: 12px; color: var(--text-2); }
  .bar-summary button { margin-left: auto; }
  .ctl { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .ctl-line { display: flex; align-items: center; gap: 6px; height: 28px; white-space: nowrap; }
  .ctl label, .ctl .lbl { font-size: 11px; font-weight: 500; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.06em; }
  .ctl input[type=date], .ctl input[type=number] { height: 26px; padding: 0 6px; border: 1px solid var(--border); border-radius: var(--r); background: var(--surface); font-size: 13px; }
  .ctl input[type=number] { width: 52px; text-align: right; font-family: var(--mono); }
  .ctl input[type=date] { width: 118px; }
  .ctl input:hover { border-color: var(--border-strong); }
  .ctl .unit { font-size: 12px; color: var(--text-3); }
  .ctl .fb { font-size: 11px; color: var(--text-3); min-height: 14px; max-width: 160px; line-height: 1.3; }
  .track { position: relative; width: 140px; height: 24px; }
  .track.caution::before { content: ""; position: absolute; left: 8px; width: calc(20% - 8px); top: 50%; height: 10px; transform: translateY(-50%); border-radius: 3px 0 0 3px; pointer-events: none; background: repeating-linear-gradient(135deg, transparent 0 3px, var(--caution) 3px 4px); opacity: 0.5; }
  .track input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 24px; margin: 0; background: transparent; cursor: pointer; }
  .track input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: linear-gradient(to right, var(--accent) 0 var(--fill, 0%), var(--track) var(--fill, 0%)); }
  .track input[type=range]::-moz-range-track { height: 4px; border-radius: 2px; background: var(--track); }
  .track input[type=range]::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--accent); }
  .track input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: -5px; border-radius: 50%; background: var(--surface); border: 2px solid var(--accent); }
  .track input[type=range]::-moz-range-thumb { width: 12px; height: 12px; border-radius: 50%; background: var(--surface); border: 2px solid var(--accent); }
  .track input[type=range]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--r); }
  /* service-level track annotations: bounds at the ends, the band where the
     line operates today, and the tick for the common industry target */
  .sl-marks { position: relative; height: 34px; width: 140px; font-size: 10px; color: var(--text-3); }
  .sl-marks .bound { position: absolute; top: 0; font-family: var(--mono); }
  .sl-marks .bound.lo { left: 0; } .sl-marks .bound.hi { right: 0; }
  .sl-marks .band { position: absolute; top: 2px; height: 4px; background: var(--amber); opacity: 0.55; border-radius: 2px; text-indent: -9999px; }
  .sl-marks .band::after { content: "current performance"; position: absolute; left: 0; top: 7px; text-indent: 0; white-space: nowrap; color: var(--amber-text); }
  .sl-marks .tick { position: absolute; top: 0; width: 2px; height: 8px; background: var(--text-2); transform: translateX(-1px); text-indent: -9999px; }
  .sl-marks .tick::after { content: "industry standard"; position: absolute; left: -46px; top: 20px; text-indent: 0; white-space: nowrap; color: var(--text-2); }
  .seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--r); overflow: hidden; height: 26px; }
  .seg label { display: inline-flex; align-items: center; gap: 4px; padding: 0 var(--sp-2); cursor: pointer; color: var(--text-2); border-right: 1px solid var(--border); font-size: 12px; text-transform: none; letter-spacing: 0; }
  .seg label:last-child { border-right: 0; }
  .seg input { position: absolute; opacity: 0; width: 0; height: 0; }
  .seg label:has(input:checked) { background: var(--highlight); color: var(--accent); font-weight: 500; }
  .seg label:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: -2px; }
  .check { display: inline-flex; align-items: center; gap: 6px; height: 26px; text-transform: none !important; letter-spacing: 0 !important; font-size: 12px !important; color: var(--text-2) !important; cursor: pointer; }
  .ctl.status { margin-left: auto; align-items: flex-end; min-width: 0; }
  .changed { font-size: 12px; font-weight: 500; color: var(--accent); min-height: 16px; }
  .status { font-size: 11px; color: var(--text-3); }
  .error { margin-top: var(--sp-3); padding: var(--sp-2) var(--sp-4); border-radius: var(--r); background: var(--red-bg); border-left: 3px solid var(--red-soft); font-size: 12px; }
  .note { margin-top: var(--sp-3); padding: var(--sp-2) var(--sp-4); border-radius: var(--r); background: var(--amber-bg); border-left: 3px solid var(--amber); font-size: 12px; }

  /* ---- c + d. grid with the docked panel beside it ---- */
  .work { display: grid; grid-template-columns: minmax(0, 1fr) var(--rail); gap: var(--sp-4); margin-top: var(--sp-3); align-items: start; }
  .grid-card { min-width: 0; }
  .grid-wrap { position: relative; }
  .grid-scroll { overflow: auto; max-height: calc(100vh - 230px); user-select: none; -webkit-user-select: none; border-radius: var(--r) var(--r) 0 0; }
  table.grid { border-collapse: separate; border-spacing: 0; width: max-content; min-width: 100%; }
  .grid th, .grid td { border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  .grid thead th { position: sticky; z-index: 2; background: var(--surface-2); font: 400 11px/1 var(--mono); color: var(--text-3); text-align: center; padding: 0; height: 26px; }
  .grid thead tr:first-child th { top: 0; } .grid thead tr:last-child th { top: 26px; }
  .grid thead th.group { height: 26px; text-align: left; padding: 0 var(--sp-2); font-family: var(--font); font-weight: 600; color: var(--text); border-left: 2px solid var(--border-strong); }
  .grid thead th.group small { font-weight: 400; color: var(--text-3); margin-left: 6px; }
  .grid thead th.hh { width: 34px; min-width: 34px; }
  .grid thead th.hh.major, .grid td.h.major { border-left: 2px solid var(--border-strong); }
  .grid thead th.hh.major { color: var(--text); font-weight: 600; }
  .grid thead th.hh.peak { box-shadow: inset 0 -2px 0 var(--accent); }
  .grid thead th.sub, .grid thead th.total { width: 48px; min-width: 48px; line-height: 1.1; }
  .grid thead th.sub span, .grid thead th.total span { display: block; color: var(--text); font-weight: 600; }
  .grid thead th.plan { width: 84px; min-width: 84px; }
  .grid th.date, .grid td.date { position: sticky; left: 0; z-index: 1; background: var(--surface); text-align: left; padding: 0 var(--sp-3); min-width: 136px; width: 136px; font-family: var(--font); }
  .grid thead th.date { z-index: 3; background: var(--surface-2); }
  .grid td.date .d { font-size: 12px; font-weight: 600; white-space: nowrap; }
  .grid td.date .d .dm { font-weight: 400; color: var(--text-2); margin-left: var(--sp-1); }
  .grid td.date .meta { font-size: 10px; color: var(--text-3); white-space: nowrap; min-height: 12px; overflow: hidden; text-overflow: ellipsis; max-width: 112px; }
  .grid tr.weekend td.date { background: var(--weekend); }
  .grid tr.today td.date .d { color: var(--accent); }
  .grid tr.picked td.date { box-shadow: inset 3px 0 0 var(--accent); }
  .grid tr.picked td.h { filter: brightness(1.05); }
  /* holiday corner marker on the date cell, always shown */
  .grid tr.holiday td.date { position: sticky; }
  .grid tr.holiday td.date::after { content: ""; position: absolute; top: 0; right: 0; border-style: solid; border-width: 0 10px 10px 0; border-color: transparent var(--accent) transparent transparent; }
  .scrolled-x .grid th.date, .scrolled-x .grid td.date { box-shadow: 6px 0 8px -6px var(--pin-shadow); }
  .scrolled-y .grid thead th { box-shadow: 0 6px 8px -6px var(--pin-shadow); }

  /* hour cell. Three cap states, each visibly its own thing:
     under = blue intensity (discrete steps), at = amber edge + numeral,
     over = red fill, white numeral, corner wedge, plus the clamped SL line. */
  .grid td.h { --lvl: 0; position: relative; width: 34px; min-width: 34px; height: 40px; padding: 0; text-align: center; cursor: default; font: 500 13px/1 var(--mono); color: var(--text); letter-spacing: 0;
    background: color-mix(in oklab, var(--heat-hi) calc(var(--lvl) * var(--heat-max-mix)), var(--heat-lo)); transition: background var(--t) var(--ease); }
  .grid td.h .n { display: block; line-height: 40px; }
  .grid td.h.cap-under { box-shadow: none; color: var(--text); }   /* blue intensity only; no outline, no edge */
  .grid td.h.cap-at { box-shadow: inset 3px 0 0 var(--amber); color: var(--amber-text); font-weight: 600; }
  .grid td.h.cap-over { background: var(--red); color: #fff; font-weight: 600; }
  .grid td.h.cap-over .n { line-height: 1; padding-top: 7px; font-size: 14px; }
  .grid td.h.cap-over .cl { display: block; font-size: 8px; line-height: 1; margin-top: 4px; opacity: 0.9; letter-spacing: -0.02em; }
  .grid td.h.cap-over::after { content: ""; position: absolute; top: 0; right: 0; border-style: solid; border-width: 0 7px 7px 0; border-color: transparent #fff transparent transparent; }
  .grid td.h.cap-undef { color: var(--text-3); }
  .grid td.h.implausible .n { text-decoration: underline dotted; text-underline-offset: 3px; }
  .grid td.h:hover { outline: 2px solid var(--text); outline-offset: -2px; }
  .grid td.h.active { outline: 2px solid var(--accent); outline-offset: -2px; }
  .grid td.h.sel { outline: 2px solid var(--accent); outline-offset: -2px; }
  .grid td.h.sel.cap-over { outline-color: #fff; }
  /* tour subtotals and planned roster */
  .grid td.sub { width: 48px; min-width: 48px; text-align: center; padding: 0; background: var(--surface-2); font: 600 13px/1 var(--mono); border-left: 2px solid var(--border-strong); }
  .grid td.sub small { display: block; font-weight: 400; color: var(--text-3); margin-top: 3px; }
  .grid td.sub.cap-at { color: var(--amber-text); } .grid td.sub.cap-over { color: var(--red-soft); }
  .grid td.plan { width: 84px; min-width: 84px; padding: 2px 4px; background: var(--surface-2); text-align: center; }
  .grid td.plan input { width: 40px; height: 20px; padding: 0 4px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); font: 600 12px var(--mono); text-align: center; }
  .grid td.plan.own input { border-color: var(--accent); }
  .grid td.plan input::placeholder { color: var(--text-3); font-weight: 400; }
  .badge-v { display: block; margin-top: 1px; font-size: 9px; line-height: 1.1; font-weight: 600; letter-spacing: 0; text-transform: uppercase; color: var(--text-3); }
  .badge-v small { display: block; font-size: 8px; font-weight: 400; text-transform: none; color: var(--text-3); }
  .v-on-target { color: var(--green-text); } .v-understaffed { color: var(--red-soft); } .v-overstaffed { color: var(--amber-text); } .v-exceeds-capacity { color: var(--red-soft); text-decoration: underline; }
  .grid td.total { width: 48px; min-width: 48px; text-align: center; font: 600 13px var(--mono); background: var(--surface-2); border-left: 2px solid var(--border-strong); }
  .legend { display: flex; flex-wrap: wrap; gap: var(--sp-2) var(--sp-4); padding: var(--sp-2) var(--sp-4); font-size: 11px; color: var(--text-3); border-top: 1px solid var(--border); align-items: center; }
  .legend .sw { display: inline-block; width: 14px; height: 14px; border-radius: 3px; vertical-align: -3px; margin-right: 5px; border: 1px solid var(--border); }
  .legend .sw.under { background: linear-gradient(to right, var(--heat-lo), color-mix(in oklab, var(--heat-hi) var(--heat-max-mix), var(--heat-lo))); width: 40px; }
  .legend .sw.at { box-shadow: inset 3px 0 0 var(--amber); background: var(--heat-lo); }
  .legend .sw.over { background: var(--red); border-color: transparent; position: relative; }
  .legend .sw.over::after { content: ""; position: absolute; top: 0; right: 0; border-style: solid; border-width: 0 5px 5px 0; border-color: transparent #fff transparent transparent; }
  .legend .sw.hol { position: relative; background: var(--surface); } .legend .sw.hol::after { content: ""; position: absolute; top: 0; right: 0; border-style: solid; border-width: 0 7px 7px 0; border-color: transparent var(--accent) transparent transparent; }
  .legend .sw.sel { border: 2px solid var(--accent); }
  .legend b { font-family: var(--mono); font-weight: 500; color: var(--text); }
  .gridnote { padding: 0 var(--sp-4) var(--sp-3); font-size: 11px; color: var(--text-3); line-height: 1.5; }

  /* docked detail panel */
  .panel { position: sticky; top: 140px; max-height: calc(100vh - 150px); overflow: auto; font-size: 12px; }
  .panel-head { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border); }
  .panel-head label { font-size: 11px; font-weight: 500; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.06em; }
  .panel-head input[type=date] { height: 26px; padding: 0 6px; border: 1px solid var(--border); border-radius: var(--r); background: var(--surface); font-size: 12px; width: 132px; }
  .panel-body { padding: var(--sp-3); }
  .panel h3 { margin: 0 0 var(--sp-2); font-size: 13px; font-weight: 600; display: flex; gap: var(--sp-2); align-items: baseline; flex-wrap: wrap; }
  .panel h3 .flag { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 999px; }
  .panel h3 .flag.over { background: var(--red); color: #fff; } .panel h3 .flag.at { background: var(--amber-bg); color: var(--amber-text); } .panel h3 .flag.hol { background: var(--highlight); color: var(--accent); text-transform: none; }
  .panel h3 .pinned { margin-left: auto; font-size: 10px; color: var(--accent); font-weight: 500; }
  .panel .big-out { display: flex; align-items: baseline; gap: var(--sp-2); margin-bottom: var(--sp-2); }
  .panel .big-out .n { font: 300 34px/1 var(--mono); } .panel .big-out .u { font-size: 11px; color: var(--text-3); }
  .panel .big-out.cap-over .n { color: var(--red-soft); } .panel .big-out.cap-at .n { color: var(--amber-text); }
  .panel table { width: 100%; border-collapse: collapse; }
  .panel td { padding: 3px 0; vertical-align: top; border-top: 1px solid var(--border); }
  .panel tr:first-child td { border-top: 0; }
  .panel td.k { color: var(--text-2); padding-right: var(--sp-3); }
  .panel td.v { text-align: right; font-family: var(--mono); white-space: nowrap; letter-spacing: 0; }
  .panel td.f { color: var(--text-3); font-family: var(--mono); font-size: 10px; padding-top: 0; border-top: 0; padding-bottom: 5px; letter-spacing: 0; }
  .panel tr.out td.v { font-weight: 600; font-size: 14px; }
  .panel .reason { margin: var(--sp-2) 0 0; padding: var(--sp-2) var(--sp-3); background: var(--amber-bg); color: var(--amber-text); border-radius: var(--r); font-size: 11px; }
  .panel .hint, .panel .scope { color: var(--text-3); font-size: 11px; line-height: 1.5; margin: 0 0 var(--sp-2); }
  .outs { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2); margin-bottom: var(--sp-3); }
  .out-tile .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3); }
  .out-tile .val { font: 300 24px/1.2 var(--mono); }
  .panel table.shifts th { font-size: 10px; font-weight: 500; color: var(--text-3); text-align: right; padding: 2px 0; } .panel table.shifts th:first-child { text-align: left; }
  .panel table.shifts td.v small { color: var(--text-3); }

  /* ---- e. summary strip: outputs large, hang-ups largest ---- */
  .summary { margin-top: var(--sp-4); padding: var(--sp-3) var(--sp-4) var(--sp-2); }
  .tiles { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: var(--sp-4) var(--sp-6); align-items: start; }
  .tile .lbl { font-size: 11px; font-weight: 500; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.08em; }
  .tile .val { font: 300 30px/1.15 var(--mono); margin-top: 4px; white-space: nowrap; }
  .tile .val small { font-size: 13px; color: var(--text-3); margin-left: 6px; }
  .tile .sub { font-size: 12px; color: var(--text-3); margin-top: 3px; line-height: 1.4; }
  .tile.big .val { font-size: 44px; color: var(--red-soft); }
  .tile.big .sub { color: var(--text-2); }
  .slack { margin: var(--sp-3) 0 0; padding-top: var(--sp-3); border-top: 1px solid var(--border); font-size: 12px; color: var(--text-2); line-height: 1.55; }
  .slack b { font-family: var(--mono); font-weight: 500; color: var(--text); }
  .caveat { margin: var(--sp-2) 0 0; font-size: 11px; color: var(--text-3); line-height: 1.5; }

  /* ---- f. credibility footer ---- */
  .footer { margin: var(--sp-4) 0 var(--sp-8); padding: var(--sp-3) var(--sp-4); border-left: 3px solid var(--accent); }
  .footer h2 { margin: 0 0 var(--sp-2); font-size: 13px; font-weight: 600; }
  .cred { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--sp-4) var(--sp-6); }
  .footer p.sub { font-size: 11px; color: var(--text-3); margin: var(--sp-3) 0 0; line-height: 1.5; }
  .footer .err { color: var(--red-soft); }

  @media (max-width: 1100px) {
    .work { grid-template-columns: minmax(0, 1fr); }
    .panel { position: static; max-height: none; }
    .tiles { grid-template-columns: 1fr 1fr; }
    .cred { grid-template-columns: 1fr 1fr; }
  }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; } }
</style>
</head>
<body>
<header class="top">
  <div class="wrap top-row">
    <span class="mark">Vets4Warriors</span>
    <h1>Staffing forecast</h1>
    <span class="badge src-unlabeled" id="sourceBadge">loading data source…</span>
    <span class="spacer"></span>
    <button type="button" class="btn" id="exportPng" title="PNG of the grid as currently computed">Export PNG</button>
    <button type="button" class="btn" id="exportCsv" title="CSV: every hour, with planned staff and verdicts">Export CSV</button>
  </div>
</header>

<main class="wrap">
  <section class="bar card" id="bar" aria-label="Forecast controls">
    <div class="bar-row">
      <div class="ctl">
        <label for="start">Window</label>
        <div class="ctl-line"><input type="date" id="start" autocomplete="off"><span class="unit">to</span><input type="date" id="end" autocomplete="off"></div>
        <div class="ctl-line"><label class="check"><input type="checkbox" id="holidays" autocomplete="off" checked>include holiday effects</label></div>
      </div>
      <div class="ctl">
        <label for="effNum">Efficiency</label>
        <div class="ctl-line"><input type="number" id="effNum" min="0" max="100" step="1" value="65" inputmode="numeric" autocomplete="off"><span class="unit">% inbound</span></div>
        <div class="track caution"><input type="range" id="eff" min="0" max="100" step="1" value="65" aria-label="Efficiency"></div>
        <span class="fb">0 to 20% not actionable</span>
      </div>
      <div class="ctl">
        <label for="slNum">Service level</label>
        <div class="ctl-line"><input type="number" id="slNum" min="80" max="95" step="1" value="80" inputmode="numeric" autocomplete="off"><span class="unit">% within</span><input type="number" id="tsec" min="0" max="3600" step="5" value="30" inputmode="numeric" autocomplete="off"><span class="unit">s</span></div>
        <div class="track"><input type="range" id="sl" min="80" max="95" step="1" value="80" aria-label="Service level target"></div>
        <div class="sl-marks" id="slMarks"></div>
      </div>
      <div class="ctl">
        <span class="lbl">Queue model</span>
        <div class="ctl-line"><span class="seg" role="radiogroup" aria-label="Queue model">
          <label><input type="radio" name="model" value="erlang_a" autocomplete="off" checked>Erlang A</label>
          <label><input type="radio" name="model" value="erlang_c" autocomplete="off">Erlang C</label>
        </span></div>
        <span class="fb">A: callers hang up. C: nobody does</span>
      </div>
      <div class="ctl">
        <label for="patience">Patience</label>
        <div class="ctl-line"><input type="number" id="patience" min="1" max="86400" step="10" inputmode="numeric" autocomplete="off"><span class="unit">s</span><button type="button" class="btn link" id="patienceReset" hidden>reset to data</button></div>
        <span class="fb" id="patienceFb"></span>
      </div>
      <div class="ctl">
        <span class="lbl">Handle-time weighting</span>
        <div class="ctl-line"><span class="seg" role="radiogroup" aria-label="Recency weighting">
          <label><input type="radio" name="recency" value="equal" autocomplete="off">Equal</label>
          <label><input type="radio" name="recency" value="weighted" autocomplete="off" checked>Weighted</label>
          <label><input type="radio" name="recency" value="recent" autocomplete="off">Recent</label>
        </span></div>
        <span class="fb" id="recencyFb"></span>
      </div>
      <div class="ctl status">
        <div class="ctl-line"><span class="changed" id="changed"></span><button type="button" class="btn" id="barToggle">Collapse</button></div>
        <span class="status" id="status"></span>
      </div>
    </div>
    <div class="bar-summary" id="barSummary" hidden></div>
  </section>
  <div class="error" id="error" hidden></div>
  <div class="note" id="holidayNote" hidden></div>

  <div class="work">
    <section class="card grid-card" aria-label="Staff to schedule per hour">
      <div class="grid-wrap">
        <div class="grid-scroll" id="gridScroll">
          <table class="grid" id="grid"><thead id="gridHead"></thead><tbody id="rows"></tbody></table>
        </div>
      </div>
      <div class="legend" id="legend">
        <span data-legend="under"><span class="sw under"></span>under the cap (<b id="legendRange"></b>), one shade per person</span>
        <span data-legend="at"><span class="sw at"></span>at the cap of 7: no headroom</span>
        <span data-legend="over"><span class="sw over"></span>over the cap: needs more than 7, never clamped; small line = service level if you can only staff 7</span>
        <span><span class="sw hol"></span>holiday</span>
        <span><span class="sw sel"></span>selected</span>
      </div>
      <div class="gridnote" id="gridNote"></div>
    </section>
    <aside class="card panel" id="panel" aria-label="Detail">
      <div class="panel-head">
        <label for="pickDate">Day</label><input type="date" id="pickDate" autocomplete="off"><button type="button" class="btn link" id="pickClear">clear</button>
        <span class="spacer"></span><button type="button" class="btn" id="pinBtn" hidden>Unpin</button>
      </div>
      <div class="panel-body" id="panelBody"></div>
    </aside>
  </div>

  <section class="card summary" id="summary" aria-label="Window summary"></section>
  <section class="card footer" id="footer" aria-label="Model credibility"></section>
</main>

<script src="erlang.js"></script>
<script src="logic.js"></script>
<script src="app.js"></script>
</body>
</html>
````

## web/app.js

````js
/* DOM layer of the staffing console. All numbers come from web/logic.js
 * (and web/erlang.js underneath); this file only reads controls, renders,
 * and talks to the API. Read logic.js first if you want to know where a
 * number comes from.
 *
 * Data flow:
 *   date range / recency / holidays change  -> fetch /api/forecast (network)
 *   any other control                        -> recompute() in the browser (no network)
 *   planned value edited                     -> store + re-judge that shift (no network)
 */
(function () {
  "use strict";
  const L = V4WUI;
  const E = V4W;
  const HOURS = L.HOURS, SHIFTS = L.SHIFTS, MAX = L.MAX_STAFF_PER_SHIFT, SPH = L.SECONDS_PER_HOUR;
  const DEBOUNCE_MS = 60;
  const DEFAULT_HORIZON_DAYS = 30;
  const SECONDS_PER_MINUTE = 60;
  const MAJOR_HOURS = new Set([0, 6, 12, 18]);
  // How each handle-time weighting reads in the trace (db/aht.py presets).
  const RECENCY_LABEL = { equal: "unweighted", weighted: "recency-weighted (1-year halflife)", recent: "recent-weighted (90-day halflife)" };
  const SL_MIN = 80, SL_MAX = 95, SL_STANDARD = 90, SL_CURRENT = [80, 85];
  const UNDEF = "-";
  const PNG_CELL = 34, PNG_ROW = 30, PNG_DATE_W = 150, PNG_SUB_W = 46, PNG_PAD = 16, PNG_HEAD = 54;

  const $ = (id) => document.getElementById(id);
  const el = {
    start: $("start"), end: $("end"), eff: $("eff"), effNum: $("effNum"), sl: $("sl"), slNum: $("slNum"), tsec: $("tsec"),
    patience: $("patience"), patienceReset: $("patienceReset"), patienceFb: $("patienceFb"), recencyFb: $("recencyFb"),
    holidays: $("holidays"), changed: $("changed"), status: $("status"), bar: $("bar"), barToggle: $("barToggle"), barSummary: $("barSummary"),
    head: $("gridHead"), rows: $("rows"), scroll: $("gridScroll"), legend: $("legend"), gridNote: $("gridNote"),
    panelBody: $("panelBody"), pinBtn: $("pinBtn"), pickDate: $("pickDate"), pickClear: $("pickClear"),
    summary: $("summary"), footer: $("footer"), sourceBadge: $("sourceBadge"), exportPng: $("exportPng"), exportCsv: $("exportCsv"),
    error: $("error"), holidayNote: $("holidayNote"),
  };
  const modelEls = [...document.querySelectorAll('input[name="model"]')];
  const recencyEls = [...document.querySelectorAll('input[name="recency"]')];

  // ---- state ----
  let cache = null;          // { key, hours, days, window, params, source }
  let computed = [];         // hours with staffing for the current controls
  let judged = [];           // days with shift roll-up + planned verdicts
  let hourIndex = new Map(), cellIndex = new Map();
  let pinnedKey = null, hoverKey = null, selection = null, pickedDate = null;
  let patienceTouched = false;
  const store = L.createPlannedStore(safeStorage());

  function safeStorage() { try { return window.localStorage; } catch (_) { return null; } }

  // ---- helpers ----
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad2 = (n) => String(n).padStart(2, "0");
  const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
  function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  function localDate(s) { return new Date(s + "T00:00:00"); }
  function shortDate(s) { return localDate(s).toLocaleDateString(undefined, { day: "numeric", month: "short" }); }
  function longDate(s) { return localDate(s).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short", year: "numeric" }); }
  function formatDuration(sec) {
    const minutes = Math.floor(sec / SECONDS_PER_MINUTE + 0.5);
    const h = Math.floor(minutes / 60), m = minutes % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }
  function queueModel() { return (modelEls.find((e) => e.checked) || modelEls[0]).value; }
  function recency() { return (recencyEls.find((e) => e.checked) || recencyEls[1]).value; }
  function estimatedPatience() { return cache && cache.params.patience_source && cache.params.patience_source.kind === "estimated" ? cache.params.patience_sec : null; }
  function patienceSec() {
    if (queueModel() === "erlang_c") return null;
    const v = Number(el.patience.value);
    if (Number.isFinite(v) && v > 0) return Math.min(v, Number(el.patience.max));
    return cache ? cache.params.patience_sec : null;
  }
  function targetSec() { const v = Number(el.tsec.value); return Number.isFinite(v) && v >= 0 ? Math.min(v, Number(el.tsec.max)) : Number(el.tsec.defaultValue); }
  function controls() {
    return { efficiency: Number(el.effNum.value) / 100, targetPct: Number(el.slNum.value) / 100, targetSec: targetSec(), patienceSec: patienceSec() };
  }
  function rangeKey() { return `${el.start.value}|${el.end.value}|${recency()}|${el.holidays.checked}`; }

  // ---- controls: sync + feedback ----
  function clampInt(v, lo, hi, fallback) { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback; }
  function syncPair(range, number) { number.value = range.value; }
  function setFill(range) {
    const p = ((range.value - range.min) / (range.max - range.min)) * 100;
    range.style.setProperty("--fill", p.toFixed(1) + "%");
  }
  function renderControlFeedback() {
    setFill(el.eff); setFill(el.sl);
    const estimate = estimatedPatience();
    const c = controls();
    el.patience.disabled = queueModel() === "erlang_c";
    if (queueModel() === "erlang_c") {
      el.patienceFb.textContent = "Erlang C: nobody hangs up";
      el.patienceReset.hidden = true;
    } else if (!patienceTouched || (estimate !== null && Math.round(c.patienceSec) === Math.round(estimate))) {
      el.patienceFb.textContent = estimate !== null ? `measured, ${cache.params.patience_source.n_abandoned.toLocaleString()} abandons` : "";
      el.patienceReset.hidden = true;
    } else {
      el.patienceFb.textContent = `your override; data says ${estimate === null ? "?" : Math.round(estimate)} s`;
      el.patienceReset.hidden = false;
    }
    if (cache) {
      const eff = cache.window.recency_effect_pct;
      el.recencyFb.textContent = recency() === "equal" ? "every call weighs the same" :
        `${eff >= 0 ? "raises" : "lowers"} expected talk time ${Math.abs(eff).toFixed(1)}% vs equal weighting`;
    }
    el.barSummary.textContent = `${shortDate(el.start.value)} to ${shortDate(el.end.value)} · efficiency ${el.effNum.value}% · ` +
      `${el.slNum.value}% in ${targetSec()} s · ${queueModel() === "erlang_a" ? `Erlang A, patience ${Math.round(c.patienceSec || 0)} s` : "Erlang C"} · ` +
      `${recency()} weighting · holidays ${el.holidays.checked ? "on" : "off"}`;
  }

  // ---- fetch ----
  async function fetchJson(url, init) {
    const res = await fetch(url, init);
    if (!res.ok) {
      let detail = res.statusText;
      try { const body = await res.json(); detail = Array.isArray(body.detail) ? body.detail.map((d) => d.msg).join("; ") : (body.detail || detail); } catch (_) {}
      throw new Error(`${res.status}: ${detail}`);
    }
    return res.json();
  }
  function serverParams() {
    const c = controls();
    const p = new URLSearchParams({ start: el.start.value, end: el.end.value, queue_model: queueModel(), recency: recency(),
      include_holidays: String(el.holidays.checked), efficiency: c.efficiency.toFixed(2), target_pct: c.targetPct.toFixed(2), target_sec: String(c.targetSec) });
    if (patienceTouched && c.patienceSec !== null) p.set("patience_sec", String(c.patienceSec));
    return p;
  }
  let inflight = 0;
  async function refresh() {
    const k = rangeKey();
    if (cache && cache.key === k) { recompute(); return; }
    const id = ++inflight;
    el.status.textContent = "Loading forecast…";
    document.body.classList.add("is-loading");
    try {
      const data = await fetchJson("/api/forecast?" + serverParams());
      if (id !== inflight) return;
      cache = { key: k, hours: data.hours.map((h) => ({ date: h.date, hour: h.hour, predicted_calls: h.predicted_calls, aht_sec: h.aht_sec })),
        days: data.days, window: data.window, params: data.params, source: data.data_source, coverage: data.holiday_coverage };
      if (!patienceTouched && data.params.patience_sec) el.patience.value = String(Math.round(data.params.patience_sec));
      el.error.hidden = true;
      renderSourceBadge(cache.source);
      el.holidayNote.hidden = !cache.coverage.message;
      el.holidayNote.textContent = cache.coverage.message || "";
      selection = null; pinnedKey = null; hoverKey = null;
      if (pickedDate && !cache.days.some((d) => d.date === pickedDate)) pickedDate = null;
      buildGrid(cache.days);
      computed = [];
      recompute();
    } catch (err) {
      if (id !== inflight) return;
      cache = null;
      el.error.hidden = false; el.error.textContent = err.message;
      el.rows.innerHTML = ""; el.status.textContent = "";
    } finally {
      if (id === inflight) document.body.classList.remove("is-loading");
    }
  }
  function renderSourceBadge(src) {
    if (!src) return;
    el.sourceBadge.className = `badge src-${src.kind}`;
    el.sourceBadge.textContent = src.kind === "unlabeled" ? src.label : `${src.label} · ${src.start} to ${src.end}`;
  }

  // ---- grid skeleton (once per range) ----
  function buildGrid(days) {
    const groups = SHIFTS.map((s) =>
      `<th class="group" colspan="${s.core.length + 2}"><span>${s.name}</span><small>${s.span}</small></th>`).join("");
    const hourHeads = (spec) => spec.core.map((h) => `<th class="hh${MAJOR_HOURS.has(h) ? " major" : ""}" data-h="${h}">${pad2(h)}</th>`).join("") +
      `<th class="sub"><span>peak</span><small>p-h</small></th><th class="plan">planned</th>`;
    el.head.innerHTML = `<tr><th class="date" rowspan="2">Date</th>${groups}<th class="total" rowspan="2"><span>total</span><small>p-h</small></th></tr>` +
      `<tr>${SHIFTS.map(hourHeads).join("")}</tr>`;
    const today = isoDate(new Date());
    el.rows.innerHTML = days.map((day) => {
      const dt = localDate(day.date);
      const cls = [day.is_weekend ? "weekend" : "", day.date === today ? "today" : "", day.holiday ? "holiday" : ""].join(" ").trim();
      const cells = SHIFTS.map((spec) =>
        spec.core.map((h) => `<td class="h${MAJOR_HOURS.has(h) ? " major" : ""}" data-k="${L.key(day.date, h)}" data-d="${day.date}" data-h="${h}" tabindex="0"></td>`).join("") +
        `<td class="sub" data-sub="${L.shiftKey(day.date, spec.name)}"></td>` +
        `<td class="plan" data-plan="${L.shiftKey(day.date, spec.name)}"><input type="number" name="planned" min="0" max="99" step="1" inputmode="numeric" aria-label="Planned staff, ${spec.name} ${day.date}" data-d="${day.date}" data-s="${spec.name}"><span class="badge-v"></span></td>`
      ).join("");
      const meta = day.holiday ? `<span class="hol" title="${esc(day.holiday)}">${esc(day.holiday)}</span>` : (day.date === today ? "Today" : "");
      return `<tr class="${cls}" data-d="${day.date}"><td class="date"><div class="d">${dt.toLocaleDateString(undefined, { weekday: "short" })}<span class="dm">${dt.toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span></div><div class="meta">${meta}</div></td>${cells}<td class="total" data-total="${day.date}"></td></tr>`;
    }).join("");
    cellIndex = new Map([...el.rows.querySelectorAll("td.h[data-k]")].map((td) => [td.dataset.k, td]));
    el.gridNote.textContent = "Tours overlap by 30 minutes (Day 08:00 to 16:30, Evening 16:00 to 00:30, Overnight 00:00 to 08:30). " +
      "The overlap hour counts toward the peak of both adjacent tours and toward the calls and person-hours of the tour that starts it. " +
      "peak = the busiest hour's people to schedule, the number to roster against; p-h = person-hours, the sum over the tour's hours. " +
      "Planned: type your roster per tour; empty follows the recommendation.";
  }

  // ---- recompute (no network) ----
  function recompute() {
    if (!cache) return;
    const t0 = performance.now();
    const c = controls();
    const next = L.computeHours(cache.hours, c);
    const changed = L.diffCells(computed, next);
    computed = next;
    hourIndex = new Map(computed.map((h) => [L.key(h.date, h.hour), h]));
    judged = L.judgeRoster(L.rollupShifts(cache.days, computed), store, c);
    patchCells(computed);
    patchShifts(judged);
    renderLegend();
    renderSummary(c);
    renderPanel();
    renderControlFeedback();
    const ms = performance.now() - t0;
    // Shown after every recompute that moved anything, including the first
    // load, so a slider's effect is visible without hunting for it.
    el.changed.textContent = changed > 0 ? `${changed} cell${changed === 1 ? "" : "s"} changed` : "no cells changed";
    el.status.textContent = `${cache.days.length} days · ${computed.length} hours · ${ms.toFixed(0)} ms`;
  }

  function patchCells(hours) {
    const scale = L.discreteScale(hours.map((h) => h.staff_to_schedule));
    const peaks = new Set(L.peakHours(hours));
    el.head.querySelectorAll("th.hh").forEach((th) => th.classList.toggle("peak", peaks.has(Number(th.dataset.h))));
    hours.forEach((h) => {
      const td = cellIndex.get(L.key(h.date, h.hour));
      if (!td) return;
      const staff = h.staff_to_schedule;
      td.style.setProperty("--lvl", h.cap_state === "under" ? scale.levelOf(staff).toFixed(3) : "0");
      td.className = `h cap-${h.cap_state}${MAJOR_HOURS.has(h.hour) ? " major" : ""}${h.implausible ? " implausible" : ""}` +
        `${inSelection(h) ? " sel" : ""}${pinnedKey === L.key(h.date, h.hour) ? " active" : ""}`;
      td.innerHTML = h.cap_state === "over"
        ? `<span class="n">${staff}</span><span class="cl">${pct(h.service_level_if_capped)} at ${MAX}</span>`
        : `<span class="n">${staff === null ? UNDEF : staff}</span>`;
    });
    el.scale = scale;
  }

  function patchShifts(days) {
    days.forEach((day) => {
      SHIFTS.forEach((spec) => {
        const s = day.shifts[spec.name], p = day.planned[spec.name];
        const k = L.shiftKey(day.date, spec.name);
        const sub = el.rows.querySelector(`td.sub[data-sub="${k}"]`);
        if (sub) {
          sub.className = `sub cap-${L.capState(s.staff_needed)}`;
          sub.innerHTML = `<span class="n">${s.staff_needed === null ? UNDEF : s.staff_needed}</span><small>${s.person_hours === null ? UNDEF : s.person_hours}</small>`;
        }
        const plan = el.rows.querySelector(`td.plan[data-plan="${k}"]`);
        if (plan) {
          const input = plan.querySelector("input"), badge = plan.querySelector(".badge-v");
          if (document.activeElement !== input) input.value = p.planned === null ? "" : p.planned;
          input.placeholder = s.staff_needed === null ? UNDEF : s.staff_needed;
          plan.classList.toggle("own", p.is_own);
          if (p.verdict === null) { badge.className = "badge-v"; badge.textContent = UNDEF; }
          else {
            badge.className = `badge-v v-${p.verdict.replace(/ /g, "-")}`;
            badge.innerHTML = `${verdictShort(p.verdict)}<small>${p.delta > 0 ? "+" : ""}${p.delta} · SL ${pct(p.service_level)}</small>`;
            badge.title = `${p.verdict}: ${p.planned} planned vs ${p.recommended} recommended. ${p.effective_agents} on inbound after efficiency; ` +
              `lowest hour delivers ${pct(p.service_level, 1)}${p.abandon_share === null ? "" : `, worst hour loses ${pct(p.abandon_share, 1)} of callers`}.`;
          }
        }
      });
      const total = el.rows.querySelector(`td.total[data-total="${day.date}"]`);
      if (total) total.textContent = day.person_hours === null ? UNDEF : day.person_hours;
    });
  }
  function verdictShort(v) { return { "understaffed": "under", "on target": "on target", "overstaffed": "over", "exceeds capacity": "exceeds cap" }[v] || v; }

  function renderLegend() {
    const s = el.scale || { lo: 0, hi: 0 };
    $("legendRange").textContent = s.lo === s.hi ? `${s.lo}` : `${s.lo} to ${s.hi}`;
  }

  // ---- summary strip ----
  function renderSummary(c) {
    const s = L.summarize(computed);
    const fewer = L.abandonedOneFewer(computed, c);
    const tile = (cls, lbl, val, sub) => `<div class="tile ${cls}"><div class="lbl">${lbl}</div><div class="val">${val}</div><div class="sub">${sub}</div></div>`;
    const talkHours = s.talkSec / SPH;
    let abandonTile;
    if (queueModel() === "erlang_c") abandonTile = tile("big", "Expected hang-ups", "n/a", "Erlang C assumes nobody hangs up");
    else if (s.abandoned === null) abandonTile = tile("big", "Expected hang-ups", UNDEF, "undefined at 0% efficiency");
    else abandonTile = tile("big", "Expected hang-ups", `${s.abandoned.toFixed(0)}<small>${s.calls > 0 ? pct(s.abandoned / s.calls, 1) : ""}</small>`,
      `<b>${s.abandoned.toFixed(0)} callers expected to hang up before a peer answers</b>, at the recommended staffing, ${shortDate(cache.window.start)} to ${shortDate(cache.window.end)}`);
    let slack;
    if (s.personHours === null) slack = `Scheduled person-hours are undefined at 0% efficiency.`;
    else {
      const gap = s.personHours - talkHours, ratio = talkHours > 0 ? s.personHours / talkHours : null;
      slack = `Scheduled person-hours exceed expected talk time by <b>${formatDuration(Math.max(0, gap) * SPH)}</b>${ratio ? ` (${ratio.toFixed(1)}× the talk time)` : ""}. ` +
        `That gap is the efficiency assumption (${el.effNum.value}% of a shift on inbound) plus the queue slack ${queueModel() === "erlang_a" ? "Erlang A" : "Erlang C"} adds to answer ${el.slNum.value}% within ${c.targetSec} s.` +
        (fewer !== null && s.abandoned !== null ? ` <b>What the slack buys:</b> at one fewer person per hour, expected hang-ups rise from <b>${s.abandoned.toFixed(0)}</b> to <b>${fewer.toFixed(0)}</b>.` : "");
    }
    el.summary.innerHTML = `<div class="tiles">${abandonTile}` +
      tile("", "Predicted calls", s.calls.toFixed(0), `${s.n} hours`) +
      tile("", "Expected talk time", formatDuration(s.talkSec), `${s.calls.toFixed(0)} calls × ${s.meanAht === null ? "?" : (s.meanAht / SECONDS_PER_MINUTE).toFixed(1)} min`) +
      tile("", "Scheduled person-hours", s.personHours === null ? UNDEF : s.personHours.toLocaleString(), "sum of people to schedule, every hour") +
      `</div><p class="slack">${slack}</p><p class="caveat">${esc(cache.window.caveat)}</p>`;
  }

  // ---- docked panel ----
  function inSelection(h) { return !!selection && selection.dates.includes(h.date) && h.hour >= selection.hours[0] && h.hour <= selection.hours[1]; }
  function renderPanel() {
    const k = pinnedKey || hoverKey;
    el.pinBtn.hidden = !pinnedKey;
    if (k && hourIndex.has(k)) { el.panelBody.innerHTML = hourView(hourIndex.get(k), !!pinnedKey); return; }
    if (selection) { el.panelBody.innerHTML = selectionView(); return; }
    if (pickedDate) { el.panelBody.innerHTML = dayView(pickedDate); return; }
    el.panelBody.innerHTML = `<p class="hint">Hover a cell for its trace, click to pin it, drag across cells to total a selection, or pick a date above for a day summary.</p>`;
  }
  const row = (k, v, f, out) => `<tr class="${out ? "out" : ""}"><td class="k">${k}</td><td class="v">${v}</td></tr>` + (f ? `<tr><td class="f" colspan="2">${f}</td></tr>` : "");
  function hourView(h, pinned) {
    const c = controls();
    const fmt = (v, d) => Number(v).toFixed(d);
    const flag = h.cap_state === "over" ? `<span class="flag over">over cap</span>` : h.cap_state === "at" ? `<span class="flag at">at cap</span>` : "";
    let body = `<h3><span>${esc(h.date)} ${pad2(h.hour)}:00</span>${flag}${pinned ? `<span class="pinned">pinned</span>` : ""}</h3>` +
      `<div class="big-out cap-${h.cap_state}"><span class="n">${h.staff_to_schedule === null ? UNDEF : h.staff_to_schedule}</span><span class="u">people to schedule</span></div><table>` +
      row("predicted calls", fmt(h.predicted_calls, 2), "LightGBM Poisson, this hour") +
      row("handle time", `${fmt(h.aht_sec, 0)} s`, `${RECENCY_LABEL[recency()]} mean for this weekday and hour`) +
      row("expected talk time", formatDuration(h.load_erlangs * SPH), `${fmt(h.predicted_calls, 2)} × ${fmt(h.aht_sec, 0)} s`) +
      row("load", `${fmt(h.load_erlangs, 3)} erlangs`, `talk time ÷ ${SPH}`) +
      row("agents required", h.agents_required, h.queue_model === "erlang_a"
        ? `smallest N with Erlang A service level ≥ ${el.slNum.value}% in ${c.targetSec} s, callers giving up after ${Math.round(h.patience_sec)} s on average`
        : `smallest N with Erlang C service level ≥ ${el.slNum.value}% in ${c.targetSec} s`);
    if (h.staff_to_schedule === null) return body + row("÷ efficiency", `${h.agents_required} ÷ 0`, "undefined", true) + `</table><p class="reason">${esc(h.reason)}</p>`;
    body += row("÷ efficiency", `${h.agents_required} ÷ ${fmt(c.efficiency, 2)} = ${fmt(h.agents_required / c.efficiency, 2)}`, "share of a shift actually on inbound") +
      row("staff to schedule", h.staff_to_schedule, `ceil(${fmt(h.agents_required / c.efficiency, 2)})`, true) +
      row("effective agents", h.effective_agents, `floor(${h.staff_to_schedule} × ${fmt(c.efficiency, 2)})`) +
      row("service level delivered", pct(h.service_level_delivered, 1), `with ${h.effective_agents} on inbound; target ${el.slNum.value}% in ${c.targetSec} s`) +
      (h.queue_model === "erlang_a" ? row("hang-ups", pct(h.abandon_share, 1), `callers who give up before answer with ${h.effective_agents} on inbound`) : row("hang-ups", "n/a", "Erlang C assumes nobody hangs up"));
    if (h.cap_state === "over") body += row(`if capped at ${MAX}`, pct(h.service_level_if_capped, 1), `service level with floor(${MAX} × ${fmt(c.efficiency, 2)}) = ${Math.floor(MAX * c.efficiency)} on inbound`, true);
    return body + `</table>` + (h.reason ? `<p class="reason">${esc(h.reason)}</p>` : "");
  }
  function selectionView() {
    const rows = computed.filter(inSelection);
    const s = L.summarize(rows);
    return `<h3><span>Selection</span><button type="button" class="link" id="selClear">clear</button></h3>` +
      `<p class="scope">${selection.dates.length} date${selection.dates.length === 1 ? "" : "s"}, ${pad2(selection.hours[0])}:00 to ${pad2(selection.hours[1])}:59, ${rows.length} cells</p>` +
      outGrid([["person-hours", s.personHours === null ? UNDEF : s.personHours.toLocaleString()], ["peak staff", s.peakStaff === null ? UNDEF : s.peakStaff],
        ["predicted calls", s.calls.toFixed(0)], ["expected hang-ups", s.abandoned === null ? "n/a" : s.abandoned.toFixed(0)]]);
  }
  function outGrid(pairs) { return `<div class="outs">${pairs.map(([k, v]) => `<div class="out-tile"><div class="lbl">${k}</div><div class="val">${v}</div></div>`).join("")}</div>`; }
  function dayView(date) {
    const day = judged.find((d) => d.date === date);
    if (!day) return `<p class="hint">${esc(date)} is outside the loaded window. Extend the date range to inspect it.</p>`;
    const st = L.dayStats(day, computed.filter((h) => h.date === date));
    const shifts = SHIFTS.map((spec) => {
      const s = day.shifts[spec.name], p = day.planned[spec.name];
      return `<tr><td class="k">${spec.name}</td><td class="v">${s.staff_needed === null ? UNDEF : s.staff_needed}</td>` +
        `<td class="v">${p.planned === null ? UNDEF : p.planned}</td><td class="v ${p.verdict ? `v-${p.verdict.replace(/ /g, "-")}` : ""}">${p.verdict ? verdictShort(p.verdict) : UNDEF}${p.service_level === null ? "" : `<small> SL ${pct(p.service_level)}</small>`}</td></tr>`;
    }).join("");
    const hoursList = (hs) => hs.length ? hs.map((h) => `${pad2(h)}:00`).join(", ") : "none";
    return `<h3><span>${esc(longDate(date))}</span>${day.holiday ? `<span class="flag hol">${esc(day.holiday)}</span>` : ""}</h3>` +
      outGrid([["predicted calls", st.calls.toFixed(0)], ["peak hour", st.peakHour === null ? UNDEF : `${pad2(st.peakHour)}:00`],
        ["peak staff", st.peakStaff === null ? UNDEF : st.peakStaff], ["expected hang-ups", st.abandoned === null ? "n/a" : st.abandoned.toFixed(0)]]) +
      `<table class="shifts"><tr><th>tour</th><th>need</th><th>planned</th><th>verdict</th></tr>${shifts}</table>` +
      `<p class="scope">At cap: ${hoursList(st.atCap)}.<br>Over cap: ${hoursList(st.overCap)}.</p>`;
  }

  // ---- grid interaction ----
  function cellOf(e) { return e.target.closest && e.target.closest("td.h[data-k]"); }
  function setPinned(k) {
    if (pinnedKey && cellIndex.has(pinnedKey)) cellIndex.get(pinnedKey).classList.remove("active");
    pinnedKey = k;
    if (k && cellIndex.has(k)) cellIndex.get(k).classList.add("active");
    renderPanel();
  }
  let drag = null;
  function rectFrom(a, b) {
    const dates = cache.days.map((d) => d.date);
    const [i0, i1] = [dates.indexOf(a.dataset.d), dates.indexOf(b.dataset.d)].sort((x, y) => x - y);
    const [h0, h1] = [Number(a.dataset.h), Number(b.dataset.h)].sort((x, y) => x - y);
    return { dates: dates.slice(i0, i1 + 1), hours: [h0, h1] };
  }
  function applySelection(sel) {
    selection = sel;
    cellIndex.forEach((td) => td.classList.toggle("sel", !!sel && sel.dates.includes(td.dataset.d) && Number(td.dataset.h) >= sel.hours[0] && Number(td.dataset.h) <= sel.hours[1]));
    renderPanel();
  }
  el.rows.addEventListener("pointerdown", (e) => { const c = cellOf(e); if (c && e.button === 0) { drag = { anchor: c, moved: false }; } });
  el.rows.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const node = document.elementFromPoint(e.clientX, e.clientY);
    const c = node && node.closest && node.closest("td.h[data-k]");
    if (!c || (c === drag.anchor && !drag.moved)) return;
    if (!drag.moved) { drag.moved = true; setPinned(null); }
    applySelection(rectFrom(drag.anchor, c));
  });
  const endDrag = () => { drag = null; };
  el.rows.addEventListener("pointerup", endDrag);
  el.rows.addEventListener("pointercancel", endDrag);
  el.rows.addEventListener("mouseover", (e) => { const c = cellOf(e); if (c && !drag) { hoverKey = c.dataset.k; if (!pinnedKey) renderPanel(); } });
  el.rows.addEventListener("mouseleave", () => { hoverKey = null; if (!pinnedKey) renderPanel(); });
  el.rows.addEventListener("focusin", (e) => { const c = cellOf(e); if (c) { hoverKey = c.dataset.k; if (!pinnedKey) renderPanel(); } });
  el.rows.addEventListener("click", (e) => {
    const c = cellOf(e);
    if (!c || (drag && drag.moved)) return;
    setPinned(pinnedKey === c.dataset.k ? null : c.dataset.k);
  });
  el.rows.addEventListener("input", (e) => {
    const input = e.target.closest && e.target.closest("td.plan input");
    if (!input) return;
    const v = input.value.trim();
    store.set(input.dataset.d, input.dataset.s, v === "" ? null : clampInt(v, 0, 99, null));
    const c = controls();
    judged = L.judgeRoster(L.rollupShifts(cache.days, computed), store, c);
    patchShifts(judged);
    if (pickedDate === input.dataset.d && !pinnedKey && !hoverKey && !selection) renderPanel();
  });
  el.panelBody.addEventListener("click", (e) => { if (e.target.id === "selClear") applySelection(null); });
  el.pinBtn.addEventListener("click", () => setPinned(null));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { setPinned(null); applySelection(null); } });
  el.scroll.addEventListener("scroll", () => {
    el.scroll.parentElement.classList.toggle("scrolled-x", el.scroll.scrollLeft > 0);
    el.scroll.parentElement.classList.toggle("scrolled-y", el.scroll.scrollTop > 0);
  }, { passive: true });

  // ---- day picker ----
  function setPicked(date) {
    pickedDate = date || null;
    el.rows.querySelectorAll("tr.picked").forEach((tr) => tr.classList.remove("picked"));
    if (pickedDate) { const tr = el.rows.querySelector(`tr[data-d="${pickedDate}"]`); if (tr) { tr.classList.add("picked"); tr.scrollIntoView({ block: "nearest" }); } }
    renderPanel();
  }
  el.pickDate.addEventListener("change", () => setPicked(el.pickDate.value));
  el.pickClear.addEventListener("click", () => { el.pickDate.value = ""; setPicked(null); });

  // ---- exports ----
  function download(name, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }
  function exportCsv() {
    if (!cache) return;
    const csv = L.toCsv(L.csvRows(computed, judged));
    download(`v4w-staffing-${cache.window.start}-to-${cache.window.end}.csv`, new Blob([csv], { type: "text/csv" }));
  }
  // PNG: the grid is redrawn on a canvas from `computed`, not screenshotted,
  // so the export never depends on scroll position or viewport size.
  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function mix(a, b, t) { const A = hexToRgb(a), B = hexToRgb(b); return `rgb(${A.map((x, i) => Math.round(x + (B[i] - x) * t)).join(",")})`; }
  function exportPng() {
    if (!cache) return;
    const lo = cssVar("--heat-lo"), hi = cssVar("--heat-hi"), bg = cssVar("--surface"), ink = cssVar("--text"), mute = cssVar("--text-3"),
      amber = cssVar("--amber"), red = cssVar("--red"), border = cssVar("--border"), maxMix = parseFloat(cssVar("--heat-max-mix")) / 100;
    const cols = 24 * PNG_CELL + 3 * PNG_SUB_W + PNG_SUB_W;
    const W = PNG_PAD * 2 + PNG_DATE_W + cols, H = PNG_PAD * 2 + PNG_HEAD + cache.days.length * PNG_ROW + 24;
    const cv = document.createElement("canvas"); cv.width = W * 2; cv.height = H * 2;
    const g = cv.getContext("2d"); g.scale(2, 2);
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    g.font = "600 13px Inter, system-ui, sans-serif"; g.fillStyle = ink;
    g.fillText(`Vets4Warriors staffing forecast: people to schedule per hour, ${cache.window.start} to ${cache.window.end}`, PNG_PAD, PNG_PAD + 12);
    g.font = "11px Inter, system-ui, sans-serif"; g.fillStyle = mute;
    g.fillText(`efficiency ${el.effNum.value}% · ${el.slNum.value}% answered within ${targetSec()} s · ${queueModel() === "erlang_a" ? "Erlang A" : "Erlang C"} · ${recency()} weighting · ${cache.source ? cache.source.label : ""}`, PNG_PAD, PNG_PAD + 28);
    const x0 = PNG_PAD + PNG_DATE_W, y0 = PNG_PAD + PNG_HEAD;
    const colX = (h) => x0 + h * PNG_CELL + Math.floor(h / 8) * PNG_SUB_W;
    g.font = "10px ui-monospace, Menlo, monospace"; g.textAlign = "center";
    HOURS.forEach((h) => { g.fillStyle = MAJOR_HOURS.has(h) ? ink : mute; g.fillText(pad2(h), colX(h) + PNG_CELL / 2, y0 - 6); });
    SHIFTS.forEach((s, i) => { g.fillStyle = ink; g.fillText(`${s.short} peak`, colX(s.core[7]) + PNG_CELL + PNG_SUB_W / 2, y0 - 6); g.fillText(s.name, colX(s.core[0]) + 4 * PNG_CELL, y0 - 20); });
    g.fillText("total", colX(23) + PNG_CELL + PNG_SUB_W / 2, y0 - 6);
    judged.forEach((day, r) => {
      const y = y0 + r * PNG_ROW;
      g.textAlign = "left"; g.font = "12px Inter, system-ui, sans-serif"; g.fillStyle = ink;
      g.fillText(`${localDate(day.date).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}${day.holiday ? " ·" : ""}`, PNG_PAD, y + 19);
      HOURS.forEach((h) => {
        const row_ = hourIndex.get(L.key(day.date, h)); if (!row_) return;
        const x = colX(h), st = row_.cap_state;
        g.fillStyle = st === "over" ? red : st === "under" ? mix(lo, hi, el.scale.levelOf(row_.staff_to_schedule) * maxMix) : lo;
        g.fillRect(x, y, PNG_CELL - 1, PNG_ROW - 1);
        if (st === "at") { g.fillStyle = amber; g.fillRect(x, y, 3, PNG_ROW - 1); }
        g.fillStyle = st === "over" ? "#fff" : st === "at" ? amber : ink; g.textAlign = "center"; g.font = "600 12px ui-monospace, Menlo, monospace";
        g.fillText(row_.staff_to_schedule === null ? UNDEF : row_.staff_to_schedule, x + PNG_CELL / 2, y + 19);
      });
      SHIFTS.forEach((s) => {
        const sh = day.shifts[s.name], x = colX(s.core[7]) + PNG_CELL;
        g.fillStyle = border; g.fillRect(x, y, PNG_SUB_W - 1, PNG_ROW - 1);
        g.fillStyle = sh.capped ? red : ink; g.textAlign = "center"; g.font = "600 12px ui-monospace, Menlo, monospace";
        g.fillText(sh.staff_needed === null ? UNDEF : sh.staff_needed, x + PNG_SUB_W / 2, y + 19);
      });
      g.fillStyle = ink; g.fillText(day.person_hours === null ? UNDEF : day.person_hours, colX(23) + PNG_CELL + PNG_SUB_W / 2, y + 19);
    });
    g.textAlign = "left"; g.font = "10px Inter, system-ui, sans-serif"; g.fillStyle = mute;
    g.fillText(`Red = over the cap of ${MAX} (never clamped); amber edge = at the cap; blue shades = under, one per person. Exported ${new Date().toISOString().slice(0, 16).replace("T", " ")}.`, PNG_PAD, H - PNG_PAD + 6);
    cv.toBlob((blob) => download(`v4w-staffing-grid-${cache.window.start}-to-${cache.window.end}.png`, blob), "image/png");
  }
  el.exportCsv.addEventListener("click", exportCsv);
  el.exportPng.addEventListener("click", exportPng);

  // ---- footer: model credibility ----
  async function loadFooter() {
    try {
      const m = await fetchJson("/api/model");
      const overall = (m.backtest && m.backtest.overall) || [];
      const by = Object.fromEntries(overall.map((r) => [r.model, r]));
      const lgbm = by.lgbm_poisson, naive = by.seasonal_naive, mean = by.overall_mean;
      if (!lgbm) throw new Error("metadata has no backtest.overall");
      const folds = m.backtest.holdout_months || new Set((m.backtest.per_fold || []).map((r) => r.fold)).size;
      renderSourceBadge(m.data_source);
      el.footer.innerHTML = `<h2>How much to trust these numbers</h2>` +
        `<div class="cred"><div class="tile"><div class="lbl">Daily-total error</div><div class="val">${lgbm.daily_mae.toFixed(1)}<small>calls/day</small></div><div class="sub">LightGBM Poisson${naive ? `; seasonal naive ${naive.daily_mae.toFixed(1)}` : ""}${mean ? `; flat mean ${mean.daily_mae.toFixed(1)}` : ""}</div></div>` +
        `<div class="tile"><div class="lbl">Hourly error</div><div class="val">${lgbm.mae.toFixed(2)}<small>calls/hour</small></div><div class="sub">MAPE ${lgbm.mape_pct.toFixed(0)}% on hours with calls${naive ? `; naive ${naive.mae.toFixed(2)}` : ""}</div></div>` +
        `<div class="tile"><div class="lbl">Backtest window</div><div class="val">${folds}<small>monthly folds</small></div><div class="sub">${m.backtest.first_test_month.slice(0, 7)} to ${m.backtest.last_test_month.slice(0, 7)}, each month predicted with no access to it</div></div>` +
        `<div class="tile"><div class="lbl">Training data</div><div class="val">${m.train_rows.toLocaleString()}<small>hours</small></div><div class="sub">${m.train_start.slice(0, 10)} to ${m.train_end.slice(0, 10)}, ${m.features.length} features</div></div></div>` +
        `<p class="sub">Model error, not magic: every cell carries about plus or minus one person. Rolling-origin backtest; the model only ever saw months before the one it predicted. Exact per-fold numbers are in models/metadata.json.</p>`;
    } catch (err) {
      el.footer.innerHTML = `<p class="err">Model metadata unavailable: ${esc(err.message)}</p>`;
    }
  }

  // ---- wiring ----
  let timer = null;
  function debounced(fn) { clearTimeout(timer); timer = setTimeout(fn, DEBOUNCE_MS); }
  const onLocal = () => { renderControlFeedback(); debounced(recompute); };
  el.eff.addEventListener("input", () => { syncPair(el.eff, el.effNum); onLocal(); });
  el.effNum.addEventListener("input", () => { el.eff.value = clampInt(el.effNum.value, 0, 100, 65); onLocal(); });
  el.effNum.addEventListener("change", () => { el.effNum.value = el.eff.value; onLocal(); });
  el.sl.addEventListener("input", () => { syncPair(el.sl, el.slNum); onLocal(); });
  el.slNum.addEventListener("input", () => { el.sl.value = clampInt(el.slNum.value, SL_MIN, SL_MAX, SL_MIN); onLocal(); });
  el.slNum.addEventListener("change", () => { el.slNum.value = el.sl.value; onLocal(); });
  el.tsec.addEventListener("input", onLocal);
  el.patience.addEventListener("input", () => { patienceTouched = true; onLocal(); });
  el.patienceReset.addEventListener("click", () => { patienceTouched = false; const est = estimatedPatience(); if (est !== null) el.patience.value = String(Math.round(est)); onLocal(); });
  modelEls.forEach((e) => e.addEventListener("change", onLocal));
  recencyEls.forEach((e) => e.addEventListener("change", () => debounced(refresh)));
  el.holidays.addEventListener("change", () => debounced(refresh));
  el.start.addEventListener("change", () => debounced(refresh));
  el.end.addEventListener("change", () => debounced(refresh));
  el.barToggle.addEventListener("click", () => {
    const collapsed = el.bar.classList.toggle("collapsed");
    el.barToggle.textContent = collapsed ? "Expand" : "Collapse";
    el.barSummary.hidden = !collapsed;
  });

  function init() {
    const today = new Date(), end = new Date(today); end.setDate(end.getDate() + DEFAULT_HORIZON_DAYS - 1);
    el.start.value = isoDate(today); el.end.value = isoDate(end);
    el.eff.value = "65"; el.effNum.value = "65"; el.sl.value = "80"; el.slNum.value = "80"; el.tsec.value = "30";
    el.patience.value = ""; el.holidays.checked = true;
    modelEls[0].checked = true; recencyEls[1].checked = true;
    const marks = $("slMarks");
    const at = (v) => `${((v - SL_MIN) / (SL_MAX - SL_MIN)) * 100}%`;
    marks.innerHTML = `<span class="bound lo">${SL_MIN}</span><span class="bound hi">${SL_MAX}</span>` +
      `<span class="band" style="left:${at(SL_CURRENT[0])};width:calc(${at(SL_CURRENT[1])} - ${at(SL_CURRENT[0])})" title="where the line operates today">current performance</span>` +
      `<span class="tick" style="left:${at(SL_STANDARD)}" title="common contact-centre target">industry standard</span>`;
    renderControlFeedback();
    loadFooter();
    refresh();
  }
  init();
  // Chrome may restore form state after scripts ran (reload, back/forward),
  // which would silently change the queue model or weighting under the
  // user. pageshow fires after that restore, so defaults are reasserted.
  window.addEventListener("pageshow", (e) => { if (e.persisted) init(); });
})();
````

## web/logic.js

````js
/* Pure functions behind the staffing grid. No DOM, no fetch.
 *
 * Loaded by index.html after erlang.js, and required under node by
 * tests/test_web.py. Everything the page displays is derived here from the
 * cached forecast (predicted calls + handle time per hour) and the control
 * values, so each number stays traceable and testable without a browser.
 */
const V4WUI = (() => {
  "use strict";
  const E = typeof V4W !== "undefined" ? V4W : require("./erlang.js");
  const MAX_STAFF_PER_SHIFT = E.MAX_STAFF_PER_SHIFT;
  const SECONDS_PER_HOUR = E.SECONDS_PER_HOUR;
  const HOURS = Array.from({ length: 24 }, (_, i) => i);

  // The partner's three tours. `core` hours are counted once (calls, person-
  // hours); the `boundary` hour is the 30-minute overlap at the tour's end and
  // joins the staffing peak of both adjacent tours but is never double-counted.
  // Evening's boundary is hour 0 of the NEXT date.
  const SHIFTS = [
    { name: "Overnight", short: "O", span: "00:00 to 08:30", core: HOURS.slice(0, 8), boundary: { hour: 8, nextDay: false } },
    { name: "Day", short: "D", span: "08:00 to 16:30", core: HOURS.slice(8, 16), boundary: { hour: 16, nextDay: false } },
    { name: "Evening", short: "E", span: "16:00 to 00:30", core: HOURS.slice(16, 24), boundary: { hour: 0, nextDay: true } },
  ];
  const SHIFT_NAMES = SHIFTS.map((s) => s.name);
  const VERDICTS = ["understaffed", "on target", "overstaffed", "exceeds capacity"];
  const PEAK_HOUR_COUNT = 4;          // hours underlined on the time axis
  const STORAGE_KEY = "v4w.planned.v1";

  const key = (date, hour) => `${date}:${hour}`;
  const shiftKey = (date, shift) => `${date}|${shift}`;

  // ---------------------------------------------------------------------------
  // Cap states. Three distinct situations with three distinct remedies:
  // under = fine; at = no headroom; over = the roster cannot do this.
  // ---------------------------------------------------------------------------
  function capState(staff) {
    if (staff === null || staff === undefined) return "undef";
    if (staff > MAX_STAFF_PER_SHIFT) return "over";
    if (staff === MAX_STAFF_PER_SHIFT) return "at";
    return "under";
  }

  // Service level if an over-cap hour were clamped to the cap: the consequence
  // of "we only have 7". The recommendation itself is never clamped.
  function clampedServiceLevel(row, c) {
    const effective = Math.floor(MAX_STAFF_PER_SHIFT * c.efficiency);
    return E.serviceLevel(effective, row.load_erlangs, row.aht_sec, c.targetSec, c.patienceSec);
  }

  // ---------------------------------------------------------------------------
  // Discrete colour scale: one step per integer across the observed under-cap
  // range. Four legible steps beat a gradient nobody can decode.
  // ---------------------------------------------------------------------------
  function discreteScale(staffValues) {
    const under = staffValues.filter((s) => capState(s) === "under");
    if (under.length === 0) return { lo: 0, hi: 0, steps: 1, levelOf: () => 0 };
    const lo = Math.min(...under), hi = Math.max(...under), steps = hi - lo + 1;
    const levelOf = (s) => (steps === 1 ? 1 : (s - lo) / (steps - 1));   // 0..1 in equal integer steps
    return { lo, hi, steps, levelOf };
  }

  // ---------------------------------------------------------------------------
  // Staffing for every hour, from the cached forecast and the controls.
  // ---------------------------------------------------------------------------
  function computeHours(baseHours, c) {
    return baseHours.map((h) => {
      const r = E.staffForHour(h.predicted_calls, h.aht_sec, c.efficiency, c.targetPct, c.targetSec, c.patienceSec);
      const state = capState(r.staff_to_schedule);
      return {
        date: h.date, hour: h.hour, ...r, cap_state: state,
        service_level_if_capped: state === "over" ? clampedServiceLevel(r, c) : null,
      };
    });
  }

  // How many cells changed their recommendation between two recomputes.
  function diffCells(prev, next) {
    if (!prev || prev.length !== next.length) return next.length;
    let n = 0;
    for (let i = 0; i < next.length; i++) if (prev[i].staff_to_schedule !== next[i].staff_to_schedule) n++;
    return n;
  }

  // ---------------------------------------------------------------------------
  // Shift roll-up. Mirrors db/staffing.rollup_shifts: staffing = max over core
  // hours plus the overlap hour; calls and person-hours = core hours only.
  // ---------------------------------------------------------------------------
  function shiftHours(byKey, date, nextDate, spec) {
    const core = spec.core.map((h) => byKey.get(key(date, h))).filter(Boolean);
    const bKey = spec.boundary.nextDay ? (nextDate ? key(nextDate, spec.boundary.hour) : null) : key(date, spec.boundary.hour);
    const all = bKey && byKey.has(bKey) ? [...core, byKey.get(bKey)] : core;
    return { core, all };
  }

  function rollupShifts(days, hours) {
    const byKey = new Map(hours.map((h) => [key(h.date, h.hour), h]));
    const dates = days.map((d) => d.date);
    return days.map((day, i) => {
      const shifts = {};
      SHIFTS.forEach((spec) => {
        const { core, all } = shiftHours(byKey, day.date, dates[i + 1], spec);
        const staff = all.map((r) => r.staff_to_schedule);
        const undefined_ = staff.some((s) => s === null) || all.length === 0;
        const peak = undefined_ ? null : Math.max(...staff);
        shifts[spec.name] = {
          predicted_calls: core.reduce((a, r) => a + r.predicted_calls, 0),
          agents_required: all.length ? Math.max(...all.map((r) => r.agents_required)) : 0,
          staff_needed: peak,
          capped: peak === null ? null : peak > MAX_STAFF_PER_SHIFT,
          person_hours: undefined_ ? null : core.reduce((a, r) => a + r.staff_to_schedule, 0),
          service_level_delivered: undefined_ ? null : Math.min(...all.map((r) => r.service_level_delivered)),
          abandon_share: undefined_ || all.some((r) => r.abandon_share === null) ? null : Math.max(...all.map((r) => r.abandon_share)),
          hours: all,
        };
      });
      const totals = Object.values(shifts).map((s) => s.person_hours);
      return { ...day, shifts, person_hours: totals.some((t) => t === null) ? null : totals.reduce((a, b) => a + b, 0) };
    });
  }

  // ---------------------------------------------------------------------------
  // Planned roster: the supervisor's number per (date, shift) against ours.
  // ---------------------------------------------------------------------------
  function verdict(planned, recommended) {
    if (planned > MAX_STAFF_PER_SHIFT) return "exceeds capacity";
    if (planned < recommended) return "understaffed";
    if (planned > recommended) return "overstaffed";
    return "on target";
  }

  // What `planned` people deliver for every hour of a shift: the same chain as
  // staffForHour evaluated at the supervisor's number. Worst hour reported.
  function plannedOutcome(rows, planned, c) {
    if (c.efficiency === 0 || rows.length === 0) return { effective_agents: null, service_level: null, abandon_share: null };
    const effective = Math.floor(planned * c.efficiency);
    const levels = rows.map((r) => E.serviceLevel(effective, r.load_erlangs, r.aht_sec, c.targetSec, c.patienceSec));
    const abandons = rows.map((r) => E.abandonShare(effective, r.load_erlangs, r.aht_sec, c.targetSec, c.patienceSec));
    const known = abandons.filter((a) => a !== null);
    return { effective_agents: effective, service_level: Math.min(...levels), abandon_share: known.length ? Math.max(...known) : null };
  }

  // Persistence for planned values. Only the supervisor's own entries are
  // stored (never our defaults), so untouched shifts keep following the
  // recommendation when controls change. Every storage call is guarded: a
  // private window or a blocked origin must not break the page.
  function createPlannedStore(storage) {
    function read() {
      try {
        const raw = storage && storage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" ? parsed : {};
      } catch (_) { return {}; }
    }
    function write(data) {
      try { if (storage) storage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (_) { /* storage unavailable: in-memory only */ }
    }
    let memory = read();
    return {
      get(date, shift) { const v = memory[shiftKey(date, shift)]; return Number.isInteger(v) ? v : null; },
      set(date, shift, value) {
        const next = { ...memory };
        if (value === null || value === undefined) delete next[shiftKey(date, shift)]; else next[shiftKey(date, shift)] = value;
        memory = next; write(next);
      },
      clear() { memory = {}; write({}); },
      size() { return Object.keys(memory).length; },
    };
  }

  // Planned value + verdict + consequence for every shift of every day.
  function judgeRoster(rolled, store, c) {
    return rolled.map((day) => {
      const judged = {};
      SHIFT_NAMES.forEach((name) => {
        const s = day.shifts[name];
        const rec = s.staff_needed;
        const own = store.get(day.date, name);
        const planned = own !== null ? own : rec;
        judged[name] = rec === null || planned === null
          ? { planned, recommended: rec, delta: null, verdict: null, is_own: own !== null, service_level: null, abandon_share: null, effective_agents: null }
          : { planned, recommended: rec, delta: planned - rec, verdict: verdict(planned, rec), is_own: own !== null, ...plannedOutcome(s.hours, planned, c) };
      });
      return { ...day, planned: judged };
    });
  }

  // ---------------------------------------------------------------------------
  // Summaries: whole window, a drag selection, or one day.
  // ---------------------------------------------------------------------------
  function summarize(hours) {
    const calls = hours.reduce((a, h) => a + h.predicted_calls, 0);
    const talkSec = hours.reduce((a, h) => a + h.load_erlangs * SECONDS_PER_HOUR, 0);
    const staffed = hours.map((h) => h.staff_to_schedule);
    const personHours = staffed.some((s) => s === null) ? null : staffed.reduce((a, s) => a + s, 0);
    const peakStaff = staffed.some((s) => s === null) || !staffed.length ? null : Math.max(...staffed);
    const known = hours.filter((h) => h.abandon_share !== null);
    const abandoned = known.length ? known.reduce((a, h) => a + h.predicted_calls * h.abandon_share, 0) : null;
    return { n: hours.length, calls, talkSec, meanAht: calls > 0 ? talkSec / calls : null, personHours, peakStaff, abandoned };
  }

  // Expected abandoned calls if every hour scheduled ONE FEWER person. Mirrors
  // api.main._abandoned_one_fewer. This is what the slack buys.
  function abandonedOneFewer(hours, c) {
    if (c.patienceSec === null || c.efficiency === 0 || hours.some((h) => h.staff_to_schedule === null)) return null;
    return hours.reduce((a, h) => {
      const effective = Math.floor(Math.max(h.staff_to_schedule - 1, 0) * c.efficiency);
      return a + h.predicted_calls * E.abandonShare(effective, h.load_erlangs, h.aht_sec, c.targetSec, c.patienceSec);
    }, 0);
  }

  function dayStats(day, dayHours) {
    const s = summarize(dayHours);
    const peakHour = dayHours.length ? dayHours.reduce((a, b) => (b.predicted_calls > a.predicted_calls ? b : a)) : null;
    return {
      ...s,
      peakHour: peakHour ? peakHour.hour : null,
      atCap: dayHours.filter((h) => h.cap_state === "at").map((h) => h.hour),
      overCap: dayHours.filter((h) => h.cap_state === "over").map((h) => h.hour),
      shifts: day.shifts, planned: day.planned,
    };
  }

  // Hours of the day that carry the most calls across the loaded window.
  function peakHours(hours, count = PEAK_HOUR_COUNT) {
    const sum = new Array(24).fill(0), n = new Array(24).fill(0);
    hours.forEach((h) => { sum[h.hour] += h.predicted_calls; n[h.hour] += 1; });
    return HOURS.filter((h) => n[h] > 0).map((h) => [h, sum[h] / n[h]]).sort((a, b) => b[1] - a[1]).slice(0, count).map(([h]) => h);
  }

  // ---------------------------------------------------------------------------
  // CSV export: the full hourly table plus the shift's planned value and
  // verdict on every hour of that shift. Values are unrounded.
  // ---------------------------------------------------------------------------
  const CSV_COLUMNS = ["date", "hour", "shift", "predicted_calls", "aht_sec", "load_erlangs", "agents_required",
    "staff_to_schedule", "effective_agents", "service_level_delivered", "abandon_share", "cap_state",
    "service_level_if_capped", "planned_shift_staff", "verdict", "service_level_at_planned"];

  function shiftOfHour(hour) { return SHIFTS.find((s) => s.core.includes(hour)).name; }

  function csvRows(hours, judgedDays) {
    const byDate = new Map(judgedDays.map((d) => [d.date, d]));
    return hours.map((h) => {
      const name = shiftOfHour(h.hour);
      const day = byDate.get(h.date);
      const p = day && day.planned ? day.planned[name] : null;
      return {
        date: h.date, hour: h.hour, shift: name, predicted_calls: h.predicted_calls, aht_sec: h.aht_sec,
        load_erlangs: h.load_erlangs, agents_required: h.agents_required, staff_to_schedule: h.staff_to_schedule,
        effective_agents: h.effective_agents, service_level_delivered: h.service_level_delivered,
        abandon_share: h.abandon_share, cap_state: h.cap_state, service_level_if_capped: h.service_level_if_capped,
        planned_shift_staff: p ? p.planned : null, verdict: p ? p.verdict : null, service_level_at_planned: p ? p.service_level : null,
      };
    });
  }

  function csvCell(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function toCsv(rows, columns = CSV_COLUMNS) {
    const lines = [columns.join(",")];
    rows.forEach((r) => lines.push(columns.map((c) => csvCell(r[c])).join(",")));
    return lines.join("\n") + "\n";
  }

  return { HOURS, SHIFTS, SHIFT_NAMES, VERDICTS, CSV_COLUMNS, STORAGE_KEY, MAX_STAFF_PER_SHIFT, SECONDS_PER_HOUR,
    key, shiftKey, capState, clampedServiceLevel, discreteScale, computeHours, diffCells, rollupShifts, verdict,
    plannedOutcome, createPlannedStore, judgeRoster, summarize, abandonedOneFewer, dayStats, peakHours,
    shiftOfHour, csvRows, toCsv };
})();

if (typeof module !== "undefined" && module.exports) module.exports = V4WUI;
````

## web/erlang.js

````js
/* Client-side port of db/erlang.py + db/staffing.py (staff_for_hour).
 *
 * Exists so slider moves recompute every cell without a round trip. It is a
 * deliberate duplicate of the Python, line for line, and tests/test_erlang_js.py
 * pins it to the Python output over a grid of inputs. Change both or neither.
 *
 * Field names follow the /api/forecast hour row so the page treats server
 * rows and client rows identically.
 */
const V4W = (() => {
  "use strict";
  const MAX_AGENTS = 1000;
  const SECONDS_PER_HOUR = 3600;
  const QUEUE_MASS_CUTOFF = 1e-14;
  const MAX_QUEUE_STATES = 4000;
  const MAX_QUEUE_AHEAD = 400;
  const UNIFORMIZATION_TAIL = 1e-12;
  const MAX_UNIFORMIZATION_STEPS = 100000;
  const MAX_STAFF_PER_SHIFT = 7;
  const MAX_PLAUSIBLE_STAFF = 50;
  const ZERO_EFFICIENCY_REASON =
    "efficiency is 0: no scheduled person is ever free for inbound calls, so people to schedule is undefined";

  // db/erlang.py: erlang_c
  function erlangC(agents, load) {
    if (load <= 0) return 0.0;
    if (agents <= 0 || agents <= load) return 1.0;
    let blocking = 1.0;
    for (let k = 1; k <= agents; k++) blocking = (load * blocking) / (k + load * blocking);
    const waiting = (agents * blocking) / (agents - load * (1.0 - blocking));
    return Math.min(1.0, Math.max(0.0, waiting));
  }

  // db/erlang.py: _queue_state_probabilities
  function queueStateProbabilities(agents, load, mu, theta) {
    const lam = load * mu;
    const weights = [1.0];
    let weight = 1.0, n = 1, largest = 1.0;
    for (;;) {
      const death = Math.min(n, agents) * mu + Math.max(n - agents, 0) * theta;
      weight = (weight * lam) / death;
      weights.push(weight);
      largest = Math.max(largest, weight);
      if (n > agents && weight < QUEUE_MASS_CUTOFF * largest) break;
      if (n >= agents + MAX_QUEUE_STATES) break;
      n += 1;
    }
    const total = weights.reduce((a, w) => a + w, 0);
    return weights.map((w) => w / total);
  }

  // db/erlang.py: _survives_and_answered_within (uniformization)
  function survivesAndAnsweredWithin(rates, theta, t) {
    const stages = rates.length;
    const clock = Math.max(...rates.map((r) => r + theta));
    if (clock <= 0 || t <= 0) return 0.0;
    let alive = new Array(stages).fill(0.0);
    alive[stages - 1] = 1.0;
    let answeredByStep = 0.0, poisson = Math.exp(-clock * t), cumulative = 0.0, m = 0, total = 0.0;
    while (cumulative < 1.0 - UNIFORMIZATION_TAIL) {
      total += poisson * answeredByStep;
      cumulative += poisson;
      const next = new Array(stages).fill(0.0);
      for (let i = 0; i < stages; i++) {
        const mass = alive[i];
        if (mass === 0.0) continue;
        const forward = (mass * rates[i]) / clock;
        if (i === 0) answeredByStep += forward; else next[i - 1] += forward;
        next[i] += mass * (1.0 - (rates[i] + theta) / clock);
      }
      alive = next;
      m += 1;
      poisson *= (clock * t) / m;
      if (m > MAX_UNIFORMIZATION_STEPS) break;
    }
    return Math.min(1.0, Math.max(0.0, total));
  }

  // db/erlang.py: erlang_a
  function erlangA(agents, load, ahtSec, patienceSec, targetSec) {
    if (load <= 0) return { wait_prob: 0.0, abandon_prob: 0.0, service_level: 1.0 };
    if (agents <= 0) return { wait_prob: 1.0, abandon_prob: 1.0, service_level: 0.0 };
    if (ahtSec <= 0 || patienceSec <= 0) throw new RangeError(`aht_sec and patience_sec must be > 0, got ${ahtSec}, ${patienceSec}`);
    const mu = 1.0 / ahtSec, theta = 1.0 / patienceSec;
    const pi = queueStateProbabilities(agents, load, mu, theta);
    let waitProb = 0.0, abandonProb = 0.0, answeredWithin = 0.0;
    for (let n = 0; n < pi.length; n++) {
      if (n < agents) { answeredWithin += pi[n]; continue; }
      const ahead = n - agents, p = pi[n];
      waitProb += p;
      if (ahead > MAX_QUEUE_AHEAD) { abandonProb += p; continue; }
      const rates = [];
      for (let i = 0; i <= ahead; i++) rates.push(agents * mu + i * theta);
      let survive = 1.0;
      for (const r of rates) survive *= r / (r + theta);
      abandonProb += p * (1.0 - survive);
      answeredWithin += p * survivesAndAnsweredWithin(rates, theta, targetSec);
    }
    const clamp = (x) => Math.min(1.0, Math.max(0.0, x));
    return { wait_prob: clamp(waitProb), abandon_prob: clamp(abandonProb), service_level: clamp(answeredWithin) };
  }

  // db/erlang.py: required_agents (patienceSec null = Erlang C)
  function requiredAgents(callsPerHour, ahtSec, targetPct, targetSec, patienceSec = null) {
    if (callsPerHour === 0) return 0;
    if (callsPerHour < 0) throw new RangeError(`calls_per_hour must be >= 0, got ${callsPerHour}`);
    if (ahtSec <= 0) throw new RangeError(`aht_sec must be > 0, got ${ahtSec}`);
    if (!(targetPct > 0 && targetPct <= 1)) throw new RangeError(`target_pct must be in (0, 1], got ${targetPct}`);
    if (targetSec < 0) throw new RangeError(`target_sec must be >= 0, got ${targetSec}`);
    const load = (callsPerHour * ahtSec) / SECONDS_PER_HOUR;
    if (patienceSec !== null && patienceSec <= 0) throw new RangeError(`patience_sec must be > 0, got ${patienceSec}`);
    let agents = patienceSec !== null ? 1 : Math.ceil(load) + 1;
    while (agents <= MAX_AGENTS) {
      const sl = patienceSec === null
        ? 1.0 - erlangC(agents, load) * Math.exp((-(agents - load) * targetSec) / ahtSec)
        : erlangA(agents, load, ahtSec, patienceSec, targetSec).service_level;
      if (sl >= targetPct) return agents;
      agents += 1;
    }
    throw new RangeError(`no staffing level up to ${MAX_AGENTS} agents reaches the target for load ${load}`);
  }

  // db/staffing.py: _service_level
  function serviceLevel(agents, load, ahtSec, targetSec, patienceSec = null) {
    if (agents <= 0) return 0.0;
    if (patienceSec !== null) return erlangA(agents, load, ahtSec, patienceSec, targetSec).service_level;
    return 1.0 - erlangC(agents, load) * Math.exp((-(agents - load) * targetSec) / ahtSec);
  }

  // db/staffing.py: _abandon_share
  function abandonShare(agents, load, ahtSec, targetSec, patienceSec) {
    if (patienceSec === null) return null;
    if (agents <= 0) return load > 0 ? 1.0 : 0.0;
    return erlangA(agents, load, ahtSec, patienceSec, targetSec).abandon_prob;
  }

  // db/staffing.py: schedule_people
  function schedulePeople(agentsRequired, efficiency) {
    if (!(efficiency >= 0 && efficiency <= 1)) throw new RangeError(`efficiency must be in [0, 1], got ${efficiency}`);
    if (efficiency === 0) return [null, null];
    const scheduled = Math.ceil(agentsRequired / efficiency);
    return [scheduled, Math.floor(scheduled * efficiency)];
  }

  function implausibleReason(scheduled) {
    if (scheduled <= MAX_PLAUSIBLE_STAFF) return null;
    return `${scheduled} people in one hour exceeds the plausible bound of ${MAX_PLAUSIBLE_STAFF} for this line; the efficiency input is not actionable`;
  }

  // db/staffing.py: staff_for_hour, with API hour-row field names
  function staffForHour(predictedCalls, ahtSec, efficiency, targetPct, targetSec, patienceSec = null) {
    if (predictedCalls < 0) throw new RangeError(`predicted_offered must be >= 0, got ${predictedCalls}`);
    if (patienceSec === undefined) patienceSec = null;
    const load = (predictedCalls * ahtSec) / SECONDS_PER_HOUR;
    const agents = requiredAgents(predictedCalls, ahtSec, targetPct, targetSec, patienceSec);
    const [scheduled, effective] = schedulePeople(agents, efficiency);
    const queueModel = patienceSec === null ? "erlang_c" : "erlang_a";
    const base = { predicted_calls: predictedCalls, aht_sec: ahtSec, load_erlangs: load, agents_required: agents,
                   queue_model: queueModel, patience_sec: patienceSec };
    if (scheduled === null) {
      return { ...base, staff_to_schedule: null, effective_agents: null, service_level_delivered: null,
               over_cap: null, implausible: false, reason: ZERO_EFFICIENCY_REASON, abandon_share: null };
    }
    const reason = implausibleReason(scheduled);
    return { ...base, staff_to_schedule: scheduled, effective_agents: effective,
             service_level_delivered: serviceLevel(effective, load, ahtSec, targetSec, patienceSec),
             over_cap: scheduled > MAX_STAFF_PER_SHIFT, implausible: reason !== null, reason,
             abandon_share: abandonShare(effective, load, ahtSec, targetSec, patienceSec) };
  }

  return { erlangC, erlangA, requiredAgents, serviceLevel, abandonShare, schedulePeople, staffForHour,
           MAX_STAFF_PER_SHIFT, MAX_PLAUSIBLE_STAFF, SECONDS_PER_HOUR };
})();

if (typeof module !== "undefined" && module.exports) module.exports = V4W;
````
