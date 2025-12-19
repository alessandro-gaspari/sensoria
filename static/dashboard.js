/* =========================================================
   SENSORIA Dashboard - GPS ONLY (Live + Replay)
   - Distanza: somma Haversine tra fix consecutivi
   - Velocità: d/dt tra gli ultimi due fix (km/h)
   - Replay: carica log da /api/logs e /api/logs/load?name=...
   ========================================================= */

(() => {
  // -----------------------------
  // Config
  // -----------------------------
  const SENSORIA_GREEN = "#97c93e";

  // Se dt è troppo piccolo o troppo grande, la speed diventa rumorosa/inutile.
  // A GPS 1 Hz ci aspettiamo ~1s; teniamo una tolleranza.
  const SPEED_DT_MIN_S = 0.5;
  const SPEED_DT_MAX_S = 3.0;

  // Se la durata sembra enorme per timestamp sballati, fallback 1s per punto
  const MAX_SESSION_MS = 6 * 60 * 60 * 1000;

  // -----------------------------
  // Stato
  // -----------------------------
  let isReplayMode = false;

  let sessionStartTimeMs = null;
  let sessionEndTimeMs = null;

  // Canonico: usato per replay slider + metriche
  // { t, lat, lng, cumDistM, speedKmh }
  let gpsSamples = [];

  // Stato calcolo
  let prevFix = null;        // ultimo fix usato
  let cumDistM = 0;
  let lastSpeedKmh = 0;

  // Map
  let map = null;
  let mapMarker = null;
  let fullRoute = null;
  let progressRoute = null;
  let isMapInitialized = false;
  let isUserInteracting = false;

  // Socket
  let socket = null;

  // -----------------------------
  // Utils
  // -----------------------------
  function getNowMs() {
    return Date.now();
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const toRad = (d) => (d * Math.PI) / 180;

    const p1 = toRad(lat1);
    const p2 = toRad(lat2);
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function formatKmh(v) {
    if (v == null || !isFinite(v)) return "--";
    return Math.max(0, v).toFixed(1);
  }

  function formatKmFromMeters(m) {
    if (m == null || !isFinite(m)) return "--";
    return Math.max(0, m / 1000).toFixed(2);
  }

  function ensureSessionStart(tMs) {
    if (sessionStartTimeMs == null) sessionStartTimeMs = tMs;
  }

  function resetGpsState() {
    sessionStartTimeMs = null;
    sessionEndTimeMs = null;
    gpsSamples = [];

    prevFix = null;
    cumDistM = 0;
    lastSpeedKmh = 0;

    // reset route layers (mappa resta)
    if (fullRoute) fullRoute.setLatLngs([]);
    if (progressRoute) progressRoute.setLatLngs([]);
  }

  // -----------------------------
  // Normalizzazione GPS (live+replay)
  // -----------------------------
  function normalizeGpsPoint(raw) {
    if (!raw || typeof raw !== "object") return null;

    const lat = Number(raw.lat ?? raw.latitude ?? raw.Latitude);
    const lng = Number(raw.lng ?? raw.lon ?? raw.longitude ?? raw.Longitude);

    let tMs = null;
    if (raw.tMs != null) tMs = Number(raw.tMs);
    else if (raw.t != null) tMs = Number(raw.t);
    else if (raw.time != null) tMs = Number(raw.time);
    else if (raw.timestamp != null) {
      if (typeof raw.timestamp === "number") tMs = raw.timestamp;
      else {
        const d = new Date(raw.timestamp);
        if (!isNaN(d.getTime())) tMs = d.getTime();
      }
    }

    if (!isFinite(lat) || !isFinite(lng) || !isFinite(tMs)) return null;
    if (lat === 0 && lng === 0) return null;

    // Se sembra in secondi (10 cifre), converto a millisecondi
    if (tMs < 1e12) tMs = tMs * 1000;

    return { t: tMs, lat, lng };
  }

  // -----------------------------
  // Ricerca GPS array “deep” (per log sconosciuti)
  // -----------------------------
  function isLikelyGpsPoint(o) {
    if (!o || typeof o !== "object") return false;
    const hasLat = (o.lat ?? o.latitude ?? o.Latitude) != null;
    const hasLng = (o.lng ?? o.lon ?? o.longitude ?? o.Longitude) != null;
    const hasT = (o.t ?? o.tMs ?? o.time ?? o.timestamp) != null;
    return hasLat && hasLng && hasT;
  }

  function findGpsArrayDeep(root) {
    const q = [root];
    const seen = new Set();
    let steps = 0;
    const MAX_STEPS = 2500;

    while (q.length && steps++ < MAX_STEPS) {
      const cur = q.shift();
      if (!cur || typeof cur !== "object") continue;
      if (seen.has(cur)) continue;
      seen.add(cur);

      if (Array.isArray(cur) && cur.length && isLikelyGpsPoint(cur[0])) return cur;

      if (Array.isArray(cur)) {
        for (const it of cur) q.push(it);
        continue;
      }

      for (const k of Object.keys(cur)) q.push(cur[k]);
    }
    return null;
  }

  // -----------------------------
  // CORE: ingest fix GPS (stessa logica per live e replay)
  // opts: { updateUi: boolean, updateMap: boolean }
  // -----------------------------
  function ingestGpsFix(fix, opts = {}) {
    const updateUi = opts.updateUi !== false;
    const updateMap = opts.updateMap !== false;

    if (!fix || !isFinite(fix.t) || !isFinite(fix.lat) || !isFinite(fix.lng)) return null;

    ensureSessionStart(fix.t);

    // Primo fix
    if (!prevFix) {
      prevFix = fix;
      cumDistM = 0;
      lastSpeedKmh = 0;

      const s0 = { t: fix.t, lat: fix.lat, lng: fix.lng, cumDistM, speedKmh: lastSpeedKmh };
      gpsSamples.push(s0);

      if (updateMap) {
        ensureMapInitialized(fix.lat, fix.lng);
        pushMapPoint(fix.lat, fix.lng, true);
      }
      if (updateUi) updateSpeedDistanceUI(lastSpeedKmh, cumDistM);

      updateReplayUiBounds();
      showReplayOverlayIfReady();
      return s0;
    }

    // dt
    const dtS = (fix.t - prevFix.t) / 1000;
    if (!isFinite(dtS) || dtS <= 0) return null;

    // step distance
    const dStep = haversineMeters(prevFix.lat, prevFix.lng, fix.lat, fix.lng);
    const stepM = isFinite(dStep) && dStep >= 0 ? dStep : 0;
    cumDistM += stepM;

    // speed (solo se dt è plausibile)
    let speedKmh = lastSpeedKmh;
    if (dtS >= SPEED_DT_MIN_S && dtS <= SPEED_DT_MAX_S) {
      speedKmh = (stepM / dtS) * 3.6;
      lastSpeedKmh = speedKmh;
    }

    prevFix = fix;

    const sample = { t: fix.t, lat: fix.lat, lng: fix.lng, cumDistM, speedKmh };
    gpsSamples.push(sample);

    if (updateMap) {
      ensureMapInitialized(fix.lat, fix.lng);
      pushMapPoint(fix.lat, fix.lng, false);
    }
    if (updateUi) updateSpeedDistanceUI(speedKmh, cumDistM);

    updateReplayUiBounds();
    showReplayOverlayIfReady();
    return sample;
  }

  // -----------------------------
  // UI Metriche (speed + distance)
  // -----------------------------
  function ensureMetricsCardsUI() {
    const mapDiv = document.getElementById("map");
    if (!mapDiv) return;

    mapDiv.style.position = "relative";

    let wrap = document.getElementById("metrics-stack");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "metrics-stack";
      wrap.style.cssText = [
        "position:absolute",
        "top:16px",
        "right:16px",
        "z-index:20000",
        "display:flex",
        "flex-direction:column",
        "gap:10px",
        "align-items:flex-end",
        "pointer-events:none"
      ].join(";");
      mapDiv.appendChild(wrap);
    }

    function buildCard(id, label, color, valueId, unitText) {
      const card = document.createElement("div");
      card.id = id;
      card.style.cssText = [
        "width:190px",
        "height:64px",
        "box-sizing:border-box",
        "border-radius:12px",
        "padding:10px 12px",
        "display:flex",
        "align-items:center",
        "gap:12px",
        "background:rgba(0,0,0,0.35)",
        `border:1px solid ${color}`,
        "box-shadow:0 10px 22px rgba(0,0,0,0.45)",
        "pointer-events:auto",
        "overflow:hidden"
      ].join(";");

      card.innerHTML = `
        <div style="flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:2px">
          <div id="${valueId}" style="font-family:monospace;font-size:14px;font-weight:900;color:#fff">--</div>
          <div style="font-size:10px;font-weight:900;letter-spacing:1px;color:${color}">
            ${label} ${unitText ? `<span style="opacity:0.9">(${unitText})</span>` : ""}
          </div>
        </div>
      `;
      return card;
    }

    if (!document.getElementById("metric-speed")) {
      wrap.appendChild(buildCard("metric-speed", "VELOCITÀ", "rgba(255,149,0,0.75)", "speed-value", "km/h"));
    }
    if (!document.getElementById("metric-dist")) {
      wrap.appendChild(buildCard("metric-dist", "DISTANZA", "rgba(255,214,10,0.75)", "distance-value", "km"));
    }
  }

  function updateSpeedDistanceUI(speedKmh, distMeters) {
    ensureMetricsCardsUI();
    const sEl = document.getElementById("speed-value");
    const dEl = document.getElementById("distance-value");
    if (sEl) sEl.textContent = formatKmh(speedKmh);
    if (dEl) dEl.textContent = formatKmFromMeters(distMeters);
  }

  // -----------------------------
  // Map
  // -----------------------------
  function ensureMapInitialized(lat, lng) {
    if (isMapInitialized) return;

    const mapDiv = document.getElementById("map");
    if (!mapDiv) return;

    mapDiv.style.position = "relative";

    map = L.map("map", { attributionControl: false, zoomControl: true }).setView([lat, lng], 18);

    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 20
    }).addTo(map);

    const pulseIcon = L.divIcon({
      className: "custom-div-icon",
      html: `<div style="
        width:14px;height:14px;border-radius:50%;
        background:${SENSORIA_GREEN};
        box-shadow:0 0 0 6px rgba(151,201,62,0.25);
        border:2px solid rgba(255,255,255,0.7);
      "></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });

    mapMarker = L.marker([lat, lng], { icon: pulseIcon }).addTo(map);
    fullRoute = L.polyline([], { color: SENSORIA_GREEN, weight: 4, opacity: 0.55, lineJoin: "round", lineCap: "round" }).addTo(map);
    progressRoute = L.polyline([], { color: SENSORIA_GREEN, weight: 7, opacity: 0.95, lineJoin: "round", lineCap: "round" }).addTo(map);

    map.on("movestart", () => { isUserInteracting = true; });
    map.on("moveend", () => { isUserInteracting = false; });

    createReplayOverlayControls();
    ensureMetricsCardsUI();

    isMapInitialized = true;
    setTimeout(() => map.invalidateSize(), 120);
  }

  function pushMapPoint(lat, lng, isFirst) {
    if (!map || !mapMarker) return;

    const pos = [lat, lng];
    mapMarker.setLatLng(pos);

    if (fullRoute) fullRoute.addLatLng(pos);
    if (!isReplayMode && progressRoute) progressRoute.addLatLng(pos);

    if (!isReplayMode && !isUserInteracting) {
      map.panTo(pos, { animate: false });
    }

    if (isFirst) map.setView(pos, 18, { animate: false });
  }

  // -----------------------------
  // Replay overlay
  // -----------------------------
  function createReplayOverlayControls() {
    const mapDiv = document.getElementById("map");
    if (!mapDiv) return;
    if (document.getElementById("replay-overlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "replay-overlay";
    overlay.style.cssText = [
      "position:absolute",
      "left:16px",
      "right:16px",
      "bottom:16px",
      "z-index:30000",
      "display:none",
      "align-items:center",
      "gap:12px",
      "padding:10px 12px",
      "border-radius:12px",
      "background:rgba(10,10,10,0.85)",
      "border:1px solid rgba(255,255,255,0.10)",
      "backdrop-filter:blur(6px)",
      "box-shadow:0 10px 28px rgba(0,0,0,0.55)"
    ].join(";");

    overlay.innerHTML = `
      <div style="min-width:74px;display:flex;flex-direction:column;gap:2px">
        <div style="font-size:10px;letter-spacing:1px;color:#9aa;font-weight:700">TIME</div>
        <div id="replay-time-label" style="font-family:monospace;font-size:13px;color:#fff;font-weight:700">00:00</div>
      </div>

      <input id="replay-slider" type="range" min="0" max="0" value="0" step="0.1"
        style="flex:1; accent-color:${SENSORIA_GREEN}; cursor:pointer" />

      <button id="btn-live" type="button"
        style="padding:6px 12px;border-radius:8px;border:1px solid ${SENSORIA_GREEN};
               background:rgba(151,201,62,0.18);color:${SENSORIA_GREEN};
               font-weight:800;font-size:11px;letter-spacing:1px;cursor:pointer">
        LIVE
      </button>
    `;

    mapDiv.appendChild(overlay);

    if (window.L && L.DomEvent) {
      L.DomEvent.disableClickPropagation(overlay);
      L.DomEvent.disableScrollPropagation(overlay);
    }

    const slider = document.getElementById("replay-slider");
    const btnLive = document.getElementById("btn-live");
    let scrubbing = false;

    function lockMapInteractions(lock) {
      if (!map) return;
      if (lock) {
        map.dragging && map.dragging.disable();
        map.scrollWheelZoom && map.scrollWheelZoom.disable();
        map.doubleClickZoom && map.doubleClickZoom.disable();
        map.touchZoom && map.touchZoom.disable();
        map.boxZoom && map.boxZoom.disable();
        map.keyboard && map.keyboard.disable();
      } else {
        map.dragging && map.dragging.enable();
        map.scrollWheelZoom && map.scrollWheelZoom.enable();
        map.doubleClickZoom && map.doubleClickZoom.enable();
        map.touchZoom && map.touchZoom.enable();
        map.boxZoom && map.boxZoom.enable();
        map.keyboard && map.keyboard.enable();
      }
    }

    function seek() {
      const sec = parseFloat(slider.value || "0");
      enterReplayAtSecond(sec);
    }

    function setSliderFromClientX(clientX) {
      const rect = slider.getBoundingClientRect();
      const x = clamp(clientX - rect.left, 0, rect.width);
      const pct = rect.width > 0 ? x / rect.width : 0;

      const min = parseFloat(slider.min || "0");
      const max = parseFloat(slider.max || "0");
      const val = min + pct * (max - min);
      slider.value = val.toFixed(1);
      seek();
    }

    slider.addEventListener("input", () => { if (!scrubbing) seek(); });

    slider.addEventListener("pointerdown", (e) => {
      scrubbing = true;
      slider.setPointerCapture(e.pointerId);
      lockMapInteractions(true);
      setSliderFromClientX(e.clientX);
      e.preventDefault();
      e.stopPropagation();
    });

    slider.addEventListener("pointermove", (e) => {
      if (!scrubbing) return;
      setSliderFromClientX(e.clientX);
      e.preventDefault();
      e.stopPropagation();
    });

    function endScrub(e) {
      if (!scrubbing) return;
      scrubbing = false;
      lockMapInteractions(false);
      if (e) e.stopPropagation();
    }

    slider.addEventListener("pointerup", endScrub);
    slider.addEventListener("pointercancel", endScrub);

    btnLive.addEventListener("click", () => goLive());
  }

  function updateReplayTimeLabel(sec) {
    const lab = document.getElementById("replay-time-label");
    if (!lab) return;
    const whole = Math.max(0, Math.round(sec));
    const m = Math.floor(whole / 60).toString().padStart(2, "0");
    const s = (whole % 60).toString().padStart(2, "0");
    lab.textContent = `${m}:${s}`;
  }

  function getSessionEndMs() {
    if (!gpsSamples.length) return sessionStartTimeMs ?? getNowMs();
    const last = gpsSamples[gpsSamples.length - 1].t;

    if (!sessionStartTimeMs) return last;

    const diff = last - sessionStartTimeMs;
    if (diff < 0 || diff > MAX_SESSION_MS) {
      return sessionStartTimeMs + gpsSamples.length * 1000;
    }
    return last;
  }

  function getDurationSec() {
    if (!sessionStartTimeMs) return 0;
    const end = getSessionEndMs();
    return Math.max(0, (end - sessionStartTimeMs) / 1000);
  }

  function showReplayOverlayIfReady() {
    const overlay = document.getElementById("replay-overlay");
    if (!overlay) return;
    const ok = gpsSamples.length >= 2 && getDurationSec() > 0;
    overlay.style.display = ok ? "flex" : "none";
  }

  function updateReplayUiBounds() {
    const slider = document.getElementById("replay-slider");
    if (!slider) return;

    const maxSec = getDurationSec();
    slider.max = String(maxSec);
    slider.step = "0.1";

    if (!isReplayMode) {
      slider.value = maxSec.toFixed(1);
      updateReplayTimeLabel(maxSec);
    }
  }

  // -----------------------------
  // Replay lookup (interpolazione)
  // -----------------------------
  function upperBoundByTime(arr, tMs) {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t <= tMs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function getInterpolatedGpsAtTime(tMs) {
    if (!gpsSamples.length) return null;
    if (gpsSamples.length === 1) return { lat: gpsSamples[0].lat, lng: gpsSamples[0].lng };

    const idx = upperBoundByTime(gpsSamples, tMs);

    if (idx <= 0) return { lat: gpsSamples[0].lat, lng: gpsSamples[0].lng };
    if (idx >= gpsSamples.length) {
      const last = gpsSamples[gpsSamples.length - 1];
      return { lat: last.lat, lng: last.lng };
    }

    const a = gpsSamples[idx - 1];
    const b = gpsSamples[idx];
    const dt = b.t - a.t;
    if (dt <= 0) return { lat: b.lat, lng: b.lng };

    const alpha = clamp((tMs - a.t) / dt, 0, 1);
    return {
      lat: a.lat + (b.lat - a.lat) * alpha,
      lng: a.lng + (b.lng - a.lng) * alpha
    };
  }

  function getDistanceAtTime(tMs) {
    if (!gpsSamples.length) return 0;
    if (gpsSamples.length === 1) return gpsSamples[0].cumDistM || 0;

    const idx = upperBoundByTime(gpsSamples, tMs);
    if (idx <= 0) return gpsSamples[0].cumDistM || 0;
    if (idx >= gpsSamples.length) return gpsSamples[gpsSamples.length - 1].cumDistM || 0;

    const a = gpsSamples[idx - 1];
    const b = gpsSamples[idx];
    const dt = Math.max(1, b.t - a.t);
    const alpha = clamp((tMs - a.t) / dt, 0, 1);

    const da = a.cumDistM || 0;
    const db = (b.cumDistM != null) ? b.cumDistM : da;
    return da + (db - da) * alpha;
  }

  function getSpeedAtTime(tMs) {
    if (!gpsSamples.length) return 0;
    if (gpsSamples.length === 1) return gpsSamples[0].speedKmh || 0;

    const idx = upperBoundByTime(gpsSamples, tMs);
    if (idx <= 0) return gpsSamples[0].speedKmh || 0;
    if (idx >= gpsSamples.length) return gpsSamples[gpsSamples.length - 1].speedKmh || 0;

    const a = gpsSamples[idx - 1];
    const b = gpsSamples[idx];
    const dt = Math.max(1, b.t - a.t);
    const alpha = clamp((tMs - a.t) / dt, 0, 1);

    const sa = a.speedKmh || 0;
    const sb = (b.speedKmh != null) ? b.speedKmh : sa;
    return sa + (sb - sa) * alpha;
  }

  function updateProgressRouteToTime(tMs) {
    if (!progressRoute) return;
    if (!gpsSamples.length) {
      progressRoute.setLatLngs([]);
      return;
    }

    let idx = upperBoundByTime(gpsSamples, tMs);
    idx = clamp(idx, 0, gpsSamples.length);

    const pts = [];
    for (let i = 0; i < idx; i++) pts.push([gpsSamples[i].lat, gpsSamples[i].lng]);

    if (idx > 0 && idx < gpsSamples.length) {
      const interp = getInterpolatedGpsAtTime(tMs);
      if (interp) pts.push([interp.lat, interp.lng]);
    }

    progressRoute.setLatLngs(pts);
  }

  function enterReplayAtSecond(sec) {
    if (sessionStartTimeMs == null) return;
    if (!gpsSamples.length) return;

    isReplayMode = true;

    const durationSec = getDurationSec();
    const clampedSec = clamp(sec, 0, durationSec);
    const tMs = sessionStartTimeMs + clampedSec * 1000;

    updateReplayTimeLabel(clampedSec);

    const pos = getInterpolatedGpsAtTime(tMs);
    if (pos && mapMarker) {
      mapMarker.setLatLng([pos.lat, pos.lng]);
      if (map) map.panTo([pos.lat, pos.lng], { animate: false });
    }

    updateProgressRouteToTime(tMs);

    const speed = getSpeedAtTime(tMs);
    const dist = getDistanceAtTime(tMs);
    updateSpeedDistanceUI(speed, dist);

    const slider = document.getElementById("replay-slider");
    if (slider && Math.abs(parseFloat(slider.value || "0") - clampedSec) > 0.5) {
      slider.value = clampedSec.toFixed(1);
    }
  }

  function goLive() {
    isReplayMode = false;

    updateReplayUiBounds();

    if (!gpsSamples.length) return;

    const last = gpsSamples[gpsSamples.length - 1];
    updateSpeedDistanceUI(last.speedKmh, last.cumDistM);

    if (map && mapMarker) {
      mapMarker.setLatLng([last.lat, last.lng]);
      map.panTo([last.lat, last.lng], { animate: false });
    }

    updateProgressRouteToTime(getSessionEndMs());
  }

  // -----------------------------
  // Socket
  // -----------------------------
  function setConnectionStatus(connected) {
    const el = document.getElementById("connection-status");
    if (!el) return;
    el.innerHTML = connected
      ? `<span class="dot" style="height:10px;width:10px;background:${SENSORIA_GREEN};border-radius:50%;display:inline-block;margin-right:8px;"></span> Connesso`
      : `<span class="dot" style="height:10px;width:10px;background:#666;border-radius:50%;display:inline-block;margin-right:8px;"></span> Disconnesso`;
  }

  function initSocket() {
    if (typeof io !== "function") {
      console.warn("socket.io non caricato (io undefined)");
      return;
    }

    socket = io({
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 500
    });

    socket.on("connect", () => setConnectionStatus(true));
    socket.on("disconnect", () => setConnectionStatus(false));

    // Supporta più nomi evento (così non resti fermo se cambia lato server)
    const handler = (data) => {
      if (isReplayMode) return; // in replay, ignoro live
      const fix = normalizeGpsPoint(data);
      if (!fix) return;
      ingestGpsFix(fix, { updateUi: true, updateMap: true });
    };

    socket.on("gps_update", handler);
    socket.on("gpsupdate", handler);
    socket.on("gps", handler);
  }

  // -----------------------------
  // Loader log (modal)
  // -----------------------------
  function initPastActivityLoader() {
    const host = document.querySelector(".dashboard-header") || document.body;
    if (document.getElementById("btn-load-activity")) return;

    const btn = document.createElement("button");
    btn.id = "btn-load-activity";
    btn.type = "button";
    btn.textContent = "Carica attività passata";
    btn.style.cssText = [
      "padding:8px 12px",
      "border-radius:10px",
      `border:1px solid rgba(151,201,62,0.8)`,
      "background:rgba(151,201,62,0.12)",
      `color:${SENSORIA_GREEN}`,
      "font-weight:800",
      "cursor:pointer",
      "white-space:nowrap",
      "margin-left:12px"
    ].join(";");

    btn.addEventListener("click", openLogsModal);
    host.appendChild(btn);
  }

  async function openLogsModal() {
    const old = document.getElementById("logs-modal");
    if (old) old.remove();

    const modal = document.createElement("div");
    modal.id = "logs-modal";
    modal.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:99999",
      "background:rgba(0,0,0,0.65)",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "padding:18px"
    ].join(";");

    modal.innerHTML = `
      <div style="width:min(620px,96vw);background:#111;border:1px solid #333;border-radius:14px;
                  box-shadow:0 18px 48px rgba(0,0,0,0.65);overflow:hidden">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid #222">
          <div style="font-weight:900;color:#fff">Carica attività passata</div>
          <button id="logs-close" style="background:transparent;color:#fff;border:0;font-size:18px;cursor:pointer">✕</button>
        </div>
        <div style="padding:14px 16px">
          <div id="logs-status" style="color:#aaa;font-size:12px;margin-bottom:10px">Caricamento lista...</div>
          <div id="logs-list" style="display:flex;flex-direction:column;gap:8px;max-height:55vh;overflow:auto"></div>
        </div>
      </div>
    `;

    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.remove();
    });

    document.body.appendChild(modal);

    document.getElementById("logs-close").onclick = () => modal.remove();

    const status = document.getElementById("logs-status");
    const list = document.getElementById("logs-list");

    try {
      const resp = await fetch("/api/logs");
      const json = await resp.json();
      const logs = Array.isArray(json) ? json : (json.logs || []);

      status.textContent = logs.length ? "Seleziona un log" : "Nessun log trovato.";
      list.innerHTML = "";

      logs.forEach((item) => {
        const row = document.createElement("button");
        row.type = "button";
        row.style.cssText = [
          "text-align:left",
          "padding:10px 12px",
          "border-radius:10px",
          "border:1px solid #2a2a2a",
          "background:#161616",
          "color:#fff",
          "cursor:pointer"
        ].join(";");

        const dt = item.mtime ? new Date(item.mtime * 1000).toLocaleString() : "";
        const kb = item.size != null ? Math.round(item.size / 1024) : "--";
        row.innerHTML = `
          <div style="font-weight:800">${item.name}</div>
          <div style="font-size:12px;color:#999;margin-top:2px">${dt} • ${kb} KB</div>
        `;

        row.onclick = async () => {
          status.textContent = `Caricamento ${item.name}...`;
          await loadPastActivity(item.name);
          modal.remove();
        };

        list.appendChild(row);
      });
    } catch (e) {
      status.textContent = "Errore nel caricamento lista log.";
      console.error(e);
    }
  }

  async function loadPastActivity(logName) {
    try {
      resetGpsState();

      const resp = await fetch(`/api/logs/load?name=${encodeURIComponent(logName)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      // Trova array GPS senza sapere il nome della chiave
      const rawGps =
        (Array.isArray(data.gps) && data.gps.length ? data.gps : null) ||
        (Array.isArray(data.gpsSamples) && data.gpsSamples.length ? data.gpsSamples : null) ||
        (Array.isArray(data.GPS) && data.GPS.length ? data.GPS : null) ||
        findGpsArrayDeep(data);

      if (!rawGps || !rawGps.length) {
        console.warn("Nessun array GPS trovato nel log:", logName, data);
        return;
      }

      const fixes = rawGps
        .map(normalizeGpsPoint)
        .filter(Boolean)
        .sort((a, b) => a.t - b.t);

      if (!fixes.length) {
        console.warn("GPS non parsabile nel log:", logName);
        return;
      }

      // Ingestione senza UI/map (prepara solo i vettori)
      fixes.forEach((f) => ingestGpsFix(f, { updateUi: false, updateMap: false }));

      // Inizializza mappa e disegna route completa
      const first = gpsSamples[0];
      ensureMapInitialized(first.lat, first.lng);

      const pts = gpsSamples.map((s) => [s.lat, s.lng]);
      if (fullRoute) fullRoute.setLatLngs(pts);

      if (map && pts.length >= 2) {
        try { map.fitBounds(fullRoute.getBounds(), { padding: [30, 30] }); } catch (_) {}
      }

      sessionEndTimeMs = getSessionEndMs();
      updateReplayUiBounds();
      showReplayOverlayIfReady();

      // Vai a inizio replay
      enterReplayAtSecond(0);

      console.log("Log caricato:", logName, "GPS samples:", gpsSamples.length);
    } catch (err) {
      console.error("Errore caricamento log:", err);
      alert("Errore durante il caricamento dell'attività (vedi console).");
    }
  }

  // -----------------------------
  // Compat: evita ReferenceError se rimane un vecchio bottone HTML
  // -----------------------------
  window.clearAllData = window.clearAllData || function () {
    // NO-OP volutamente
    console.warn("clearAllData() disabilitato in versione GPS-only");
  };

  // Debug (utile in console)
  window.__sensoriaGps = {
    get gpsSamples() { return gpsSamples; },
    get sessionStartTimeMs() { return sessionStartTimeMs; },
    get isReplayMode() { return isReplayMode; }
  };

  // -----------------------------
  // Bootstrap
  // -----------------------------
  document.addEventListener("DOMContentLoaded", () => {
    ensureMetricsCardsUI();
    initPastActivityLoader();
    initSocket();
    setConnectionStatus(false);
  });

})();