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
// 4. Normaliza utm_content do CRM para uso como chave de join
//    Valores inválidos (FALSE, nan, vazio) → string vazia
// ============================================================
const INVALID_UTM = new Set(['false', 'nan', '']);

function normalizeUtmContent(val) {
  const s = (val || '').trim();
  return INVALID_UTM.has(s.toLowerCase()) ? '' : s;
}

// ============================================================
// 5. Builds two structures from CRM rows:
//    leadsMap  — Map<utm_content, count>  (para join com Meta)
//    crmByUtm  — Map<utm_content, {count, adNameCRM, channel}>
//                onde adNameCRM = utm_content legível e
//                     channel   = utm_medium (ex: "institucional")
// ============================================================
function buildLeadsMap(crmRows) {
  const leadsMap = new Map();
  crmRows.forEach(r => {
    const key = normalizeUtmContent(r['utm_content']);
    if (!key) return;
    leadsMap.set(key, (leadsMap.get(key) || 0) + 1);
  });
  return leadsMap;
}

/** Retorna Map<adNameCRM, {count, channel}> para todas as linhas CRM,
 *  incluindo as sem utm_content válido (chave = '' para diretos). */
function buildCRMGroups(crmRows) {
  const map = new Map();
  crmRows.forEach(r => {
    const key     = normalizeUtmContent(r['utm_content']);
    const channel = (r['utm_medium'] || '').trim();
    if (!map.has(key)) map.set(key, { count: 0, channel });
    map.get(key).count += 1;
  });
  return map;
}

// ============================================================
// 6. Merge Meta aggregates + CRM groups → final rows
//    • Linhas Meta que casam com CRM pelo Ad Name = utm_content
//    • Linhas CRM-only (utm_content não existe no Meta ou é inválido)
// ============================================================
function mergeData(metaAgg, crmRows) {
  const leadsMap  = buildLeadsMap(crmRows);
  const crmGroups = buildCRMGroups(crmRows);

  // ── Linhas que têm dados no Meta ──────────────────────────
  const metaRows = metaAgg.map(a => {
    // Encontra a chave exata no leadsMap (case-insensitive)
    const matchedKey =
      leadsMap.has(a.adName)               ? a.adName :
      leadsMap.has(a.adName.toLowerCase()) ? a.adName.toLowerCase() :
      [...leadsMap.keys()].find(k => k.toLowerCase() === a.adName.toLowerCase()) || null;

    const leads = matchedKey ? (leadsMap.get(matchedKey) || 0) : 0;
    const cpl   = leads > 0 ? a.spend / leads : null;

    // Caso 1 — Meta-only (nenhum CRM casou): adNameCRM = vazio
    // Caso 3 — Meta + CRM casados:           adNameCRM = utm_content (matchedKey)
    return {
      ...a,
      leads,
      cpl,
      adNameCRM: matchedKey || '',   // '' → Meta-only; valor → casado
      channel:   matchedKey ? (crmGroups.get(matchedKey)?.channel || '') : '',
      crmOnly:   false,
    };
  });

  // ── Linhas CRM-only: utm_content que NÃO casa com nenhum Ad Name ──
  const metaAdNames = new Set(metaAgg.map(a => a.adName.toLowerCase()));

  const crmOnlyRows = [];
  crmGroups.forEach(({ count, channel }, utmKey) => {
    // Chave vazia = leads sem utm_content válido (diretos/institucionais)
    const isMatched = utmKey !== '' && metaAdNames.has(utmKey.toLowerCase());
    if (isMatched) return; // já coberto pelas linhas Meta

    crmOnlyRows.push({
      adName:       '',           // sem dados no Meta
      campaignName: '',
      adSetName:    '',
      day:          '',
      spend:        0,
      impressions:  0,
      clicks:       0,
      cpm:          0,
      ctr:          0,
      leads:        count,
      cpl:          null,
      adNameCRM:    utmKey,       // pode ser '' (direto) ou valor sem Meta
      channel,
      crmOnly:      true,
    });
  });

  return [...metaRows, ...crmOnlyRows];
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
    tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--text-secondary);padding:40px">Nenhum dado encontrado para os filtros selecionados.</td></tr>';
    return;
  }

  // Meta rows first (sorted by spend desc), then CRM-only rows (sorted by leads desc)
  const metaRows   = [...rows].filter(r => !r.crmOnly).sort((a, b) => b.spend - a.spend);
  const crmOnlyRows = [...rows].filter(r =>  r.crmOnly).sort((a, b) => b.leads - a.leads);
  const sorted = [...metaRows, ...crmOnlyRows];

  // ── Totais ──
  const totalSpend  = sorted.reduce((s, r) => s + r.spend,       0);
  const totalImp    = sorted.reduce((s, r) => s + r.impressions,  0);
  const totalClicks = sorted.reduce((s, r) => s + r.clicks,       0);
  const totalLeads  = sorted.reduce((s, r) => s + r.leads,        0);
  const avgCPM      = totalImp   > 0 ? (totalSpend / totalImp) * 1000 : 0;
  const avgCTR      = totalClicks > 0 && totalImp > 0 ? (totalClicks / totalImp) * 100 : 0;
  const totalCPL    = totalLeads > 0 ? totalSpend / totalLeads : null;

  const totalsRow = `
    <tr class="row-totals">
      <td colspan="5"><strong>Total</strong></td>
      <td class="num"><strong>${fmtBRL(totalSpend)}</strong></td>
      <td class="num"><strong>${fmtNum(totalImp)}</strong></td>
      <td class="num"><strong>${fmtBRL(avgCPM)}</strong></td>
      <td class="num"><strong>${fmtNum(totalClicks)}</strong></td>
      <td class="num"><strong>${fmtPct(avgCTR)}</strong></td>
      <td class="num ${cplClass(totalCPL)}"><strong>${totalCPL !== null ? fmtBRL(totalCPL) : '—'}</strong></td>
      <td class="num"><strong>${fmtNum(totalLeads)}</strong></td>
    </tr>
  `;

  tbody.innerHTML = sorted.map(r => {
    // ── Coluna AD NAME (CRM) ──
    // Caso 1 — Meta-only (sem leads CRM):      "—"
    // Caso 2 — CRM-only (sem dados Meta):       utm_content → canal → "Direto"
    // Caso 3 — Meta + CRM casados:             utm_content (adNameCRM)
    let adNameCRMContent, adNameCRMTitle;
    if (!r.crmOnly && !r.adNameCRM) {
      adNameCRMContent = '<span style="color:var(--text-secondary)">—</span>';
      adNameCRMTitle   = '';
    } else if (r.adNameCRM) {
      adNameCRMContent = removePrefix(r.adNameCRM, AD_PREFIX);
      adNameCRMTitle   = r.adNameCRM;
    } else if (r.channel) {
      adNameCRMContent = `<span style="color:var(--text-secondary);font-style:italic">${r.channel}</span>`;
      adNameCRMTitle   = r.channel;
    } else {
      adNameCRMContent = '<span style="color:var(--text-secondary);font-style:italic">Direto</span>';
      adNameCRMTitle   = '';
    }

    // ── Células Meta (vazias para linhas CRM-only) ──
    const dayCell    = r.crmOnly ? '<span style="color:var(--text-secondary)">—</span>' : r.day;
    const spendCell  = r.crmOnly ? '<span style="color:var(--text-secondary)">—</span>' : fmtBRL(r.spend);
    const impCell    = r.crmOnly ? '<span style="color:var(--text-secondary)">—</span>' : fmtNum(r.impressions);
    const cpmCell    = r.crmOnly ? '<span style="color:var(--text-secondary)">—</span>' : fmtBRL(r.cpm);
    const clkCell    = r.crmOnly ? '<span style="color:var(--text-secondary)">—</span>' : fmtNum(r.clicks);
    const ctrCell    = r.crmOnly ? '<span style="color:var(--text-secondary)">—</span>' : fmtPct(r.ctr);

    // Texto completo (sem truncamento) — title mantém valor original para tooltip
    const campaignTxt = r.crmOnly ? '—' : r.campaignName;
    const adSetTxt    = r.crmOnly ? '—' : removePrefix(r.adSetName, AD_PREFIX);
    const adNameTxt   = r.crmOnly
      ? '<span style="color:var(--text-secondary);font-style:italic">Sem dado Meta</span>'
      : removePrefix(r.adName, AD_PREFIX);

    return `
    <tr class="${r.crmOnly ? 'row-crm-only' : ''}">
      <td>${dayCell}</td>
      <td class="cell-truncate" title="${r.crmOnly ? '' : r.campaignName}">${campaignTxt}</td>
      <td class="cell-truncate" title="${r.crmOnly ? '' : r.adSetName}">${adSetTxt}</td>
      <td class="cell-truncate" title="${r.crmOnly ? '' : r.adName}">${adNameTxt}</td>
      <td class="cell-truncate" title="${adNameCRMTitle}">${adNameCRMContent}</td>
      <td class="num">${spendCell}</td>
      <td class="num">${impCell}</td>
      <td class="num">${cpmCell}</td>
      <td class="num">${clkCell}</td>
      <td class="num">${ctrCell}</td>
      <td class="num ${cplClass(r.cpl)}">${r.cpl !== null ? fmtBRL(r.cpl) : '—'}</td>
      <td class="num">${fmtNum(r.leads)}</td>
    </tr>
  `;
  }).join('') + totalsRow;
}

function cplClass(cpl) {
  if (cpl === null) return '';
  if (cpl <= CPL_ALERT * 0.75) return 'cpl-good';
  if (cpl <= CPL_ALERT)        return 'cpl-warn';
  return 'cpl-bad';
}

/** Remove prefixo do início do texto (case-sensitive) */
function removePrefix(text, prefix) {
  if (!text) return text || '';
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/** Trunca no espaço mais próximo antes de maxChars; adiciona "…" */
function truncate(text, maxChars) {
  if (!text || text.length <= maxChars) return text || '';
  const cut = text.lastIndexOf(' ', maxChars);
  return (cut > maxChars * 0.6 ? text.slice(0, cut) : text.slice(0, maxChars)) + '…';
}

// Alias interno para compatibilidade com chamadas legadas
function trunc(s, n) { return truncate(s, n); }

const AD_PREFIX = 'graduacao_grad-adm_';

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
// 9. Render Insights panel — 2×2 grid
// ============================================================
function renderInsights(rows, crmRows) {
  const el = document.getElementById('insights');
  if (!el) return;

  // ── Dados base ──────────────────────────────────────────────
  const totalSpend = rows.reduce((s, r) => s + r.spend, 0);
  const totalLeads = crmRows.length;
  const globalCPL  = totalLeads > 0 ? totalSpend / totalLeads : null;

  // Leads e spend por praça (fonte CRM + merge com Meta)
  const cityLeads = {};   // city → count
  const citySpend = {};   // city → spend (dos rows mesclados)
  crmRows.forEach(r => {
    const city = cityFromEventoCompleto(r['Evento Completo']) || 'Outros';
    cityLeads[city] = (cityLeads[city] || 0) + 1;
  });
  rows.forEach(r => {
    if (!r.spend) return;
    const city = cityFromAdSetSlug(r.adSetName || '') || 'Outros';
    citySpend[city] = (citySpend[city] || 0) + r.spend;
  });

  // CPL por praça
  const cityList = Object.keys(cityLeads).sort();
  const cityStats = cityList.map(city => {
    const leads = cityLeads[city] || 0;
    const spend = citySpend[city] || 0;
    const cpl   = leads > 0 ? spend / leads : null;
    return { city, leads, spend, cpl };
  }).sort((a, b) => b.leads - a.leads);

  // Melhor criativo por cidade (menor CPL, mín. 1 lead)
  const bestCreativeByCity = {};
  rows.forEach(r => {
    if (!r.leads || r.cpl === null) return;
    const city = cityFromAdSetSlug(r.adSetName || '') || 'Outros';
    if (!bestCreativeByCity[city] || r.cpl < bestCreativeByCity[city].cpl) {
      bestCreativeByCity[city] = r;
    }
  });

  // ── Quadrante 1: CPL Global ──────────────────────────────────
  const q1 = insightQuad(
    'CPL Global',
    globalCPL !== null
      ? `<span class="iq-kpi ${globalCPL <= CPL_ALERT ? 'iq-good' : 'iq-bad'}">${fmtBRL(globalCPL)}</span>`
      : '<span class="iq-empty">Sem dados</span>',
    globalCPL !== null
      ? `<div class="iq-sub-row"><span>${fmtNum(totalLeads)} leads</span><span>${fmtBRL(totalSpend)} investidos</span></div>`
      : ''
  );

  // ── Quadrante 2: CPL por Praça ───────────────────────────────
  const cplRows = cityStats.length
    ? cityStats.map(s => {
        const cls = s.cpl === null ? '' : s.cpl <= CPL_ALERT ? 'iq-good' : 'iq-bad';
        return `
          <div class="iq-city-row">
            <span class="iq-city-name">${s.city}</span>
            <span class="iq-city-leads">${fmtNum(s.leads)} leads</span>
            <span class="iq-city-cpl ${cls}">${s.cpl !== null ? fmtBRL(s.cpl) : '—'}</span>
          </div>`;
      }).join('')
    : '<span class="iq-empty">Sem dados por praça</span>';

  const q2 = insightQuad('CPL por Praça', cplRows, '');

  // ── Quadrante 3: Volume de Leads por Cidade ──────────────────
  const maxLeads = cityStats[0]?.leads || 1;
  const leadsRows = cityStats.length
    ? cityStats.map((s, i) => {
        const pct = Math.round((s.leads / maxLeads) * 100);
        const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        return `
          <div class="iq-bar-row">
            <span class="iq-bar-rank">${rank}</span>
            <span class="iq-bar-label">${s.city}</span>
            <div class="iq-bar-wrap">
              <div class="iq-bar-fill" style="width:${pct}%"></div>
            </div>
            <span class="iq-bar-val">${fmtNum(s.leads)}</span>
          </div>`;
      }).join('')
    : '<span class="iq-empty">Sem dados</span>';

  const q3 = insightQuad('Volume de Leads por Cidade', leadsRows, '');

  // ── Quadrante 4: Melhor Criativo por Cidade ──────────────────
  const creativeRows = Object.keys(bestCreativeByCity).length
    ? Object.entries(bestCreativeByCity)
        .sort((a, b) => b[1].leads - a[1].leads)
        .map(([city, r]) => `
          <div class="iq-creative-row">
            <span class="iq-creative-city">${city}</span>
            <span class="iq-creative-name">${removePrefix(r.adName, AD_PREFIX) || r.adName}</span>
            <span class="iq-creative-stats">
              <span class="iq-good">${fmtBRL(r.cpl)}</span>
              <span class="iq-muted">&middot; ${fmtNum(r.leads)} leads</span>
            </span>
          </div>`).join('')
    : '<span class="iq-empty">Sem dados de criativo</span>';

  const q4 = insightQuad('Melhor Criativo por Cidade', creativeRows, '');

  el.innerHTML = q1 + q2 + q3 + q4;
}

function insightQuad(title, bodyHtml, footerHtml) {
  return `
    <div class="insight-quad">
      <div class="iq-header">${title}</div>
      <div class="iq-body">${bodyHtml}</div>
      ${footerHtml ? `<div class="iq-footer">${footerHtml}</div>` : ''}
    </div>`;
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
// PRAÇA — normalização e extração
//
// Meta Ad Set Name usa slug:  "evento-saopaulo-1104"  → "São Paulo"
// CRM Evento Completo usa:    "São Paulo - 11/04/2026" → "São Paulo"
//
// Normalizar para lowercase+sem acento permite comparar as duas fontes.
// ============================================================

// Slug → cidade legível (cobre as praças conhecidas do dataset)
const SLUG_TO_CITY = {
  saopaulo:  'São Paulo',
  fortaleza: 'Fortaleza',
  salvador:  'Salvador',
  recife:    'Recife',
  riodejaneiro: 'Rio de Janeiro',
  belo:      'Belo Horizonte',   // "belo-horizonte"
  horizonte: 'Belo Horizonte',
  curitiba:  'Curitiba',
  manaus:    'Manaus',
  belem:     'Belém',
  goiania:   'Goiânia',
  portoalegre: 'Porto Alegre',
};

/** "evento-saopaulo-1104" → "São Paulo"  |  null se não reconhecer */
function cityFromAdSetSlug(adSetName) {
  // Procura segmento que começa com "evento-"
  const match = adSetName.toLowerCase().match(/evento-([a-z]+)/);
  if (!match) return null;
  const slug = match[1];
  return SLUG_TO_CITY[slug] || slug.charAt(0).toUpperCase() + slug.slice(1);
}

/** "Fortaleza - 25/04/2026" → "Fortaleza" */
function cityFromEventoCompleto(ev) {
  if (!ev || !ev.trim()) return null;
  return ev.split('-')[0].trim() || null;
}

/** Normaliza string para comparação: lowercase, sem acento, sem espaço extra */
function normCity(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// ============================================================
// FILTERS — populate dropdowns from raw data
// ============================================================

/** Praças únicas — fonte: CRM Evento Completo (exibição) */
function extractPracas(crmRows) {
  const set = new Set();
  crmRows.forEach(r => {
    const city = cityFromEventoCompleto(r['Evento Completo']);
    if (city) set.add(city);
  });
  return [...set].sort();
}

/**
 * Ad Names únicos do Meta — filtrados pela praça se informada.
 * Usa cityFromAdSetSlug para identificar quais Ad Sets pertencem à praça.
 */
function extractCriativos(metaRows, praca) {
  const set = new Set();
  const normPraca = normCity(praca);
  metaRows.forEach(r => {
    const name = (r['Ad Name'] || '').trim();
    if (!name) return;
    if (praca) {
      const city = cityFromAdSetSlug(r['Ad Set Name'] || '');
      if (!city || normCity(city) !== normPraca) return;
    }
    set.add(name);
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
  // Mantém seleção atual apenas se ainda existir nas novas opções
  el.value = [...el.options].some(o => o.value === current) ? current : '';
}

function populateFilters() {
  populateSelect('filter-praca', extractPracas(_rawCRM));
  // Criativos sem filtro de praça ainda (será re-populado no onChange de praça)
  populateSelect('filter-criativo', extractCriativos(_rawMeta, ''));
}

/** Chamado quando o select de praça muda — re-popula criativos */
function onPracaChange() {
  const praca = (document.getElementById('filter-praca') || {}).value || '';
  populateSelect('filter-criativo', extractCriativos(_rawMeta, praca));
  applyFilters();
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
  // Restaura todos os criativos
  populateSelect('filter-criativo', extractCriativos(_rawMeta, ''));
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
  const normPraca = normCity(f.praca);

  // ── Meta rows ──────────────────────────────────────────────
  let metaRows = _rawMeta.slice();

  // Filtro praça: Ad Set Name deve conter a cidade selecionada
  if (f.praca) {
    metaRows = metaRows.filter(r => {
      const city = cityFromAdSetSlug(r['Ad Set Name'] || '');
      return city ? normCity(city) === normPraca : false;
    });
  }

  // Filtro criativo (Ad Name)
  if (f.criativo) {
    metaRows = metaRows.filter(r => (r['Ad Name'] || '') === f.criativo);
  }

  // Filtro data (coluna "Day" no Meta, formato YYYY-MM-DD)
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

  // ── CRM rows ───────────────────────────────────────────────
  let crmRows = _rawCRM.slice();

  // Filtro praça: Evento Completo deve ter a mesma cidade
  if (f.praca) {
    crmRows = crmRows.filter(r => {
      const city = cityFromEventoCompleto(r['Evento Completo']);
      return city ? normCity(city) === normPraca : false;
    });
  }

  // Filtro criativo: utm_content deve ser igual ao Ad Name
  if (f.criativo) {
    crmRows = crmRows.filter(r => (r['utm_content'] || '').trim() === f.criativo);
  }

  // Filtro data (coluna "Data" no CRM, formato DD/MM/YYYY)
  if (f.dateStart || f.dateEnd) {
    const start = parseDate(f.dateStart);
    const end   = parseDate(f.dateEnd);
    crmRows = crmRows.filter(r => {
      const d = parseDate(r['Data']);
      if (!d) return true;
      if (start && d < start) return false;
      if (end   && d > end)   return false;
      return true;
    });
  }

  // ── Re-render ──────────────────────────────────────────────
  const metaAgg = aggregateMeta(metaRows);
  const data    = mergeData(metaAgg, crmRows);

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
  const metaAgg = aggregateMeta(metaRows);
  const data    = mergeData(metaAgg, crmRows);
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

    // Praça: re-popula criativos antes de re-renderizar
    const elPraca = document.getElementById('filter-praca');
    if (elPraca) elPraca.addEventListener('change', onPracaChange);

    // Criativo e datas: apenas re-renderizam
    ['filter-criativo','filter-date-start','filter-date-end'].forEach(id => {
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
