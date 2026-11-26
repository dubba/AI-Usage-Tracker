"use strict";

/* ==========================================================================
   Illustrative data, shaped exactly like ActivityTracker:
   days[{ usedPercent, quality }], resets[], resetUsedPercent[].
   ========================================================================== */
const DAY = 86400000;
const TODAY = new Date();
TODAY.setHours(0, 0, 0, 0);
const DATES = Array.from({ length: 90 }, (_, i) => new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() - (89 - i)));
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const sum = (list) => list.reduce((a, b) => a + b, 0);
const mean = (list) => (list.length ? sum(list) / list.length : null);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pct = (v) => (v == null ? "—" : v > 0 && v < 1 ? "<1%" : Math.round(v) + "%");
const fmtShort = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
const fmtLong = (d) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const fmtWd = (d) => DOW[d.getDay()];
const fmtTime = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(":00", "").replace(" ", "");
const sod = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayIndexOf = (d) => Math.round((sod(d) - DATES[0]) / DAY);

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACCOUNTS = [
  { id: "grok", name: "Grok", plan: "SuperGrok/$30", email: "m.bahabib@yahoo.com", provider: "grok", hex: "#ff9f6e", seed: 11, startAt: 89, base: 0, target: 0, resetOffset: 6, resetHour: 0, spike: 0, est: [] },
  { id: "claude", name: "Claude123", plan: "Pro/$20", email: "m.bahabib@yahoo.com", provider: "anthropic", hex: "#a078ff", seed: 23, startAt: 0, base: 7.2, target: 84, resetOffset: 6, resetHour: 16, spike: 0.09, est: [78, 79] },
  { id: "chatgpt", name: "ChatGPT Work", plan: "Plus/$20", email: "work@studio.dev", provider: "openai", hex: "#6ecbff", seed: 41, startAt: 0, base: 4.4, target: 46, resetOffset: 3, resetHour: 10, spike: 0.05, est: [85, 86], gap: [72, 75], needsSignIn: true },
];

function build() {
  for (const a of ACCOUNTS) {
    const rnd = mulberry32(a.seed);
    a.days = [];
    for (let i = 0; i < 90; i++) {
      if (i < a.startAt || (a.gap && i >= a.gap[0] && i < a.gap[1])) {
        a.days.push({ v: null, q: "none" });
        continue;
      }
      const rhythm = [0.45, 1.12, 1.28, 1.06, 1.18, 0.94, 0.5][DATES[i].getDay()];
      let v = a.base * rhythm * (0.55 + rnd() * 0.9);
      if (rnd() < a.spike) v *= 2.3;
      a.days.push({ v: Math.max(0, v), q: (a.est || []).includes(i) ? "approximate" : "measured" });
    }

    const start = 89 - a.resetOffset;
    a.cycleStart = start;
    // Make the current cycle add up to the header percentage, ramping toward today so the
    // shape is believable rather than a flat block.
    if (a.target != null) {
      let weighted = 0;
      for (let i = start; i < 90; i++) {
        const w = 0.7 + 0.45 * ((i - start) / Math.max(1, 89 - start));
        weighted += (a.days[i].v ?? 0) * w;
      }
      const k = weighted > 0 ? a.target / weighted : 0;
      for (let i = start; i < 90; i++) {
        if (a.days[i].v == null) continue;
        const w = 0.7 + 0.45 * ((i - start) / Math.max(1, 89 - start));
        a.days[i].v *= k * w;
      }
    }
    a.current = Math.round(sum(a.days.slice(start).map((d) => d.v ?? 0)));

    a.resets = [];
    for (let s = start; s >= 0; s -= 7) {
      const date = new Date(DATES[s].getTime() + a.resetHour * 3600000);
      let used = null;
      if (s >= 7) {
        const prev = a.days.slice(s - 7, s).map((d) => d.v).filter((v) => v != null);
        if (prev.length) used = sum(prev);
      }
      a.resets.unshift({ date, index: s, used });
    }

    a.cycles = a.resets.map((r) => {
      const vals = [];
      for (let i = r.index; i < Math.min(r.index + 7, 90); i++) vals.push(a.days[i].v ?? 0);
      let acc = 0;
      const cum = vals.map((v) => (acc += v));
      return { start: r.index, vals, cum, total: acc, complete: r.index + 7 <= 90 };
    });

    a.observed = a.days.filter((d) => d.v != null).length;
    a.peak = Math.max(0, ...a.days.map((d) => d.v ?? 0));
    a.nextReset = new Date(a.resets[a.resets.length - 1].date.getTime() + 7 * DAY);
  }
}
build();

/* ==========================================================================
   Small pieces
   ========================================================================== */
function icon(provider) {
  if (provider === "anthropic") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><g stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M12 3.4v17.2M3.4 12h17.2M5.9 5.9l12.2 12.2M18.1 5.9L5.9 18.1"/></g></svg>`;
  }
  if (provider === "openai") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.7l7.7 4.45v9.7L12 21.3l-7.7-4.45v-9.7z" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 7.4l3.9 2.25v4.7L12 16.6l-3.9-2.25v-4.7z" fill="none" stroke="currentColor" stroke-width="1.3" opacity=".65"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M6.4 17.6L17.6 6.4" stroke="currentColor" stroke-width="1.8"/></svg>`;
}

function acctHead(a) {
  const tone = a.current >= 90 ? "critical" : a.current >= 70 ? "warning" : "healthy";
  return `<header class="acct-head">
    <span class="grip" aria-hidden="true"></span>
    <span class="tile ${a.provider}">${icon(a.provider)}</span>
    <div class="ident">
      <div class="name-row"><h3 class="acct-name">${a.name}</h3><span class="plan">${a.plan}</span></div>
      <p class="email">${a.needsSignIn ? '<span class="attn-dot"></span>' : ""}${a.email}</p>
    </div>
    <div class="total ${tone}"><strong>${pct(a.current)}</strong><span>used this week</span></div>
  </header>`;
}

function notice(a) {
  return `<div class="notice"><span>${a.needsSignIn ? "Sign in again to keep tracking this account." : ""}</span><button type="button">Sign in again</button></div>`;
}

function statsHtml(a, n, labels, first) {
  const days = a.days.slice(-n);
  const dates = DATES.slice(-n);
  const today = first != null ? first : days[days.length - 1]?.v;
  let peak = -1;
  let peakIndex = -1;
  const seen = [];
  days.forEach((d, i) => {
    if (d.v == null) return;
    seen.push(d.v);
    if (d.v >= peak) {
      peak = d.v;
      peakIndex = i;
    }
  });
  const peakWhen = peakIndex === days.length - 1 ? "Today" : fmtShort(dates[peakIndex]);
  const avg = mean(seen);
  return `<div class="stats">
    <span>${labels[0]} <b>${pct(today ?? 0)}</b></span>
    ${peakIndex >= 0 ? `<span>${labels[1]} <b>${pct(peak)}</b> <span class="muted">(${peakWhen})</span></span>` : ""}
    ${avg != null ? `<span>${labels[2]} <b>${pct(avg)}</b> /day</span>` : ""}
  </div>`;
}

/* ---- 7 day bars: the current chart, kept ---- */
function barChart(a, labels = ["Today", "Peak", "Avg"]) {
  const days = a.days.slice(-7);
  const dates = DATES.slice(-7);
  const top = Math.max(15, Math.ceil(Math.max(0, ...days.map((d) => d.v ?? 0)) / 5) * 5);
  const ticks = [];
  for (let t = 0; t <= top; t += 5) ticks.push(t);
  const startIndex = 83;

  const resetMarks = a.resets
    .filter((r) => r.index >= startIndex)
    .map((r) => {
      const fraction = clamp((r.date - DATES[r.index]) / DAY, 0, 1);
      return { ...r, left: ((r.index - startIndex + fraction) / 7) * 100 };
    });

  const cols = days
    .map((d, i) => {
      const date = dates[i];
      const isToday = i === 6;
      const level = d.v == null ? "none" : d.q === "approximate" ? "est" : d.v === 0 ? "zero" : "";
      const height = d.v == null ? null : clamp((d.v / top) * 100, 0, 100);
      const tip = `${fmtLong(date)} · ${d.v == null ? "No data" : pct(d.v) + " of the weekly limit"}\n${d.q === "approximate" ? "Estimated — data did not refresh for part of the day" : d.q === "none" ? "Nothing observed" : "Measured"}`;
      return `<div class="col" data-tip="${tip}">
        <div class="bar ${level}" style="${height == null ? "" : `height:${height}%`}"></div>
      </div>`;
    })
    .join("");

  return `<div class="barchart" role="img" aria-label="${a.name}, last 7 days, daily usage as a percent of the weekly limit">
    <div class="yaxis" aria-hidden="true">
      ${ticks.filter((t) => t > 0).map((t) => `<span style="bottom:${(t / top) * 100}%">${t}%</span>`).join("")}
    </div>
    <div>
      <div class="plot">
        ${ticks.map((t) => `<span class="grid${t === 0 ? " base" : ""}" style="bottom:${(t / top) * 100}%"></span>`).join("")}
        <div class="cols">${cols}</div>
        ${resetMarks.map((r) => `<span class="reset-line" style="left:${r.left}%"></span>${r.used != null ? `<span class="reset-label" style="left:${r.left}%">${pct(r.used)}</span>` : ""}`).join("")}
      </div>
      <div class="xlabels">${dates.map((d, i) => `<span class="${i === 6 ? "today" : ""}">${i === 6 ? "Today" : fmtWd(d)}</span>`).join("")}</div>
    </div>
  </div>
  ${statsHtml(a, 7, labels)}`;
}

/* ==========================================================================
   Concept A — calendar heat
   ========================================================================== */
const LEVELS = (v) => (v == null ? "none" : v <= 0 ? "zero" : v < 4 ? "l1" : v < 8 ? "l2" : v < 12 ? "l3" : v < 16 ? "l4" : "l5");

function resetMap(a, startIndex) {
  const map = {};
  for (const r of a.resets) if (r.index >= startIndex) map[r.index] = r;
  return map;
}

function cellTip(a, cell, reset) {
  const v = cell.day.v;
  return `${fmtLong(cell.date)} · ${v == null ? "No data" : pct(v) + " of the weekly limit"}\n${cell.day.q === "approximate" ? "Estimated — part of the day was not measured" : cell.day.q === "none" ? "Nothing observed" : "Measured"}${reset ? `\nWeekly reset ${fmtTime(reset.date)}${reset.used != null ? ` · previous week ${pct(reset.used)}` : ""}` : ""}`;
}

/* 30 days: a real month grid. Each day is a tile with its number and value; the
   gutter column carries the calendar week's total, which is what the limit counts. */
function monthGrid(a) {
  const startIndex = 60;
  const startDate = DATES[startIndex];
  const lead = (startDate.getDay() + 6) % 7;
  const cells = Array.from({ length: lead }, () => null);
  for (let i = 0; i < 30; i++) cells.push({ day: a.days[startIndex + i], date: DATES[startIndex + i], index: startIndex + i });
  while (cells.length % 7) cells.push(null);
  const weeks = cells.length / 7;
  const weekStart0 = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() - lead);
  const resets = resetMap(a, startIndex);

  const tile = (cell) => {
    if (!cell) return `<span class="mtile void" aria-hidden="true"></span>`;
    const v = cell.day.v;
    const reset = resets[cell.index];
    const cls = ["mtile", LEVELS(v), cell.day.q === "approximate" ? "est" : "", cell.date.getTime() === TODAY.getTime() ? "today" : "", reset ? "reset" : ""].filter(Boolean).join(" ");
    return `<span class="${cls}" data-tip="${cellTip(a, cell, reset)}">
      <span class="dnum">${cell.date.getDate()}</span>
      <span class="mval">${v == null ? "—" : pct(v)}</span>
    </span>`;
  };

  let body = `<div class="mrow mhead"><span class="mh-week">Week</span>${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<span class="mh-day">${d}</span>`).join("")}</div>`;
  for (let w = 0; w < weeks; w++) {
    const row = cells.slice(w * 7, w * 7 + 7);
    let total = 0;
    let seen = 0;
    row.forEach((c) => {
      if (c && c.day.v != null) {
        total += c.day.v;
        seen += 1;
      }
    });
    const start = new Date(weekStart0.getFullYear(), weekStart0.getMonth(), weekStart0.getDate() + w * 7);
    const partial = seen < 7;
    const tone = seen === 0 ? "" : total >= 100 ? "over" : total >= 80 ? "warm" : "";
    body += `<div class="mrow"><span class="mweek${partial ? " partial" : ""}" data-tip="${fmtShort(start)} – ${fmtShort(new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6))}\n${seen ? pct(total) + " of one weekly limit" : "No data"}${partial && seen ? `\n${seen} of 7 days recorded` : ""}">
      <b>${fmtShort(start)}</b><i class="${tone}">${seen ? pct(total) : "—"}</i>
    </span>${row.map(tile).join("")}</div>`;
  }

  return `<div class="month" role="img" aria-label="${a.name}, last 30 days as a calendar. Each tile is a day, shaded by how much of the weekly limit it used.">
      ${body}
    </div>
    <div class="heat-caption"><span>${fmtShort(startDate)} – ${fmtShort(DATES[89])} · ${weeks} weeks</span><span>Shade = share of the weekly limit</span></div>
  ${a.observed < 3 ? `<p class="detail-note">Tracking started today; history builds from here.</p>` : ""}
  ${statsHtml(a, 30, ["Today", "Peak", "Avg"])}`;
}

/* 90 days: a contribution-style quarter. 13 week columns, squares, plus the weekly
   total under each column so the weekly limit stays the unit of comparison. */
function quarterGrid(a) {
  const startIndex = 0;
  const startDate = DATES[startIndex];
  const lead = (startDate.getDay() + 6) % 7;
  const cells = Array.from({ length: lead }, () => null);
  for (let i = 0; i < 90; i++) cells.push({ day: a.days[i], date: DATES[i], index: i });
  while (cells.length % 7) cells.push(null);
  const weeks = cells.length / 7;
  const weekStart0 = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() - lead);
  const resets = resetMap(a, 0);

  const cell = (c) => {
    if (!c) return `<span class="qcell void" aria-hidden="true"></span>`;
    const reset = resets[c.index];
    const cls = ["qcell", LEVELS(c.day.v), c.day.q === "approximate" ? "est" : "", c.date.getTime() === TODAY.getTime() ? "today" : "", reset ? "reset" : ""].filter(Boolean).join(" ");
    return `<span class="${cls}" data-tip="${cellTip(a, c, reset)}"></span>`;
  };

  let grid = "";
  for (let w = 0; w < weeks; w++) for (let d = 0; d < 7; d++) grid += cell(cells[w * 7 + d]);

  const months = Array.from({ length: weeks }, (_, w) => {
    const date = new Date(weekStart0.getFullYear(), weekStart0.getMonth(), weekStart0.getDate() + w * 7);
    const prev = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 7);
    const show = w === 0 || date.getDate() <= 7 || (w === weeks - 1 && date.getMonth() !== prev.getMonth());
    return `<span class="${show ? "" : "hide"}">${date.toLocaleDateString("en-US", { month: "short" })}</span>`;
  }).join("");

  const totals = [];
  for (let w = 0; w < weeks; w++) {
    const row = cells.slice(w * 7, w * 7 + 7);
    let total = 0;
    let seen = 0;
    row.forEach((c) => {
      if (c && c.day.v != null) {
        total += c.day.v;
        seen += 1;
      }
    });
    const start = new Date(weekStart0.getFullYear(), weekStart0.getMonth(), weekStart0.getDate() + w * 7);
    totals.push({ total, seen, start, now: start <= TODAY && new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6) >= TODAY });
  }
  const max = Math.max(60, ...totals.map((t) => t.total));
  const scale = Math.ceil(max / 20) * 20;

  const strip = totals
    .map((t, w) => {
      const h = t.seen ? clamp(2 + (t.total / scale) * 30, 2, 32) : 0;
      const tip = `${fmtShort(t.start)} – ${fmtShort(new Date(t.start.getFullYear(), t.start.getMonth(), t.start.getDate() + 6))}\n${t.seen ? pct(t.total) + " of one weekly limit" : "No data"}${t.seen < 7 && t.seen ? `\n${t.seen} of 7 days recorded` : ""}`;
      const show = w === weeks - 1;
      return `<div class="wt${t.now ? " now" : ""}${t.seen && t.seen < 7 ? " partial" : ""}${t.seen ? "" : " empty"}" data-tip="${tip}">
        <div class="wt-track"><div class="wt-fill" style="height:${h}px"></div></div>
        ${show ? `<b>${t.seen ? pct(t.total) : "—"}</b>` : `<b>&nbsp;</b>`}
      </div>`;
    })
    .join("");

  return `<div class="quarter" style="--weeks:${weeks}" role="img" aria-label="${a.name}, the last 90 days as a grid of weeks and weekdays, shaded by how much of the weekly limit each day used">
      <div class="q-head" aria-hidden="true">${months}</div>
      <div class="q-days" aria-hidden="true">${["Mon", "", "Wed", "", "Fri", "", "Sun"].map((d) => `<span>${d}</span>`).join("")}</div>
      <div class="q-grid">${grid}</div>
      <div class="strip-head"><b>Weekly burn</b><span>each column's total · 100% = one weekly limit</span></div>
      <div class="strip-wrap"><div class="strip-grid">${strip}</div></div>
      <div class="heat-caption" style="grid-column:2"><span>${fmtShort(DATES[0])} – ${fmtShort(DATES[89])} · ${weeks} weeks</span><span>Each square is one day</span></div>
    </div>
  ${a.observed < 3 ? `<p class="detail-note">Tracking started today; history builds from here.</p>` : ""}
  ${statsHtml(a, 90, ["Today", "Peak", "Avg"])}`;
}

function heatChart(a, n) {
  return n === 30 ? monthGrid(a) : quarterGrid(a);
}

function renderA(n) {
  return `<div class="cards">${ACCOUNTS.map((a) => `<article class="card${a.needsSignIn ? " is-attn" : ""}">
    ${acctHead(a)}
    ${a.needsSignIn ? notice(a) : ""}
    <div class="chart-body">${n === 7 ? barChart(a) : heatChart(a, n)}</div>
  </article>`).join("")}</div>`;
}
