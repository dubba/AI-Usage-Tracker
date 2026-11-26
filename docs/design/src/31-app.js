/* ==========================================================================
   Concept B — weekly cycles
   ========================================================================== */
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const median = (list) => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const rolling = (list, k) => list.map((_, i) => mean(list.slice(Math.max(0, i - k + 1), i + 1)));

function chartIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>`;
}

function placeholder(a) {
  return `<div class="placeholder">${chartIcon()}<span>Not enough history yet${a.observed ? " for this account" : ""}. Tracking started today; the ${a.observed ? "weekly view fills" : "chart fills"} in over the next few days.</span></div>`;
}

function nextResetLabel(a) {
  const days = Math.round((sod(a.nextReset) - TODAY) / DAY);
  const when = days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
  return `Resets ${when} · ${fmtTime(a.nextReset)}`;
}

function burnup(a) {
  if (a.observed < 3) return placeholder(a);
  const cycles = a.cycles.slice(-5);
  const currentIndex = cycles.length - 1;
  const W = 560;
  const H = 196;
  const L = 34;
  const R = 14;
  const T = 12;
  const B = 28;
  const x = (i) => L + (i / 6) * (W - L - R);
  const y = (v) => T + (1 - clamp(v, 0, 110) / 110) * (H - T - B);

  let grid = "";
  for (const t of [0, 25, 50, 75, 100]) {
    grid += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="${t === 0 ? "glb" : "gl"}" />`;
    grid += `<text x="${L - 6}" y="${y(t) + 3}" text-anchor="end" class="t">${t}%</text>`;
  }

  const past = cycles
    .slice(0, -1)
    .map((c, i) => {
      const points = c.cum.map((v, d) => `${x(d)},${y(v)}`).join(" ");
      const alpha = 0.16 + 0.07 * (i + 1);
      return `<polyline id="cyc-${i}" class="cyc" points="${points}" fill="none" stroke="rgba(160,120,255,${alpha})" stroke-width="1.6" stroke-linejoin="round" />`;
    })
    .join("");

  const cur = cycles[currentIndex];
  const pts = cur.cum.map((v, d) => [x(d), y(v)]);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ");
  const area = `M${x(0)},${y(0)} L${pts.map((p) => `${p[0]},${p[1]}`).join(" L")} L${x(cur.cum.length - 1)},${y(0)} Z`;
  const dots = cur.cum
    .map((v, d) => {
      const date = addDays(DATES[cur.start], d);
      const recorded = a.days[cur.start + d]?.v != null;
      const tip = `${fmtWd(date)}, ${fmtShort(date)} · ${pct(v)} cumulative\n${pct(cur.vals[d])} used that day${recorded ? "" : " (estimated)"}`;
      return `<circle cx="${x(d)}" cy="${y(v)}" r="3.2" fill="#a078ff" stroke="#0e0e0e" stroke-width="1.5" data-tip="${tip}" />`;
    })
    .join("");

  const end = pts[pts.length - 1];
  const endAnchor = end[0] > W - 74 ? "end" : "start";
  const endLabel = `<text x="${end[0] + (endAnchor === "end" ? -8 : 8)}" y="${end[1] - 7}" text-anchor="${endAnchor}" fill="#d0bcff" font-size="11" font-weight="700">${pct(cur.total)}</text>`;

  const weekdays = Array.from({ length: 7 }, (_, i) => fmtWd(addDays(DATES[cur.start], i)));
  const xlabels = weekdays
    .map((d, i) => `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? "start" : i === 6 ? "end" : "middle"}" class="t">${d}</text>`)
    .join("");

  const chips = cycles
    .map((c, i) => {
      const ago = cycles.length - 1 - i;
      const name = ago === 0 ? "This week" : ago === 1 ? "Last week" : `${ago} wks ago`;
      return `<button type="button" class="chip${i === currentIndex ? " now" : ""}" data-cycle="${i}" aria-label="${name}, ${pct(c.total)} of the limit"><i></i>${name} · ${pct(c.total)}</button>`;
    })
    .join("");

  return `<div class="panel-head">
      <div><span class="panel-title">Weekly pace</span><span class="panel-sub">cumulative % of the limit</span></div>
      <span class="panel-note">${nextResetLabel(a)}</span>
    </div>
    <div class="chips">${chips}</div>
    <svg class="svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${a.name}: how each of the last ${cycles.length} weeks filled, day by day">
      ${grid}
      <line x1="${L}" y1="${y(100)}" x2="${W - R}" y2="${y(100)}" class="limit" />
      <text x="${W - R}" y="${y(100) - 5}" text-anchor="end" class="t">weekly limit</text>
      <line x1="${x(0)}" y1="${y(0)}" x2="${x(6)}" y2="${y(100)}" class="pace" />
      ${past}
      <path d="${area}" fill="rgba(160,120,255,.14)" />
      <path id="cyc-${currentIndex}" d="${line}" fill="none" stroke="#a078ff" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" />
      ${dots}
      ${endLabel}
      ${xlabels}
    </svg>
    <div class="pace-legend"><span><i></i>This week</span><span><i class="dash"></i>Even pace</span><span><i style="border-color:rgba(160,120,255,.35)"></i>Earlier weeks</span></div>`;
}

function weekTrend(a) {
  if (a.observed < 3) return placeholder(a);
  const cycles = a.cycles;
  const W = 560;
  const H = 126;
  const L = 34;
  const R = 10;
  const T = 10;
  const B = 24;
  const plotW = W - L - R;
  const slot = plotW / cycles.length;
  const bw = Math.max(8, slot * 0.56);
  const y = (v) => T + (1 - clamp(v, 0, 110) / 110) * (H - T - B);

  let grid = "";
  for (const t of [0, 50, 100]) {
    grid += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="${t === 0 ? "glb" : "gl"}" />`;
    grid += `<text x="${L - 6}" y="${y(t) + 3}" text-anchor="end" class="t">${t}%</text>`;
  }

  const bars = cycles
    .map((c, i) => {
      const h = Math.max(1.5, (clamp(c.total, 0, 110) / 110) * (H - T - B));
      const x = L + i * slot + (slot - bw) / 2;
      const isNow = i === cycles.length - 1;
      const recorded = a.days.slice(c.start, c.start + 7).filter((d) => d.v != null).length;
      const tip = `Week of ${fmtShort(DATES[c.start])} · ${pct(c.total)} of the limit\n${recorded < 7 ? `Partial data: ${recorded} of 7 days` : "Complete week"}${isNow ? "\nIn progress" : ""}`;
      return `<rect x="${x}" y="${H - B - h}" width="${bw}" height="${h}" rx="3" fill="${isNow ? "#a078ff" : "rgba(160,120,255,.48)"}" data-tip="${tip}" />`;
    })
    .join("");

  const avgPoints = cycles
    .map((_, i) => {
      if (i < 3) return null;
      const avg = mean(cycles.slice(i - 3, i + 1).map((c) => c.total));
      return `${L + i * slot + slot / 2},${y(avg)}`;
    })
    .filter(Boolean)
    .join(" ");

  const xlabels = cycles
    .map((c, i) => {
      const show = i === 0 || i === cycles.length - 1 || i % 3 === 0;
      return show ? `<text x="${L + i * slot + slot / 2}" y="${H - 8}" text-anchor="middle" class="t">${fmtShort(DATES[c.start])}</text>` : "";
    })
    .join("");

  return `<div class="panel-head">
      <div><span class="panel-title">Weekly fill</span><span class="panel-sub">how full each week got</span></div>
      <span class="panel-note">13 weeks</span>
    </div>
    <svg class="svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${a.name}: weekly fill for the last 13 weeks, with a four-week average">
      ${grid}
      <line x1="${L}" y1="${y(100)}" x2="${W - R}" y2="${y(100)}" class="limit" />
      ${bars}
      <polyline points="${avgPoints}" class="avgline" />
      ${xlabels}
    </svg>
    <div class="pace-legend"><span><i style="border-color:rgba(160,120,255,.5)"></i>Week total</span><span><i class="dash"></i>4-week average</span></div>`;
}

function paceCompare(a) {
  if (a.observed < 3) return placeholder(a);
  const cur = a.cycles[a.cycles.length - 1];
  const past = a.cycles.slice(0, -1);
  const typical = Array.from({ length: 7 }, (_, i) => {
    const vals = past.map((c) => c.cum[Math.min(i, c.cum.length - 1)]).filter((v) => v != null);
    return median(vals) ?? 0;
  });
  const W = 560;
  const H = 146;
  const L = 34;
  const R = 12;
  const T = 10;
  const B = 26;
  const x = (i) => L + (i / 6) * (W - L - R);
  const y = (v) => T + (1 - clamp(v, 0, 110) / 110) * (H - T - B);

  let grid = "";
  for (const t of [0, 50, 100]) {
    grid += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="${t === 0 ? "glb" : "gl"}" />`;
    grid += `<text x="${L - 6}" y="${y(t) + 3}" text-anchor="end" class="t">${t}%</text>`;
  }

  const pts = cur.cum.map((v, d) => [x(d), y(v)]);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]},${p[1]}`).join(" ");
  const area = `M${x(0)},${y(0)} L${pts.map((p) => `${p[0]},${p[1]}`).join(" L")} L${x(cur.cum.length - 1)},${y(0)} Z`;
  const typicalLine = typical.map((v, d) => `${x(d)},${y(v)}`).join(" ");
  const dots = cur.cum
    .map((v, d) => {
      const date = addDays(DATES[cur.start], d);
      return `<circle cx="${x(d)}" cy="${y(v)}" r="3" fill="#a078ff" stroke="#0e0e0e" stroke-width="1.4" data-tip="${fmtWd(date)}, ${fmtShort(date)} · ${pct(v)} cumulative\nTypical week at this point: ${pct(typical[d])}" />`;
    })
    .join("");

  const weekdays = Array.from({ length: 7 }, (_, i) => fmtWd(addDays(DATES[cur.start], i)));
  const xlabels = weekdays.map((d, i) => `<text x="${x(i)}" y="${H - 8}" text-anchor="${i === 0 ? "start" : i === 6 ? "end" : "middle"}" class="t">${d}</text>`).join("");

  return `<div class="panel-head">
      <div><span class="panel-title">Pace</span><span class="panel-sub">this week against your typical week</span></div>
      <span class="panel-note">${pct(cur.total)} so far</span>
    </div>
    <svg class="svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${a.name}: this week's cumulative usage against a typical week">
      ${grid}
      <polyline points="${typicalLine}" fill="none" stroke="#cbc3d7" stroke-width="1.5" stroke-dasharray="4 3" opacity=".8" />
      <path d="${area}" fill="rgba(160,120,255,.13)" />
      <path d="${line}" fill="none" stroke="#a078ff" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" />
      ${dots}
      ${xlabels}
    </svg>
    <div class="pace-legend"><span><i></i>This week</span><span><i class="dash"></i>Typical week (median of earlier weeks)</span></div>`;
}

function renderB(n) {
  return `<div class="cards">${ACCOUNTS.map((a) => {
    let body;
    if (n === 7) body = barChart(a, ["Today", "Peak", "Avg"]);
    else if (a.observed < 3) body = placeholder(a) + statsHtml(a, n, ["This week", "Best day", "Avg"], a.current);
    else if (n === 30) body = burnup(a) + statsHtml(a, n, ["This week", "Best day", "Avg"], a.current);
    else body = weekTrend(a) + paceCompare(a) + statsHtml(a, n, ["This week", "Best day", "Avg"], a.current);
    return `<article class="card${a.needsSignIn ? " is-attn" : ""}">
      ${acctHead(a)}
      ${a.needsSignIn ? notice(a) : ""}
      <div class="chart-body">${body}</div>
    </article>`;
  }).join("")}</div>`;
}

/* ==========================================================================
   Concept C — portfolio
   ========================================================================== */
function periodPeak(a, n) {
  const days = a.days.slice(-n);
  const dates = DATES.slice(-n);
  let best = { v: -1, date: null };
  days.forEach((d, i) => {
    if (d.v != null && d.v > best.v) best = { v: d.v, date: dates[i] };
  });
  return best;
}

function busiest(n) {
  let best = { v: -1 };
  for (const a of ACCOUNTS) {
    const p = periodPeak(a, n);
    if (p.v > best.v) best = { ...p, account: a };
  }
  return best;
}

function donut(p) {
  return `<svg class="donut" width="38" height="38" viewBox="0 0 40 40" aria-hidden="true">
    <circle cx="20" cy="20" r="15" fill="none" stroke="#2e2e2e" stroke-width="4" />
    <circle cx="20" cy="20" r="15" fill="none" stroke="#a078ff" stroke-width="4" stroke-linecap="round" pathLength="100" stroke-dasharray="${clamp(p, 0, 100)} 100" transform="rotate(-90 20 20)" />
  </svg>`;
}

function kpis(n) {
  const live = ACCOUNTS.filter((a) => !a.needsSignIn).length;
  const stale = ACCOUNTS.length - live;
  const avgUsed = mean(ACCOUNTS.map((a) => a.current)) ?? 0;
  const peak = busiest(n);
  const recent = mean(ACCOUNTS.map((a) => mean(a.days.slice(83, 90).map((d) => d.v).filter((v) => v != null))).filter((v) => v != null)) ?? 0;
  const prior = mean(ACCOUNTS.map((a) => mean(a.days.slice(76, 83).map((d) => d.v).filter((v) => v != null))).filter((v) => v != null)) ?? 0;
  const delta = recent - prior;
  const arrow = delta > 0.4 ? "▲" : delta < -0.4 ? "▼" : "→";
  const trendClass = delta > 0.4 ? "up" : delta < -0.4 ? "down" : "";
  const sparkVals = Array.from({ length: 14 }, (_, i) => sum(ACCOUNTS.map((a) => a.days[76 + i]?.v ?? 0)));
  const sparkMax = Math.max(1, ...sparkVals);
  const spark = sparkVals
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i / 13) * 62 + 2},${19 - (v / sparkMax) * 16}`)
    .join(" ");

  return `<div class="kpis">
    <div class="kpi">
      <div class="kpi-label">Tracked</div>
      <div class="kpi-value">${ACCOUNTS.length}</div>
      <div class="kpi-sub">${live} live${stale ? ` · <span class="stale">${stale} needs sign-in</span>` : ""}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Used this week</div>
      <div class="kpi-value">${pct(avgUsed)} ${donut(avgUsed)}</div>
      <div class="kpi-sub">average across accounts</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Busiest day</div>
      <div class="kpi-value">${peak.v >= 0 ? pct(peak.v) : "—"}</div>
      <div class="kpi-sub">${peak.account ? `${peak.account.name} · ${fmtShort(peak.date)}` : "No data"}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Daily burn trend</div>
      <div class="kpi-value">${delta >= 0 ? "+" : ""}${Math.abs(delta) < 0.4 ? "0" : delta.toFixed(0)} pts
        <svg width="66" height="21" viewBox="0 0 66 21" aria-hidden="true"><path d="${spark}" fill="none" stroke="#958ea0" stroke-width="1.4" stroke-linecap="round" /></svg>
      </div>
      <div class="kpi-sub"><span class="${trendClass}">${arrow}</span> vs previous 7 days</div>
    </div>
  </div>`;
}

function stackMax(series, n) {
  let max = 0;
  for (let i = 0; i < n; i++) max = Math.max(max, sum(series.map((s) => s.vals[i] ?? 0)));
  return Math.max(5, Math.ceil(max / 5) * 5);
}

function heroC(n) {
  const smooth = n > 7 ? 7 : 1;
  const series = ACCOUNTS.map((a) => ({
    a,
    vals: rolling(a.days.slice(-n).map((d) => d.v ?? 0), smooth),
  }));
  const max = stackMax(series, n);
  const legend = ACCOUNTS.map((a) => `<span class="legend-item"><i style="background:${a.hex}"></i>${a.name} <b>${pct(a.current)}</b>${a.needsSignIn ? ' <span class="stale">stale</span>' : ""}</span>`).join("");
  const sub = n === 7 ? "raw daily usage" : "7-day average";

  if (n === 7) {
    const step = max <= 15 ? 5 : 10;
    const top = Math.ceil(max / step) * step;
    const ticks = [];
    for (let t = 0; t <= top; t += step) ticks.push(t);
    const cols = Array.from({ length: 7 }, (_, i) => {
      const date = DATES[83 + i];
      const segs = ACCOUNTS.map((a) => ({ a, v: a.days[83 + i]?.v ?? 0 }));
      const total = sum(segs.map((s) => s.v));
      const tip = `${fmtLong(date)} · ${pct(total)} combined\n${segs.map((s) => `${s.a.name}: ${pct(s.v)}`).join("\n")}`;
      return `<div class="stack-col" data-tip="${tip}" style="justify-content:flex-end">
        ${segs.filter((s) => s.v > 0).reverse().map((s) => `<span style="height:${(s.v / top) * 100}%;background:${s.a.hex}"></span>`).join("")}
      </div>`;
    }).join("");
    return `<div class="hero">
      <div class="hero-head">
        <div><div class="hero-title">Combined burn</div><div class="hero-sub">Each account's daily usage, stacked · ${sub}</div></div>
        <div class="hero-legend">${legend}</div>
      </div>
      <div class="stack-chart">
        <div class="stack-yaxis">${ticks.filter((t) => t > 0).map((t) => `<span style="bottom:${(t / top) * 100}%">${t}%</span>`).join("")}</div>
        <div class="stack-plot">
          ${ticks.map((t) => `<span class="grid${t === 0 ? " base" : ""}" style="bottom:${(t / top) * 100}%"></span>`).join("")}
          <div class="stack-cols">${cols}</div>
        </div>
        <div class="stack-xlabels">${Array.from({ length: 7 }, (_, i) => `<span class="${i === 6 ? "today" : ""}">${i === 6 ? "Today" : fmtWd(DATES[83 + i])}</span>`).join("")}</div>
      </div>
    </div>`;
  }

  const W = 560;
  const H = 190;
  const L = 34;
  const R = 10;
  const T = 12;
  const B = 24;
  const x = (i) => L + (i / (n - 1)) * (W - L - R);
  const y = (v) => T + (1 - clamp(v, 0, max) / max) * (H - T - B);
  const step = max <= 20 ? 5 : max <= 60 ? 10 : 20;
  let grid = "";
  for (let t = 0; t <= max; t += step) {
    grid += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="${t === 0 ? "glb" : "gl"}" />`;
    grid += `<text x="${L - 6}" y="${y(t) + 3}" text-anchor="end" class="t">${t}%</text>`;
  }

  let lower = Array.from({ length: n }, () => 0);
  const fills = series.map((s) => {
    const upper = s.vals.map((v, i) => (lower[i] ?? 0) + (v ?? 0));
    const top = upper.map((v, i) => `${x(i)},${y(v)}`).join(" L");
    const bottom = lower.map((v, i) => `${x(i)},${y(v)}`).reverse().join(" L");
    const path = `M${top} L${bottom} Z`;
    const stroke = upper.map((v, i) => `${x(i)},${y(v)}`).join(" ");
    lower = upper;
    return `<path d="${path}" fill="${s.a.hex}" opacity=".28" /><polyline points="${stroke}" fill="none" stroke="${s.a.hex}" stroke-width="1.4" opacity=".85" />`;
  }).join("");

  const hits = Array.from({ length: n }, (_, i) => {
    const date = DATES[90 - n + i];
    const rows = ACCOUNTS.map((a) => `${a.name}: ${pct(a.days[90 - n + i]?.v ?? 0)}`).join("\n");
    return `<rect class="hit" x="${x(i) - (W - L - R) / (n - 1) / 2}" y="${T}" width="${(W - L - R) / (n - 1)}" height="${H - T - B}" data-tip="${fmtLong(date)}\n${rows}" />`;
  }).join("");

  const xlabels = Array.from({ length: 7 }, (_, k) => {
    const i = Math.round((k / 6) * (n - 1));
    return `<text x="${x(i)}" y="${H - 8}" text-anchor="${k === 0 ? "start" : k === 6 ? "end" : "middle"}" class="t">${k === 6 ? "Today" : fmtShort(DATES[90 - n + i])}</text>`;
  }).join("");

  return `<div class="hero">
    <div class="hero-head">
      <div><div class="hero-title">Combined burn</div><div class="hero-sub">Each account's daily usage, stacked · ${sub}</div></div>
      <div class="hero-legend">${legend}</div>
    </div>
    <svg class="svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Combined daily usage across all accounts, last ${n} days">
      ${grid}
      ${fills}
      ${hits}
      ${xlabels}
    </svg>
  </div>`;
}

function sparkline(a, n) {
  const vals = a.days.slice(-n).map((d) => d.v);
  if (vals.filter((v) => v != null).length < 2) return `<span class="r-num muted">No history yet</span>`;
  if (n === 7) {
    const max = Math.max(1, ...vals.map((v) => v ?? 0));
    const bars = vals.map((v, i) => {
      const h = v == null ? 2 : Math.max(2, (v / max) * 26);
      return `<rect x="${i * 17 + 2}" y="${28 - h}" width="12" height="${h}" rx="2" fill="${v == null ? "#3a3540" : a.hex}" opacity="${v == null ? 1 : 0.9}" />`;
    }).join("");
    return `<svg class="svg" viewBox="0 0 122 30" style="height:30px" aria-hidden="true">${bars}</svg>`;
  }
  const W = 130;
  const H = 30;
  const max = Math.max(1, ...vals.map((v) => v ?? 0));
  let d = "";
  let pen = false;
  vals.forEach((v, i) => {
    if (v == null) {
      pen = false;
      return;
    }
    const px = (i / (n - 1)) * (W - 4) + 2;
    const py = H - 3 - (v / max) * (H - 7);
    d += `${pen ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)} `;
    pen = true;
  });
  const lastIndex = vals.map((v, i) => (v != null ? i : -1)).filter((i) => i >= 0).pop();
  const lastV = vals[lastIndex];
  const dotX = (lastIndex / (n - 1)) * (W - 4) + 2;
  const dotY = H - 3 - (lastV / max) * (H - 7);
  return `<svg class="svg" viewBox="0 0 ${W} ${H}" style="height:30px" aria-hidden="true">
    <line x1="2" y1="${H - 3}" x2="${W - 2}" y2="${H - 3}" stroke="#2e2e2e" />
    <path d="${d}" fill="none" stroke="${a.hex}" stroke-width="1.5" stroke-linejoin="round" />
    <circle cx="${dotX}" cy="${dotY}" r="2" fill="${a.hex}" />
  </svg>`;
}

function detailArea(a, n) {
  const vals = a.days.slice(-n).map((d) => d.v);
  const max = Math.max(5, Math.ceil(Math.max(0, ...vals.map((v) => v ?? 0)) / 5) * 5);
  const W = 380;
  const H = 118;
  const L = 30;
  const R = 8;
  const T = 8;
  const B = 18;
  const x = (i) => L + (i / Math.max(1, n - 1)) * (W - L - R);
  const y = (v) => T + (1 - clamp(v, 0, max) / max) * (H - T - B);

  let grid = "";
  for (const t of [0, Math.round(max / 2), max]) {
    grid += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" class="${t === 0 ? "glb" : "gl"}" />`;
    grid += `<text x="${L - 5}" y="${y(t) + 3}" text-anchor="end" class="t">${t}%</text>`;
  }

  let line = "";
  let pen = false;
  let area = "";
  let segStart = null;
  vals.forEach((v, i) => {
    if (v == null) {
      if (pen && segStart != null) area += ` L${x(i - 1)},${y(0)} L${x(segStart)},${y(0)} Z`;
      pen = false;
      segStart = null;
      return;
    }
    if (!pen) {
      line += `M${x(i)},${y(v)} `;
      segStart = i;
      pen = true;
    } else {
      line += `L${x(i)},${y(v)} `;
    }
  });
  if (pen && segStart != null) area = `M${x(segStart)},${y(0)} ` + line.slice(line.lastIndexOf("M")) + ` L${x(segStart + 0)},${y(0)} Z`;

  // Rebuild the area cleanly per contiguous segment.
  area = "";
  let seg = [];
  const flush = () => {
    if (seg.length < 1) return;
    const first = seg[0][0];
    const last = seg[seg.length - 1][0];
    area += `M${x(first)},${y(0)} L${seg.map(([i, v]) => `${x(i)},${y(v)}`).join(" L")} L${x(last)},${y(0)} Z `;
    seg = [];
  };
  vals.forEach((v, i) => {
    if (v == null) flush();
    else seg.push([i, v]);
  });
  flush();

  const avg = rolling(vals.map((v) => v ?? 0), Math.min(7, n));
  const avgLine = avg.map((v, i) => `${x(i)},${y(v)}`).join(" ");

  const resetTicks = a.resets
    .filter((r) => r.index >= 90 - n)
    .map((r) => `<line x1="${x(r.index - (90 - n))}" x2="${x(r.index - (90 - n))}" y1="${T}" y2="${H - B}" stroke="rgba(160,120,255,.35)" stroke-width="1" stroke-dasharray="2 3" />`)
    .join("");

  const hits = vals.map((v, i) => {
    const date = DATES[90 - n + i];
    return `<rect class="hit" x="${x(i) - (W - L - R) / (n - 1) / 2}" y="${T}" width="${(W - L - R) / (n - 1)}" height="${H - T - B}" data-tip="${fmtLong(date)} · ${v == null ? "No data" : pct(v) + " of the limit"}" />`;
  }).join("");

  return `<svg class="svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${a.name}, daily usage over ${n} days">
    ${grid}
    ${resetTicks}
    <path d="${area}" fill="${a.hex}" opacity=".16" />
    <path d="${line}" fill="none" stroke="${a.hex}" stroke-width="1.8" stroke-linejoin="round" />
    <polyline points="${avgLine}" fill="none" stroke="#cbc3d7" stroke-width="1.2" stroke-dasharray="3 3" opacity=".65" />
    ${hits}
    <text x="${L}" y="${H - 4}" class="t">${fmtShort(DATES[90 - n])}</text>
    <text x="${W - R}" y="${H - 4}" text-anchor="end" class="t">Today</text>
  </svg>`;
}

function weekdayBars(a, n) {
  const totals = Array.from({ length: 7 }, () => []);
  a.days.slice(-n).forEach((d, i) => {
    if (d.v != null) totals[DATES[90 - n + i].getDay()].push(d.v);
  });
  const avgs = totals.map((list) => mean(list));
  const max = Math.max(1, ...avgs.map((v) => v ?? 0));
  const maxIndex = avgs.indexOf(Math.max(...avgs.map((v) => v ?? 0)));
  const order = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun
  const cols = order.map((d) => {
    const v = avgs[d];
    const h = v == null ? 0 : Math.max(2, (v / max) * 64);
    const tip = `${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d]}\n${v == null ? "No data" : pct(v) + " average per day"}`;
    return `<div class="wd-col" data-tip="${tip}">
      ${d === maxIndex && v != null ? `<span class="wd-max">${pct(v)}</span>` : ""}
      <div class="wd-bar" style="height:${h}px;background:${a.hex}"></div>
      <span>${DOW[d][0]}</span>
    </div>`;
  }).join("");
  return `<div class="wd" role="img" aria-label="Average usage by weekday">${cols}</div>`;
}

function rowDetail(a, n) {
  if (n === 7) return `<div class="chart-body">${barChart(a)}</div>`;
  if (a.observed < 3) return placeholder(a);
  return `<div class="detail-grid">
    <div><div class="detail-title">Daily usage</div>${detailArea(a, n)}<div class="detail-note">Dashed line: 7-day average. Vertical ticks: weekly resets.</div></div>
    <div><div class="detail-title">By weekday</div>${weekdayBars(a, n)}<div class="detail-note">Average % of the limit per day.</div></div>
  </div>
  ${statsHtml(a, n, ["Today", "Peak", "Avg"])}
  ${a.needsSignIn ? notice(a) : ""}`;
}

function rowC(a, n) {
  const days = a.days.slice(-n);
  const seen = days.map((d) => d.v).filter((v) => v != null);
  const peak = seen.length ? Math.max(...seen) : null;
  const avg = mean(seen);
  const tone = a.current >= 90 ? "crit" : a.current >= 70 ? "warn" : "";
  const open = a.id === "claude";
  const sub = a.needsSignIn
    ? `<span class="stale">Sign-in needed</span>`
    : `${a.plan} · ${a.email}`;
  return `<button type="button" class="row" data-expand="${a.id}" aria-expanded="${open}" aria-controls="detail-${a.id}">
      <span class="r-acct">
        <span class="r-tile ${a.provider}">${icon(a.provider)}</span>
        <span class="r-name"><b>${a.name}</b><span>${sub}</span></span>
      </span>
      <span class="r-spark">${sparkline(a, n)}</span>
      <span class="r-num ${tone}">${pct(a.current)}</span>
      <span class="r-num muted r-peak">${pct(peak)}</span>
      <span class="r-num muted r-avg">${avg == null ? "—" : pct(avg)}</span>
      <span class="r-chev"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></span>
    </button>
    <div class="row-detail" id="detail-${a.id}" ${open ? "" : "hidden"}>${rowDetail(a, n)}</div>`;
}

function renderC(n) {
  return `${kpis(n)}
    ${heroC(n)}
    <div class="rows-panel">
      <div class="rows-head"><span class="rows-title">Accounts</span><span class="rows-hint">Select a row for daily detail</span></div>
      <div class="row-cols" aria-hidden="true"><span>Account</span><span>${n}-day trend</span><span>This week</span><span>Peak</span><span>Avg</span><span></span></div>
      ${ACCOUNTS.map((a) => rowC(a, n)).join("")}
    </div>`;
}

/* ==========================================================================
   Page shell
   ========================================================================== */
const PERIOD_DAYS = { "7d": 7, "30d": 30, "90d": 90 };
const NOTES = {
  A: "Every day is a cell. On 30 days it is a real month grid, with each week's total in the gutter; on 90 days it is thirteen-plus weeks of squares, with each week's burn underneath. Patterns jump out and a quarter fits on one screen.",
  B: "The weekly limit resets, so the cycle is the unit. Longer ranges compare how fast each week filled, with an even-pace guide and week-over-week totals.",
  C: "A page-level summary first, then compact account rows. Detail opens in place, so the page scales to many accounts without a wall of tall cards.",
};
const DESCS = {
  A: "Track daily usage as a percentage of each account's weekly limit.",
  B: "How fast each week fills against the limit, and how this week compares with past ones.",
  C: "Daily usage against each account's weekly limit, with the whole portfolio in one place.",
};

const state = { concept: "A", period: "30d" };

function keyRow(concept) {
  let extra = "";
  if (concept === "A") {
    extra = `<span class="key-spacer"></span><span class="heat-scale">Less <i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i><i class="l5"></i> More</span>`;
  } else if (concept === "B") {
    extra = `<span class="key-spacer"></span><span class="key-hint"><i class="ln"></i>this week <i class="ln dash"></i>even pace</span>`;
  } else {
    extra = `<span class="key-spacer"></span><span class="key-hint">Rows expand for daily detail</span>`;
  }
  return `<span class="key-chip">KEY</span>
    <span class="key-item"><i class="sw meas"></i>Measured</span>
    <span class="key-item"><i class="sw est"></i>Estimated</span>
    <span class="key-item"><i class="sw none"></i>No data</span>
    <span class="key-item"><i class="sw reset"></i>Reset</span>
    ${extra}`;
}

function render() {
  const n = PERIOD_DAYS[state.period];
  document.querySelectorAll(".ctab").forEach((b) => {
    const on = b.dataset.concept === state.concept;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll("[data-period]").forEach((b) => {
    const on = b.dataset.period === state.period;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
  document.getElementById("note").textContent = NOTES[state.concept];
  document.getElementById("page-desc").textContent = DESCS[state.concept];
  document.getElementById("key").className = "key";
  document.getElementById("key").innerHTML = keyRow(state.concept);
  document.getElementById("view").innerHTML =
    state.concept === "A" ? renderA(n) : state.concept === "B" ? renderB(n) : renderC(n);
}

/* ---- events ---- */
document.querySelectorAll(".ctab").forEach((b) =>
  b.addEventListener("click", () => {
    state.concept = b.dataset.concept;
    render();
  }),
);
document.querySelectorAll("[data-period]").forEach((b) =>
  b.addEventListener("click", () => {
    state.period = b.dataset.period;
    render();
  }),
);

const view = document.getElementById("view");
view.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-expand]");
  if (!btn) return;
  const detail = document.getElementById("detail-" + btn.dataset.expand);
  const open = btn.getAttribute("aria-expanded") === "true";
  btn.setAttribute("aria-expanded", String(!open));
  detail.hidden = open;
});

view.addEventListener("pointerover", (e) => {
  const chip = e.target.closest("[data-cycle]");
  if (!chip) return;
  const path = document.getElementById("cyc-" + chip.dataset.cycle);
  if (path) path.classList.add("hot");
});
view.addEventListener("pointerout", (e) => {
  const chip = e.target.closest("[data-cycle]");
  if (!chip) return;
  const path = document.getElementById("cyc-" + chip.dataset.cycle);
  if (path) path.classList.remove("hot");
});

const tip = document.getElementById("tip");
function placeTip(e) {
  const pad = 14;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + w > window.innerWidth - 8) x = e.clientX - w - pad;
  if (y + h > window.innerHeight - 8) y = e.clientY - h - pad;
  tip.style.left = Math.max(8, x) + "px";
  tip.style.top = Math.max(8, y) + "px";
}
const mock = document.getElementById("mock");
mock.addEventListener("pointerover", (e) => {
  const t = e.target.closest("[data-tip]");
  if (!t) return;
  tip.textContent = t.getAttribute("data-tip");
  tip.classList.add("on");
  placeTip(e);
});
mock.addEventListener("pointermove", (e) => {
  if (tip.classList.contains("on")) placeTip(e);
});
mock.addEventListener("pointerout", (e) => {
  const t = e.target.closest("[data-tip]");
  if (!t) return;
  if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest("[data-tip]")) tip.classList.remove("on");
});
mock.addEventListener("click", (e) => {
  if (e.target.closest(".notice button")) e.preventDefault();
});

render();
