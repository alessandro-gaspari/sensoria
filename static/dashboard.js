/* =========================================================
   SENSORIA Dashboard - GPS + BPM (Live + Replay)
   - Distanza: somma Haversine tra fix consecutivi
   - Velocità: Haversine(fix corrente, fix precedente) / dt -> km/h (aggiorna ad ogni fix ~1Hz)
   - Metric cards: BPM, Velocità, Distanza con emoji
   - Replay: carica log da /api/logs e /api/logs/load?name=...
   ========================================================= */

(() => {
  // -----------------------------
  // Config
  // -----------------------------
  const SENSORIA_GREEN = "#97c93e";

  // Se la sessione sembra enorme per timestamp sballati, fallback 1s per punto
  const MAX_SESSION_MS = 6 * 60 * 60 * 1000;

  // -----------------------------
  // Stato
  // -----------------------------
  let isReplayMode = false;

  let sessionStartTimeMs = null;

  // GPS canonical samples
  // { t, lat, lng, cumDistM, speedKmh }
  let gpsSamples = [];

  // BPM timeline
  // { t, bpm }
  let bpmSamples = [];
  let lastLiveBpm = "--";

  // Stato calcolo GPS
  let prevFix = null; // ultimo fix usato (per speed e distanza)
  let cumDistM = 0;

  // Heuristica unità tempo per raw.t numerico (alcuni server mandano ms relativi, altri secondi)
  let gpsRawTimeUnit = null; // 'ms' | 's' | null (default ms)
  let lastGpsRawT = null;
  let timelineScaleApplied = 1; // 1 o 1000 (se scopriamo che era in secondi)

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

  function resetAllState() {
    sessionStartTimeMs = null;

    gpsSamples = [];
    bpmSamples = [];
    lastLiveBpm = "--";

    prevFix = null;
    cumDistM = 0;

    gpsRawTimeUnit = null;
    lastGpsRawT = null;
    timelineScaleApplied = 1;

    if (fullRoute) fullRoute.setLatLngs([]);
    if (progressRoute) progressRoute.setLatLngs([]);

    updateBpmValue("--");
    updateSpeedDistanceUI(null, null);
    updateReplayUiBounds();
    showReplayOverlayIfReady();
  }

  function rescaleTimeline(factor) {
    if (!factor || factor === 1) return;

    // sessionStart
    if (sessionStartTimeMs != null) sessionStartTimeMs *= factor;

    // gps
    gpsSamples.forEach((s) => (s.t *= factor));
    if (prevFix && prevFix.t != null) prevFix.t *= factor;

    // bpm
    bpmSamples.forEach((b) => (b.t *= factor));

    timelineScaleApplied *= factor;
  }

  // -----------------------------
  // Normalizzazione GPS (live+replay)
  // -----------------------------
  function normalizeGpsPoint(raw) {
    if (!raw || typeof raw !== "object") return null;

    const lat = Number(raw.lat ?? raw.latitude ?? raw.Latitude);
    const lng = Number(raw.lng ?? raw.lon ?? raw.longitude ?? raw.Longitude);

    // timestamp preferito: stringa ISO / Date -> ms epoch
    let tMs = null;
    if (raw.timestamp != null && typeof raw.timestamp !== "number") {
      const d = new Date(raw.timestamp);
      if (!isNaN(d.getTime())) tMs = d.getTime();
    }
    if (tMs == null) {
      // numerico (può essere epoch ms oppure relativo ms oppure relativo s)
      const tRaw = Number(raw.tMs ?? raw.t ?? raw.time);
      if (!isFinite(tRaw)) return null;

      if (tRaw >= 1e12) {
        // epoch ms
        tMs = tRaw;
      } else {
        // relativo: decide unità guardando delta (se disponibile)
        if (gpsRawTimeUnit == null && lastGpsRawT != null) {
          const d = tRaw - lastGpsRawT;

          // Se incrementa di ~1, ~2, ~3 -> probabilmente secondi
          if (d > 0 && d < 20) gpsRawTimeUnit = "s";

          // Se incrementa di ~1000 -> probabilmente millisecondi
          if (d >= 20 && d < 200000) gpsRawTimeUnit = "ms";

          // Se scopriamo che erano secondi ma finora li avevamo trattati come ms, riscalo tutto
          if (gpsRawTimeUnit === "s" && timelineScaleApplied === 1 && gpsSamples.length) {
            rescaleTimeline(1000);
          }
        }

        lastGpsRawT = tRaw;
        tMs = gpsRawTimeUnit === "s" ? tRaw * 1000 : tRaw; // default: ms
      }
    }

    if (!isFinite(lat) || !isFinite(lng) || !isFinite(tMs)) return null;
    if (lat === 0 && lng === 0) return null;

    return { t: tMs, lat, lng };
  }

  // -----------------------------
  // Normalizzazione BPM (live+replay)
  // -----------------------------
  function normalizeBpmPoint(raw) {
    if (raw == null) return null;

    // Caso live: raw è numero
    if (typeof raw === "number" || typeof raw === "string") {
      const bpm = parseInt(raw, 10);
      if (!isFinite(bpm) || bpm <= 0) return null;
      return { t: getNowMs(), bpm };
    }

    if (typeof raw !== "object") return null;

    const bpm = parseInt(raw.bpm ?? raw.value ?? raw.hr ?? raw.heartRate, 10);
    if (!isFinite(bpm) || bpm <= 0) return null;

    let tMs = null;
    if (raw.timestamp != null && typeof raw.timestamp !== "number") {
      const d = new Date(raw.timestamp);
      if (!isNaN(d.getTime())) tMs = d.getTime();
    }
    if (tMs == null) {
      const tRaw = Number(raw.tMs ?? raw.t ?? raw.time);
      if (!isFinite(tRaw)) tMs = getNowMs();
      else tMs = tRaw >= 1e12 ? tRaw : tRaw; // default ms (coerente con GPS default)
    }

    return { t: tMs, bpm };
  }

  // -----------------------------
  // CORE: ingest GPS fix (uguale per live e replay)
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

      const s0 = { t: fix.t, lat: fix.lat, lng: fix.lng, cumDistM, speedKmh: 0 };
      gpsSamples.push(s0);

      if (updateMap) {
        ensureMapInitialized(fix.lat, fix.lng);
        pushMapPoint(fix.lat, fix.lng, true);
      }
      if (updateUi) updateSpeedDistanceUI(0, cumDistM);

      updateReplayUiBounds();
      showReplayOverlayIfReady();
      return s0;
    }

    // dt (secondi)
    const dtS = (fix.t - prevFix.t) / 1000;
    if (!isFinite(dtS) || dtS <= 0) return null;

    // Distanza step (metri)
    const stepM = haversineMeters(prevFix.lat, prevFix.lng, fix.lat, fix.lng);
    const validStepM = isFinite(stepM) && stepM >= 0 ? stepM : 0;

    // Distanza cumulativa OK
    cumDistM += validStepM;

    // Velocità richiesta: distanza tra fix corrente e precedente (1 Hz -> “metri in un secondo”)
    // In pratica usiamo dt reale per robustezza: km/h = (m / s) * 3.6
    const speedKmh = (validStepM / dtS) * 3.6;

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

  function ingestBpmPoint(p, opts = {}) {
    const updateUi = opts.updateUi !== false;
    if (!p || !isFinite(p.t) || !isFinite(p.bpm)) return null;

    ensureSessionStart(p.t);

    bpmSamples.push(p);
    lastLiveBpm = p.bpm;

    if (updateUi && !isReplayMode) updateBpmValue(p.bpm);

    updateReplayUiBounds();
    showReplayOverlayIfReady();
    return p;
  }

  // -----------------------------
  // Metric Cards UI (emoji + BPM/SPEED/DIST)
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

    function buildMetricCard({ id, emoji, label, labelColor, borderColor, valueId, unitText }) {
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
        `border:1px solid ${borderColor}`,
        "box-shadow:0 10px 22px rgba(0,0,0,0.45)",
        "pointer-events:auto",
        "overflow:hidden"
      ].join(";");

      card.innerHTML = `
        <div style="font-size:26px;line-height:1;width:34px;text-align:center">${emoji}</div>
        <div style="flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:2px">
          <div id="${valueId}" style="font-family:monospace;font-size:14px;font-weight:900;color:#fff">--</div>
          <div style="font-size:10px;font-weight:900;letter-spacing:1px;color:${labelColor}">
            ${label} ${unitText ? `<span style="opacity:0.9">${unitText}</span>` : ""}
          </div>
        </div>
      `;
      return card;
    }

    if (!document.getElementById("metric-bpm")) {
      wrap.appendChild(
        buildMetricCard({
          id: "metric-bpm",
          emoji: "❤️",
          label: "BPM LIVE",
          labelColor: "rgba(255,65,54,0.95)",
          borderColor: "rgba(255,65,54,0.70)",
          valueId: "bpm-value",
          unitText: ""
        })
      );
    }

    if (!document.getElementById("metric-speed")) {
      wrap.appendChild(
        buildMetricCard({
          id: "metric-speed",
          emoji: "⚡",
          label: "VELOCITÀ",
          labelColor: "rgba(255,149,0,0.95)",
          borderColor: "rgba(255,149,0,0.70)",
          valueId: "speed-value",
          unitText: "km/h"
        })
      );
    }

    if (!document.getElementById("metric-dist")) {
      wrap.appendChild(
        buildMetricCard({
          id: "metric-dist",
          emoji: "📍",
          label: "DISTANZA",
          labelColor: "rgba(255,214,10,0.95)",
          borderColor: "rgba(255,214,10,0.70)",
          valueId: "distance-value",
          unitText: "km"
        })
      );
    }
  }

  function updateBpmValue(val) {
    ensureMetricsCardsUI();
    const el = document.getElementById("bpm-value");
    if (!el) return;
    el.textContent = val == null ? "--" : String(val);
  }

  function updateSpeedDistanceUI(speedKmh, distMeters) {
    ensureMetricsCardsUI();
    const sEl = document.getElementById("speed-value");
    const dEl = document.getElementById("distance-value");
    if (sEl) sEl.textContent = speedKmh == null ? "--" : formatKmh(speedKmh);
    if (dEl) dEl.textContent = distMeters == null ? "--" : formatKmFromMeters(distMeters);
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

  function getLastTimeMs(arr) {
    if (!arr || !arr.length) return null;
    return arr[arr.length - 1].t;
  }

  function getSessionEndMs() {
    const lastGps = getLastTimeMs(gpsSamples);
    const lastBpm = getLastTimeMs(bpmSamples);

    let end = null;
    if (lastGps != null) end = lastGps;
    if (lastBpm != null) end = end == null ? lastBpm : Math.max(end, lastBpm);

    if (end == null) return sessionStartTimeMs ?? getNowMs();
    if (sessionStartTimeMs == null) return end;

    const diff = end - sessionStartTimeMs;
    if (diff < 0 || diff > MAX_SESSION_MS) {
      // fallback: 1s per GPS campione (se presente)
      if (gpsSamples.length) return sessionStartTimeMs + gpsSamples.length * 1000;
      return end;
    }
    return end;
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
  // Replay lookup (binary search + interpolazione)
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

  function getBpmAtTime(tMs) {
    if (!bpmSamples.length) return null;
    if (bpmSamples.length === 1) return bpmSamples[0].bpm;

    const idx = upperBoundByTime(bpmSamples, tMs);
    if (idx <= 0) return bpmSamples[0].bpm;
    return bpmSamples[idx - 1].bpm;
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

    const bpm = getBpmAtTime(tMs);
    if (bpm != null) updateBpmValue(bpm);

    const slider = document.getElementById("replay-slider");
    if (slider && Math.abs(parseFloat(slider.value || "0") - clampedSec) > 0.5) {
      slider.value = clampedSec.toFixed(1);
    }
  }

  function goLive() {
    isReplayMode = false;

    updateReplayUiBounds();

    if (gpsSamples.length) {
      const last = gpsSamples[gpsSamples.length - 1];
      updateSpeedDistanceUI(last.speedKmh, last.cumDistM);

      if (map && mapMarker) {
        mapMarker.setLatLng([last.lat, last.lng]);
        map.panTo([last.lat, last.lng], { animate: false });
      }

      updateProgressRouteToTime(getSessionEndMs());
    }

    if (lastLiveBpm !== "--") updateBpmValue(lastLiveBpm);
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

    const gpsHandler = (data) => {
      if (isReplayMode) return;
      const fix = normalizeGpsPoint(data);
      if (!fix) return;
      ingestGpsFix(fix, { updateUi: true, updateMap: true });
    };

    const bpmHandler = (val) => {
      if (isReplayMode) return;
      const p = normalizeBpmPoint(val);
      if (!p) return;
      ingestBpmPoint(p, { updateUi: true });
    };

    // Supporta più nomi evento
    socket.on("gps_update", gpsHandler);
    socket.on("gpsupdate", gpsHandler);
    socket.on("gps", gpsHandler);

    socket.on("bpm_update", bpmHandler);
    socket.on("bpmupdate", bpmHandler);
    socket.on("bpm", bpmHandler);
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
      "border:1px solid rgba(151,201,62,0.8)",
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

  // Find arrays without knowing exact key
  function isLikelyGpsPoint(o) {
    if (!o || typeof o !== "object") return false;
    const hasLat = (o.lat ?? o.latitude ?? o.Latitude) != null;
    const hasLng = (o.lng ?? o.lon ?? o.longitude ?? o.Longitude) != null;
    const hasT = (o.t ?? o.tMs ?? o.time ?? o.timestamp) != null;
    return hasLat && hasLng && hasT;
  }

  function isLikelyBpmPoint(o) {
    if (!o || typeof o !== "object") return false;
    const hasBpm = (o.bpm ?? o.value ?? o.hr ?? o.heartRate) != null;
    const hasT = (o.t ?? o.tMs ?? o.time ?? o.timestamp) != null;
    return hasBpm && hasT;
  }

  function findArrayDeep(root, predicate) {
    const q = [root];
    const seen = new Set();
    let steps = 0;
    const MAX_STEPS = 2500;

    while (q.length && steps++ < MAX_STEPS) {
      const cur = q.shift();
      if (!cur || typeof cur !== "object") continue;
      if (seen.has(cur)) continue;
      seen.add(cur);

      if (Array.isArray(cur) && cur.length && predicate(cur[0])) return cur;

      if (Array.isArray(cur)) {
        for (const it of cur) q.push(it);
        continue;
      }

      for (const k of Object.keys(cur)) q.push(cur[k]);
    }
    return null;
  }

  async function loadPastActivity(logName) {
    try {
      resetAllState();

      const resp = await fetch(`/api/logs/load?name=${encodeURIComponent(logName)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      // GPS
      const rawGps =
        (Array.isArray(data.gps) && data.gps.length ? data.gps : null) ||
        (Array.isArray(data.gpsSamples) && data.gpsSamples.length ? data.gpsSamples : null) ||
        (Array.isArray(data.GPS) && data.GPS.length ? data.GPS : null) ||
        findArrayDeep(data, isLikelyGpsPoint);

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

      // Ingestione GPS (no UI/map durante build)
      fixes.forEach((f) => ingestGpsFix(f, { updateUi: false, updateMap: false }));

      // BPM (opzionale)
      const rawBpm =
        (Array.isArray(data.bpm) && data.bpm.length ? data.bpm : null) ||
        (Array.isArray(data.hr) && data.hr.length ? data.hr : null) ||
        findArrayDeep(data, isLikelyBpmPoint);

      if (rawBpm && rawBpm.length) {
        const bpms = rawBpm
          .map(normalizeBpmPoint)
          .filter(Boolean)
          .sort((a, b) => a.t - b.t);

        bpms.forEach((p) => ingestBpmPoint(p, { updateUi: false }));
      }

      // sessionStart = min tra primo gps e primo bpm (se presente)
      const t0Gps = gpsSamples.length ? gpsSamples[0].t : null;
      const t0Bpm = bpmSamples.length ? bpmSamples[0].t : null;
      if (t0Gps != null && t0Bpm != null) sessionStartTimeMs = Math.min(t0Gps, t0Bpm);
      else if (t0Gps != null) sessionStartTimeMs = t0Gps;
      else if (t0Bpm != null) sessionStartTimeMs = t0Bpm;

      // Mappa + route completa
      const first = gpsSamples[0];
      ensureMapInitialized(first.lat, first.lng);

      const pts = gpsSamples.map((s) => [s.lat, s.lng]);
      if (fullRoute) fullRoute.setLatLngs(pts);

      if (map && pts.length >= 2) {
        try { map.fitBounds(fullRoute.getBounds(), { padding: [30, 30] }); } catch (_) {}
      }

      updateReplayUiBounds();
      showReplayOverlayIfReady();

      // Vai a inizio replay
      enterReplayAtSecond(0);

      console.log("Log caricato:", logName, "GPS:", gpsSamples.length, "BPM:", bpmSamples.length);
    } catch (err) {
      console.error("Errore caricamento log:", err);
      alert("Errore durante il caricamento dell'attività (vedi console).");
    }
  }

  // -----------------------------
  // Compat (se in HTML esiste un bottone vecchio)
  // -----------------------------
  window.clearAllData = window.clearAllData || function () {
    console.warn("clearAllData() disabilitato in questa versione");
  };

  // Debug
  window.__sensoria = {
    get gpsSamples() { return gpsSamples; },
    get bpmSamples() { return bpmSamples; },
    get sessionStartTimeMs() { return sessionStartTimeMs; },
    get isReplayMode() { return isReplayMode; }
  };

  // -----------------------------
  // Bootstrap
  // -----------------------------
  document.addEventListener("DOMContentLoaded", () => {
    ensureMetricsCardsUI();
    updateBpmValue("--");
    updateSpeedDistanceUI("--", "--");

    initPastActivityLoader();
    initSocket();
    setConnectionStatus(false);
  });

})();
