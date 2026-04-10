// ============================================================
// app.js — Dashboard OpenDay
// ============================================================

const META_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vQrvGegy-dCxyj_wEA116kWtbKANAhxjgvg7CtyM6qmdX2OsiN2x3du4jvOpGelKk1QqV3by0fans39/pub?gid=994133017&single=true&output=csv';

const CRM_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vQrvGegy-dCxyj_wEA116kWtbKANAhxjgvg7CtyM6qmdX2OsiN2x3du4jvOpGelKk1QqV3by0fans39/pub?gid=450199426&single=true&output=csv';

// CPL alert threshold (R$)
const CPL_ALERT = 150;

// ============================================================
// Raw data cache — persists between filter changes
// ============================================================
let _rawMeta = [];   // all Meta rows filtered by "openday"
let _rawCRM  = [];   // all CRM rows filtered by "openday"

// ============================================================
// CSV parser
// opts.skipFirstCol: skip column index 0 (Meta has empty col A)
// opts.headerMarker: find header row by looking for this string in any cell
// opts.headerRow: fixed row index (0-based) for header; default 0
// ============================================================
function parseCSV(text, opts = {}) {
  const { skipFirstCol = false, headerMarker = null, headerRow = 0 } = opts;

  const rawLines = text.split(/\r?\n/);

  // Locate the header row
  let headerIdx;
  if (headerMarker !== null) {
    // Find first row where any cell exactly matches the marker (case-insensitive)
    headerIdx = rawLines.findIndex(l =>
      splitCSVLine(l).some(c => c.trim().toLowerCase() === headerMarker.toLowerCase())
    );
    if (headerIdx === -1) {
      console.warn('[parseCSV] Header marker not found:', headerMarker);
      return [];
    }
  } else {
    headerIdx = headerRow;
  }

  const headerLine = rawLines[headerIdx];
  if (!headerLine) return [];

  const allHeaders = splitCSVLine(headerLine);

  // Keep only columns with non-empty headers, optionally skip col 0
  const validIndexes = allHeaders
    .map((h, i) => ({ h: h.trim(), i }))
    .filter(({ h, i }) => h !== '' && !(skipFirstCol && i === 0));

  // Data: all non-blank lines after the header
  const dataLines = rawLines
    .slice(headerIdx + 1)
    .filter(l => l.trim() !== '');

  return dataLines.map(line => {
    const values = splitCSVLine(line);
    const row = {};
    validIndexes.forEach(({ h, i }) => {
      row[h] = (values[i] ?? '').trim();
    });
    return row;
  });
}

// Meta: col A is empty, header row contains "Day" as one of the cells
function parseMetaCSV(text) {
  return parseCSV(text, { skipFirstCol: true, headerMarker: 'Day' });
}

// CRM: standard CSV, header on row 0
function parseCRMCSV(text) {
  return parseCSV(text, { skipFirstCol: false, headerRow: 0 });
}

function splitCSVLine(line) {
  const result = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQ = !inQ; }
    else if (ch === ',' && !inQ) { result.push(cur.trim().replace(/^"|"$/g, '')); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur.trim().replace(/^"|"$/g, ''));
  return result;
}

// ============================================================
// Number / format helpers
// ============================================================
function parseNum(val) {
  if (!val && val !== 0) return 0;
  return parseFloat(String(val).replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
}

function fmtBRL(n) {
  return 'R$ ' + Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtNum(n, dec = 0) {
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function fmtPct(n) {
  return fmtNum(n, 2) + '%';
}

// ============================================================
// 1. FILTER META — Campaign Name === 'openday' (exact, case-insensitive)
//    Rejects: graduacao_nextgen_*, graduacao_grad-adm_*, etc.
// ============================================================
// Campaign Name real: "graduacao_grad-adm_lead_Openday_lf"
// Usar toLowerCase() para não depender de capitalização exata
function filterMeta(rows) {
  return rows.filter(r =>
    String(r['Campaign Name'] || '').toLowerCase().includes('openday')
  );
}

// ============================================================
// 2. FILTER CRM — any of:
//    a) utm_campaign contains "openday"
//    b) utm_content contains "openday"
//    c) Evento Completo is non-empty (lead inscrito em algum evento)
// ============================================================
function filterCRM(rows) {
  return rows.filter(r =>
    String(r['utm_campaign']     || '').toLowerCase().includes('openday') ||
    String(r['utm_content']      || '').toLowerCase().includes('openday') ||
    String(r['Evento Completo']  || '').trim() !== ''
  );
}

// ============================================================
// Helper — finds a column by partial key match (case-insensitive)
// ============================================================
function findColumn(row, keyword) {
  const kw = keyword.toLowerCase();
  return Object.entries(row).find(([k]) => k.toLowerCase().includes(kw))?.[1] ?? 0;
}

// ============================================================
// 3. Aggregate Meta rows by Ad Name
//    Returns array of { adName, campaignName, adSetName, day,
//    spend, impressions, cpm, clicks, ctr }
// ============================================================
function aggregateMeta(rows) {
  const map = new Map();

  rows.forEach(r => {
    const key = r['Ad Name'] || '(sem nome)';
    if (!map.has(key)) {
      map.set(key, {
        adName:       key,
        campaignName: r['Campaign Name'] || '',
        adSetName:    r['Ad Set Name']   || '',
        day:          r['Day']           || '',
        spend:        0,
        impressions:  0,
        clicks:       0,
        cpmSum:       0,
        ctrSum:       0,
        count:        0,
      });
    }
    const agg = map.get(key);
    agg.spend       += parseNum(r['Amount Spent']);
    agg.impressions += parseNum(r['Impressions']);
    agg.clicks      += parseNum(r['Link Clicks']);
    agg.cpmSum      += parseNum(findColumn(r, 'CPM'));
    agg.ctrSum      += parseNum(findColumn(r, 'CTR'));
    agg.count       += 1;
    // Keep last day (or could keep first)
    if (r['Day']) agg.day = r['Day'];
  });

  return Array.from(map.values()).map(a => ({
    ...a,
    cpm: a.count ? a.cpmSum / a.count : 0,
    ctr: a.count ? a.ctrSum / a.count : 0,
  }));
}

// ============================================================
// 4. Count CRM leads per utm_content (= Ad Name no Meta)
//    Returns Map<utm_content, count>
//    O campo utm_content do CRM corresponde ao Ad Name do Meta Ads
// ============================================================
function buildLeadsMap(crmRows) {
  const map = new Map();
  crmRows.forEach(r => {
    const key = (r['utm_content'] || '').trim();
    if (!key) return;
    map.set(key, (map.get(key) || 0) + 1);
  });
  return map;
}

// ============================================================
// 5. Merge Meta aggregates with CRM leads → final rows
//    Join: Meta "Ad Name" === CRM "utm_content"
// ============================================================
function mergeData(metaAgg, leadsMap) {
  return metaAgg.map(a => {
    // Exact match first, then case-insensitive fallback
    const leads =
      leadsMap.get(a.adName) ||
      leadsMap.get(a.adName.toLowerCase()) ||
      [...leadsMap.entries()].find(([k]) => k.toLowerCase() === a.adName.toLowerCase())?.[1] ||
      0;
    const cpl = leads > 0 ? a.spend / leads : null;
    return { ...a, leads, cpl };
  });
}

// ============================================================
// 6. Render KPI cards
// ============================================================
function renderKPIs(rows, crmRows) {
  const totalSpend  = rows.reduce((s, r) => s + r.spend,  0);
  const totalClicks = rows.reduce((s, r) => s + r.clicks, 0);
  // Leads: total CRM filtrado é a fonte de verdade
  const totalLeads  = crmRows.length;
  const globalCPL   = totalLeads > 0 ? totalSpend / totalLeads : 0;

  setText('kpi-spend',  fmtBRL(totalSpend));
  setText('kpi-leads',  fmtNum(totalLeads));
  setText('kpi-clicks', fmtNum(totalClicks));
  setText('kpi-cpl',    globalCPL > 0 ? fmtBRL(globalCPL) : '—');
}

// ============================================================
// 7. Render ads table
// ============================================================
function renderTable(rows) {
  const tbody = document.getElementById('ads-tbody');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--text-secondary);padding:40px">Nenhum dado com "openday" na Campaign Name.</td></tr>';
    return;
  }

  // Sort by spend desc
  const sorted = [...rows].sort((a, b) => b.spend - a.spend);

  tbody.innerHTML = sorted.map(r => `
    <tr>
      <td>${r.day}</td>
      <td title="${r.campaignName}">${trunc(r.campaignName, 22)}</td>
      <td title="${r.adSetName}">${trunc(r.adSetName, 22)}</td>
      <td title="${r.adName}">${trunc(r.adName, 32)}</td>
      <td class="num">${fmtBRL(r.spend)}</td>
      <td class="num">${fmtNum(r.impressions)}</td>
      <td class="num">${fmtBRL(r.cpm)}</td>
      <td class="num">${fmtNum(r.clicks)}</td>
      <td class="num">${fmtPct(r.ctr)}</td>
      <td class="num ${cplClass(r.cpl)}">${r.cpl !== null ? fmtBRL(r.cpl) : '—'}</td>
      <td class="num">${fmtNum(r.leads)}</td>
    </tr>
  `).join('');
}

function cplClass(cpl) {
  if (cpl === null) return '';
  if (cpl <= CPL_ALERT * 0.75) return 'cpl-good';
  if (cpl <= CPL_ALERT)        return 'cpl-warn';
  return 'cpl-bad';
}

function trunc(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ============================================================
// 8. Render pie/donut chart — leads by utm_medium (canal)
// ============================================================
function renderChart(crmRows) {
  const canvas = document.getElementById('leads-chart');
  if (!canvas) return;

  // Group by utm_medium
  const map = {};
  crmRows.forEach(r => {
    const canal = r['utm_medium'] || 'Outros';
    map[canal] = (map[canal] || 0) + 1;
  });

  const labels = Object.keys(map);
  const data   = Object.values(map);
  const total  = data.reduce((a, b) => a + b, 0);

  if (!total) {
    canvas.parentElement.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:32px 0">Sem dados de canal no CRM.</p>';
    return;
  }

  const COLORS = ['#4f8ef7','#3ecf8e','#f5a623','#e05252','#a855f7','#ec4899','#14b8a6','#f97316','#6366f1','#84cc16'];

  // Size canvas
  const size = Math.min(canvas.parentElement.offsetWidth || 300, 300);
  canvas.width  = size;
  canvas.height = size;

  const ctx    = canvas.getContext('2d');
  const cx     = size / 2;
  const cy     = size / 2;
  const R      = cx * 0.75;
  const inner  = R * 0.52;

  ctx.clearRect(0, 0, size, size);

  let angle = -Math.PI / 2;
  const slices = data.map((v, i) => {
    const sweep = (v / total) * 2 * Math.PI;
    const slice = { start: angle, sweep, color: COLORS[i % COLORS.length], label: labels[i], v };
    angle += sweep;
    return slice;
  });

  slices.forEach(s => {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, s.start, s.start + s.sweep);
    ctx.closePath();
    ctx.fillStyle = s.color;
    ctx.fill();
    ctx.strokeStyle = '#1a1d27';
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  // Donut hole
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, 2 * Math.PI);
  ctx.fillStyle = '#22263a';
  ctx.fill();

  // Center text
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e8eaf0';
  ctx.font = `bold ${Math.round(size * 0.08)}px system-ui`;
  ctx.fillText(total, cx, cy - size * 0.04);
  ctx.font = `${Math.round(size * 0.055)}px system-ui`;
  ctx.fillStyle = '#9aa0b4';
  ctx.fillText('leads', cx, cy + size * 0.05);

  // Legend
  const legend = document.getElementById('chart-legend');
  if (legend) {
    legend.innerHTML = slices.map(s => `
      <div class="legend-item">
        <span class="legend-dot" style="background:${s.color}"></span>
        <span class="legend-label">${s.label}</span>
        <span class="legend-val">${s.v} &nbsp;(${((s.v / total) * 100).toFixed(1)}%)</span>
      </div>
    `).join('');
  }
}

// ============================================================
// 9. Render Insights panel
// ============================================================
function renderInsights(rows, crmRows) {
  const el = document.getElementById('insights');
  if (!el) return;

  const withLeads = rows.filter(r => r.leads > 0 && r.cpl !== null);

  // Global CPL — leads vem do CRM filtrado (fonte de verdade)
  const totalSpend = rows.reduce((s, r) => s + r.spend, 0);
  const totalLeads = crmRows.length;
  const globalCPL  = totalLeads > 0 ? totalSpend / totalLeads : null;

  // Best creative (lowest CPL with at least 1 lead)
  const best = withLeads.length
    ? withLeads.reduce((a, b) => a.cpl < b.cpl ? a : b)
    : null;

  // City performance from CRM (Evento Completo → extract city)
  const cityMap = {};
  crmRows.forEach(r => {
    const ev = r['Evento Completo'] || '';
    const city = ev.split('-')[0].trim() || 'Outros';
    cityMap[city] = (cityMap[city] || 0) + 1;
  });
  const cities = Object.entries(cityMap).sort((a, b) => b[1] - a[1]);
  const bestCity  = cities[0]  || null;
  const worstCity = cities[cities.length - 1] || null;

  // CPL alerts — creatives above threshold
  const alerts = withLeads.filter(r => r.cpl > CPL_ALERT);

  const lines = [];

  if (globalCPL !== null) {
    lines.push(insightCard('CPL Global', fmtBRL(globalCPL), globalCPL <= CPL_ALERT ? 'good' : 'bad',
      `Base: ${fmtNum(totalLeads)} leads / ${fmtBRL(totalSpend)} investidos`));
  }

  if (best) {
    lines.push(insightCard('Melhor Criativo', trunc(best.adName, 36), 'good',
      `CPL ${fmtBRL(best.cpl)} &middot; ${fmtNum(best.leads)} leads`));
  }

  if (bestCity) {
    lines.push(insightCard('Melhor Cidade', bestCity[0], 'good',
      `${fmtNum(bestCity[1])} leads`));
  }

  if (worstCity && worstCity[0] !== (bestCity && bestCity[0])) {
    lines.push(insightCard('Cidade com Menos Leads', worstCity[0], 'warn',
      `${fmtNum(worstCity[1])} leads`));
  }

  if (alerts.length) {
    alerts.forEach(r => {
      lines.push(insightCard('Alerta CPL Alto', trunc(r.adName, 36), 'bad',
        `CPL ${fmtBRL(r.cpl)} — acima do limite de ${fmtBRL(CPL_ALERT)}`));
    });
  }

  el.innerHTML = lines.length
    ? lines.join('')
    : '<p style="color:var(--text-secondary)">Sem dados suficientes para insights.</p>';
}

function insightCard(title, value, type, detail) {
  const colors = { good: 'var(--success)', bad: 'var(--danger)', warn: 'var(--warning)' };
  return `
    <div class="insight-card">
      <div class="insight-title">${title}</div>
      <div class="insight-value" style="color:${colors[type]}">${value}</div>
      <div class="insight-detail">${detail}</div>
    </div>
  `;
}

// ============================================================
// Utilities
// ============================================================
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function showStatus(msg, isError = false) {
  const el = document.getElementById('status-msg');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
  el.style.color = isError ? 'var(--danger)' : 'var(--text-secondary)';
}

function hideStatus() {
  const el = document.getElementById('status-msg');
  if (el) el.style.display = 'none';
}

async function fetchCSV(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ============================================================
// FILTERS — populate dropdowns from raw data
// ============================================================

/** Extract unique praças from CRM "Evento Completo" (text before first "-") */
function extractPracas(crmRows) {
  const set = new Set();
  crmRows.forEach(r => {
    const ev = (r['Evento Completo'] || '').trim();
    if (!ev) return;
    const praca = ev.split('-')[0].trim();
    if (praca) set.add(praca);
  });
  return [...set].sort();
}

/** Extract unique Ad Names from Meta rows */
function extractCriativos(metaRows) {
  const set = new Set();
  metaRows.forEach(r => {
    const name = (r['Ad Name'] || '').trim();
    if (name) set.add(name);
  });
  return [...set].sort();
}

function populateSelect(id, options) {
  const el = document.getElementById(id);
  if (!el) return;
  const current = el.value;
  while (el.options.length > 1) el.remove(1);
  options.forEach(opt => {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = opt;
    el.appendChild(o);
  });
  if ([...el.options].some(o => o.value === current)) el.value = current;
}

function populateFilters() {
  populateSelect('filter-praca',    extractPracas(_rawCRM));
  populateSelect('filter-criativo', extractCriativos(_rawMeta));
}

// ============================================================
// FILTERS — read current values
// ============================================================
function getFilters() {
  return {
    praca:     (document.getElementById('filter-praca')      || {}).value || '',
    dateStart: (document.getElementById('filter-date-start') || {}).value || '',
    dateEnd:   (document.getElementById('filter-date-end')   || {}).value || '',
    criativo:  (document.getElementById('filter-criativo')   || {}).value || '',
  };
}

function clearFilters() {
  ['filter-praca','filter-criativo'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  ['filter-date-start','filter-date-end'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const chk = document.getElementById('chk-compare');
  if (chk) { chk.checked = false; toggleComparativo(false); }
  applyFilters();
}

// ============================================================
// FILTERS — apply to raw data
// ============================================================

/** Parse "DD/MM/YYYY" or "YYYY-MM-DD" → Date (midnight local) */
function parseDate(str) {
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
    const [d, m, y] = str.split('/').map(Number);
    return new Date(y, m - 1, d);
  }
  return null;
}

function applyFilters() {
  const f = getFilters();

  // --- Filter Meta rows ---
  let metaRows = _rawMeta.slice();

  if (f.criativo) {
    metaRows = metaRows.filter(r => (r['Ad Name'] || '') === f.criativo);
  }
  if (f.dateStart || f.dateEnd) {
    const start = parseDate(f.dateStart);
    const end   = parseDate(f.dateEnd);
    metaRows = metaRows.filter(r => {
      const d = parseDate(r['Day']);
      if (!d) return true;
      if (start && d < start) return false;
      if (end   && d > end)   return false;
      return true;
    });
  }

  // --- Filter CRM rows ---
  let crmRows = _rawCRM.slice();

  if (f.praca) {
    crmRows = crmRows.filter(r => {
      const ev = (r['Evento Completo'] || '').trim();
      return ev.split('-')[0].trim() === f.praca;
    });
  }
  if (f.dateStart || f.dateEnd) {
    const start = parseDate(f.dateStart);
    const end   = parseDate(f.dateEnd);
    const DATE_COLS = ['Data de criação','created_at','Data','date','Data Criação'];
    crmRows = crmRows.filter(r => {
      const colKey = DATE_COLS.find(c => r[c] !== undefined);
      if (!colKey) return true;
      const d = parseDate(r[colKey]);
      if (!d) return true;
      if (start && d < start) return false;
      if (end   && d > end)   return false;
      return true;
    });
  }
  if (f.criativo) {
    crmRows = crmRows.filter(r => (r['utm_content'] || '').trim() === f.criativo);
  }

  // --- Re-render ---
  const metaAgg  = aggregateMeta(metaRows);
  const leadsMap = buildLeadsMap(crmRows);
  const data     = mergeData(metaAgg, leadsMap);

  renderKPIs(data, crmRows);
  renderTable(data);
  renderChart(crmRows);
  renderInsights(data, crmRows);
}

// ============================================================
// COMPARATIVO DE PERÍODOS
// ============================================================
function toggleComparativo(open) {
  const sec = document.getElementById('compare-section');
  if (!sec) return;
  if (open) {
    sec.classList.add('visible');
  } else {
    sec.classList.remove('visible');
    // Hide results when closing
    const kpis = document.getElementById('compare-kpis');
    if (kpis) kpis.style.display = 'none';
  }
}

function filterByPeriod(metaRows, crmRows, dateStart, dateEnd) {
  const start = parseDate(dateStart);
  const end   = parseDate(dateEnd);

  const meta = (!start && !end) ? metaRows : metaRows.filter(r => {
    const d = parseDate(r['Day']);
    if (!d) return true;
    if (start && d < start) return false;
    if (end   && d > end)   return false;
    return true;
  });

  const DATE_COLS = ['Data de criação','created_at','Data','date','Data Criação'];
  const crm = (!start && !end) ? crmRows : crmRows.filter(r => {
    const colKey = DATE_COLS.find(c => r[c] !== undefined);
    if (!colKey) return true;
    const d = parseDate(r[colKey]);
    if (!d) return true;
    if (start && d < start) return false;
    if (end   && d > end)   return false;
    return true;
  });

  return { meta, crm };
}

function computeKPISet(metaRows, crmRows) {
  const metaAgg  = aggregateMeta(metaRows);
  const leadsMap = buildLeadsMap(crmRows);
  const data     = mergeData(metaAgg, leadsMap);
  const spend    = data.reduce((s, r) => s + r.spend, 0);
  const clicks   = data.reduce((s, r) => s + r.clicks, 0);
  const leads    = crmRows.length;
  const cpl      = leads > 0 ? spend / leads : null;
  return { spend, clicks, leads, cpl };
}

function applyComparativo() {
  const aStart = (document.getElementById('cmp-a-start') || {}).value;
  const aEnd   = (document.getElementById('cmp-a-end')   || {}).value;
  const bStart = (document.getElementById('cmp-b-start') || {}).value;
  const bEnd   = (document.getElementById('cmp-b-end')   || {}).value;

  const pA = filterByPeriod(_rawMeta, _rawCRM, aStart, aEnd);
  const pB = filterByPeriod(_rawMeta, _rawCRM, bStart, bEnd);

  const kA = computeKPISet(pA.meta, pA.crm);
  const kB = computeKPISet(pB.meta, pB.crm);

  const container = document.getElementById('compare-kpis');
  if (!container) return;
  container.style.display = 'grid';

  const labelA = (aStart || aEnd) ? `${aStart || '…'} → ${aEnd || '…'}` : 'Período A (todos)';
  const labelB = (bStart || bEnd) ? `${bStart || '…'} → ${bEnd || '…'}` : 'Período B (todos)';

  const metrics = [
    { key: 'spend',  label: 'Investimento', fmt: fmtBRL,                              lowerIsBetter: false },
    { key: 'leads',  label: 'Leads (CRM)',  fmt: v => fmtNum(v),                      lowerIsBetter: false },
    { key: 'clicks', label: 'Cliques',      fmt: v => fmtNum(v),                      lowerIsBetter: false },
    { key: 'cpl',    label: 'CPL Médio',    fmt: v => v != null ? fmtBRL(v) : '—',   lowerIsBetter: true  },
  ];

  container.innerHTML = metrics.map(m => {
    const vA = kA[m.key];
    const vB = kB[m.key];

    function deltaHtml(base, comp, lowerIsBetter) {
      if (base == null || comp == null || base === 0) return '';
      const pct  = ((comp - base) / Math.abs(base)) * 100;
      const up   = pct > 0;
      const good = lowerIsBetter ? !up : up;
      const cls  = Math.abs(pct) < 0.5 ? 'delta-flat' : (good ? 'delta-up' : 'delta-down');
      const sign = up ? '+' : '';
      return `<div class="ck-delta ${cls}">${sign}${pct.toFixed(1)}% vs A</div>`;
    }

    return `
      <div class="compare-kpi-col">
        <div class="compare-kpi-header">${m.label}</div>
        <div class="compare-kpi-item">
          <div class="ck-label">${labelA}</div>
          <div class="ck-val">${m.fmt(vA)}</div>
        </div>
        <div class="compare-kpi-item">
          <div class="ck-label">${labelB}</div>
          <div class="ck-val">${m.fmt(vB)}</div>
          ${deltaHtml(vA, vB, m.lowerIsBetter)}
        </div>
      </div>
    `;
  }).join('');
}

// ============================================================
// MAIN
// ============================================================
async function init() {
  showStatus('Carregando dados...');

  ['kpi-spend','kpi-leads','kpi-clicks','kpi-cpl'].forEach(id => setText(id, '—'));

  try {
    const [metaText, crmText] = await Promise.all([
      fetchCSV(META_CSV_URL),
      fetchCSV(CRM_CSV_URL),
    ]);

    const allMeta = parseMetaCSV(metaText);
    const allCRM  = parseCRMCSV(crmText);

    console.log('[Meta] Colunas:', Object.keys(allMeta[0] || {}));
    console.log('[CRM]  Colunas:', Object.keys(allCRM[0]  || {}));
    console.log(`[Meta] Total linhas: ${allMeta.length}`);
    console.log(`[CRM]  Total linhas: ${allCRM.length}`);

    // Store filtered raw data globally for re-use by filters
    _rawMeta = filterMeta(allMeta);
    _rawCRM  = filterCRM(allCRM);

    console.log(`[Meta] Filtrado openday: ${_rawMeta.length}`);
    console.log(`[CRM]  Filtrado openday: ${_rawCRM.length}`);

    // Populate filter dropdowns
    populateFilters();

    // Wire up filter change listeners
    ['filter-praca','filter-criativo','filter-date-start','filter-date-end'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', applyFilters);
    });

    // Initial render with no extra filters applied
    applyFilters();

    hideStatus();
  } catch (err) {
    console.error(err);
    showStatus('Erro ao carregar: ' + err.message, true);
  }
}

document.addEventListener('DOMContentLoaded', init);
