// ==========================================
// dashboard.js (Sensoria Dashboard) - FULL
// GPS core: onGpsUpdate (live + replay)
// ==========================================

// ---- VERSION marker (per capire subito se il browser sta usando questo file) ----
console.log("dashboard.js loaded - VERSION 2025-12-19 17:20 PRESSIONI FIX");

// ==========================================
// Socket
// ==========================================
var socket = io({
  transports: ["websocket"],
  reconnection: true,
  reconnectionDelay: 500
});

// ==========================================
// UI colors
// ==========================================
const SENSORIA_GREEN = "#97c93e";

// ==========================================
// SENSORI / DATI
// ==========================================
var sensors = {};

// --- TIMELINE (time-based) ---
var sessionStartTimeMs = null;
var sessionEndTimeMs = null;
var isReplayMode = false;

var gpsSamples = []; // { t, lat, lng, acc, cumDistM, speedKmh }
var bpmSamples = []; // { t, bpm }
var lastLiveBpm = "--";

var isBulkLoading = false;

var speedBySec = [];
var secPos = [];
var lastSpeedSec = null;
var lastSecFix = null;
var lastSpeedKmh = 0;

// ==========================================
// MAPPA
// ==========================================
var map = null;
var mapMarker = null;
var isMapInitialized = false;
var fullRoute = null; // polilinea intera
var progressRoute = null; // polilinea fino al tempo (replay/live)

// (opzionale) stato marker animato / rotazione
var currentMapPos = null;
var targetMapPos = null;
var startMapPos = null;
var animationStartTime = null;
var animationFrameId = null;
const ANIMATION_DURATION = 700;

var mapRotationDeg = 0;

// ==========================================
// METRIC CARDS (BPM/SPEED/DIST)
// ==========================================
const METRIC_CARD_W = 190;
const METRIC_CARD_H = 64;

// ==========================================
// GRAFICI (uPlot)
// ==========================================
var charts = {
  accel: null,
  gyro: null,
  mag: null,
  pressure: null
};

var chartData = {
  accel: [[], [], [], []],
  gyro: [[], [], [], []],
  mag: [[], [], [], []],
  pressure: [[], [], [], []]
};

var selectedSensor = null;
var chartsInitialized = false;
var isUserInteracting = false;
var MIN_ZOOM_RANGE = 0.5;

// ==========================================
// Calzini (pressure)
// ==========================================
var leftSockSamples = [];
var rightSockSamples = [];
var sockCharts = { left: null, right: null };
var sockChartData = {
  left: [[], [], [], []],
  right: [[], [], [], []]
};

// ==========================================
// GPS SPEED config (anti picchi)
// ==========================================
const GPS_MAX_ACCURACY_FOR_DIST_M = 60; // se accuracy > 60m ignora step distanza
const GPS_MIN_DT_S = 0.30; // se dt < 0.30s ignora fix (timestamp duplicati)
const GPS_MAX_DT_S = 10.0; // se dt troppo grande, clamp per evitare drop/impulsi strani
const GPS_MIN_STEP_M = 0.20; // sotto 20cm = jitter (non sommare, non dare speed)
const MAX_SPEED_KMH = 100; // cap (alzabile per pattinaggio veloce)

// ==========================================
// INIZIALIZZAZIONE
// ==========================================
document.addEventListener("DOMContentLoaded", function () {
  initSocket();
  ensureMapDomOverlay();
  ensureMetricsCardsUI();
  initPastActivityLoader();

  if (!biAvgTimer) {
    biAvgTimer = setInterval(() => {
      // LEFT
      if (biAgg.left.n > 0) {
        biAgg.left.last = biAgg.left.sum / biAgg.left.n;
        biAgg.left.sum = 0; biAgg.left.n = 0;

        // aggiorna solo BI (pressioni restano quelle già mostrate)
        const l = leftSockSamples.length ? leftSockSamples[leftSockSamples.length - 1] : null;
        if (l && !isReplayMode) updateSocksUI('left', { p0: l.p0, p1: l.p1, p2: l.p2 }, biAgg.left.last);
      }

      // RIGHT
      if (biAgg.right.n > 0) {
        biAgg.right.last = biAgg.right.sum / biAgg.right.n;
        biAgg.right.sum = 0; biAgg.right.n = 0;

        const r = rightSockSamples.length ? rightSockSamples[rightSockSamples.length - 1] : null;
        if (r && !isReplayMode) updateSocksUI('right', { p0: r.p0, p1: r.p1, p2: r.p2 }, biAgg.right.last);
      }
    }, BI_AVG_WINDOW_MS);
  }

  var sel = document.getElementById("chart-sensor-select");
  if (sel) {
    sel.addEventListener("change", function (e) {
      selectedSensor = e.target.value || null;
      resetChartData();
      var container = document.getElementById("charts-container");
      if (selectedSensor) {
        container.style.display = "block";
        if (!chartsInitialized) {
          initCharts();
          chartsInitialized = true;
        }
      } else {
        container.style.display = "none";
      }
    });
  }
});

// ==========================================
// SOCKET
// ==========================================
function initSocket() {
  socket.on("connect", () => {
    var el = document.getElementById("connection-status");
    if (el) {
      el.className = "";
      el.innerHTML = '<span class="dot"></span> Connesso';
    }
  });

  socket.on("disconnect", () => {
    var el = document.getElementById("connection-status");
    if (el) {
      el.className = "disconnected";
      el.innerHTML = '<span class="dot"></span> Disconnesso';
    }
  });

  socket.on("sensor_update", (data) => processIncomingData(data));
  socket.on("bpm_update", (val) => onBpmUpdate(val));
  socket.on("profile_update", (data) => updateProfileUI(data));
  socket.on("gps_update", (data) => onGpsUpdate(data, { updateUi: true, updateMap: true }));

  socket.on("data_cleared", () => {
    if (sessionStartTimeMs != null) {
      sessionEndTimeMs = getNowMs();
      updateReplayUiBounds();
      showReplayOverlayIfReady();
    }
  });
}

// ==========================================
// TIME + UTILS
// ==========================================
function getNowMs() {
  return Date.now();
}

function ensureSessionStart(tMs) {
  if (sessionStartTimeMs == null) sessionStartTimeMs = tMs;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function rebuildSpeedBySecFromGps() {
  speedBySec = [];
  secPos = [];
  if (sessionStartTimeMs == null || !gpsSamples.length) return;

  // durata in secondi (ceil per coprire l'ultimo tratto)
  const dur = Math.max(0, Math.ceil(getDurationSec()));
  let prev = null;

  for (let s = 0; s <= dur; s++) {
    const tMs = sessionStartTimeMs + s * 1000;
    const pos = getInterpolatedGpsAtTime(tMs);
    if (!pos) continue;

    secPos[s] = pos;

    if (!prev) {
      speedBySec[s] = 0;
    } else {
      const dM = haversineMeters(prev.lat, prev.lng, pos.lat, pos.lng);
      // scatto "1 secondo": m/s = dM / 1, km/h = m/s * 3.6
      let kmh = dM * 3.6;
      if (!isFinite(kmh) || kmh < 0) kmh = 0;
      kmh = Math.min(kmh, 100);
      speedBySec[s] = kmh;
    }
    prev = pos;
  }
}

function getSessionEndMs() {
  if (!gpsSamples.length) return sessionStartTimeMs || Date.now();
  const lastGps = gpsSamples[gpsSamples.length - 1].t;

  // guard-rail: se durata enorme, probabile timestamp errato -> fallback 1s per campione
  const diff = lastGps - sessionStartTimeMs;
  if (diff > 7200000) {
    console.warn("Rilevato timestamp anomalo, tronco la durata.");
    return sessionStartTimeMs + gpsSamples.length * 1000;
  }
  return lastGps;
}

function getDurationSec() {
  if (!sessionStartTimeMs) return 0;
  return Math.max(0, (getSessionEndMs() - sessionStartTimeMs) / 1000);
}

// ==========================================
// HAVERSINE + FORMAT
// ==========================================
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
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

// ==========================================
// METRIC CARDS UI
// ==========================================
function ensureMetricsCardsUI() {
  // Nascondi vecchio bpm-display se esiste
  var oldBpm = document.getElementById("bpm-display");
  if (oldBpm) oldBpm.style.display = "none";

  let wrap = document.getElementById("metrics-stack");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "metrics-stack";
    wrap.style.cssText = `
      position:absolute;
      top:16px;
      right:16px;
      z-index:20000;
      display:flex;
      flex-direction:column;
      gap:10px;
      align-items:flex-end;
      pointer-events:none;
    `;
    const mapDiv = document.getElementById("map");
    (mapDiv || document.body).appendChild(wrap);
  } else {
    const mapDiv = document.getElementById("map");
    if (mapDiv && wrap.parentElement !== mapDiv) mapDiv.appendChild(wrap);
  }

  if (!document.getElementById("metric-bpm")) {
    wrap.appendChild(
      buildMetricCard({
        id: "metric-bpm",
        emoji: "❤️",
        label: "BPM LIVE",
        labelColor: "rgba(255, 65, 54, 0.95)",
        borderColor: "rgba(255, 65, 54, 0.70)",
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
        labelColor: "rgba(255, 149, 0, 0.95)",
        borderColor: "rgba(255, 149, 0, 0.70)",
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
        labelColor: "rgba(255, 214, 10, 0.95)",
        borderColor: "rgba(255, 214, 10, 0.70)",
        valueId: "distance-value",
        unitText: "km"
      })
    );
  }
}

function buildMetricCard({ id, emoji, label, labelColor, borderColor, valueId, unitText }) {
  const card = document.createElement("div");
  card.id = id;
  card.style.cssText = `
    width:${METRIC_CARD_W}px;
    height:${METRIC_CARD_H}px;
    box-sizing:border-box;
    border-radius:12px;
    padding:10px 12px;
    display:flex;
    align-items:center;
    gap:12px;
    background: rgba(0,0,0,0.35);
    border: 1px solid ${borderColor};
    box-shadow: 0 10px 22px rgba(0,0,0,0.45);
    pointer-events:auto;
    overflow:hidden;
  `;

  card.innerHTML = `
    <div style="font-size:26px;line-height:1;width:34px;text-align:center">${emoji}</div>
    <div style="flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:2px">
      <div id="${valueId}" style="font-family:monospace;font-size:14px;font-weight:900;color:#fff">--</div>
      <div style="font-size:10px;font-weight:900;letter-spacing:1px;color:${labelColor}">
        ${label}
        ${unitText ? `<span style="opacity:0.9">${unitText}</span>` : ""}
      </div>
    </div>
  `;

  return card;
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

// ==========================================
// BPM (LIVE / TIMELINE)
// ==========================================
function onBpmUpdate(val) {
  var bpmInt = parseInt(val, 10);
  if (isNaN(bpmInt) || bpmInt <= 0) return;

  var tMs = getNowMs();
  ensureSessionStart(tMs);

  lastLiveBpm = bpmInt;
  bpmSamples.push({ t: tMs, bpm: bpmInt });

  if (!isReplayMode) {
    updateBpmValue(bpmInt);
  }

  updateReplayUiBounds();
  showReplayOverlayIfReady();
}

// ==========================================
// GPS NORMALIZATION (live + replay)
// ==========================================
let gpsTimeUnit = null; // "ms" / "s" / null
let lastGpsTRaw = null;

function normalizeGpsPoint(raw) {
  if (!raw || typeof raw !== "object") return null;

  // già normalizzato?
  if (raw.t != null && raw.lat != null && raw.lng != null) {
    const tMs = Number(raw.t);
    const lat = Number(raw.lat);
    const lng = Number(raw.lng);
    const acc = Number(raw.acc ?? raw.accuracy ?? 999);
    if (!isFinite(tMs) || !isFinite(lat) || !isFinite(lng)) return null;
    if (lat === 0 && lng === 0) return null;
    return { t: tMs, lat, lng, acc };
  }

  const lat = Number(raw.lat ?? raw.latitude ?? raw.Latitude);
  const lng = Number(raw.lng ?? raw.lon ?? raw.longitude ?? raw.Longitude);
  const acc = Number(raw.accuracy ?? raw.acc ?? raw.hdop ?? 999);

  if (!isFinite(lat) || !isFinite(lng)) return null;
  if (lat === 0 && lng === 0) return null;

  let tMs = null;

  // 1) timestamp string ISO o number
  const ts = raw.timestamp ?? raw.ts;
  if (ts != null) {
    if (typeof ts === "number") {
      tMs = ts > 1e12 ? ts : ts * 1000;
    } else {
      const d = new Date(ts);
      if (!isNaN(d.getTime())) tMs = d.getTime();
    }
  }

  // 2) fallback: t / tMs / time numerico relativo o epoch
  if (tMs == null) {
    const tRaw = Number(raw.tMs ?? raw.t ?? raw.time);
    if (!isFinite(tRaw)) return null;

    if (tRaw > 1e12) {
      tMs = tRaw;
    } else {
      // capisci unit dal delta
      if (gpsTimeUnit == null && lastGpsTRaw != null) {
        const d = tRaw - lastGpsTRaw;
        if (d > 0 && d < 20) {
          gpsTimeUnit = "s";
        } else if (d >= 20) {
          gpsTimeUnit = "ms";
        }
      }
      lastGpsTRaw = tRaw;
      tMs = gpsTimeUnit === "s" ? tRaw * 1000 : tRaw;
    }
  }

  if (!isFinite(tMs)) return null;

  return { t: tMs, lat, lng, acc };
}

// ==========================================
// GPS (LIVE / REPLAY CORE: onGpsUpdate)
// ==========================================
function onGpsUpdate(data) {
  if (!data) return;

  const lat = Number(data.latitude ?? data.lat);
  const lng = Number(data.longitude ?? data.lng ?? data.lon);
  const acc = Number(data.accuracy ?? data.acc ?? 10);

  // timestamp: preferisci t, fallback timestamp ISO, fallback now
  let tMs = null;
  if (data.t != null) {
    tMs = Number(data.t);
  } else if (data.timestamp) {
    tMs = new Date(data.timestamp).getTime();
  } else {
    tMs = Date.now();
  }

  if (!isFinite(lat) || !isFinite(lng) || lat === 0 || lng === 0) return;
  if (!isFinite(tMs)) return;

  ensureSessionStart(tMs);

  const prevSample = gpsSamples.length ? gpsSamples[gpsSamples.length - 1] : null;

  // primo punto: speed = 0
  if (!prevSample) {
    gpsSamples.push({ t: tMs, lat, lng, acc, cumDistM: 0, speedKmh: 0 });

    if (!isBulkLoading) {
      ensureMapInitialized(lat, lng);
      if (!isReplayMode) {
        updateSpeedDistanceUI(0, 0);
      }
    }

    updateReplayUiBounds();
    showReplayOverlayIfReady();
    return;
  }

  // CALCOLO VELOCITÀ (con SMOOTHING per GPS rumorosi)
  const dtSec = (tMs - prevSample.t) / 1000;
  const stepM = haversineMeters(prevSample.lat, prevSample.lng, lat, lng);

  let usedStepM = 0;
  let speedKmh = 0;

  // Filtri qualità GPS
  if (dtSec >= 0.3 && dtSec <= 5.0 && acc <= 50) {
    // Se ti muovi pochissimo (<1m), considera velocità = 0
    if (stepM < 1.0) {
      speedKmh = 0;
      usedStepM = 0;
    }
    // Movimento rilevato
    else {
      usedStepM = stepM;
      const instantSpeed = (stepM / dtSec) * 3.6; // km/h istantaneo

      // Smoothing esponenziale: 70% vecchio, 30% nuovo per evitare oscillazioni
      const prevSpeed = prevSample.speedKmh || 0;
      speedKmh = prevSpeed * 0.7 + instantSpeed * 0.3;

      // Cap realistico
      if (!isFinite(speedKmh) || speedKmh < 0) speedKmh = 0;
      speedKmh = Math.min(speedKmh, 100);
    }
  } else {
    // Fix scadenti: mantieni velocità precedente
    speedKmh = prevSample.speedKmh || 0;
  }

  const newCumDistM = (prevSample.cumDistM || 0) + usedStepM;

  // Salva sample
  gpsSamples.push({ t: tMs, lat, lng, acc, cumDistM: newCumDistM, speedKmh });

  // UI/MAP: aggiorna solo se non bulk
  if (isBulkLoading) return;

  if (!isReplayMode) {
    updateSpeedDistanceUI(speedKmh, newCumDistM);
  }

  if (map && mapMarker) {
    const pos = [lat, lng];
    mapMarker.setLatLng(pos);
    if (fullRoute) fullRoute.addLatLng(pos);
    if (progressRoute) progressRoute.addLatLng(pos);
    if (!isUserInteracting) map.panTo(pos);
  }

  updateReplayUiBounds();
  showReplayOverlayIfReady();
}

// ==========================================
// MAP INIT + push point
// ==========================================
function ensureMapDomOverlay() {
  const mapDiv = document.getElementById("map");
  if (!mapDiv) return;
  mapDiv.style.position = "relative";
}

function ensureMapInitialized(lat, lng) {
  if (isMapInitialized) return;

  const mapDiv = document.getElementById("map");
  if (!mapDiv) return;
  mapDiv.style.position = "relative";

  map = L.map("map", {
    attributionControl: false,
    zoomControl: true
  }).setView([lat, lng], 19);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", {
    maxZoom: 20
  }).addTo(map);

  // pane ordering
  map.createPane("routePane");
  map.getPane("routePane").style.zIndex = 450;

  map.createPane("markerPane");
  map.getPane("markerPane").style.zIndex = 650;

  var pulseIcon = L.divIcon({
    className: "custom-div-icon",
    html: '<div class="pulsating-marker"></div>',
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  mapMarker = L.marker([lat, lng], {
    icon: pulseIcon,
    pane: "markerPane"
  }).addTo(map);

  fullRoute = L.polyline([], {
    pane: "routePane",
    color: SENSORIA_GREEN,
    weight: 4,
    opacity: 0.45,
    lineJoin: "round",
    lineCap: "round"
  }).addTo(map);

  progressRoute = L.polyline([], {
    pane: "routePane",
    color: SENSORIA_GREEN,
    weight: 7,
    opacity: 0.95,
    lineJoin: "round",
    lineCap: "round"
  }).addTo(map);

  createReplayOverlayControls();
  createRotateControl();
  ensureMetricsCardsUI();

  isMapInitialized = true;

  setTimeout(() => {
    map.invalidateSize();
  }, 120);
}

function pushMapPoint(lat, lng) {
  if (!map || !mapMarker) return;

  const pos = [lat, lng];
  mapMarker.setLatLng(pos);
  if (fullRoute) fullRoute.addLatLng(pos);
  if (progressRoute) progressRoute.addLatLng(pos);
  if (!isUserInteracting) map.panTo(pos);
}

// ==========================================
// ROTATE CONTROL
// ==========================================
function createRotateControl() {
  const mapDiv = document.getElementById("map");
  if (!mapDiv) return;
  if (document.getElementById("rotate-btn")) return;

  const btn = document.createElement("button");
  btn.id = "rotate-btn";
  btn.innerHTML = "🧭";
  btn.title = "Ruota mappa";
  btn.style.cssText = `
    position:absolute;
    top:90px;
    left:10px;
    width:28px;
    height:28px;
    border-radius:4px;
    border:none;
    background:rgba(0,0,0,0.7);
    color:#fff;
    font-size:16px;
    line-height:1;
    cursor:pointer;
    z-index:20000;
    display:flex;
    align-items:center;
    justify-content:center;
  `;

  btn.addEventListener("click", () => {
    mapRotationDeg = (mapRotationDeg + 90) % 360;
    applyMapRotation(mapRotationDeg);
  });

  mapDiv.appendChild(btn);
}

function applyMapRotation(deg) {
  if (!map) return;

  const container = map.getContainer();
  const mapPane = container.querySelector(".leaflet-map-pane");
  if (!mapPane) return;

  const style = window.getComputedStyle(mapPane);
  const current = style.transform !== "none" ? style.transform : "";
  const cleaned = current.replace(/rotate\([^)]+\)/g, "").trim();
  const next = `${cleaned} rotate(${deg}deg)`.trim();

  mapPane.style.transformOrigin = "50% 50%";
  mapPane.style.transition = "transform 0.25s ease-out";
  mapPane.style.transform = next;

  setTimeout(() => {
    map.invalidateSize(true);
    const c = map.getCenter();
    map.panTo(c, { animate: false });
  }, 260);
}

// ==========================================
// REPLAY OVERLAY + LOOKUP
// ==========================================
function createReplayOverlayControls() {
  var mapDiv = document.getElementById("map");
  if (!mapDiv) return;
  if (document.getElementById("replay-overlay")) return;

  var overlay = document.createElement("div");
  overlay.id = "replay-overlay";
  overlay.style.cssText = `
    position:absolute;
    left:16px;
    right:16px;
    bottom:16px;
    z-index:30000;
    display:none;
    align-items:center;
    gap:12px;
    padding:10px 12px;
    border-radius:12px;
    background: rgba(10,10,10,0.85);
    border: 1px solid rgba(255,255,255,0.10);
    backdrop-filter: blur(6px);
    box-shadow: 0 10px 28px rgba(0,0,0,0.55);
  `;

  overlay.innerHTML = `
    <div style="min-width:64px;display:flex;flex-direction:column;gap:2px">
      <div style="font-size:10px;letter-spacing:1px;color:#9aa;font-weight:700">TIME</div>
      <div id="replay-time-label" style="font-family:monospace;font-size:13px;color:#fff;font-weight:700">00:00</div>
    </div>
    <input id="replay-slider" type="range" min="0" max="0" value="0" step="0.1" style="flex:1; accent-color:${SENSORIA_GREEN}; cursor:pointer" />
    <button id="btn-live" type="button" style="padding:6px 12px;border-radius:8px;border:1px solid ${SENSORIA_GREEN};background:rgba(151,201,62,0.18);color:${SENSORIA_GREEN}; font-weight:800;font-size:11px;letter-spacing:1px;cursor:pointer">
      LIVE
    </button>
  `;

  mapDiv.appendChild(overlay);

  var slider = document.getElementById("replay-slider");
  var btnLive = document.getElementById("btn-live");

  // blocca propagazione verso Leaflet
  if (window.L && L.DomEvent) {
    L.DomEvent.disableClickPropagation(overlay);
    L.DomEvent.disableScrollPropagation(overlay);
  }

  let scrubbing = false;

  function lockMapInteractions(lock) {
    if (!map) return;
    if (lock) {
      if (map.dragging) map.dragging.disable();
      if (map.scrollWheelZoom) map.scrollWheelZoom.disable();
      if (map.doubleClickZoom) map.doubleClickZoom.disable();
      if (map.touchZoom) map.touchZoom.disable();
      if (map.boxZoom) map.boxZoom.disable();
      if (map.keyboard) map.keyboard.disable();
    } else {
      if (map.dragging) map.dragging.enable();
      if (map.scrollWheelZoom) map.scrollWheelZoom.enable();
      if (map.doubleClickZoom) map.doubleClickZoom.enable();
      if (map.touchZoom) map.touchZoom.enable();
      if (map.boxZoom) map.boxZoom.enable();
      if (map.keyboard) map.keyboard.enable();
    }
  }

  function seekToSliderValue() {
    const sec = parseFloat(slider.value) || 0;
    enterReplayAtSecond(sec);
  }

  function setSliderFromClientX(clientX) {
    const rect = slider.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, rect.width);
    const pct = rect.width > 0 ? x / rect.width : 0;
    const min = parseFloat(slider.min) || 0;
    const max = parseFloat(slider.max) || 0;
    const val = min + pct * (max - min);
    slider.value = val.toFixed(1);
    seekToSliderValue();
  }

  slider.addEventListener("input", () => {
    if (!scrubbing) seekToSliderValue();
  });

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

  // fallback anti-pan
  slider.addEventListener("mousedown", (e) => e.stopPropagation());
  slider.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

  btnLive.addEventListener("click", goLive);
}

function updateReplayTimeLabel(sec) {
  var lab = document.getElementById("replay-time-label");
  if (!lab) return;
  var whole = Math.max(0, Math.round(sec));
  var m = Math.floor(whole / 60).toString().padStart(2, "0");
  var s = (whole % 60).toString().padStart(2, "0");
  lab.textContent = `${m}:${s}`;
}

function showReplayOverlayIfReady() {
  var overlay = document.getElementById("replay-overlay");
  if (!overlay) return;
  if (getDurationSec() > 0 && gpsSamples.length >= 1) {
    overlay.style.display = "flex";
  } else {
    overlay.style.display = "none";
  }
}

function updateReplayUiBounds() {
  var slider = document.getElementById("replay-slider");
  if (!slider) return;

  var maxSec = getDurationSec();
  slider.max = String(maxSec);
  slider.step = "0.1";

  if (!isReplayMode) {
    slider.value = maxSec.toFixed(1);
    updateReplayTimeLabel(maxSec);
  }
}

// ---- replay search helpers ----
function upperBoundByTime(arr, tMs) {
  var lo = 0,
    hi = arr.length;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    if (arr[mid].t <= tMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function getInterpolatedGpsAtTime(tMs) {
  if (!gpsSamples.length) return null;
  if (gpsSamples.length === 1) return { lat: gpsSamples[0].lat, lng: gpsSamples[0].lng };

  var idx = upperBoundByTime(gpsSamples, tMs);
  if (idx === 0) return { lat: gpsSamples[0].lat, lng: gpsSamples[0].lng };
  if (idx >= gpsSamples.length) {
    var last = gpsSamples[gpsSamples.length - 1];
    return { lat: last.lat, lng: last.lng };
  }

  var a = gpsSamples[idx - 1];
  var b = gpsSamples[idx];
  if (b.t === a.t) return { lat: b.lat, lng: b.lng };

  var alpha = clamp((tMs - a.t) / (b.t - a.t), 0, 1);
  return {
    lat: a.lat + (b.lat - a.lat) * alpha,
    lng: a.lng + (b.lng - a.lng) * alpha
  };
}

function getBpmAtTime(tMs) {
  if (!bpmSamples.length) return null;
  var idx = upperBoundByTime(bpmSamples, tMs);
  if (idx === 0) return bpmSamples[0].bpm;
  return bpmSamples[idx - 1].bpm;
}

function getDistanceAtTime(tMs) {
  if (!gpsSamples.length) return 0;
  if (gpsSamples.length === 1) return gpsSamples[0].cumDistM || 0;

  var idx = upperBoundByTime(gpsSamples, tMs);
  if (idx === 0) return gpsSamples[0].cumDistM || 0;
  if (idx >= gpsSamples.length) return gpsSamples[gpsSamples.length - 1].cumDistM || 0;

  var a = gpsSamples[idx - 1];
  var b = gpsSamples[idx];
  var dt = Math.max(1, b.t - a.t);
  var alpha = clamp((tMs - a.t) / dt, 0, 1);

  var da = a.cumDistM || 0;
  var db = b.cumDistM != null ? b.cumDistM : da;
  return da + (db - da) * alpha;
}

function getSpeedAtTime(tMs) {
  if (!gpsSamples.length) return 0;
  if (gpsSamples.length === 1) return gpsSamples[0].speedKmh || 0;

  var idx = upperBoundByTime(gpsSamples, tMs);
  if (idx === 0) return gpsSamples[0].speedKmh || 0;
  if (idx >= gpsSamples.length) return gpsSamples[gpsSamples.length - 1].speedKmh || 0;

  var a = gpsSamples[idx - 1];
  var b = gpsSamples[idx];
  var dt = Math.max(1, b.t - a.t);
  var alpha = clamp((tMs - a.t) / dt, 0, 1);

  var sa = a.speedKmh || 0;
  var sb = b.speedKmh != null ? b.speedKmh : sa;
  return sa + (sb - sa) * alpha;
}

function updateProgressRouteToTime(tMs) {
  if (!progressRoute) return;
  if (!gpsSamples.length) {
    progressRoute.setLatLngs([]);
    return;
  }

  var idx = upperBoundByTime(gpsSamples, tMs);
  idx = clamp(idx, 0, gpsSamples.length);

  var pts = [];
  for (var i = 0; i < idx; i++) {
    pts.push([gpsSamples[i].lat, gpsSamples[i].lng]);
  }

  if (idx > 0 && idx < gpsSamples.length) {
    var interp = getInterpolatedGpsAtTime(tMs);
    if (interp) pts.push([interp.lat, interp.lng]);
  }

  progressRoute.setLatLngs(pts);
}

// FUNZIONE HELPER PER TROVARE SAMPLE CALZINI
function findSampleAtTime(samples, tMs) {
  if (!samples || samples.length === 0) return null;
  
  if (samples.length === 1) return samples[0];
  
  let idx = upperBoundByTime(samples, tMs);
  
  if (idx === 0) return samples[0];
  if (idx >= samples.length) return samples[samples.length - 1];
  
  return samples[idx - 1];
}

function avgBiInWindow(samples, tMs, windowMs) {
  if (!samples || !samples.length) return null;
  const tMin = tMs - windowMs;

  // idxEnd: primo > tMs
  let idxEnd = upperBoundByTime(samples, tMs);
  // idxStart: primo > tMin
  let idxStart = upperBoundByTime(samples, tMin);

  idxStart = Math.max(0, Math.min(idxStart, samples.length));
  idxEnd = Math.max(0, Math.min(idxEnd, samples.length));

  if (idxEnd <= idxStart) {
    // fallback: ultimo noto
    const s = samples[Math.max(0, idxEnd - 1)];
    return s ? s.bi : null;
  }

  let sum = 0;
  let n = 0;
  for (let i = idxStart; i < idxEnd; i++) {
    const v = samples[i] && samples[i].bi;
    if (v != null && isFinite(v)) { sum += v; n++; }
  }
  if (!n) return null;
  return sum / n;
}

function enterReplayAtSecond(sec) {
  if (sessionStartTimeMs == null) return;

  // modalità replay
  isReplayMode = true;

  // stop animazioni live marker se presenti
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  // 1) clamp tempo
  const durationSec = getDurationSec();
  const clampedSec = Math.max(0, Math.min(sec, durationSec));
  const tMs = sessionStartTimeMs + clampedSec * 1000;

  // 2) label mm:ss
  updateReplayTimeLabel(clampedSec);

  // 3) mappa: posizione interpolata + progress route
  const pos = getInterpolatedGpsAtTime(tMs);
  if (pos && mapMarker) {
    mapMarker.setLatLng([pos.lat, pos.lng]);
    currentMapPos = { lat: pos.lat, lng: pos.lng };
    if (map) map.panTo([pos.lat, pos.lng], { animate: false });
  }
  updateProgressRouteToTime(tMs);

  // 4) BPM: step ultimo noto a tMs
  const bpm = getBpmAtTime(tMs);
  if (bpm != null) updateBpmValue(bpm);

  // 5) distanza continua + velocita a scatti ogni secondo
  const dist = getDistanceAtTime(tMs);
  const wholeSec = Math.max(0, Math.floor(clampedSec));

  // velocita a scatti: se manca il valore per quel secondo, usa ultimo valore noto (no flash a 0)
  let speed = null;
  if (Array.isArray(speedBySec) && speedBySec.length) {
    if (speedBySec[wholeSec] != null) {
      speed = speedBySec[wholeSec];
    } else {
      for (let s = wholeSec - 1; s >= 0; s--) {
        if (speedBySec[s] != null) {
          speed = speedBySec[s];
          break;
        }
      }
    }
  }
  if (speed == null || !isFinite(speed)) speed = 0;
  speed = Math.max(0, speed);

  updateSpeedDistanceUI(speed, dist);

  // 6) calzini: finestra zoom + valori istantanei
  const windowHalf = 5;
  const tMin = Math.max(0, clampedSec - windowHalf);
  const tMax = tMin + windowHalf * 2;

  if (sockCharts.left) {
    sockCharts.left.setScale("x", { min: tMin, max: tMax });
  }
  if (sockCharts.right) {
    sockCharts.right.setScale("x", { min: tMin, max: tMax });
  }

  // AGGIORNA VALORI ISTANTANEI CALZINI
  const lS = findSampleAtTime(leftSockSamples, tMs);
  if (lS) {
    const biL = avgBiInWindow(leftSockSamples, tMs, 150);
    updateSocksUI("left", { p0: lS.p0, p1: lS.p1, p2: lS.p2 }, biL ?? lS.bi);
  }

  const rS = findSampleAtTime(rightSockSamples, tMs);
  if (rS) {
    const biR = avgBiInWindow(rightSockSamples, tMs, 150);
    updateSocksUI("right", { p0: rS.p0, p1: rS.p1, p2: rS.p2 }, biR ?? rS.bi);
  }


  // 7) sync slider (solo se non stai trascinando in modo fine)
  const slider = document.getElementById("replay-slider");
  if (slider) {
    const v = parseFloat(slider.value) || 0;
    if (!isFinite(v) || Math.abs(v - clampedSec) > 0.5) {
      slider.value = clampedSec.toFixed(1);
    }
  }
}

function goLive() {
  isReplayMode = false;
  updateReplayUiBounds();

  if (gpsSamples.length) {
    var lastG = gpsSamples[gpsSamples.length - 1];
    updateSpeedDistanceUI(lastG.speedKmh, lastG.cumDistM);

    if (mapMarker) {
      mapMarker.setLatLng([lastG.lat, lastG.lng]);
    }
    if (map) {
      map.panTo([lastG.lat, lastG.lng], { animate: false });
    }

    updateProgressRouteToTime(getSessionEndMs());
  }

  if (lastLiveBpm !== "--") {
    updateBpmValue(lastLiveBpm);
  }
}

// ==========================================
// SENSOR UPDATE (parsing calzini)
// ==========================================
function processIncomingData(data) {
  var payload = data && typeof data === "object" && data.data ? data.data : data;
  if (!payload || (!payload.sensorname && !payload.name && !payload.sensor_name)) return;

  // SUPPORTA: sensor_name, sensorname, name
  const name = String(payload.sensor_name ?? payload.sensorname ?? payload.name ?? "unknown").toLowerCase();
  const tMs = getNowMs();
  ensureSessionStart(tMs);

  // Calzini: mapping campi flessibile
  const p0 = Number(payload.pressure_0 ?? payload.p0 ?? payload.pressure0 ?? 0);
  const p1 = Number(payload.pressure_1 ?? payload.p1 ?? payload.pressure1 ?? 0);
  const p2 = Number(payload.pressure_2 ?? payload.p2 ?? payload.pressure2 ?? 0);
  const bi = calculateBI(payload);

  if (name.includes("sx") || name.includes("dx")) {
  console.log("SOCK PAYLOAD", name, "ax=", payload.accelx, "ay=", payload.accely, "az=", payload.accelz, "bi=", bi);  
  }

  if (name.includes("sx") || name.includes("left")) {
    leftSockSamples.push({ t: tMs, p0, p1, p2, bi });
    if (!isReplayMode) {
      updateSocksUI("left", { p0, p1, p2 }, bi);
    }
  } else if (name.includes("dx") || name.includes("right")) {
    rightSockSamples.push({ t: tMs, p0, p1, p2, bi });
    if (!isReplayMode) {
      updateSocksUI("right", { p0, p1, p2 }, bi);
    }
  }

  sensors[payload.sensor_name ?? payload.sensorname ?? payload.name] = payload;

  updateSensorCardUI(payload.sensor_name ?? payload.sensorname ?? payload.name, payload);
  // charts: se selezionato
  updateChartsUI(payload.sensor_name ?? payload.sensorname ?? payload.name, payload);
}

// Quale asse considerare latero-laterale: 'x' | 'y' | 'z'
const BI_LATERAL_AXIS = 'x';
const BI_AVG_WINDOW_MS = 850;

const biAgg = {
  left: { sum: 0, n: 0, last: null },
  right:{ sum: 0, n: 0, last: null }
};

let biAvgTimer = null;


function calculateBI(payload) {
  const ax = payload.accelx ?? payload.ax ?? payload.accX ?? payload.AccelX;
  const ay = payload.accely ?? payload.ay ?? payload.accY ?? payload.AccelY;
  const az = payload.accelz ?? payload.az ?? payload.accZ ?? payload.AccelZ;

  if (ax == null || ay == null || az == null) return 0;

  const norm = Math.sqrt(ax*ax + ay*ay + az*az);
  return norm > 0.1 ? Math.abs(ax / norm) * 100 : 0;
  if (ax == null || ay == null || az == null) console.log("BI=0 missing accel", payload);
}

function initSockCharts() {
  const leftEl = document.getElementById("chart-left-p");
  const rightEl = document.getElementById("chart-right-p");
  if (!leftEl || !rightEl) return;

  const makeOpts = (container, title) => ({
    width: container.offsetWidth,
    height: 130,
    scales: {
      x: { time: false }, // secondi dall'inizio attività
      y: { auto: true }
    },
    series: [
      {},
      { label: "P0", stroke: "#ffb74d", width: 2, points: { show: false } },
      { label: "P1", stroke: "#e91e63", width: 2, points: { show: false } },
      { label: "P2", stroke: "#4fc3f7", width: 2, points: { show: false } }
    ],
    axes: [{ show: false }, { show: false }],
    legend: { show: true, live: false },
    cursor: { show: true, sync: { key: "socks" } }
  });

  if (!sockCharts.left) {
    sockCharts.left = new uPlot(makeOpts(leftEl, "SX"), sockChartData.left, leftEl);
  }
  if (!sockCharts.right) {
    sockCharts.right = new uPlot(makeOpts(rightEl, "DX"), sockChartData.right, rightEl);
  }
}

// FUNZIONE AGGIORNATA: updateSocksUI
function updateSocksUI(side, data, bi) {
  console.log("updateSocksUI called", side, bi, data);
  const prefix = side === "left" ? "l" : "r";
  
  // BI (Balance Index) - se hai questo dato
  const biEl = document.getElementById(`bi-val-${side}`);
  if (biEl) {
    biEl.textContent = `BI: ${bi.toFixed(1)}`;
    biEl.style.color = bi > 40 ? "#ff4444" : SENSORIA_GREEN;
  }

  // Estrai i valori con fallback multipli
  const val0 = data.p0 ?? data.pressure_0 ?? data.pressure0 ?? 0;
  const val1 = data.p1 ?? data.pressure_1 ?? data.pressure1 ?? 0;
  const val2 = data.p2 ?? data.pressure_2 ?? data.pressure2 ?? 0;

  // MAPPING CORRETTO PER CALZINO SX E DX
  const el_posteriore = document.getElementById(`${prefix}-posteriore`);
  const el_sinistra = document.getElementById(`${prefix}-sinistra`);
  const el_destra = document.getElementById(`${prefix}-destra`);

  if (side === "left") {
    // CALZINO SX: posteriore=p2, sinistra=p0, destra=p1
    if (el_posteriore) el_posteriore.textContent = Math.round(val2);
    if (el_sinistra) el_sinistra.textContent = Math.round(val0);
    if (el_destra) el_destra.textContent = Math.round(val1);
  } else {
    // CALZINO DX: posteriore=p2, sinistra=p1, destra=p0
    if (el_posteriore) el_posteriore.textContent = Math.round(val2);
    if (el_sinistra) el_sinistra.textContent = Math.round(val1);
    if (el_destra) el_destra.textContent = Math.round(val0);
  }

  // aggiorna grafico live calzino
  if (!isReplayMode) {
    if (!sockCharts.left) initSockCharts();
    const chart = sockCharts[side];
    if (chart) {
      const d = sockChartData[side];
      const tRel = sessionStartTimeMs ? (Date.now() - sessionStartTimeMs) / 1000 : 0;
      d[0].push(tRel);
      d[1].push(val0);
      d[2].push(val1);
      d[3].push(val2);
      if (d[0].length > 100) d.forEach((a) => a.shift());
      chart.setData(d);
    }
  }
}


// ==========================================
// SENSOR CARDS UI (minimal)
// ==========================================
function createSensorCard(name, data) {
  var grid = document.getElementById("sensors-grid");
  if (!grid) return;

  var div = document.createElement("div");
  div.className = "sensor-card sensor-col connected";
  div.setAttribute("data-sensor", name);

  div.innerHTML = `
    <div class="sensor-header">
      <span class="emoji">📡</span>
      <span class="name">${name}</span>
      <div class="status-indicator active"></div>
    </div>
    <div class="sensor-data-section">
      <div class="sensor-data-row"><span class="sensor-data-label">P0</span><span class="sensor-value" data-key="pressure_0">0</span></div>
      <div class="sensor-data-row"><span class="sensor-data-label">P1</span><span class="sensor-value" data-key="pressure_1">0</span></div>
      <div class="sensor-data-row"><span class="sensor-data-label">P2</span><span class="sensor-value" data-key="pressure_2">0</span></div>
    </div>
  `;
  grid.appendChild(div);
}

function updateSensorCardUI(name, data) {
  if (!name) return;

  var card = document.querySelector(`[data-sensor="${CSS.escape(name)}"]`);
  if (!card) {
    createSensorCard(name, data);
    card = document.querySelector(`[data-sensor="${CSS.escape(name)}"]`);
  }
  if (!card) return;

  // aggiorna valori noti
  const p0 = data.pressure_0 ?? data.p0 ?? data.pressure0;
  const p1 = data.pressure_1 ?? data.p1 ?? data.pressure1;
  const p2 = data.pressure_2 ?? data.p2 ?? data.pressure2;

  const set = (key, val) => {
    const el = card.querySelector(`[data-key="${key}"]`);
    if (el && val != null && isFinite(val)) {
      el.textContent = String(Math.round(val));
    }
  };

  set("pressure_0", p0);
  set("pressure_1", p1);
  set("pressure_2", p2);
}

// ==========================================
// PROFILE UI (placeholder)
// ==========================================
function updateProfileUI(data) {
  // se hai già HTML specifico, puoi completare qui
  // lasciato volutamente minimale
}

// ==========================================
// uPlot charts (minimal, compat)
// ==========================================
function initCharts() {
  var accelDiv = document.getElementById("accel-chart");
  var gyroDiv = document.getElementById("gyro-chart");
  var magDiv = document.getElementById("mag-chart");
  var pressureDiv = document.getElementById("pressure-chart");

  if (!accelDiv || !gyroDiv || !magDiv || !pressureDiv) return;

  accelDiv.innerHTML = "";
  gyroDiv.innerHTML = "";
  magDiv.innerHTML = "";
  pressureDiv.innerHTML = "";

  var commonOpts = {
    width: accelDiv.offsetWidth,
    height: 200,
    cursor: { show: true, drag: { x: true, y: false } },
    scales: { x: { time: true }, y: { auto: true } },
    axes: [
      { stroke: SENSORIA_GREEN, grid: { stroke: "#333" } },
      { stroke: SENSORIA_GREEN, grid: { stroke: "#333" } }
    ]
  };

  function mkSeries(c1, c2, c3) {
    return [
      {},
      { label: "X", stroke: c1, width: 2 },
      { label: "Y", stroke: c2, width: 2 },
      { label: "Z", stroke: c3, width: 2 }
    ];
  }

  var o1 = Object.assign({}, commonOpts);
  o1.series = mkSeries("#ff6384", "#36a2eb", "#4bc0c0");

  var o2 = Object.assign({}, commonOpts);
  o2.series = mkSeries("#ff9f40", "#9966ff", "#ffcd56");

  var o3 = Object.assign({}, commonOpts);
  o3.series = mkSeries("#c9cbcf", "#4bc0c0", "#ff6384");

  var o4 = Object.assign({}, commonOpts);
  o4.height = 250;
  o4.scales = { x: { time: true }, y: { auto: false, range: [0, 1024] } };
  o4.series = [
    {},
    { label: "P0", stroke: "#ff6384", width: 3 },
    { label: "P1", stroke: "#36a2eb", width: 3 },
    { label: "P2", stroke: "#ffce56", width: 3 }
  ];

  charts.accel = new uPlot(o1, chartData.accel, accelDiv);
  charts.gyro = new uPlot(o2, chartData.gyro, gyroDiv);
  charts.mag = new uPlot(o3, chartData.mag, magDiv);
  charts.pressure = new uPlot(o4, chartData.pressure, pressureDiv);

  addInteraction(charts.accel);
  addInteraction(charts.gyro);
  addInteraction(charts.mag);
  addInteraction(charts.pressure);
}

function addInteraction(u) {
  if (!u || !u.over) return;
  u.over.addEventListener("mousedown", () => (isUserInteracting = true));
  u.over.addEventListener("wheel", () => (isUserInteracting = true));
  u.over.addEventListener("dblclick", () => (isUserInteracting = false));
}

function resetChartData() {
  isUserInteracting = false;
  chartData = {
    accel: [[], [], [], []],
    gyro: [[], [], [], []],
    mag: [[], [], [], []],
    pressure: [[], [], [], []]
  };

  if (!chartsInitialized) return;

  if (charts.accel) charts.accel.setData(chartData.accel);
  if (charts.gyro) charts.gyro.setData(chartData.gyro);
  if (charts.mag) charts.mag.setData(chartData.mag);
  if (charts.pressure) charts.pressure.setData(chartData.pressure);
}

function updateChartsUI(sensorName, data) {
  if (!selectedSensor || !chartsInitialized) return;
  if (!sensorName || String(sensorName) !== String(selectedSensor)) return;

  const timestamp = Date.now() / 1000;

  function push(arr, vals) {
    arr[0].push(timestamp);
    vals.forEach((v, i) => arr[i + 1].push(v ?? 0));
    if (arr[0].length > 1000) arr.forEach((s) => s.shift());
  }

  // accel
  if (data.accel_x != null || data.accelx != null) {
    push(chartData.accel, [
      data.accel_x ?? data.accelx,
      data.accel_y ?? data.accely,
      data.accel_z ?? data.accelz
    ]);
    charts.accel.setData(chartData.accel);
  }

  // gyro
  if (data.gyro_x != null || data.gyrox != null) {
    push(chartData.gyro, [
      data.gyro_x ?? data.gyrox,
      data.gyro_y ?? data.gyroy,
      data.gyro_z ?? data.gyroz
    ]);
    charts.gyro.setData(chartData.gyro);
  }

  // mag
  if (data.mag_x != null || data.magx != null) {
    push(chartData.mag, [
      data.mag_x ?? data.magx,
      data.mag_y ?? data.magy,
      data.mag_z ?? data.magz
    ]);
    charts.mag.setData(chartData.mag);
  }

  // pressure
  const p0 = data.pressure_0 ?? data.p0 ?? data.pressure0;
  if (p0 != null) {
    push(chartData.pressure, [
      p0,
      data.pressure_1 ?? data.p1 ?? data.pressure1,
      data.pressure_2 ?? data.p2 ?? data.pressure2
    ]);
    charts.pressure.setData(chartData.pressure);
  }
}

// ==========================================
// PAST ACTIVITY LOADER (modal replay build)
// ==========================================
function initPastActivityLoader() {
  const header =
    document.querySelector(".dashboard-info") ||
    document.querySelector(".dashboard-header") ||
    document.body;

  if (document.getElementById("btn-load-activity")) return;

  const btn = document.createElement("button");
  btn.id = "btn-load-activity";
  btn.type = "button";
  btn.textContent = "Carica attività passata";
  btn.style.cssText = `
    padding:8px 12px;
    border-radius:10px;
    border:1px solid rgba(151,201,62,0.8);
    background:rgba(151,201,62,0.12);
    color:${SENSORIA_GREEN};
    font-weight:800;
    cursor:pointer;
    white-space:nowrap;
    margin-left:12px;
  `;
  btn.addEventListener("click", openLogsModal);
  header.appendChild(btn);
}

async function openLogsModal() {
  const old = document.getElementById("logs-modal");
  if (old) old.remove();

  const modal = document.createElement("div");
  modal.id = "logs-modal";
  modal.style.cssText = `
    position:fixed;
    inset:0;
    z-index:99999;
    background:rgba(0,0,0,0.65);
    display:flex;
    align-items:center;
    justify-content:center;
    padding:18px;
  `;

  modal.innerHTML = `
    <div style="width:min(620px,96vw);background:#111;border:1px solid #333;border-radius:14px; box-shadow:0 18px 48px rgba(0,0,0,0.65);overflow:hidden">
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
    const logs = Array.isArray(json) ? json : json.logs || [];

    status.textContent = logs.length ? "Seleziona un log:" : "Nessun log trovato.";
    list.innerHTML = "";

    logs.forEach((item) => {
      const row = document.createElement("button");
      row.type = "button";
      row.style.cssText = `
        text-align:left;
        padding:10px 12px;
        border-radius:10px;
        border:1px solid #2a2a2a;
        background:#161616;
        color:#fff;
        cursor:pointer;
      `;

      const dt = item.mtime ? new Date(item.mtime * 1000).toLocaleString() : "--";
      const kb = item.size != null ? Math.round(item.size / 1024) : "--";

      row.innerHTML = `
        <div style="font-weight:800">${item.name}</div>
        <div style="font-size:12px;color:#999;margin-top:2px">${dt} · ${kb} KB</div>
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

function resetReplayState() {
  gpsSamples = [];
  bpmSamples = [];
  leftSockSamples = [];
  rightSockSamples = [];

  sockChartData.left = [[], [], [], []];
  sockChartData.right = [[], [], [], []];

  speedBySec = [];
  lastSpeedKmh = 0;
  lastSpeedSec = null;
  lastSecFix = null;
  lastLiveBpm = "--";

  sessionStartTimeMs = null;
  sessionEndTimeMs = null;
  isReplayMode = false;

  gpsTimeUnit = null;
  lastGpsTRaw = null;

  if (fullRoute) fullRoute.setLatLngs([]);
  if (progressRoute) progressRoute.setLatLngs([]);

  updateBpmValue("--");
  updateSpeedDistanceUI(null, null);
}

async function loadPastActivity(logName) {
  try {
    // --- helper UI status (se la modale è aperta) ---
    const statusEl = document.getElementById("logs-status");
    const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };

    setStatus(`Caricamento ${logName}...`);

    // --- fetch log ---
    const resp = await fetch(`/api/logs/load?name=${encodeURIComponent(logName)}`);
    const data = await resp.json();

    // 1) Reset stati/array
    gpsSamples = [];
    bpmSamples = [];
    speedBySec = [];
    secPos = [];

    leftSockSamples = [];
    rightSockSamples = [];
    sockChartData.left = [[], [], [], []];
    sockChartData.right = [[], [], [], []];

    sessionStartTimeMs = null;
    sessionEndTimeMs = null;
    isReplayMode = false;

    gpsTimeUnit = null;
    lastGpsTRaw = null;

    lastSpeedKmh = 0;
    lastSpeedSec = null;
    lastSecFix = null;
    lastLiveBpm = "--";

    if (fullRoute) fullRoute.setLatLngs([]);
    if (progressRoute) progressRoute.setLatLngs([]);

    updateBpmValue("--");
    updateSpeedDistanceUI(null, null);

    // 2) Sensori calzini
    setStatus("Parsing sensori...");
    const sensorsData = Array.isArray(data.sensors) ? data.sensors : [];

    if (sensorsData.length > 0) {
      // calcola sessionStartTimeMs robusto
      const firstSensor = sensorsData[0];
      const initialT =
        firstSensor.t ? Number(firstSensor.t) :
        firstSensor.timestamp ? new Date(firstSensor.timestamp).getTime() :
        Date.now();

      sessionStartTimeMs = sensorsData.reduce((min, item) => {
        const t =
          item.t ? Number(item.t) :
          item.timestamp ? new Date(item.timestamp).getTime() :
          null;
        if (!t || !isFinite(t)) return min;
        return t < min ? t : min;
      }, initialT);

      sensorsData.forEach((sensorItem) => {
        const tMs =
          sensorItem.t ? Number(sensorItem.t) :
          sensorItem.timestamp ? new Date(sensorItem.timestamp).getTime() :
          null;
        if (!tMs || !isFinite(tMs)) return;

        const tRelSec = (tMs - sessionStartTimeMs) / 1000;

        // SUPPORTA: sensor_name, sensorname, name
        const name = String(
          sensorItem.sensor_name ?? sensorItem.sensorname ?? sensorItem.name ?? "unknown"
        ).toLowerCase();

        // SUPPORTA: pressure_0, p0, pressure0 (ecc.)
        const p0 = Number(sensorItem.pressure_0 ?? sensorItem.p0 ?? sensorItem.pressure0 ?? 0);
        const p1 = Number(sensorItem.pressure_1 ?? sensorItem.p1 ?? sensorItem.pressure1 ?? 0);
        const p2 = Number(sensorItem.pressure_2 ?? sensorItem.p2 ?? sensorItem.pressure2 ?? 0);

        const biInst = calculateBI(sensorItem);
        const sample = { t: tMs, p0, p1, p2, bi: biInst };

        if (name.includes("sx") || name.includes("left") || name.includes("sinistro")) {
          leftSockSamples.push(sample);
          sockChartData.left[0].push(tRelSec);
          sockChartData.left[1].push(p0);
          sockChartData.left[2].push(p1);
          sockChartData.left[3].push(p2);
        } else if (name.includes("dx") || name.includes("right") || name.includes("destro")) {
          rightSockSamples.push(sample);
          sockChartData.right[0].push(tRelSec);
          sockChartData.right[1].push(p0);
          sockChartData.right[2].push(p1);
          sockChartData.right[3].push(p2);
        }
      });
    }

    // 3) GPS bulk-load (NO map/UI per ogni punto)
    setStatus("Parsing GPS...");
    const gpsArr = Array.isArray(data.gps) ? data.gps : [];
    if (gpsArr.length === 0) {
      console.warn("Nessun GPS nel log.");
      setStatus("Nessun GPS nel log.");
      return;
    }

    isBulkLoading = true;

    // Chunking per non freezare (log grandi)
    const CHUNK = 1000;
    for (let i = 0; i < gpsArr.length; i += CHUNK) {
      const end = Math.min(i + CHUNK, gpsArr.length);
      setStatus(`Parsing GPS... ${end}/${gpsArr.length}`);
      for (let j = i; j < end; j++) {
        // usa la tua onGpsUpdate già robusta (accetta più formati)
        onGpsUpdate(gpsArr[j]);
      }
      // yield UI
      await new Promise((r) => setTimeout(r, 0));
    }

    isBulkLoading = false;

    // 4) BPM
    setStatus("Parsing BPM...");
    if (Array.isArray(data.bpm)) {
      data.bpm.forEach((b) => {
        const tMs =
          b.t ? Number(b.t) :
          b.timestamp ? new Date(b.timestamp).getTime() :
          null;
        if (!tMs || !isFinite(tMs)) return;
        bpmSamples.push({ t: tMs, bpm: b.bpm ?? b.value ?? 0 });
      });
    }

    // 5) UI/Grafici calzini una volta
    setStatus("Rendering grafici calzini...");
    initSockCharts();
    if (sockCharts.left) sockCharts.left.setData(sockChartData.left);
    if (sockCharts.right) sockCharts.right.setData(sockChartData.right);

    // 6) MAPPA: aggiorna UNA volta sola (route completa + marker)
    setStatus("Rendering mappa...");
    if (gpsSamples.length) {
      const first = gpsSamples[0];
      ensureMapInitialized(first.lat, first.lng);

      // downsample route per Leaflet (boost: 1 punto ogni 2m)
      const pts = [];
      let last = null;
      const MIN_STEP_M = 2.0;

      for (let i = 0; i < gpsSamples.length; i++) {
        const s = gpsSamples[i];
        if (!last) {
          pts.push([s.lat, s.lng]);
          last = s;
          continue;
        }
        const dm = haversineMeters(last.lat, last.lng, s.lat, s.lng);
        if (dm >= MIN_STEP_M) {
          pts.push([s.lat, s.lng]);
          last = s;
        }
      }

      if (fullRoute) fullRoute.setLatLngs(pts);
      if (progressRoute) progressRoute.setLatLngs([]); // ricostruita da enterReplayAtSecond
      if (mapMarker) mapMarker.setLatLng([first.lat, first.lng]);
    }

    // 7) Bounds + overlay replay una volta
    setStatus("Finalizzazione replay...");
    sessionEndTimeMs = getSessionEndMs();
    updateReplayUiBounds();
    showReplayOverlayIfReady();
    rebuildSpeedBySecFromGps();

    // vai all'inizio attività
    enterReplayAtSecond(0);

    setStatus("Caricato.");
    console.log(
      "✅ Log caricato:",
      logName,
      "GPS:", gpsSamples.length,
      "BPM:", bpmSamples.length,
      "Left socks:", leftSockSamples.length,
      "Right socks:", rightSockSamples.length
    );
  } catch (error) {
    isBulkLoading = false;
    console.error("Errore durante il caricamento dell'attività:", error);
    const statusEl = document.getElementById("logs-status");
    if (statusEl) statusEl.textContent = "Errore durante il caricamento dell'attività.";
  }
}

// ==========================================
// OPTIONAL: clear API (client)
// ==========================================
function clearAllData() {
  if (!confirm("Pulire tutto?")) return;
  fetch("/api/clear", { method: "POST" });
}
window.clearAllData = clearAllData;
