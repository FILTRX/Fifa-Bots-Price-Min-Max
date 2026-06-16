'use strict';
// FIFA WC 2026 Ticket Bot — Content Script v21 PRICE-ONLY
// No category filter — scans ALL available seats, filters by price only
// Greedy seats: takes up to maxSeats (4) if more adjacent seats found than minCount

if (window.__fifaBotLoaded) { /* skip */ } else {
window.__fifaBotLoaded = true;

const DB_NAME = 'FifaBotDB', DB_VER = 1, STORE = 'settings';

let settings = {
  perfIds: [], count: 2, maxSeats: 4, interval: 30, running: false,
  minPrice: 0, maxPrice: 350,
};

// ── IndexedDB ─────────────────────────────────────────────────────────────────
let _db = null;
async function getDB() {
  if (!_db) _db = await new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    r.onsuccess = e => res(e.target.result);
    r.onerror = e => rej(e.target.error);
  });
  return _db;
}
async function saveSettings() {
  (await getDB()).transaction(STORE, 'readwrite').objectStore(STORE).put({ id: 1, settings: { ...settings } });
}
async function loadSettings() {
  return new Promise(async res => {
    const req = (await getDB()).transaction(STORE, 'readonly').objectStore(STORE).get(1);
    req.onsuccess = e => {
      if (e.target.result?.settings) settings = { ...settings, ...e.target.result.settings };
      res(settings);
    };
    req.onerror = () => res(settings);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function pickFirst(...vals) {
  return vals.find(v => v !== undefined && v !== null && v !== '');
}

function textOf(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object') return String(
    pickFirst(v.name?.en, v.name, v.label?.en, v.label, v.description?.en, v.description, v.code, v.key, v.id, '')
  );
  return String(v);
}

function getCategoryText(f) {
  const p = f?.properties || {};
  return textOf(p.seatCategory || p.category || p.seat_category || p.seatCategoryName || p.tariff || p.priceLevel);
}

function parseMoneyToCents(v) {
  if (v === undefined || v === null || v === '') return NaN;
  if (typeof v === 'number') {
    // FIFA resale sends amount in 1/1000 USD: 830070 = $830.07, 750000 = $750.00
    return v > 10000 ? Math.round(v / 10) : Math.round(v * 100);
  }
  const raw = String(v).replace(/[^0-9.,-]/g, '');
  if (!raw) return NaN;
  const normalized = raw.includes(',') && raw.includes('.')
    ? raw.replace(/,/g, '')
    : raw.replace(',', '.');
  const n = Number(normalized);
  if (!Number.isFinite(n)) return NaN;
  return n > 10000 ? Math.round(n / 10) : Math.round(n * 100);
}

function getPriceCents(f) {
  const p = f?.properties || {};
  const vals = [
    p.amount, p.price, p.priceAmount, p.faceValue, p.totalAmount, p.minPrice,
    p.offer?.amount, p.offer?.price, p.ticket?.amount, p.ticket?.price,
    p.product?.amount, p.product?.price, p.tariff?.amount, p.tariff?.price,
  ];
  for (const v of vals) {
    const cents = parseMoneyToCents(v);
    if (Number.isFinite(cents) && cents > 0) return cents;
  }
  return NaN;
}

function blockName(f) {
  const p = f?.properties || {};
  return textOf(p.block?.name?.en || p.block?.name || p.block || p.blockId || p.sector || p.section);
}

function getBlockId(f) {
  const p = f?.properties || {};
  return textOf(p.block?.id || p.blockId || p.block?.code || p.block?.name?.en || p.block?.name || p.block || p.sector || p.section);
}

function seatDebugList(features, limit = 30) {
  return features.slice(0, limit).map(f => {
    const p = f.properties || {};
    const cents = getPriceCents(f);
    return {
      id: f.id,
      category: getCategoryText(f),
      priceUsd: Number.isFinite(cents) ? +(cents / 100).toFixed(2) : null,
      rawAmount: p.amount,
      blockId: getBlockId(f),
      block: blockName(f),
      row: pickFirst(p.row, p.rowName, p.place?.row),
      seat: pickFirst(p.number, p.seatNumber, p.place?.seat),
      propKeys: Object.keys(p).slice(0, 25).join(','),
    };
  });
}

function log(msg, type = 'info') {
  if (type === 'error') console.error('[FIFA Bot]', msg);
  else if (type === 'warn') console.warn('[FIFA Bot]', msg);
  else console.log('[FIFA Bot]', msg);
  chrome.runtime.sendMessage({ type: 'LOG', msg, logType: type }).catch(() => {});
  pageLogs.push({ t: new Date().toTimeString().slice(0, 8), msg, type });
  if (pageLogs.length > 80) pageLogs.shift();
  const b = document.querySelector('#fb-badge');
  if (b) b.textContent = msg.slice(0, 72);
  updatePageLog();
}

// ── Intercept seat/zone data from MAIN world via postMessage ─────────────────
let _allSeats = [];
let _interceptedSeats = null;
let _zones = [];  // NUMBERED_AREA blocks from the map

window.addEventListener('message', e => {
  if (!e.data || !e.data.__fb) return;
  const d = e.data;

  // Individual seats from XHR (seats/free/ol) — have row/seat/price
  if (d.type === 'seats' && d.features?.length) {
    const existingIds = new Set(_allSeats.map(f => String(f.id)));
    const newSeats = d.features.filter(f => !existingIds.has(String(f.id)));
    _allSeats = [..._allSeats, ...newSeats];
    _interceptedSeats = _allSeats;

    const withPrice = _allSeats.filter(f => Number.isFinite(getPriceCents(f)));
    if (withPrice.length) {
      const prices = withPrice.map(f => getPriceCents(f) / 100);
      const minP = Math.min(...prices).toFixed(2);
      const maxP = Math.max(...prices).toFixed(2);
      log(`+${newSeats.length} seats (total: ${_allSeats.length}) | $${minP}–$${maxP}`);
    } else if (newSeats.length > 0) {
      log(`+${newSeats.length} seats (total: ${_allSeats.length})`);
    }
  }

  // Zone list (NUMBERED_AREA blocks) — one per stadium section
  if (d.type === 'zones' && d.zones?.length) {
    _zones = d.zones;
    log(`Map loaded: ${_zones.length} zones available`);
  }

  if (d.type === 'csrf') log(`CSRF: ${d.value.slice(0, 8)}…`);
});

// ── Find cheapest adjacent group (NO category filter, greedy up to maxSeats) ──
function findAdjacentGroup(features, count, maxSeats, minPrice, maxPrice) {
  const minCents = Math.round((Number(minPrice) || 0) * 100);
  const maxCents = Number.isFinite(Number(maxPrice)) && Number(maxPrice) > 0
    ? Math.round(Number(maxPrice) * 100)
    : Infinity;

  // Filter only by price — no category filter
  let pool = features.filter(f => {
    const amount = getPriceCents(f);
    return Number.isFinite(amount) && amount >= minCents && amount <= maxCents;
  });

  log(`Pool: ${features.length} total → ${pool.length} matching price $${minPrice}–$${maxPrice || '∞'}`);

  if (!pool.length) {
    const sample = seatDebugList(features, 20);
    console.log('[FIFA Bot DEBUG no-pool sample]', JSON.stringify(sample, null, 2));
    console.table(sample);
    return null;
  }

  // Sort cheapest first
  pool.sort((a, b) => (getPriceCents(a) || 0) - (getPriceCents(b) || 0));

  // Log cheapest 5
  const top5 = pool.slice(0, 5).map(f => {
    const p = f.properties;
    const price = getPriceCents(f) / 100;
    return `$${price.toFixed(2)} B${blockName(f) || '?'} R${p.row} S${p.number}`;
  });
  log(`Cheapest available: ${top5.join(' | ')}`);

  // Group by block.id + row
  const rowMap = {};
  pool.forEach(f => {
    const p = f.properties;
    const key = `${p.block?.id}||${p.row}`;
    if (!rowMap[key]) rowMap[key] = [];
    rowMap[key].push(f);
  });

  // Find all consecutive runs of at least `count` seats, up to `maxSeats`
  const candidates = [];
  for (const seats of Object.values(rowMap)) {
    if (seats.length < count) continue;
    seats.sort((a, b) => parseInt(a.properties?.number || 0) - parseInt(b.properties?.number || 0));

    // Scan for consecutive windows
    for (let i = 0; i < seats.length; i++) {
      // Extend run as far as possible (greedy)
      let runEnd = i;
      while (
        runEnd + 1 < seats.length &&
        parseInt(seats[runEnd + 1].properties?.number || 0) === parseInt(seats[runEnd].properties?.number || 0) + 1 &&
        runEnd - i + 1 < maxSeats
      ) {
        runEnd++;
      }
      const runLen = runEnd - i + 1;
      if (runLen < count) continue;

      const win = seats.slice(i, runEnd + 1);
      candidates.push({
        features: win,
        total: win.reduce((s, f) => s + (getPriceCents(f) || 0), 0),
        count: win.length,
      });

      // Also try the window starting from i+1 to not skip combinations
    }
  }

  if (!candidates.length) return null;

  // Pick best: most seats first (greedy), then cheapest total
  candidates.sort((a, b) => b.count - a.count || a.total - b.total);
  const best = candidates[0];
  const p0 = best.features[0].properties;

  return {
    features: best.features,
    ids: best.features.map(f => f.id),
    block: p0.block?.name?.en || '?',
    area: p0.area?.name?.en || '',
    row: p0.row,
    seatNumbers: best.features.map(f => parseInt(f.properties?.number || 0)),
    category: getCategoryText(best.features[0]),
    priceEach: (getPriceCents(best.features[0]) || 0) / 100,
    totalPrice: best.total / 100,
    count: best.count,
  };
}

// ── Select seats + Add to cart ────────────────────────────────────────────────
async function selectAndAddToCart(group) {
  const seatMapEl = document.getElementById('seatMap');
  if (!seatMapEl) { log('No #seatMap', 'error'); return false; }

  log(`Dispatching selectSeatsByIds: [${group.ids.join(', ')}]`);
  seatMapEl.dispatchEvent(new CustomEvent('selectSeatsByIds', {
    detail: { seatIds: group.ids },
    bubbles: true, cancelable: true,
  }));

  log('Waiting for Add to cart…');
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const btn = findAddToCartBtn();
    if (btn) {
      log('✓ Clicking Add to cart!', 'ok');
      btn.click();
      return true;
    }
  }

  log('Add to cart button not found after selectSeatsByIds', 'warn');
  return false;
}

function findAddToCartBtn() {
  for (const el of document.querySelectorAll('button, a[role="button"]')) {
    const txt = (el.textContent || '').trim().toLowerCase();
    if (txt !== 'add to cart') continue;
    const disabled = el.disabled || el.hasAttribute('disabled') ||
      el.classList.contains('p-disabled') ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.getAttribute('aria-disabled') === '';
    if (!disabled) return el;
  }
  return null;
}

// ── Wait for STX to be ready ──────────────────────────────────────────────────
async function waitForSTX() {
  for (let i = 0; i < 60; i++) {
    if (document.querySelector('#seatMap canvas')) break;
    await sleep(250);
  }
  await new Promise(res => {
    const check = () => {
      const el = document.getElementById('seatMap');
      if (!el) { setTimeout(check, 200); return; }
      el.dispatchEvent(new CustomEvent('__fbtest'));
      res();
    };
    setTimeout(check, 1500);
  });
  await sleep(1000);
}

// ── Collect seats: trigger zone load → click each zone → XHR returns seats ────
// STX flow: selectBlockByAvailabilities → console.log('features', zones[])
//           → our interceptor captures zones via __fbZones
//           → we dispatch selectBlockById per zone → STX calls seats/free/ol XHR
//           → interceptor captures individual seats
async function collectAllSeats(count) {
  const seatMapEl = document.getElementById('seatMap');
  if (!seatMapEl) return;

  const prevTotal = _allSeats.length;

  // Step 1: trigger zone list load (if not loaded yet)
  if (_zones.length === 0) {
    log('Loading stadium zones…');
    seatMapEl.dispatchEvent(new CustomEvent('selectBlockByAvailabilities', {
      detail: { category: 'Category 3', numberOfSeats: count },
      bubbles: true, cancelable: true,
    }));
    await sleep(2000);
  }

  if (_zones.length === 0) {
    log('No zones loaded — cannot scan seats', 'warn');
    return;
  }

  // Step 2: filter zones within price range
  // zone.minPrice is in 1/1000 USD: 500000 = $500
  const ourMaxIn1000 = (Number(settings.maxPrice) || 0) * 1000;
  const ourMinIn1000 = (Number(settings.minPrice) || 0) * 1000;

  // Debug: log first few zones
  if (_zones.length > 0) {
    const sample = _zones.slice(0, 3).map(z => ({id: z.id, enabled: z.enabled, minPrice: z.minPrice, maxPrice: z.maxPrice}));
    log(`Zone sample: ${JSON.stringify(sample)}`);
    log(`ourMaxIn1000=${ourMaxIn1000} ourMinIn1000=${ourMinIn1000}`);
  }

  let targetZones = _zones.filter(z => {
    if (z.enabled === false) return false;  // only skip explicitly disabled
    const zMin = z.minPrice || 0;
    const zMax = z.maxPrice || Infinity;
    // Skip zone if its cheapest seat is strictly above our max
    if (ourMaxIn1000 > 0 && zMin > ourMaxIn1000) return false;
    // Skip zone if its most expensive seat is strictly below our min
    if (ourMinIn1000 > 0 && zMax > 0 && zMax < ourMinIn1000) return false;
    return true;
  });

  // Sort by minPrice ascending — scan cheapest zones first
  targetZones.sort((a, b) => (a.minPrice || 0) - (b.minPrice || 0));

  log(`Clicking ${targetZones.length}/${_zones.length} zones (sorted cheapest first)…`);

  // Step 3: click zones one by one with human-like delays
  // Limit to first 5 cheapest zones to avoid DataDome detection
  const scanLimit = Math.min(targetZones.length, 5);
  log(`Scanning top ${scanLimit} cheapest zones…`);

  for (let i = 0; i < scanLimit; i++) {
    if (!isRunning) break;
    const zone = targetZones[i];
    const before = _allSeats.length;

    // Random human-like delay before each click (800–2500ms)
    const delay = 800 + Math.random() * 1700;
    await sleep(delay);

    window.postMessage({ __fb: true, type: 'clickZone', olUid: zone.olUid, flatCoords: zone.flatCoords || [] }, '*');

    // Wait for XHR response
    await sleep(1200 + Math.random() * 800);

    const got = _allSeats.length - before;
    if (got > 0) {
      log(`  Zone ${zone.id} ($${(zone.minPrice/1000).toFixed(0)}+): +${got} seats`);
      // Early exit: check if we already have a matching group
      const quick = findAdjacentGroup(_allSeats, settings.count, settings.maxSeats, settings.minPrice, settings.maxPrice);
      if (quick) {
        log(`Match found after zone ${zone.id} — stopping scan`);
        break;
      }
    }
  }

  log(`Scan done: ${_allSeats.length} total seats (was ${prevTotal})`);
}

// ── Main loop ─────────────────────────────────────────────────────────────────
let isRunning = false, pollTimer = null, checkCount = 0;
let stats = { checks: 0, found: 0, added: 0 };
let pageLogs = [];

function getCurrentPerformanceId() {
  return window.location.href.match(/performance\/(\d+)/)?.[1] || null;
}

function isOnSeatMapPage() {
  return window.location.href.includes('/seat/performance/') ||
         window.location.href.includes('/selection/event/seat/');
}

function broadcastState() {
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state: { running: isRunning, ...stats } }).catch(() => {});
  updatePageStatus();
}

async function runCheck() {
  if (!isRunning) return;

  if (window.location.href.includes('cart/shoppingCart')) {
    log('🎉 Cart page! Tickets added!', 'ok');
    stopBot();
    try {
      chrome.notifications.create('', {
        type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon48.png'),
        title: '🎟 FIFA Tickets in cart!',
        message: 'Review cart and click Buy Now!', priority: 2,
      });
    } catch(e) {}
    return;
  }

  const onSeatmap = isOnSeatMapPage();
  const perfId = getCurrentPerformanceId();

  if (!onSeatmap || !perfId) {
    log('Open the exact match seat map page first, then press Start', 'error');
    stopBot();
    return;
  }

  stats.checks++;
  checkCount++;
  log(`Check #${checkCount} — match ${perfId} | price $${settings.minPrice}–$${settings.maxPrice} | want ${settings.count}–${settings.maxSeats} seats`);
  broadcastState();

  log('Waiting for STX…');
  await waitForSTX();

  await collectAllSeats(settings.count);

  if (!_allSeats.length) {
    log('No seats collected — retrying', 'warn');
    scheduleReload();
    return;
  }

  log(`Searching in ${_allSeats.length} total seats…`);

  const group = findAdjacentGroup(
    _allSeats,
    settings.count,
    settings.maxSeats,
    settings.minPrice,
    settings.maxPrice
  );

  if (!group) {
    log(`No ${settings.count}+ adjacent seats in $${settings.minPrice}–$${settings.maxPrice} — retrying`, 'warn');
    scheduleReload();
    return;
  }

  stats.found++;
  log(
    `✓ FOUND ${group.count} seats! Block ${group.block} | ${group.area} | Row ${group.row} | Seats ${group.seatNumbers.join(',')} | Cat: ${group.category || 'any'} | $${group.priceEach.toFixed(2)}/each | Total $${group.totalPrice.toFixed(2)}`,
    'ok'
  );
  broadcastState();

  const added = await selectAndAddToCart(group);
  if (added) {
    stats.added++;
    broadcastState();
    await sleep(5000);
    if (isRunning && !window.location.href.includes('cart/shoppingCart')) {
      log('No cart redirect — reloading', 'warn');
      scheduleReload();
    }
  } else {
    scheduleReload();
  }
}

function scheduleReload() {
  stopPolling();
  pollTimer = setTimeout(() => {
    if (isRunning) {
      _allSeats = [];
      _interceptedSeats = null;
      window.location.reload();
    }
  }, settings.interval * 1000);
}

function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

function startBot() {
  if (isRunning) return;
  isRunning = true; checkCount = 0;
  stats = { checks: 0, found: 0, added: 0 };
  _allSeats = []; _interceptedSeats = null; _zones = [];
  settings.running = true; saveSettings();
  const perfId = getCurrentPerformanceId();
  log(`Bot started on match ${perfId || '?'} | ALL categories | ${settings.count}–${settings.maxSeats} seats | $${settings.minPrice}–$${settings.maxPrice} | every ${settings.interval}s`, 'ok');
  broadcastState(); createFloatingUI();
  runCheck();
}

function stopBot() {
  isRunning = false; stopPolling();
  settings.running = false; saveSettings();
  broadcastState(); log('Bot stopped', 'warn'); createFloatingUI();
}

function updateSettingsFromPanel() {
  const root = document.querySelector('#fb-root');
  if (!root) return;
  const count    = Math.max(1, parseInt(root.querySelector('#fb-count')?.value, 10) || 2);
  const maxSeats = Math.max(count, parseInt(root.querySelector('#fb-maxseats')?.value, 10) || 4);
  const minPrice = Math.max(0, parseFloat(root.querySelector('#fb-min')?.value) || 0);
  const maxPrice = Math.max(0, parseFloat(root.querySelector('#fb-max')?.value) || 0);
  const interval = Math.max(5, parseInt(root.querySelector('#fb-interval')?.value, 10) || 30);
  settings = { ...settings, count, maxSeats, minPrice, maxPrice, interval };
  saveSettings();
  updatePageStatus();
}

function updatePageLog() {
  const box = document.querySelector('#fb-log');
  if (!box) return;
  box.innerHTML = pageLogs.slice(-12).map(l => {
    const color = l.type === 'error' ? '#fecaca' : l.type === 'warn' ? '#fde68a' : l.type === 'ok' ? '#bbf7d0' : '#dbeafe';
    return `<div style="color:${color};margin:2px 0;line-height:1.25"><span style="opacity:.55">${l.t}</span> ${escapeHtml(l.msg)}</div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function updatePageStatus() {
  const root = document.querySelector('#fb-root');
  if (!root) return;
  const perfId   = getCurrentPerformanceId();
  const state    = root.querySelector('#fb-state');
  const badge    = root.querySelector('#fb-badge');
  const startBtn = root.querySelector('#fb-start');
  const dot      = root.querySelector('#fb-dot');
  const match    = root.querySelector('#fb-match');
  if (match) match.textContent = perfId || 'not on match page';
  if (state) state.textContent = isRunning
    ? `Running · checks ${stats.checks} · found ${stats.found}`
    : 'Ready';
  if (badge) badge.textContent = isRunning
    ? `Running · ${settings.count}–${settings.maxSeats} seats · $${settings.minPrice}–$${settings.maxPrice}`
    : `FIFA Bot · all categories · $${settings.minPrice}–$${settings.maxPrice}`;
  if (startBtn) startBtn.textContent = isRunning ? 'Stop bot' : 'Start bot';
  if (dot) dot.style.background = isRunning ? '#22c55e' : (perfId ? '#f59e0b' : '#ef4444');
}

function createFloatingUI() {
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', createFloatingUI, { once: true });
    return;
  }
  document.querySelector('#fb-root')?.remove();

  const css = document.createElement('style');
  css.id = 'fb-style';
  css.textContent = `
    #fb-root, #fb-root * { box-sizing: border-box; font-family: Inter, system-ui, -apple-system, Segoe UI, Arial, sans-serif; }
    #fb-root { position: fixed; right: 18px; bottom: 18px; z-index: 2147483647; color: #fff; }
    #fb-card { width: 360px; border: 1px solid rgba(255,255,255,.14); border-radius: 22px; overflow: hidden; background: linear-gradient(145deg, rgba(9,18,38,.96), rgba(16,37,73,.96)); box-shadow: 0 22px 70px rgba(0,0,0,.45); backdrop-filter: blur(12px); }
    #fb-head { padding: 14px 16px; display:flex; align-items:center; justify-content:space-between; background: rgba(255,255,255,.06); border-bottom:1px solid rgba(255,255,255,.09); }
    #fb-title { display:flex; gap:10px; align-items:center; font-weight:900; letter-spacing:.2px; }
    #fb-dot { width:10px; height:10px; border-radius:99px; background:#f59e0b; box-shadow:0 0 18px currentColor; }
    #fb-mini { border:0; color:#cbd5e1; background:rgba(255,255,255,.08); border-radius:10px; padding:4px 9px; cursor:pointer; }
    #fb-body { padding: 14px 16px 16px; }
    #fb-state { color:#cbd5e1; font-size:12px; margin-top:3px; }
    #fb-match-row { margin: 12px 0; padding: 10px 12px; border-radius:14px; background:rgba(15,23,42,.65); border:1px solid rgba(148,163,184,.18); font-size:12px; color:#cbd5e1; }
    #fb-match { display:block; color:#fff; font-size:13px; font-weight:800; margin-top:3px; }
    #fb-mode-badge { display:inline-block; margin-top:6px; padding:2px 8px; background:rgba(99,102,241,.25); border:1px solid rgba(99,102,241,.4); border-radius:6px; font-size:10px; color:#a5b4fc; font-weight:700; letter-spacing:.05em; }
    .fb-grid { display:grid; grid-template-columns: 1fr 1fr; gap:10px; }
    .fb-field { display:flex; flex-direction:column; gap:5px; }
    .fb-field label { font-size:11px; color:#94a3b8; font-weight:700; text-transform:uppercase; letter-spacing:.45px; }
    .fb-field input { width:100%; border:1px solid rgba(148,163,184,.22); border-radius:12px; padding:9px 10px; outline:none; background:rgba(15,23,42,.82); color:#fff; font-size:13px; }
    .fb-field input:focus { border-color:#60a5fa; box-shadow:0 0 0 3px rgba(96,165,250,.17); }
    #fb-actions { display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-top:12px; }
    #fb-start, #fb-save { border:0; border-radius:14px; padding:11px 12px; color:#fff; font-weight:900; cursor:pointer; }
    #fb-start { background: linear-gradient(135deg,#2563eb,#7c3aed); }
    #fb-save { background: rgba(255,255,255,.10); color:#dbeafe; }
    #fb-log { margin-top:12px; max-height:140px; overflow:auto; padding:10px; border-radius:14px; background:rgba(2,6,23,.58); border:1px solid rgba(148,163,184,.14); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; }
    #fb-badge { margin-top:9px; color:#bfdbfe; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    #fb-card.fb-collapsed { width:auto; }
    #fb-card.fb-collapsed #fb-body { display:none; }
    #fb-card.fb-collapsed #fb-head { border-bottom:0; }
  `;
  document.getElementById('fb-style')?.remove();
  document.documentElement.appendChild(css);

  const root = document.createElement('div');
  root.id = 'fb-root';
  root.innerHTML = `
    <div id="fb-card">
      <div id="fb-head">
        <div>
          <div id="fb-title"><span id="fb-dot"></span><span>FIFA Ticket Bot</span></div>
          <div id="fb-state">Ready</div>
        </div>
        <button id="fb-mini" title="Minimize">−</button>
      </div>
      <div id="fb-body">
        <div id="fb-match-row">
          Current match ID <span id="fb-match">checking…</span>
          <span class="fb-mode-badge">⚡ ALL CATEGORIES — PRICE ONLY</span>
        </div>
        <div class="fb-grid">
          <div class="fb-field">
            <label>Min seats (together)</label>
            <input id="fb-count" type="number" min="1" max="8" step="1">
          </div>
          <div class="fb-field">
            <label>Max seats (greedy)</label>
            <input id="fb-maxseats" type="number" min="1" max="8" step="1">
          </div>
          <div class="fb-field">
            <label>Min price, $</label>
            <input id="fb-min" type="number" min="0" step="1">
          </div>
          <div class="fb-field">
            <label>Max price, $</label>
            <input id="fb-max" type="number" min="0" step="1">
          </div>
          <div class="fb-field" style="grid-column:1/-1">
            <label>Interval, sec</label>
            <input id="fb-interval" type="number" min="5" max="300" step="1">
          </div>
        </div>
        <div id="fb-actions"><button id="fb-start">Start bot</button><button id="fb-save">Save</button></div>
        <div id="fb-log"></div>
        <div id="fb-badge">FIFA Bot · all categories</div>
      </div>
    </div>`;
  document.body.appendChild(root);

  root.querySelector('#fb-count').value    = settings.count;
  root.querySelector('#fb-maxseats').value = settings.maxSeats;
  root.querySelector('#fb-interval').value = settings.interval;
  root.querySelector('#fb-min').value      = settings.minPrice;
  root.querySelector('#fb-max').value      = settings.maxPrice;

  root.querySelector('#fb-start').onclick = () => {
    updateSettingsFromPanel();
    if (isRunning) stopBot(); else startBot();
  };
  root.querySelector('#fb-save').onclick = () => {
    updateSettingsFromPanel();
    log('Settings saved', 'ok');
  };
  root.querySelector('#fb-mini').onclick = () => {
    const card = root.querySelector('#fb-card');
    card.classList.toggle('fb-collapsed');
    root.querySelector('#fb-mini').textContent = card.classList.contains('fb-collapsed') ? '+' : '−';
  };
  root.querySelectorAll('input').forEach(el => el.addEventListener('change', updateSettingsFromPanel));
  updatePageStatus();
  updatePageLog();
}

chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
  if (msg.type === 'START') {
    if (msg.settings) settings = { ...settings, ...msg.settings };
    startBot(); sendResponse({ ok: true }); return true;
  }
  if (msg.type === 'STOP')  { stopBot();  sendResponse({ ok: true }); return true; }
  if (msg.type === 'GET_STATE') { sendResponse({ running: isRunning, settings, ...stats }); return true; }
  if (msg.type === 'UPDATE_SETTINGS') {
    settings = { ...settings, ...msg.settings }; saveSettings(); createFloatingUI();
    sendResponse({ ok: true }); return true;
  }
});

(async () => {
  await loadSettings();
  createFloatingUI();
  if (settings.running) {
    log('Resuming…'); await sleep(500);
    isRunning = true; checkCount = 0;
    _allSeats = []; _interceptedSeats = null;
    stats = { checks: 0, found: 0, added: 0 };
    broadcastState(); createFloatingUI();
    runCheck();
  }
})();

} // end guard