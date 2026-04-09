// ============================================================
// app.js — Dashboard OpenDay
// ============================================================

const META_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vQrvGegy-dCxyj_wEA116kWtbKANAhxjgvg7CtyM6qmdX2OsiN2x3du4jvOpGelKk1QqV3by0fans39/pub?gid=994133017&single=true&output=csv';

const CRM_CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vQrvGegy-dCxyj_wEA116kWtbKANAhxjgvg7CtyM6qmdX2OsiN2x3du4jvOpGelKk1QqV3by0fans39/pub?gid=450199426&single=true&output=csv';

// ============================================================
// CSV parser
// ============================================================
function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));

  return lines.slice(1).map(line => {
    // Handle quoted fields that may contain commas
    const values = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    values.push(current.trim());

    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
    return row;
  });
}

// ============================================================
// Column name resolver — handles variations from Meta Ads exports
// ============================================================
const COLUMN_ALIASES = {
  adName:      ['Ad name', 'Ad Name', 'Nome do anúncio', 'ad_name', 'Nome do conjunto de anuncios', 'Ad set name'],
  praca:       ['Praça', 'Praca', 'praca', 'Cidade', 'cidade', 'Região', 'regiao'],
  ctr:         ['CTR (all)', 'CTR', 'ctr', 'CTR (Link Click-Through Rate)'],
  clicks:      ['Link clicks', 'Clicks', 'clicks', 'Cliques no link', 'Cliques'],
  cpm:         ['CPM (cost per 1,000 impressions)', 'CPM', 'cpm'],
  spend:       ['Amount spent (BRL)', 'Amount spent', 'Valor gasto (BRL)', 'Valor gasto', 'spend', 'Investimento'],
  impressions: ['Impressions', 'impressions', 'Impressões'],
  reach:       ['Reach', 'reach', 'Alcance'],
  leads:       ['Leads', 'leads', 'Result', 'Results', 'Resultados'],
  channel:     ['Channel', 'Canal', 'canal', 'Source', 'Fonte'],
};

function resolve(row, key) {
  const aliases = COLUMN_ALIASES[key] || [key];
  for (const alias of aliases) {
    if (row[alias] !== undefined) return row[alias];
  }
  return '';
}

// ============================================================
// Number helpers
// ============================================================
function parseNum(val) {
  if (val === undefined || val === null || val === '') return 0;
  return parseFloat(String(val).replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
}

function fmt(n, decimals = 2) {
  return Number(n).toLocaleString('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtCurrency(n) {
  return 'R$ ' + fmt(n, 2);
}

function fmtPct(n) {
  return fmt(n, 2) + '%';
}

// ============================================================
// Filter rows that mention "openday" anywhere
// ============================================================
function filterOpenDay(rows) {
  return rows.filter(row =>
    Object.values(row).some(v =>
      String(v).toLowerCase().includes('openday') ||
      String(v).toLowerCase().includes('open day') ||
      String(v).toLowerCase().includes('open_day')
    )
  );
}

// ============================================================
// Build the ads table
// ============================================================
function buildTable(metaRows, leadsMap) {
  const tbody = document.getElementById('ads-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (metaRows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-secondary)">Nenhum dado encontrado com "openday".</td></tr>';
    return;
  }

  metaRows.forEach(row => {
    const adName    = resolve(row, 'adName')      || resolve(row, 'praca') || '—';
    const praca     = resolve(row, 'praca')        || '—';
    const ctr       = parseNum(resolve(row, 'ctr'));
    const clicks    = parseNum(resolve(row, 'clicks'));
    const cpm       = parseNum(resolve(row, 'cpm'));
    const spend     = parseNum(resolve(row, 'spend'));

    // Try leads from meta row first, then from CRM map
    let leads = parseNum(resolve(row, 'leads'));
    if (!leads) {
      const key = adName.toLowerCase().trim();
      leads = leadsMap[key] || 0;
    }

    const cpl = leads > 0 ? spend / leads : 0;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td title="${adName}">${truncate(adName, 40)}</td>
      <td>${praca}</td>
      <td>${fmtPct(ctr)}</td>
      <td>${fmt(clicks, 0)}</td>
      <td>${fmtCurrency(cpm)}</td>
      <td>${cpl > 0 ? fmtCurrency(cpl) : '—'}</td>
      <td>${fmt(leads, 0)}</td>
      <td>${fmtCurrency(spend)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + '…' : str;
}

// ============================================================
// Build the KPI summary cards
// ============================================================
function buildKPIs(metaRows, crmRows) {
  const totalSpend  = metaRows.reduce((s, r) => s + parseNum(resolve(r, 'spend')), 0);
  const totalClicks = metaRows.reduce((s, r) => s + parseNum(resolve(r, 'clicks')), 0);
  const totalLeads  = crmRows.length || metaRows.reduce((s, r) => s + parseNum(resolve(r, 'leads')), 0);
  const cpl         = totalLeads > 0 ? totalSpend / totalLeads : 0;

  setText('kpi-spend',  fmtCurrency(totalSpend));
  setText('kpi-leads',  fmt(totalLeads, 0));
  setText('kpi-clicks', fmt(totalClicks, 0));
  setText('kpi-cpl',    cpl > 0 ? fmtCurrency(cpl) : '—');
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

// ============================================================
// Build pie chart — leads by channel (CRM data)
// ============================================================
function buildPieChart(crmRows) {
  const canvas = document.getElementById('leads-chart');
  if (!canvas) return;

  // Group by channel
  const channelMap = {};
  crmRows.forEach(row => {
    const channel = resolve(row, 'channel') || resolve(row, 'praca') || 'Outros';
    channelMap[channel] = (channelMap[channel] || 0) + 1;
  });

  // If CRM has no channel data, group meta rows by praca
  if (Object.keys(channelMap).length === 0) {
    canvas.parentElement.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:40px 0">Sem dados de canal no CRM filtrado.</p>';
    return;
  }

  const labels  = Object.keys(channelMap);
  const data    = Object.values(channelMap);
  const total   = data.reduce((a, b) => a + b, 0);

  const COLORS = [
    '#4f8ef7', '#3ecf8e', '#f5a623', '#e05252',
    '#a855f7', '#ec4899', '#14b8a6', '#f97316',
    '#6366f1', '#84cc16',
  ];

  const ctx    = canvas.getContext('2d');
  const W      = canvas.width  = canvas.offsetWidth  || 340;
  const H      = canvas.height = canvas.offsetHeight || 340;
  const cx     = W / 2;
  const cy     = H / 2;
  const radius = Math.min(cx, cy) * 0.72;
  const inner  = radius * 0.5; // donut hole

  ctx.clearRect(0, 0, W, H);

  let startAngle = -Math.PI / 2;
  const slices = [];

  data.forEach((val, i) => {
    const angle = (val / total) * 2 * Math.PI;
    slices.push({ startAngle, angle, color: COLORS[i % COLORS.length], label: labels[i], val });
    startAngle += angle;
  });

  // Draw slices
  slices.forEach(s => {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, s.startAngle, s.startAngle + s.angle);
    ctx.closePath();
    ctx.fillStyle = s.color;
    ctx.fill();
    ctx.strokeStyle = '#0f1117';
    ctx.lineWidth = 2;
    ctx.stroke();
  });

  // Donut hole
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, 2 * Math.PI);
  ctx.fillStyle = '#1a1d27';
  ctx.fill();

  // Center label
  ctx.fillStyle = '#e8eaf0';
  ctx.font = 'bold 22px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(total, cx, cy - 10);
  ctx.font = '12px system-ui';
  ctx.fillStyle = '#9aa0b4';
  ctx.fillText('leads', cx, cy + 12);

  // Legend
  const legend = document.getElementById('chart-legend');
  if (legend) {
    legend.innerHTML = slices.map(s => `
      <div class="legend-item">
        <span class="legend-dot" style="background:${s.color}"></span>
        <span class="legend-label">${s.label}</span>
        <span class="legend-val">${s.val} (${((s.val / total) * 100).toFixed(1)}%)</span>
      </div>
    `).join('');
  }
}

// ============================================================
// Main — fetch, parse, filter, render
// ============================================================
async function init() {
  showStatus('Carregando dados...');

  try {
    const [metaText, crmText] = await Promise.all([
      fetchCSV(META_CSV_URL),
      fetchCSV(CRM_CSV_URL),
    ]);

    const allMeta = parseCSV(metaText);
    const allCRM  = parseCSV(crmText);

    // Debug: log columns found
    if (allMeta.length) console.log('[Meta] Colunas:', Object.keys(allMeta[0]));
    if (allCRM.length)  console.log('[CRM]  Colunas:', Object.keys(allCRM[0]));

    const metaRows = filterOpenDay(allMeta);
    const crmRows  = filterOpenDay(allCRM);

    console.log(`[Meta] ${allMeta.length} linhas → ${metaRows.length} openday`);
    console.log(`[CRM]  ${allCRM.length} linhas → ${crmRows.length} openday`);

    // Build a leads lookup map from CRM keyed by ad name / praca
    const leadsMap = {};
    crmRows.forEach(row => {
      const key = (resolve(row, 'adName') || resolve(row, 'praca') || '').toLowerCase().trim();
      if (key) leadsMap[key] = (leadsMap[key] || 0) + 1;
    });

    buildKPIs(metaRows, crmRows);
    buildTable(metaRows, leadsMap);
    buildPieChart(crmRows);

    hideStatus();
  } catch (err) {
    console.error(err);
    showStatus('Erro ao carregar dados: ' + err.message, true);
  }
}

async function fetchCSV(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar ${url}`);
  return res.text();
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

document.addEventListener('DOMContentLoaded', init);
