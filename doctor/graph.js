// HIVE — GRAPH ENGINE (shared by Lawyer & Doctor). Deterministic, offline, NO libraries:
// it renders a labelled bar or line chart as a self-contained SVG string from plain data.
// Same input -> identical SVG, every time. Used for tracking (blood pressure, weight, symptom
// scores; legal cost/interest projections, settlement comparisons) and for teaching people how
// a chart is built. No eval, no network, no fonts beyond the system stack.
"use strict";
(function (root) {
  const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  const PAL = ["#6f8dff", "#c9a227", "#49c98a", "#e06a6a", "#a97bd8", "#46c6ab"];

  // Parse free text into {labels, values}. Accepts "10, 20, 30" or "Jan:120, Feb:118, Mar:121".
  function parseSeries(text) {
    text = String(text || "");
    // If the input uses newlines or semicolons, those separate the points and commas inside a
    // value are thousands separators. Otherwise commas separate the points.
    const sep = /[\n;]/.test(text) ? /[\n;]+/ : /,+/;
    const parts = text.split(sep).map(s => s.trim()).filter(Boolean);
    const labels = [], values = [];
    parts.forEach((p, i) => {
      const m = p.match(/^(.*?)[:=]\s*(-?\d[\d,]*\.?\d*)$/);
      if (m) { labels.push(m[1].trim()); values.push(parseFloat(m[2].replace(/,/g, ""))); }
      else { const n = parseFloat(p.replace(/,/g, "")); if (!isNaN(n)) { labels.push(String(i + 1)); values.push(n); } }
    });
    return { labels, values };
  }

  // "nice" axis ceiling/step so gridlines land on round numbers.
  function niceBounds(min, max) {
    if (min === max) { max = min + 1; }
    min = Math.min(0, min);
    const range = max - min || 1;
    const rawStep = range / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const niceMax = Math.ceil(max / step) * step;
    const niceMin = Math.floor(min / step) * step;
    return { min: niceMin, max: niceMax, step };
  }
  function fmt(n) { return (Math.round(n * 100) / 100).toLocaleString("en-US"); }

  // buildChart({type, title, xLabel, yLabel, labels, series:[{name, values, color}], bands})
  // series may also be given as a single {values} or as a bare values array for convenience.
  function buildChart(spec) {
    spec = spec || {};
    const type = spec.type === "line" ? "line" : "bar";
    const W = spec.width || 440, H = spec.height || 260;
    const padL = 48, padR = 16, padT = spec.title ? 34 : 14, padB = 48;
    let series = spec.series;
    if (!series && Array.isArray(spec.values)) series = [{ values: spec.values }];
    series = (series || []).map((s, i) => Array.isArray(s) ? { values: s } : s).filter(s => s && s.values && s.values.length);
    if (!series.length) return `<svg viewBox="0 0 ${W} 60" xmlns="http://www.w3.org/2000/svg"><text x="12" y="34" fill="#9aa6b8" font="12px sans-serif">No data to plot.</text></svg>`;
    const labels = spec.labels && spec.labels.length ? spec.labels : series[0].values.map((_, i) => String(i + 1));
    const all = series.reduce((a, s) => a.concat(s.values), []);
    const b = niceBounds(Math.min(...all), Math.max(...all));
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const x0 = padL, y0 = H - padB;
    const yOf = v => y0 - ((v - b.min) / (b.max - b.min)) * plotH;
    let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(spec.title || "chart")}">`;
    svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="transparent"/>`;
    if (spec.title) svg += `<text x="${W / 2}" y="20" text-anchor="middle" fill="#eef1f6" font="600 14px sans-serif">${esc(spec.title)}</text>`;
    // gridlines + y labels
    for (let v = b.min; v <= b.max + 1e-9; v += b.step) {
      const y = yOf(v);
      svg += `<line x1="${x0}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" stroke="#ffffff" stroke-opacity="0.08"/>`;
      svg += `<text x="${x0 - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" fill="#9aa6b8" font="9px sans-serif">${fmt(v)}</text>`;
    }
    // optional reference bands (e.g., healthy range) [{from,to,color,label}]
    for (const band of (spec.bands || [])) {
      const yA = yOf(band.to), yB = yOf(band.from);
      svg += `<rect x="${x0}" y="${Math.min(yA, yB).toFixed(1)}" width="${plotW}" height="${Math.abs(yB - yA).toFixed(1)}" fill="${band.color || "#49c98a"}" opacity="0.12"/>`;
      if (band.label) svg += `<text x="${W - padR - 2}" y="${(Math.min(yA, yB) + 11).toFixed(1)}" text-anchor="end" fill="#9aa6b8" font="8.5px sans-serif">${esc(band.label)}</text>`;
    }
    const n = labels.length;
    const slot = plotW / n;
    if (type === "bar") {
      const bw = Math.max(4, (slot * 0.7) / series.length);
      series.forEach((s, si) => {
        const col = s.color || PAL[si % PAL.length];
        s.values.forEach((v, i) => {
          const bx = x0 + i * slot + slot * 0.15 + si * bw;
          const by = yOf(v), bh = y0 - by;
          svg += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" rx="2" fill="${col}" opacity="0.85"/>`;
        });
      });
    } else {
      series.forEach((s, si) => {
        const col = s.color || PAL[si % PAL.length];
        const pts = s.values.map((v, i) => `${(x0 + i * slot + slot / 2).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
        svg += `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="2"/>`;
        s.values.forEach((v, i) => { svg += `<circle cx="${(x0 + i * slot + slot / 2).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="3" fill="${col}"/>`; });
      });
    }
    // x labels (thin out if crowded)
    const every = Math.ceil(n / 10);
    labels.forEach((lab, i) => {
      if (i % every) return;
      svg += `<text x="${(x0 + i * slot + slot / 2).toFixed(1)}" y="${H - padB + 14}" text-anchor="middle" fill="#9aa6b8" font="9px sans-serif">${esc(lab)}</text>`;
    });
    // axis titles
    if (spec.xLabel) svg += `<text x="${(x0 + plotW / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" fill="#9aa6b8" font="10px sans-serif">${esc(spec.xLabel)}</text>`;
    if (spec.yLabel) svg += `<text x="12" y="${(padT + plotH / 2).toFixed(1)}" text-anchor="middle" fill="#9aa6b8" font="10px sans-serif" transform="rotate(-90 12 ${(padT + plotH / 2).toFixed(1)})">${esc(spec.yLabel)}</text>`;
    // legend
    if (series.length > 1 || series.some(s => s.name)) {
      let lx = x0;
      series.forEach((s, si) => {
        const col = s.color || PAL[si % PAL.length];
        const nm = s.name || ("Series " + (si + 1));
        svg += `<rect x="${lx}" y="${padT - 12}" width="9" height="9" rx="2" fill="${col}"/><text x="${lx + 13}" y="${padT - 4}" fill="#9aa6b8" font="9px sans-serif">${esc(nm)}</text>`;
        lx += 24 + nm.length * 5.4;
      });
    }
    svg += `</svg>`;
    return svg;
  }
  const GRAPH = { buildChart, parseSeries, niceBounds };
  if (typeof module !== "undefined") module.exports = GRAPH;
  else root.GRAPH = GRAPH;
})(typeof window !== "undefined" ? window : this);
