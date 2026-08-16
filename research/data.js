// Aura AI — research/data.js  (V2)
// Deterministic data-analysis layer for Deep Research. NO model calls:
// every number produced here is computed in code from the actual bytes the
// user uploaded, which makes the Data Analyst Agent's output auditable and
// testable. The model-based agents consume these summaries as evidence.
//
//   parseCsv(text)          → { columns, rows } (header + typed cells)
//   analyzeDataset(csv)     → per-column stats, group means, trends,
//                             outliers — with the exact formula noted
//   datasetCharts(analysis) → chart specs built ONLY from computed values

const MAX_CELLS = 200_000;      // hard bound on parsed cells
const MAX_ROWS = 20_000;
const MAX_COLS = 100;

// Minimal RFC-4180-ish CSV parser: quoted fields, escaped quotes,
// configurable delimiter (auto-detects , vs ; vs \t from the header line).
function parseCsv(text) {
  const raw = String(text || '');
  if (!raw.trim()) return { error: 'empty' };

  const firstLine = raw.split(/\r?\n/, 1)[0] || '';
  const counts = [
    { d: ',', n: (firstLine.match(/,/g) || []).length },
    { d: ';', n: (firstLine.match(/;/g) || []).length },
    { d: '\t', n: (firstLine.match(/\t/g) || []).length },
  ].sort((a, b) => b.n - a.n);
  const delim = counts[0].n > 0 ? counts[0].d : ',';

  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let cellCount = 0;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"') {
        if (raw[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delim) { row.push(field); field = ''; cellCount++; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && raw[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
      cellCount++;
    } else field += ch;
    if (cellCount > MAX_CELLS || rows.length > MAX_ROWS) return { error: 'too_large' };
  }
  row.push(field);
  if (row.some(c => c.trim() !== '')) rows.push(row);

  if (rows.length === 0) return { error: 'empty' };

  const header = rows[0].map((h, i) => h.trim() || `column_${i + 1}`).slice(0, MAX_COLS);
  const dataRows = rows.slice(1).map(r => {
    const cells = header.map((_, i) => (r[i] !== undefined ? r[i].trim() : ''));
    return cells;
  });

  return { columns: header, rows: dataRows, delimiter: delim };
}

function toNumber(v) {
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(/[\s,$€£%]/g, '');
  if (!/^-?\d*\.?\d+(e[-+]?\d+)?$/i.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// ---- univariate statistics (formulas documented inline) ----
function numericStats(values) {
  const n = values.length;
  if (n === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  // Sample variance (n-1 denominator) for n>1; population for n==1.
  const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const stdev = Math.sqrt(variance);
  const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  // IQR outlier fences: below Q1-1.5·IQR or above Q3+1.5·IQR (Tukey).
  const q = (p) => {
    const idx = (n - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  const q1 = q(0.25), q3 = q(0.75);
  const iqr = q3 - q1;
  const outliers = values.filter(v => v < q1 - 1.5 * iqr || v > q3 + 1.5 * iqr);
  return {
    count: n, sum: round(sum), mean: round(mean), median: round(median),
    min: round(sorted[0]), max: round(sorted[n - 1]),
    stdev: round(stdev), q1: round(q1), q3: round(q3),
    missing: 0,
    outliers: { count: outliers.length, values: outliers.slice(0, 10).map(round),
               fences: [round(q1 - 1.5 * iqr), round(q3 + 1.5 * iqr)] },
  };
}

function round(v) { return Math.round(v * 1000) / 1000; }

// Full dataset analysis: column typing, per-column stats, group means for
// the first categorical × first numeric pairing, and a linear trend for
// the first date-like + numeric pairing.
function analyzeDataset(csv, name) {
  const { columns, rows } = csv;
  const columnProfiles = columns.map((col, ci) => {
    const raw = rows.map(r => r[ci]);
    const numeric = raw.map(toNumber);
    const numericCount = numeric.filter(v => v !== null).length;
    const missing = raw.filter(v => v === '' || v == null).length;
    const isNumeric = numericCount >= Math.max(2, Math.floor(raw.length * 0.7));
    const distinct = new Set(raw.filter(v => v !== '')).size;
    return {
      name: col,
      type: isNumeric ? 'numeric' : distinct <= Math.min(12, Math.max(2, Math.floor(rows.length * 0.5))) ? 'categorical' : 'text',
      distinct,
      missing,
      stats: isNumeric ? numericStats(numeric.filter(v => v !== null)) : null,
    };
  });

  // Group comparison: first categorical column × first numeric column.
  let groups = null;
  const cat = columnProfiles.find(c => c.type === 'categorical');
  const num = columnProfiles.find(c => c.type === 'numeric');
  if (cat && num && rows.length >= 3) {
    const ci = columns.indexOf(cat.name);
    const ni = columns.indexOf(num.name);
    const byGroup = new Map();
    for (const r of rows) {
      const g = r[ci] || '(blank)';
      const v = toNumber(r[ni]);
      if (v === null) continue;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(v);
    }
    groups = {
      by: cat.name, measure: num.name,
      entries: [...byGroup.entries()].slice(0, 10).map(([label, vals]) => ({
        label, n: vals.length, mean: round(vals.reduce((a, b) => a + b, 0) / vals.length),
        min: round(Math.min(...vals)), max: round(Math.max(...vals)),
      })).sort((a, b) => b.mean - a.mean),
    };
  }

  // Trend: a date-like column (a text column with date patterns, or any
  // column named year/date/month/quarter/time) × the first numeric column.
  // Rows are ordered by their parsed date value before fitting.
  let trend = null;
  const isDateLikeName = (name) => /^(year|date|month|quarter|time|period|fy)$/i.test(String(name || '').trim());
  const dateCol = columnProfiles.find(c =>
    c.type === 'text' && rows.some(r => {
      const v = r[columns.indexOf(c.name)];
      return v && /\b(19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}\b|\b(19|20)\d{2}-\d{1,2}\b/.test(v);
    })) || columnProfiles.find(c => isDateLikeName(c.name));
  if (dateCol && num) {
    const di = columns.indexOf(dateCol.name);
    const ni = columns.indexOf(num.name);
    const pts = [];
    rows.forEach((r, i) => {
      const v = toNumber(r[ni]);
      const d = r[di];
      if (v === null || !d) return;
      // Sort key: parsed year(+month) when possible, otherwise row order.
      const ym = /\b((?:19|20)\d{2})[-/](\d{1,2})/.exec(d) || /\b((?:19|20)\d{2})\b/.exec(d);
      const sortKey = ym ? parseInt(ym[1], 10) * 12 + (parseInt(ym[2] || 1, 10) - 1) : i;
      pts.push({ x: sortKey, y: v, date: d });
    });
    pts.sort((a, b) => a.x - b.x);
    // Aggregate to one mean per unique period before fitting — multiple
    // rows per period would otherwise weight periods unevenly and a single
    // outlier row would dominate the slope.
    const byPeriod = new Map();
    for (const p of pts) {
      if (!byPeriod.has(p.date)) byPeriod.set(p.date, []);
      byPeriod.get(p.date).push(p);
    }
    const periodPts = [...byPeriod.values()].map(group => {
      const mean = group.reduce((a, p) => a + p.y, 0) / group.length;
      return { x: group[0].x, y: mean, date: group[0].date };
    }).sort((a, b) => a.x - b.x);
    if (periodPts.length >= 2) {
      // Ordinary least squares slope over period means.
      const nP = periodPts.length;
      const mx = periodPts.reduce((a, p) => a + p.x, 0) / nP;
      const my = periodPts.reduce((a, p) => a + p.y, 0) / nP;
      let num2 = 0, den = 0;
      for (const p of periodPts) { num2 += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
      const slope = den === 0 ? 0 : num2 / den;
      // Chart samples are the REAL period means (never interpolated).
      const samples = periodPts.slice(0, 14).map(p => ({ label: p.date, value: round(p.y), date: p.date }));
      trend = {
        dateColumn: dateCol.name, valueColumn: num.name,
        points: pts.length, periods: nP,
        firstDate: periodPts[0].date, lastDate: periodPts[nP - 1].date,
        firstValue: round(periodPts[0].y), lastValue: round(periodPts[nP - 1].y),
        slopePerRow: round(slope),
        direction: slope > 0.0001 ? 'increasing' : slope < -0.0001 ? 'decreasing' : 'flat',
        method: 'OLS over per-period means (rows aggregated by date first)',
        samples,
      };
    }
  }

  return {
    name: name || 'dataset',
    rowCount: rows.length, columnCount: columns.length,
    columns: columnProfiles,
    groups, trend,
    notes: [
      `Parsed ${rows.length} rows × ${columns.length} columns.`,
      'Statistics computed deterministically in code (see data.js): mean/median/quartiles, sample stdev (n-1), Tukey IQR outliers.',
    ],
  };
}

// Chart specs from computed analysis — values come ONLY from the computed
// group means / trend points, never re-typed by a model.
function datasetCharts(analysis, sourceN) {
  const charts = [];
  if (analysis.groups && analysis.groups.entries.length >= 2) {
    charts.push({
      id: 'ds_' + Math.random().toString(36).slice(2, 8),
      type: 'bar',
      title: `Mean ${analysis.groups.measure} by ${analysis.groups.by}`,
      unit: '', period: '',
      sourceN, origin: 'dataset',
      series: analysis.groups.entries.slice(0, 10).map(e => ({ label: e.label, value: e.mean })),
      note: `Computed means from the uploaded dataset (${analysis.rowCount} rows). Method: arithmetic mean per group.`,
    });
  }
  if (analysis.trend && analysis.trend.points >= 3) {
    charts.push({
      id: 'ds_' + Math.random().toString(36).slice(2, 8),
      type: 'line',
      title: `${analysis.trend.valueColumn} over ${analysis.trend.dateColumn}`,
      unit: '', period: `${analysis.trend.firstDate} → ${analysis.trend.lastDate}`,
      sourceN, origin: 'dataset',
      series: [], // filled by caller from trend samples if desired
      note: `${analysis.trend.direction} (${analysis.trend.method}).`,
      trendRef: analysis.trend,
    });
  }
  return charts;
}

module.exports = { parseCsv, analyzeDataset, datasetCharts, numericStats, toNumber };
