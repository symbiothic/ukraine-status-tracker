/**
 * Ukraine Status Tracker — script.js
 * Pulls data from DeepStateMap via cached data/map.json (updated by GitHub Actions)
 * Falls back to direct API via CORS proxy if cache not available
 */

'use strict';

// ─── CONFIG ────────────────────────────────────────────────────────────────

const CONFIG = {
  // Primary: GitHub Actions caches this every 15 min
  DATA_URL:         'data/map.json',
  // Fallback CORS proxy for direct browser access
  CORS_PROXY:       'https://api.allorigins.win/raw?url=',
  DEEPSTATE_API:    'https://deepstatemap.live/api/history/last',
  DEEPSTATE_MAP:    'https://deepstatemap.live',
  REFRESH_INTERVAL: 15 * 60 * 1000, // 15 minutes
  PAGE_SIZE:        100,
};

// ─── STATE ─────────────────────────────────────────────────────────────────

const state = {
  allRows:      [],   // raw parsed rows
  filtered:     [],   // after search + filters
  sortCol:      'oblast',
  sortDir:      'asc',
  page:         1,
  searchTerm:   '',
  filterOblast: '',
  filterRaion:  '',
  filterStatus: '',
  lastUpdated:  null,
  updateTimer:  null,
};

// ─── DOM REFS ──────────────────────────────────────────────────────────────

const $  = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

const el = {
  body:         document.body,
  tableBody:    $('tableBody'),
  loadOverlay:  $('loadingOverlay'),
  emptyState:   $('emptyState'),
  tableWrap:    document.querySelector('.table-wrap'),
  tableContainer: document.querySelector('.table-container'),
  searchInput:  $('searchInput'),
  searchClear:  $('searchClear'),
  filterOblast: $('filterOblast'),
  filterRaion:  $('filterRaion'),
  filterStatus: $('filterStatus'),
  updateDot:    $('updateDot'),
  updateText:   $('updateText'),
  rowCount:     $('rowCount'),
  pagination:   $('pagination'),
  statTotal:    $('statTotal'),
  statFree:     $('statFree'),
  statOccupied: $('statOccupied'),
  statUnknown:  $('statUnknown'),
  themeToggle:  $('themeToggle'),
};

// ─── STATUS PARSING ────────────────────────────────────────────────────────

/**
 * Parse status from DeepStateMap feature properties.
 * DeepState uses styleUrl/fill colour and the name field to indicate status.
 * Occupied areas have specific style hashes referencing "occupied" / red fills.
 * Free areas are styled with green. Unknown = grey.
 */
function parseStatus(props) {
  const name = (props.name || '').toLowerCase();
  const fill = (props.fill || '').toLowerCase();
  const styleUrl = (props.styleUrl || props.styleHash || '').toLowerCase();

  // Explicit name markers used by DeepState
  if (name.includes('окупован') || name.includes('occupied') || name.includes('occ'))
    return 'occupied';
  if (name.includes('вільн') || name.includes('free') || name.includes('liberat'))
    return 'free';

  // Colour-based heuristics (DeepState conventions)
  // Red / dark red = occupied
  if (/^#(b71c|c62828|d32f|e53935|ef5350|f44336|e74c|ff1744|d50000|c0392b|922b|7b241c|641e|4a0e)/.test(fill))
    return 'occupied';
  // Green = free / liberated
  if (/^#(1b5e|2e7d|388e|43a047|4caf|66bb|76ff|00c853|00e676|1abc|27ae|2ecc|38d9|00b894|4cd964)/.test(fill))
    return 'free';

  // Style URL / hash hints
  if (styleUrl.includes('occ') || styleUrl.includes('red') || styleUrl.includes('bcaaa') === false && fill.startsWith('#b') || fill.startsWith('#c') || fill.startsWith('#d') || fill.startsWith('#e') || fill.startsWith('#f')) {
    // Further filter: typical occupied reds in DeepState
    const hex = fill.replace('#', '');
    if (hex.length >= 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if (r > 150 && g < 100 && b < 100) return 'occupied';
      if (r > 100 && g > 150 && b < 100) return 'free';
    }
  }

  return 'unknown';
}

/**
 * Compute centroid of a GeoJSON geometry (Polygon or MultiPolygon)
 * Returns [lng, lat] or null.
 */
function getCentroid(geometry) {
  try {
    let coords = [];
    if (geometry.type === 'Point') {
      return [geometry.coordinates[0], geometry.coordinates[1]];
    }
    if (geometry.type === 'Polygon') {
      coords = geometry.coordinates[0];
    } else if (geometry.type === 'MultiPolygon') {
      // Use the largest ring
      let best = [];
      for (const poly of geometry.coordinates) {
        if (poly[0].length > best.length) best = poly[0];
      }
      coords = best;
    } else {
      return null;
    }
    let sumLng = 0, sumLat = 0, n = 0;
    for (const c of coords) {
      sumLng += c[0]; sumLat += c[1]; n++;
    }
    return n ? [sumLng / n, sumLat / n] : null;
  } catch { return null; }
}

// ─── NAME / LOCATION PARSING ───────────────────────────────────────────────

/**
 * Extract human-readable place name from DeepState feature name field.
 * The name field often has format: "Назва /// Name /// geoJSON.key"
 * or just a plain Ukrainian name.
 */
function parsePlaceName(rawName) {
  if (!rawName) return '';
  // Split by ///
  const parts = rawName.split('///').map(s => s.trim()).filter(Boolean);
  // Return first Ukrainian-looking part (non-latin-only)
  for (const p of parts) {
    if (/[а-яіїєґА-ЯІЇЄҐ]/.test(p)) return p;
  }
  return parts[0] || rawName;
}

// ─── LOCATION LOOKUP TABLE ────────────────────────────────────────────────

/**
 * Built-in lookup: map of place name → { oblast, raion }
 * This is populated from data/locations.json (pre-built by script)
 * or falls back to coordinate-based oblast detection.
 */
let locationDB = null;

async function loadLocationDB() {
  try {
    const r = await fetch('data/locations.json');
    if (r.ok) {
      locationDB = await r.json();
      console.log(`[LocationDB] Loaded ${Object.keys(locationDB).length} entries`);
    }
  } catch (e) {
    console.warn('[LocationDB] Not available, using coordinate fallback');
  }
}

/**
 * Rough coordinate → oblast lookup (bounding boxes, not exact polygons).
 * Only used as fallback when locationDB is missing.
 */
const OBLAST_BOUNDS = [
  { name: 'Донецька',       minLng: 36.5, maxLng: 39.0, minLat: 47.0, maxLat: 49.4 },
  { name: 'Луганська',      minLng: 37.8, maxLng: 40.2, minLat: 48.0, maxLat: 50.1 },
  { name: 'Запорізька',     minLng: 34.0, maxLng: 37.0, minLat: 46.5, maxLat: 48.0 },
  { name: 'Херсонська',     minLng: 32.0, maxLng: 35.5, minLat: 45.7, maxLat: 47.8 },
  { name: 'Харківська',     minLng: 35.5, maxLng: 38.5, minLat: 49.0, maxLat: 50.4 },
  { name: 'Миколаївська',   minLng: 31.0, maxLng: 34.5, minLat: 46.5, maxLat: 48.5 },
  { name: 'Дніпропетровська', minLng: 33.0, maxLng: 36.5, minLat: 47.2, maxLat: 49.0 },
  { name: 'Одеська',        minLng: 28.8, maxLng: 31.5, minLat: 45.3, maxLat: 47.5 },
  { name: 'Сумська',        minLng: 32.5, maxLng: 35.5, minLat: 50.2, maxLat: 52.4 },
  { name: 'Чернігівська',   minLng: 30.5, maxLng: 33.8, minLat: 50.5, maxLat: 52.4 },
  { name: 'Київська',       minLng: 29.2, maxLng: 32.3, minLat: 49.5, maxLat: 51.6 },
  { name: 'Полтавська',     minLng: 32.5, maxLng: 35.5, minLat: 48.8, maxLat: 50.5 },
  { name: 'Черкаська',      minLng: 30.5, maxLng: 32.8, minLat: 48.5, maxLat: 50.0 },
  { name: 'Кіровоградська', minLng: 30.5, maxLng: 33.0, minLat: 47.8, maxLat: 49.2 },
  { name: 'Вінницька',      minLng: 27.5, maxLng: 30.5, minLat: 48.2, maxLat: 50.0 },
  { name: 'Житомирська',    minLng: 27.4, maxLng: 30.5, minLat: 49.5, maxLat: 51.8 },
  { name: 'Хмельницька',    minLng: 26.0, maxLng: 28.5, minLat: 48.5, maxLat: 50.2 },
  { name: 'Тернопільська',  minLng: 25.2, maxLng: 27.0, minLat: 48.8, maxLat: 50.0 },
  { name: 'Рівненська',     minLng: 25.5, maxLng: 28.0, minLat: 50.2, maxLat: 51.8 },
  { name: 'Волинська',      minLng: 23.5, maxLng: 26.0, minLat: 50.4, maxLat: 52.2 },
  { name: 'Львівська',      minLng: 22.5, maxLng: 25.0, minLat: 48.7, maxLat: 50.5 },
  { name: 'Івано-Франківська', minLng: 23.5, maxLng: 25.5, minLat: 47.7, maxLat: 49.1 },
  { name: 'Закарпатська',   minLng: 22.0, maxLng: 24.5, minLat: 47.8, maxLat: 49.0 },
  { name: 'Чернівецька',    minLng: 24.8, maxLng: 26.5, minLat: 47.7, maxLat: 48.9 },
  { name: 'Автономна Республіка Крим', minLng: 32.5, maxLng: 36.7, minLat: 44.4, maxLat: 46.3 },
];

function guessOblast(lng, lat) {
  // Find the matching oblast with smallest area (most specific)
  let best = null, bestArea = Infinity;
  for (const o of OBLAST_BOUNDS) {
    if (lng >= o.minLng && lng <= o.maxLng && lat >= o.minLat && lat <= o.maxLat) {
      const area = (o.maxLng - o.minLng) * (o.maxLat - o.minLat);
      if (area < bestArea) { best = o.name; bestArea = area; }
    }
  }
  return best || '';
}

// ─── DATA FETCHING ─────────────────────────────────────────────────────────

async function fetchData() {
  setUpdateStatus('loading', 'Завантаження…');

  let json = null;

  // 1. Try cached file (GitHub Actions updates this)
  try {
    const r = await fetch(CONFIG.DATA_URL + '?t=' + Date.now());
    if (r.ok) {
      json = await r.json();
      console.log('[Data] Loaded from cache');
    }
  } catch (e) { /* fallthrough */ }

  // 2. Try direct API via CORS proxy
  if (!json) {
    try {
      const url = CONFIG.CORS_PROXY + encodeURIComponent(CONFIG.DEEPSTATE_API);
      const r = await fetch(url);
      if (r.ok) {
        json = await r.json();
        console.log('[Data] Loaded via CORS proxy');
      }
    } catch (e) {
      console.error('[Data] All fetches failed:', e);
      setUpdateStatus('error', 'Помилка завантаження');
      return;
    }
  }

  if (!json) {
    setUpdateStatus('error', 'Дані недоступні');
    return;
  }

  parseAndRender(json);
}

// ─── PARSING ───────────────────────────────────────────────────────────────

function parseAndRender(json) {
  const features = json?.map?.features || json?.features || [];
  const updatedAt = json?.updated_at || json?.id
    ? new Date(typeof json.id === 'number' && json.id > 1e9 ? json.id * 1000 : Date.now())
    : new Date();

  const rows = [];

  for (const f of features) {
    const props = f.properties || {};
    const rawName = props.name || '';

    // Skip unnamed / style-only features
    if (!rawName || rawName.startsWith('poly-') || rawName.startsWith('#')) continue;

    const placeName = parsePlaceName(rawName);
    if (!placeName) continue;

    const status = parseStatus(props);
    const centroid = getCentroid(f.geometry);
    const [lng, lat] = centroid || [0, 0];

    // Location lookup
    let oblast = '', raion = '';
    const nameKey = placeName.toLowerCase().trim();

    if (locationDB) {
      const entry = locationDB[nameKey] || locationDB[nameKey.replace(/^(місто|смт|село|селище)\s+/i, '')];
      if (entry) { oblast = entry.oblast || ''; raion = entry.raion || ''; }
    }

    if (!oblast && centroid) {
      oblast = guessOblast(lng, lat);
    }

    // Build map URL
    const zoom = 13;
    const mapUrl = centroid
      ? `${CONFIG.DEEPSTATE_MAP}/#${zoom}/${lat.toFixed(7)}/${lng.toFixed(7)}`
      : CONFIG.DEEPSTATE_MAP;

    // Date from props or global
    let dateStr = '';
    if (props.updated_at) {
      dateStr = formatDate(new Date(props.updated_at));
    } else {
      dateStr = formatDate(updatedAt);
    }

    rows.push({ name: placeName, oblast, raion, status, dateStr, mapUrl, lat, lng });
  }

  // Deduplicate by name+oblast
  const seen = new Set();
  const deduped = rows.filter(r => {
    const key = r.name + '|' + r.oblast;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  state.allRows = deduped;
  state.lastUpdated = new Date();

  populateFilters();
  applyFilters();
  updateStats();
  hideLoading();

  setUpdateStatus('ok', 'Оновлено ' + formatDate(state.lastUpdated));
}

// ─── FILTERS & SEARCH ─────────────────────────────────────────────────────

function populateFilters() {
  const oblasts = [...new Set(state.allRows.map(r => r.oblast).filter(Boolean))].sort();
  const raions  = [...new Set(state.allRows.map(r => r.raion).filter(Boolean))].sort();

  fillSelect(el.filterOblast, oblasts, 'Всі області');
  fillSelect(el.filterRaion, raions, 'Всі райони');
}

function fillSelect(sel, values, placeholder) {
  const cur = sel.value;
  sel.innerHTML = `<option value="">${placeholder}</option>`;
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v; o.textContent = v;
    if (v === cur) o.selected = true;
    sel.appendChild(o);
  }
}

function applyFilters() {
  const term = state.searchTerm.toLowerCase();
  const { filterOblast, filterRaion, filterStatus } = state;

  state.filtered = state.allRows.filter(r => {
    if (filterOblast && r.oblast !== filterOblast) return false;
    if (filterRaion  && r.raion  !== filterRaion)  return false;
    if (filterStatus && r.status !== filterStatus) return false;
    if (term && !(
      r.name.toLowerCase().includes(term)   ||
      r.oblast.toLowerCase().includes(term) ||
      r.raion.toLowerCase().includes(term)
    )) return false;
    return true;
  });

  sortRows();
}

function sortRows() {
  const { sortCol, sortDir } = state;
  state.filtered.sort((a, b) => {
    let av = a[sortCol] || '', bv = b[sortCol] || '';
    if (sortCol === 'status') {
      const order = { free: 0, unknown: 1, occupied: 2 };
      av = order[av] ?? 1; bv = order[bv] ?? 1;
    }
    const cmp = typeof av === 'number' ? av - bv : av.localeCompare(bv, 'uk');
    return sortDir === 'asc' ? cmp : -cmp;
  });
  state.page = 1;
  renderTable();
}

// ─── RENDERING ─────────────────────────────────────────────────────────────

function renderTable() {
  const { filtered, page } = state;
  const start = (page - 1) * CONFIG.PAGE_SIZE;
  const pageRows = filtered.slice(start, start + CONFIG.PAGE_SIZE);

  if (!filtered.length) {
    el.tableContainer.style.display = 'none';
    el.emptyState.style.display     = 'block';
    el.rowCount.textContent = '0 записів';
    el.pagination.innerHTML = '';
    return;
  }

  el.tableContainer.style.display = '';
  el.emptyState.style.display     = 'none';
  el.rowCount.textContent = `${filtered.length.toLocaleString('uk')} записів`;

  // Render rows using DocumentFragment for performance
  const frag = document.createDocumentFragment();
  for (const r of pageRows) {
    const tr = buildRow(r);
    frag.appendChild(tr);
  }
  el.tableBody.innerHTML = '';
  el.tableBody.appendChild(frag);

  renderPagination();
}

function buildRow(r) {
  const tr = document.createElement('tr');

  const statusLabel = { free: '🟢 Вільний', occupied: '🔴 Окупований', unknown: '⚪ Невідомо' }[r.status] || r.status;
  const badgeCls    = { free: 'badge-free', occupied: 'badge-occupied', unknown: 'badge-unknown' }[r.status] || 'badge-unknown';

  tr.innerHTML = `
    <td class="td-oblast" title="${esc(r.oblast)}">${esc(r.oblast) || '—'}</td>
    <td class="td-raion"  title="${esc(r.raion)}">${esc(r.raion)  || '—'}</td>
    <td class="td-name"   title="${esc(r.name)}">${esc(r.name)}</td>
    <td><span class="badge ${badgeCls}">${statusLabel}</span></td>
    <td class="td-date">${esc(r.dateStr)}</td>
    <td>
      <a class="map-link" href="${esc(r.mapUrl)}" target="_blank" rel="noopener" title="Відкрити на DeepStateMap">
        🗺 Карта
      </a>
    </td>
  `;
  return tr;
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderPagination() {
  const total = Math.ceil(state.filtered.length / CONFIG.PAGE_SIZE);
  if (total <= 1) { el.pagination.innerHTML = ''; return; }

  const frag = document.createDocumentFragment();
  const cur  = state.page;

  const addBtn = (label, pg, disabled = false) => {
    const b = document.createElement('button');
    b.className = 'page-btn' + (pg === cur ? ' active' : '');
    b.textContent = label;
    b.disabled = disabled;
    if (!disabled) b.addEventListener('click', () => goPage(pg));
    frag.appendChild(b);
  };

  addBtn('‹', cur - 1, cur === 1);

  // Show window of pages
  const range = pageRange(cur, total);
  let prev = null;
  for (const p of range) {
    if (prev !== null && p - prev > 1) {
      const span = document.createElement('span');
      span.textContent = '…'; span.style.cssText = 'padding:0 4px;color:var(--c-text3);line-height:32px;';
      frag.appendChild(span);
    }
    addBtn(p, p);
    prev = p;
  }

  addBtn('›', cur + 1, cur === total);
  el.pagination.innerHTML = '';
  el.pagination.appendChild(frag);
}

function pageRange(cur, total) {
  const delta = 2;
  const range = new Set([1, total]);
  for (let i = Math.max(2, cur - delta); i <= Math.min(total - 1, cur + delta); i++) range.add(i);
  return [...range].sort((a, b) => a - b);
}

function goPage(p) {
  state.page = p;
  renderTable();
  el.tableContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── STATS ─────────────────────────────────────────────────────────────────

function updateStats() {
  const all  = state.allRows;
  const free = all.filter(r => r.status === 'free').length;
  const occ  = all.filter(r => r.status === 'occupied').length;
  const unk  = all.filter(r => r.status === 'unknown').length;

  el.statTotal.textContent    = all.length.toLocaleString('uk');
  el.statFree.textContent     = free.toLocaleString('uk');
  el.statOccupied.textContent = occ.toLocaleString('uk');
  el.statUnknown.textContent  = unk.toLocaleString('uk');
}

// ─── UI HELPERS ────────────────────────────────────────────────────────────

function setUpdateStatus(type, text) {
  el.updateDot.className = 'update-dot ' + type;
  el.updateText.textContent = text;
}

function hideLoading() {
  el.loadOverlay.classList.add('hidden');
}

function formatDate(d) {
  if (!(d instanceof Date) || isNaN(d)) return '—';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── SORT HEADERS ──────────────────────────────────────────────────────────

function initSortHeaders() {
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (state.sortCol === col) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortCol = col;
        state.sortDir = 'asc';
      }
      // Update header classes
      document.querySelectorAll('th.sortable').forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
      th.classList.add(state.sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      sortRows();
    });
  });
}

// ─── THEME ─────────────────────────────────────────────────────────────────

function initTheme() {
  const saved = localStorage.getItem('theme') || 'dark';
  setTheme(saved);
  el.themeToggle.addEventListener('click', () => {
    setTheme(el.body.classList.contains('dark') ? 'light' : 'dark');
  });
}

function setTheme(t) {
  el.body.classList.toggle('dark',  t === 'dark');
  el.body.classList.toggle('light', t === 'light');
  el.themeToggle.textContent = t === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('theme', t);
}

// ─── EVENT LISTENERS ───────────────────────────────────────────────────────

function initEvents() {
  // Search — debounced
  let searchTimer;
  el.searchInput.addEventListener('input', e => {
    clearTimeout(searchTimer);
    const val = e.target.value;
    el.searchClear.classList.toggle('visible', val.length > 0);
    searchTimer = setTimeout(() => {
      state.searchTerm = val;
      applyFilters();
    }, 180);
  });

  el.searchClear.addEventListener('click', () => {
    el.searchInput.value = '';
    el.searchClear.classList.remove('visible');
    state.searchTerm = '';
    applyFilters();
  });

  // Filters
  el.filterOblast.addEventListener('change', e => {
    state.filterOblast = e.target.value;
    // Reset raion filter when oblast changes
    state.filterRaion = '';
    el.filterRaion.value = '';
    // Update raion dropdown to match oblast
    if (e.target.value) {
      const raions = [...new Set(
        state.allRows
          .filter(r => r.oblast === e.target.value)
          .map(r => r.raion)
          .filter(Boolean)
      )].sort();
      fillSelect(el.filterRaion, raions, 'Всі райони');
    } else {
      const raions = [...new Set(state.allRows.map(r => r.raion).filter(Boolean))].sort();
      fillSelect(el.filterRaion, raions, 'Всі райони');
    }
    applyFilters();
  });

  el.filterRaion.addEventListener('change', e => {
    state.filterRaion = e.target.value;
    applyFilters();
  });

  el.filterStatus.addEventListener('change', e => {
    state.filterStatus = e.target.value;
    applyFilters();
  });

  $('resetFilters').addEventListener('click', resetAll);
}

function resetAll() {
  state.searchTerm   = '';
  state.filterOblast = '';
  state.filterRaion  = '';
  state.filterStatus = '';
  el.searchInput.value    = '';
  el.filterOblast.value   = '';
  el.filterRaion.value    = '';
  el.filterStatus.value   = '';
  el.searchClear.classList.remove('visible');
  applyFilters();
}

// Expose for inline onclick
window.resetAll = resetAll;

// ─── AUTO REFRESH ─────────────────────────────────────────────────────────

function startAutoRefresh() {
  if (state.updateTimer) clearInterval(state.updateTimer);
  state.updateTimer = setInterval(() => {
    console.log('[AutoRefresh] Fetching new data…');
    fetchData();
  }, CONFIG.REFRESH_INTERVAL);
}

// ─── INIT ──────────────────────────────────────────────────────────────────

async function init() {
  initTheme();
  initSortHeaders();
  initEvents();

  // Load location database in parallel with data
  await Promise.all([
    loadLocationDB(),
    fetchData(),
  ]);

  startAutoRefresh();
}

document.addEventListener('DOMContentLoaded', init);
