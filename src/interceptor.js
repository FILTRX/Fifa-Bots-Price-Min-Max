// FIFA Bot interceptor — MAIN world, document_start
// These are ZONES (blocks), not individual seats.
// Individual seats come via XHR seats/free/ol when a block is clicked.
(function() {
  if (window.__fbIntercepting) return;
  window.__fbIntercepting = true;

  // ── Store zone features (blocks) separately from seat features ───────────────
  window.__fbZones = [];    // NUMBERED_AREA blocks
  window.__fbSeats = [];    // individual seats from XHR

  let _lastSentIds = new Set();

  function sendSeats(features) {
    if (!Array.isArray(features) || !features.length) return;
    const newOnes = features.filter(f => {
      const key = String(f.id ?? f.properties?.id ?? JSON.stringify(f).slice(0,30));
      if (_lastSentIds.has(key)) return false;
      _lastSentIds.add(key);
      return true;
    });
    if (!newOnes.length) return;
    window.postMessage({ __fb: true, type: 'seats', features: newOnes }, '*');
  }

  // ── Hook console.log to capture zones ────────────────────────────────────────
  // SeatMap.js logs: console.log('features', [NUMBERED_AREA, ...])
  // These are map zones — we store them for block-by-block clicking
  const _origLog = console.log;
  console.log = function(...args) {
    if (args[0] === 'features' && Array.isArray(args[1]) && args[1].length > 0) {
      const zones = args[1].map(f => {
        try {
          const v = f.values_ || {};
          // Get polygon flat coordinates for centroid click
          let flatCoords = [];
          try {
            const geom = v.geometry || (typeof f.getGeometry === 'function' ? f.getGeometry() : null);
            flatCoords = geom?.flatCoordinates || geom?.values_?.flatCoordinates || [];
          } catch(e) {}
          return {
            olUid: String(f.ol_uid ?? ''),
            id: v.id,
            type: v.type,
            minPrice: v.minPrice,
            maxPrice: v.maxPrice,
            enabled: v.enabled,
            seatCategoryIds: v.seatCategoryIds || [],
            flatCoords: Array.from(flatCoords),
          };
        } catch(e) { return null; }
      }).filter(z => z && z.type === 'NUMBERED_AREA' && z.enabled !== false);

      if (zones.length > 0) {
        window.__fbZones = zones;
        window.postMessage({ __fb: true, type: 'zones', zones }, '*');
      }
    }
    return _origLog.apply(this, arguments);
  };

  // ── XHR hook — this is where INDIVIDUAL SEATS come from ──────────────────────
  // After clicking a block, STX calls: GET /seats/free/ol?blockId=...
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origSet  = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function(method, url) {
    this._fbUrl = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (name === 'X-CSRF-Token' && value && !value.startsWith('INIT')) {
      window.postMessage({ __fb: true, type: 'csrf', value }, '*');
    }
    return origSet.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function() {
    const url = this._fbUrl || '';
    if (url.includes('seats/free')) {
      this.addEventListener('load', function() {
        if (this.status === 200) {
          try {
            const data = JSON.parse(this.responseText);
            const features = data?.features || [];
            if (features.length > 0) {
              sendSeats(features);
            }
          } catch(e) {}
        }
      });
    }
    const m = url.match(/productId=(\d{10,})/);
    if (m) window.postMessage({ __fb: true, type: 'productId', value: m[1] }, '*');
    return origSend.apply(this, arguments);
  };

  // ── Fetch hook (fallback) ─────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    const url = typeof input === 'string' ? input : (input?.url || '');
    const p = origFetch.apply(this, arguments);
    if (url.includes('seats/free')) {
      p.then(resp => resp.clone().json().then(data => {
        const features = data?.features || [];
        if (features.length > 0) sendSeats(features);
      }).catch(() => {})).catch(() => {});
    }
    return p;
  };

  // ── Click zone by simulating real mouse events on canvas ────────────────────
  // selectBlockById doesn't work (STX uses native handler).
  // Instead we convert OL coordinates to canvas pixels and fire a real click.
  // Each zone has flatCoordinates in OL map space — we use the OL map's viewport.

  function getOLMap() {
    // OL map attaches to the canvas's parent; find it via __olMaps or scan
    if (window.__olMaps?.length) return window.__olMaps[0];
    return null;
  }

  function clickZoneOnCanvas(flatCoords) {
    const seatMapEl = document.getElementById('seatMap');
    if (!seatMapEl) return false;
    const canvas = seatMapEl.querySelector('canvas');
    if (!canvas) return false;

    const map = getOLMap();
    let px, py;

    if (map && map.getPixelFromCoordinate) {
      // Use OL to convert map coordinate to pixel
      // flatCoords is [x1,y1, x2,y2, ...] — use centroid
      let cx = 0, cy = 0, n = flatCoords.length / 2;
      for (let i = 0; i < flatCoords.length; i += 2) {
        cx += flatCoords[i]; cy += flatCoords[i+1];
      }
      cx /= n; cy /= n;
      const pixel = map.getPixelFromCoordinate([cx, cy]);
      if (pixel) { px = pixel[0]; py = pixel[1]; }
    }

    if (px == null) {
      // Fallback: click center of canvas
      const rect = canvas.getBoundingClientRect();
      px = rect.width / 2; py = rect.height / 2;
    }

    const rect = canvas.getBoundingClientRect();
    const clientX = rect.left + px;
    const clientY = rect.top + py;

    // OL's updateTrackedPointers_ needs PointerEvent with pointerId
    const pointerOpts = {
      bubbles: true, cancelable: true, view: window,
      clientX, clientY, button: 0, buttons: 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
      pressure: 0.5,
    };
    const pointerUpOpts = { ...pointerOpts, buttons: 0, pressure: 0 };

    try {
      // Simulate human mouse movement before click (3-5 intermediate points)
      const steps = 3 + Math.floor(Math.random() * 3);
      const startX = clientX + (Math.random() - 0.5) * 200;
      const startY = clientY + (Math.random() - 0.5) * 200;
      for (let i = 0; i <= steps; i++) {
        const mx = startX + (clientX - startX) * (i / steps);
        const my = startY + (clientY - startY) * (i / steps);
        canvas.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, view: window,
          clientX: mx, clientY: my,
          pointerId: 1, pointerType: 'mouse', isPrimary: true,
          buttons: 0, pressure: 0,
        }));
      }

      // Actual click
      canvas.dispatchEvent(new PointerEvent('pointerdown', pointerOpts));
      canvas.dispatchEvent(new PointerEvent('pointerup', pointerUpOpts));
      canvas.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, view: window,
        clientX, clientY, button: 0, buttons: 0,
      }));
    } catch(err) {
      canvas.dispatchEvent(new MouseEvent('click', {
        bubbles: true, cancelable: true, view: window,
        clientX, clientY, button: 0,
      }));
    }
    return true;
  }

  window.addEventListener('message', e => {
    if (!e.data || !e.data.__fb) return;
    if (e.data.type === 'clickZone') {
      clickZoneOnCanvas(e.data.flatCoords || []);
    }
  });

})();
