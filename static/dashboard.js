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

function getHrColor(bpm) {
  if (!Number.isFinite(bpm)) return HR_GREEN;
  if (bpm < 100) return HR_GREEN;
  if (bpm <= 140) return HR_YELLOW;
  return HR_RED;
}


// ==========================================
// SENSORI / DATI
// ==========================================
var sensors = {};

// --- TIMELINE (time-based) ---
var sessionStartTimeMs = null;
var sessionEndTimeMs = null;
var isReplayMode = false;
var lastDataTime = Date.now();
var isStreamActive = false;

var gpsSamples = []; // { t, lat, lng, acc, cumDistM, speedKmh }
var bpmSamples = []; // { t, bpm }
var lastLiveBpm = "--";

var isBulkLoading = false;
var lastValidIMU = {};

var speedBySec = [];
var secPos = [];
var lastSpeedSec = null;
var lastSecFix = null;
var lastSpeedKmh = 0;
var lastDataTimestamp = Date.now();

// ==========================================
// MAPPA
// ==========================================
var map = null;
var mapMarker = null;
var isMapInitialized = false;
var fullRouteSegments = [];   // ogni elemento: { polyline, color };

// (opzionale) stato marker animato / rotazione
var currentMapPos = null;
var targetMapPos = null;
var startMapPos = null;
var animationStartTime = null;
var animationFrameId = null;
const ANIMATION_DURATION = 700;
var allSensorSamples = {};

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
const SPEED_WINDOW_SEC = 12;
const SPEED_A_WEIGHT = 0.6
let speedWindow = [];

// ==========================================
// Calzini (pressure)
// ==========================================
var leftSockSamples = [];
// ---- SOCK CHART RENDER THROTTLE (LIVE) ----
var sockRenderScheduled = { left: false, right: false };
var sockLastX = { left: 0, right: 0 };
var rightSockSamples = [];
var sockCharts = { left: null, right: null };
var sockChartData = {
  left: [[], [], [], []],
  right: [[], [], [], []]
};
var replayCursorSec = null;
// --- MAP FOLLOW ultra-reattivo (Leaflet) ---
const MAP_FOLLOW_EPS = 1e-7;

function setMapTarget(lat, lng) {
  targetMapPos = { lat, lng };

  if (!currentMapPos) currentMapPos = { ...targetMapPos };
  if (!startMapPos) startMapPos = { ...currentMapPos };

  // reset animazione ad ogni nuovo fix (super reattivo)
  startMapPos = { ...currentMapPos };
  animationStartTime = performance.now();

  if (!animationFrameId) {
    animationFrameId = requestAnimationFrame(animateMapFollow);
  }
}

function animateMapFollow(now) {
  if (!map || !mapMarker || !targetMapPos) {
    animationFrameId = null;
    return;
  }

  const elapsed = now - (animationStartTime ?? now);
  const t = Math.max(0, Math.min(1, elapsed / ANIMATIONDURATION));
  // ease-out (morbido ma veloce)
  const k = 1 - Math.pow(1 - t, 3);

  currentMapPos = {
    lat: startMapPos.lat + (targetMapPos.lat - startMapPos.lat) * k,
    lng: startMapPos.lng + (targetMapPos.lng - startMapPos.lng) * k,
  };

  mapMarker.setLatLng(currentMapPos);

  if (!isUserInteracting) {
    // NO panTo: setView immediato, niente animazioni accodate
    map.setView([currentMapPos.lat, currentMapPos.lng], map.getZoom(), {
      animate: false,
      noMoveStart: true,
    });
  }

  const closeEnough =
    Math.abs(currentMapPos.lat - targetMapPos.lat) < MAP_FOLLOW_EPS &&
    Math.abs(currentMapPos.lng - targetMapPos.lng) < MAP_FOLLOW_EPS;

  animationFrameId = closeEnough ? null : requestAnimationFrame(animateMapFollow);
}


function centerLinePlugin() {
  return {
    hooks: {
      draw: [
        (u) => {
          // Se NON siamo in replay, non disegnare nulla (exit early)
          if (!isReplayMode || replayCursorSec == null) return;

          const ctx = u.ctx;
          const xVal = replayCursorSec;
          const x = u.valToPos(xVal, "x", true);

          ctx.save();
          ctx.strokeStyle = "rgba(151,201,62,0.9)";
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 6]);
          ctx.beginPath();
          ctx.moveTo(x, u.bbox.top);
          ctx.lineTo(x, u.bbox.top + u.bbox.height);
          ctx.stroke();
          ctx.restore();
        }
      ]
    }
  };
}


// ==========================================
// BPM -> colore traccia
// ==========================================
const HR_GREEN  = "#00c853";  // < 100
const HR_YELLOW = "#ffeb3b";  // 100..140
const HR_RED    = "#ff5252";  // > 140

function getHrColor(bpm) {
  if (!Number.isFinite(bpm)) return HR_GREEN;
  if (bpm < 100) return HR_GREEN;
  if (bpm <= 140) return HR_YELLOW;
  return HR_RED;
}

// ==========================================
// FULL route (sempre tutta): segmenti colorati
// ==========================================
var fullRouteSegments = [];   // array di L.Polyline
var fullActiveSeg = null;
var fullActiveColor = null;

// ==========================================
// PROGRESS route (fino al tempo): segmenti colorati
// ==========================================
var progressRouteSegments = []; // array di L.Polyline
var progActiveSeg = null;
var progActiveColor = null;

function clearSegs(arr) {
  if (!map) return;
  (arr || []).forEach(seg => map.removeLayer(seg));
}

function clearFullRouteSegments() {
  clearSegs(fullRouteSegments);
  fullRouteSegments = [];
  fullActiveSeg = null;
  fullActiveColor = null;
}

function clearProgressRouteSegments() {
  clearSegs(progressRouteSegments);
  progressRouteSegments = [];
  progActiveSeg = null;
  progActiveColor = null;
}

// helper comune: crea/estende segmenti contigui dello stesso colore
function appendColoredSegment(state, a, b, weight, opacity) {
  if (!map || !a || !b) return;

  const midT = (a.t + b.t) / 2;
  const bpm = getBpmAtTime(midT);           // già presente nel file
  const color = getHrColor(bpm);

  if (!state.activeSeg || state.activeColor !== color) {
    state.activeColor = color;
    state.activeSeg = L.polyline([[a.lat, a.lng], [b.lat, b.lng]], {
      pane: "routePane",
      color,
      weight,
      opacity,
      lineJoin: "round",
      lineCap: "round",
    }).addTo(map);
    state.segments.push(state.activeSeg);
  } else {
    state.activeSeg.addLatLng([b.lat, b.lng]);
  }
}

function addFullColoredBetween(a, b) {
  appendColoredSegment(
    { segments: fullRouteSegments, activeSeg: fullActiveSeg, activeColor: fullActiveColor },
    a, b, 4, 0.45
  );
  // sync back
  fullActiveSeg = fullRouteSegments.length ? fullRouteSegments[fullRouteSegments.length - 1] : null;
  fullActiveColor = fullActiveSeg ? fullActiveSeg.options.color : null;
}

function addProgressColoredBetween(a, b) {
  appendColoredSegment(
    { segments: progressRouteSegments, activeSeg: progActiveSeg, activeColor: progActiveColor },
    a, b, 7, 0.95
  );
  // sync back
  progActiveSeg = progressRouteSegments.length ? progressRouteSegments[progressRouteSegments.length - 1] : null;
  progActiveColor = progActiveSeg ? progActiveSeg.options.color : null;
}

// Ricostruisce FULL route UNA volta (replay load) o incrementale (live)
function rebuildColoredFullRouteFromGpsSamples(minStepM = 0) {
  clearFullRouteSegments();
  if (!map || !gpsSamples || gpsSamples.length < 2) return;

  let prev = gpsSamples[0];
  for (let i = 1; i < gpsSamples.length; i++) {
    const cur = gpsSamples[i];
    if (minStepM > 0) {
      const dm = haversineMeters(prev.lat, prev.lng, cur.lat, cur.lng);
      if (!isFinite(dm) || dm < minStepM) continue;
    }
    addFullColoredBetween(prev, cur);
    prev = cur;
  }
}

// Ricostruisce PROGRESS route ogni seek (fino a tMs)
function rebuildColoredProgressRouteToTime(tMs, minStepM = 0) {
  clearProgressRouteSegments();
  if (!map || !gpsSamples || gpsSamples.length < 2) return;

  let idx = upperBoundByTime(gpsSamples, tMs); // già presente nel file
  idx = clamp(idx, 0, gpsSamples.length);

  if (idx <= 1) return;

  let prev = gpsSamples[0];

  // segmenti fino all'ultimo punto <= tMs
  for (let i = 1; i < idx; i++) {
    const cur = gpsSamples[i];
    if (minStepM > 0) {
      const dm = haversineMeters(prev.lat, prev.lng, cur.lat, cur.lng);
      if (!isFinite(dm) || dm < minStepM) continue;
    }
    addProgressColoredBetween(prev, cur);
    prev = cur;
  }

  // aggiungi punto interpolato finale a tMs (così la progress arriva “precisa” al tempo slider)
  if (idx < gpsSamples.length) {
    const interp = getInterpolatedGpsAtTime(tMs); // già presente nel file
    if (interp) {
      const pseudo = { t: tMs, lat: interp.lat, lng: interp.lng };
      const dm = haversineMeters(prev.lat, prev.lng, pseudo.lat, pseudo.lng);
      if (!minStepM || (isFinite(dm) && dm >= minStepM)) {
        addProgressColoredBetween(prev, pseudo);
      }
    }
  }
}



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

  setInterval(() => {
    if (!isReplayMode && sessionStartTimeMs) {
      updateReplayUiBounds();
    }
  }, 1000);

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

function ensureProfileHeaderUI() {
  // prova a trovare un contenitore header “ragionevole”
  const header =
    document.querySelector(".dashboard-info") ||
    document.querySelector(".dashboard-header") ||
    document.body;

  if (!header) return;

  // se già esiste, fine
  if (document.getElementById("profile-name-header")) return;

  // trova il logo e inserisci subito dopo
  const logo =
    header.querySelector('img[src*="logoClean"]') ||
    header.querySelector("img");

  const wrap = document.createElement("div");
  wrap.id = "profile-header";
  wrap.style.cssText =
    "display:flex;flex-direction:column;gap:2px;line-height:1.05;min-width:160px;margin-left:10px;";

  wrap.innerHTML = `
    <div id="profile-name-header" style="font-size:16px;font-weight:900;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">--</div>
    <div id="profile-meta-header" style="font-size:11px;font-weight:800;letter-spacing:0.6px;color:#97c93e;opacity:0.95;">Peso -- kg • Età --</div>
  `;

  if (logo && logo.parentNode) logo.insertAdjacentElement("afterend", wrap);
  else header.appendChild(wrap);
}

function updateProfileUI(data) {
  ensureProfileHeaderUI();

  const nameEl = document.getElementById("profile-name-header");
  const metaEl = document.getElementById("profile-meta-header");
  if (!nameEl || !metaEl) return;

  if (!data || typeof data !== "object") return;

  const name =
    data.name ?? data.user_name ?? data.username ?? data.user ?? data.athlete ?? data.nome ?? "--";

  const weightRaw =
    data.weightKg ?? data.weight ?? data.peso_kg ?? data.peso;

  const ageRaw =
    data.age ?? data.eta ?? data["età"];

  const w = Number(weightRaw);
  const a = Number(ageRaw);

  nameEl.textContent = String(name || "--");
  metaEl.textContent = `Peso ${Number.isFinite(w) ? Math.round(w) : "--"} kg • Età ${Number.isFinite(a) ? Math.round(a) : "--"}`;
}

// Sostituisci il placeholder che hai già:
let lastProfile = { name: "--", weightKg: null, age: null };

function updateProfileHeaderUI(p) {
  const nameEl = document.getElementById("profile-name-header");
  const metaEl = document.getElementById("profile-meta-header");
  if (!nameEl || !metaEl) return;

  const name = (p && p.name) ? String(p.name) : "--";
  const w = (p && Number.isFinite(p.weightKg)) ? `${Math.round(p.weightKg)} kg` : "-- kg";
  const a = (p && Number.isFinite(p.age)) ? `${Math.round(p.age)}` : "--";

  nameEl.textContent = name;
  metaEl.textContent = `Peso ${w} • Età ${a}`;
}


// ==========================================
// SOCKET
// ==========================================
function initSocket() {
  socket.on("connect", () => {
    isStreamActive = true;
    lastDataTime = Date.now();
    var el = document.getElementById("connection-status");
    if (el) {
      el.className = "";
      el.innerHTML = '<span class="dot"></span> Connesso';
    }
  });

  socket.on("disconnect", () => {
    isStreamActive = false;
    var el = document.getElementById("connection-status");
    if (el) {
      el.className = "disconnected";
      el.innerHTML = '<span class="dot"></span> Disconnesso';
    }
  });

  socket.on("sensorupdate", (data) => processIncomingData(data));
  socket.on("bpmupdate", (val) => onBpmUpdate(val));
  socket.on("profileupdate", (data) => updateProfileUI(data));
  socket.on("gpsupdate", (data) => onGpsUpdate(data, { updateUi: true, updateMap: true }));

  socket.on("datacleared", () => {
    isReplayMode = false;
    showReplayOverlayIfReady();
    leftSockSamples = [];
    rightSockSamples = [];
    sockChartData.left  = [[], [], [], []];
    sockChartData.right = [[], [], [], []];
    sockLastX = { left: 0, right: 0 };

    if (sockCharts.left)  sockCharts.left.setData(sockChartData.left);
    if (sockCharts.right) sockCharts.right.setData(sockChartData.right);
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
  if (!sessionStartTimeMs) return Date.now();

  // Se lo stop tracking ha fissato una fine sessione, congela lì (LIVE fermo)
  if (!isReplayMode && sessionEndTimeMs != null) return sessionEndTimeMs;

  // Replay: finisce sull'ultimo campione registrato
  if (isReplayMode) {
    if (!gpsSamples.length) return sessionEndTimeMs || sessionStartTimeMs;
    return gpsSamples[gpsSamples.length - 1].t;
  }

  // Live attivo: fino ad adesso
  return Date.now();
}

function getDurationSec() {
  if (!sessionStartTimeMs) return 0;
  
  let endMs;

  if (isReplayMode) {
    // REPLAY: durata fissa fino alla fine dei campioni
    endMs = gpsSamples.length ? gpsSamples[gpsSamples.length - 1].t : sessionStartTimeMs;
  } else {
    // LIVE: controlla se lo stream è attivo
    const now = Date.now();
    // Se non arrivano dati da > 5 secondi, consideriamo l'attività FERMA
    if (typeof lastDataTimestamp !== 'undefined' && (now - lastDataTimestamp) > 3000) {
      // Stream fermo -> Blocca il tempo sull'ultimo dato GPS disponibile
      // NON resetta a 0, ma mantiene il valore raggiunto (es. 10:23)
      endMs = gpsSamples.length ? gpsSamples[gpsSamples.length - 1].t : sessionStartTimeMs;
    } else {
      // Stream attivo -> Il tempo scorre fluido
      endMs = now;
    }
  }
  
  return Math.max(0, (endMs - sessionStartTimeMs) / 1000);
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
function onBpmUpdate(payload) {
  let bpmInt = null;
  let tMs = null;

  // nuovo formato dal server: { bpm, t }
  if (payload && typeof payload === "object") {
    bpmInt = parseInt(payload.bpm, 10);
    tMs = Number(payload.t);
  } else {
    // fallback vecchio formato: numero secco
    bpmInt = parseInt(payload, 10);
    tMs = getNowMs();
  }

  if (!Number.isFinite(bpmInt) || bpmInt <= 0) return;
  if (!Number.isFinite(tMs)) tMs = getNowMs();

  ensureSessionStart(tMs);

  lastLiveBpm = bpmInt;
  bpmSamples.push({ t: tMs, bpm: bpmInt });

  if (!isReplayMode) updateBpmValue(bpmInt);

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

function onGpsUpdate(data, opts) {
  lastDataTimestamp = Date.now();
  opts = opts || { updateUi: true, updateMap: true };
  if (!data) return;

  const lat = Number(data.latitude ?? data.lat);
  const lng = Number(data.longitude ?? data.lng ?? data.lon);
  const acc = Number(data.accuracy ?? data.acc ?? data.hdop ?? 999);


  let tMs = null;
  if (data.t != null) tMs = Number(data.t);
  else if (data.timestamp) tMs = new Date(data.timestamp).getTime();
  else tMs = Date.now();

  if (!isFinite(lat) || !isFinite(lng) || lat === 0 || lng === 0) return;
  if (!isFinite(tMs)) return;

  ensureSessionStart(tMs);

  const prevSample = gpsSamples.length ? gpsSamples[gpsSamples.length - 1] : null;

  if (!prevSample) {
    gpsSamples.push({ t: tMs, lat, lng, acc, cumDistM: 0, speedKmh: 0 });
    if (!isBulkLoading) ensureMapInitialized(lat, lng);

    if (!isReplayMode && opts.updateUi) updateSpeedDistanceUI(0, 0);
    updateReplayUiBounds();
    showReplayOverlayIfReady();
    return;
  }

  const dtSecRaw = (tMs - prevSample.t) / 1000;
  const dtSec = clamp(dtSecRaw, GPS_MIN_DT_S, GPS_MAX_DT_S);
  const stepM = haversineMeters(prevSample.lat, prevSample.lng, lat, lng);

  let usedStepM = 0;
  let speedKmh = 0;

  const goodFix = dtSecRaw >= GPS_MIN_DT_S && dtSecRaw <= 5.0 && acc <= GPS_MAX_ACCURACY_FOR_DIST_M;
  const prevSpeed = prevSample.speedKmh ?? 0;

  if (goodFix) {
    if (stepM < GPS_MIN_STEP_M) {
      usedStepM = 0;
      speedKmh = prevSpeed * 0.85;
      if (speedKmh < 0.3) speedKmh = 0;
    } else {
      usedStepM = stepM;
      const instantSpeed = (stepM / dtSec) * 3.6;
      speedKmh = prevSpeed * 0.7 + instantSpeed * 0.3;
      if (!isFinite(speedKmh)) speedKmh = 0;
      speedKmh = Math.min(Math.max(0, speedKmh), MAX_SPEED_KMH);
    }
  } else {
    speedKmh = prevSpeed;
  }


  const newCumDistM = (prevSample.cumDistM ?? 0) + usedStepM;
  const newSample = { t: tMs, lat, lng, acc, cumDistM: newCumDistM, speedKmh };
  gpsSamples.push(newSample);

  // aggiorna finestra B
  speedWindow.push({ t: newSample.t, cumDistM: newSample.cumDistM });
  const tMin = newSample.t - SPEED_WINDOW_SEC * 1000;
  while (speedWindow.length > 2 && speedWindow[0].t < tMin) speedWindow.shift();

  let speedB = newSample.speedKmh; // fallback
  if (speedWindow.length >= 2) {
    const first = speedWindow[0];
    const dtB = (newSample.t - first.t) / 1000;
    const dB = newSample.cumDistM - first.cumDistM;
    if (dtB > 0.5 && dB >= 0) speedB = (dB / dtB) * 3.6;
  }

  // combina A+B
  let speedFinal = SPEED_A_WEIGHT * newSample.speedKmh + (1 - SPEED_A_WEIGHT) * speedB;
  speedFinal = Math.min(Math.max(0, speedFinal), MAX_SPEED_KMH);

  newSample.speedKmh = speedFinal; // sovrascrivi per UI+replay coerenti


  if (isBulkLoading) return;

  if (!isReplayMode && opts.updateUi) updateSpeedDistanceUI(newSample.speedKmh, newCumDistM);

  if (opts.updateMap && map && mapMarker) {
    setMapTarget(lat, lng);

    // FULL route (sottile) colorata BPM
    addFullColoredBetween(prevSample, newSample);

    // PROGRESS (spessa) colorata BPM - in live coincide col "fino ad ora"
    if (!isReplayMode) addProgressColoredBetween(prevSample, newSample);

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

  map = L.map("map", { attributionControl: false, zoomControl: true }).setView([lat, lng], 19);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", {
    maxZoom: 20,
  }).addTo(map);

  map.createPane("routePane");
  map.getPane("routePane").style.zIndex = 450;

  map.createPane("markerPane");
  map.getPane("markerPane").style.zIndex = 650;

  const pulseIcon = L.divIcon({
    className: "custom-div-icon",
    html: '<div class="pulsating-marker"></div>',
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });

  mapMarker = L.marker([lat, lng], { icon: pulseIcon, pane: "markerPane" }).addTo(map);

  createReplayOverlayControls();
  createRotateControl();
  ensureMetricsCardsUI();

  isMapInitialized = true;
  setTimeout(() => map.invalidateSize(), 120);
}


function pushMapPoint(lat, lng) {
  if (!map || !mapMarker) return;

  const pos = [lat, lng];
  mapMarker.setLatLng(pos);
  if (!isUserInteracting) map.panTo(pos);
}

//Rotazione mappa rimossa perché non nativamente supportata da leaflet

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

  // 1. OVERLAY "TIME" + SLIDER (Sinistra)
  if (!document.getElementById("replay-overlay")) {
    var overlay = document.createElement("div");
    overlay.id = "replay-overlay";
    overlay.style.cssText = `
      position: absolute;
      left: 16px;
      right: 16px; /* Occupa tutta la larghezza meno i margini */
      bottom: 24px;
      z-index: 30000;
      display: none;
      align-items: center;
      gap: 12px;
      padding: 8px 14px;
      border-radius: 12px;
      background: rgba(10,10,10,0.85);
      border: 1px solid rgba(255,255,255,0.15);
      backdrop-filter: blur(6px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
      height: 44px;
      box-sizing: border-box;
    `;

    overlay.innerHTML = `
      <div style="display:flex;flex-direction:column;justify-content:center;gap:0px;min-width:50px;">
        <div style="font-size:9px;letter-spacing:1px;color:#9aa;font-weight:700;line-height:1.1">TIME</div>
        <div id="replay-time-label" style="font-family:monospace;font-size:16px;color:#fff;font-weight:700;line-height:1.1">00:00</div>
      </div>
      <!-- Slider: prende tutto lo spazio rimanente -->
      <input id="replay-slider" type="range" min="0" max="0" value="0" step="0.1"
             style="display:none; flex:1; accent-color:#97c93e; cursor:pointer; margin:0; height:100%;" />
    `;
    
    // Blocca click sulla mappa sotto l'overlay
    if (window.L && L.DomEvent) {
      L.DomEvent.disableClickPropagation(overlay);
      L.DomEvent.disableScrollPropagation(overlay);
    }
    mapDiv.appendChild(overlay);

    // -- LOGICA SLIDER FLUIDO --
    var slider = document.getElementById("replay-slider");
    
    // Funzione che aggiorna tutto istantaneamente
    function onSliderInput() {
      const sec = parseFloat(slider.value) || 0;
      // Chiama la funzione di aggiornamento replay (senza ricaricare tutto se non serve)
      enterReplayAtSecond(sec); 
      // Aggiorna label tempo manualmente per reattività immediata
      updateReplayTimeLabel(sec);
    }

    // "input" scatta continuamente mentre trascini -> FLUIDITÀ
    slider.addEventListener("input", onSliderInput);

    // Gestione interazioni mappa (blocca pan/zoom mentre trascini lo slider)
    function lockMap(lock) {
      if (!map) return;
      if (lock) {
        map.dragging.disable();
        map.scrollWheelZoom.disable();
      } else {
        map.dragging.enable();
        map.scrollWheelZoom.enable();
      }
    }

    slider.addEventListener("mousedown", () => lockMap(true));
    slider.addEventListener("touchstart", () => lockMap(true), {passive: true});
    
    slider.addEventListener("mouseup", () => lockMap(false));
    slider.addEventListener("touchend", () => lockMap(false));
  }

  // 2. BOTTONE LIVE (Destra)
  if (!document.getElementById('btn-live')) {
      var btnLive = document.createElement('div');
      btnLive.id = 'btn-live';
      btnLive.innerHTML = `
          <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#ff0000; margin-right:6px;"></span>
          <span style="color:#000000; font-weight:900; font-size:13px; letter-spacing:0.8px;">LIVE</span>
      `;
      btnLive.style.cssText = `
          position: absolute;
          right: 16px;
          bottom: 28px;
          z-index: 30001;
          display: none;
          align-items: center;
          padding: 6px 12px;
          background: #97c93e;
          border: 1px solid rgba(0,0,0,0.2);
          border-radius: 20px;
          cursor: default;
          pointer-events: none;
          box-shadow: 0 4px 10px rgba(0,0,0,0.3);
      `;
      mapDiv.appendChild(btnLive);
  }


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
  const overlay = document.getElementById("replay-overlay");
  const slider = document.getElementById("replay-slider");
  const btnLive = document.getElementById("btn-live");
  const liveInd = document.getElementById('live-indicator');
  
  if (!overlay || !slider || !btnLive) return;

  const hasSession = (typeof sessionStartTimeMs !== 'undefined' && sessionStartTimeMs != null && gpsSamples.length > 0);
  
  if (hasSession) {
    overlay.style.display = "flex";

    if (isReplayMode) {
      // --- REPLAY MODE ---
      // Slider visibile e attivo
      if (liveInd) liveInd.style.display = 'none';
      slider.style.display = "block";
      slider.disabled = false;
      
      // Overlay prende quasi tutta la larghezza (o adatta i margini come preferisci)
      overlay.style.right = "16px"; 
      
      // NASCONDI IL TASTO LIVE (richiesta utente)
      btnLive.style.display = "none";
      
    } else {
      // --- LIVE MODE ---
      // Slider nascosto
      if (liveInd) liveInd.style.display = 'flex';
      slider.style.display = "none";
      slider.disabled = true;
      
      // Overlay ridotto al solo tempo
      overlay.style.right = "auto"; 
      
      // MOSTRA IL TASTO LIVE (solo indicatore)
      btnLive.style.display = "flex";
      btnLive.style.cursor = "default";
      btnLive.style.background = "#97c93e";
      btnLive.style.color = "#000";
    }
  } else {
    if(liveInd) liveInd.style.display = 'none';
    overlay.style.display = "none";
    btnLive.style.display = "none";
  }
}

function updateReplayUiBounds() {
  var slider = document.getElementById("replay-slider");
  if (!slider) return;

  var maxSec = getDurationSec();
  
  // Aggiorna limiti slider
  slider.max = String(maxSec);
  slider.step = "0.1";

  // Se siamo in LIVE, il cursore (virtuale) è alla fine
  if (!isReplayMode) {
    slider.value = maxSec.toFixed(1);
    updateReplayTimeLabel(maxSec);
    
    // Aggiorna visibilità (ad es. per mostrare che siamo LIVE)
    showReplayOverlayIfReady();
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

function lastSockSec(side) {
  const arr = sockChartData[side]?.[0] || [];
  return arr.length ? arr[arr.length - 1] : 0;
}

function setSockWindow(u, centerSec, halfWin, maxSec) {
  const win = halfWin * 2;
  const min = Math.max(0, Math.min(centerSec - halfWin, Math.max(0, maxSec - win)));
  const max = min + win;
  u.setScale("x", { min, max });
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
  // downsample 2m per non ammazzare il browser durante lo scrubbing
  rebuildColoredProgressRouteToTime(tMs, 2.0);
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
  
  // Attiva modalità replay
  isReplayMode = true;

  // Ferma animazioni live marker se presenti
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  // --- 1. Calcola il tempo assoluto (timestamp) del cursore ---
  const durationSec = getDurationSec();
  const clampedSec = Math.max(0, Math.min(sec, durationSec));
  const tMs = sessionStartTimeMs + (clampedSec * 1000);

  // --- 2. Aggiorna UI Tempo e Slider ---
  updateReplayTimeLabel(clampedSec);
  replayCursorSec = clampedSec; // Serve per la linea verticale sui grafici

  // --- 3. Sincronizza Mappa e Percorso ---
  const pos = getInterpolatedGpsAtTime(tMs);
  if (pos) {
    if (!mapMarker) { 
       // Init marker se non c'è (raro)
    } else { 
       mapMarker.setLatLng([pos.lat, pos.lng]); 
    }
    
    if (map) map.panTo([pos.lat, pos.lng], { animate: false });
    currentMapPos = { lat: pos.lat, lng: pos.lng }; 
  }
  updateProgressRouteToTime(tMs);

  // --- 4. Sincronizza Metriche (BPM, Speed, Dist) ---
  const bpm = getBpmAtTime(tMs);
  if (bpm != null) updateBpmValue(bpm);

  const dist = getDistanceAtTime(tMs);
  const wholeSec = Math.floor(clampedSec);
  const speed = getSpeedAtTime(tMs);
  updateSpeedDistanceUI(speed, dist);

  // --- 5. AGGIORNAMENTO DATI RAW SENSORI (Sync Replay) ---
  const sampleL = findSampleAtTime(leftSockSamples, tMs);
  if (sampleL) {
    // Calcola BI medio su finestra 1500ms
    const biLavg = avgBiInWindow(leftSockSamples, tMs, BI_AVG_WINDOW_MS);
    // Grafico BI+Pressioni
    updateSocksUI('left', { p0: sampleL.p0, p1: sampleL.p1, p2: sampleL.p2 }, biLavg);
    // Dati RAW (Accel, Gyro, Mag)
    updateSensorCardUI(sampleL.sensorname || 'Calzino SX', sampleL);
  }

  const sampleR = findSampleAtTime(rightSockSamples, tMs);
  if (sampleR) {
    // Calcola BI medio su finestra 1500ms
    const biRavg = avgBiInWindow(rightSockSamples, tMs, BI_AVG_WINDOW_MS);
    updateSocksUI('right', { p0: sampleR.p0, p1: sampleR.p1, p2: sampleR.p2 }, biRavg);
    updateSensorCardUI(sampleR.sensorname || 'Calzino DX', sampleR);
  }


  // --- AGGIORNAMENTO GLOBALE SENSORI ---
  if (typeof allSensorSamples !== 'undefined') {
      for (const [sName, samples] of Object.entries(allSensorSamples)) {
          // Trova il sample più vicino a tMs
          const s = findSampleAtTime(samples, tMs);
          if (s) {
              // Aggiorna la card UI (Ax, Ay, Gx...)
              updateSensorCardUI(sName, s);
          }
      }
  }


  // --- 6. Aggiorna Grafici (Zoom/Pan e Linea verticale) ---
  // Hack per forzare redraw cursore
  if (sockCharts.left) sockCharts.left.setCursor({left: -10, top: -10});
  if (sockCharts.right) sockCharts.right.setCursor({left: -10, top: -10});
  
  // ✅ FINESTRA ADATTIVA PER GRAFICI PRESSIONI
  const WINDOW_SEC = 5; // Larghezza finestra (secondi)
  
  // Calcola la durata totale dei dati disponibili
  const maxDataSec = getDurationSec(); // Funzione già presente nel tuo file
  
  let minX, maxX;
  
  if (maxDataSec <= WINDOW_SEC) {
      // Se la durata totale è minore della finestra, mostra tutto
      minX = 0;
      maxX = maxDataSec;
  } else {
      // Finestra scorrevole intelligente
      const halfWin = WINDOW_SEC / 2;
      
      if (clampedSec < halfWin) {
          // INIZIO: Mostra da 0 fino a WINDOW_SEC
          minX = 0;
          maxX = WINDOW_SEC;
      } else if (clampedSec > maxDataSec - halfWin) {
          // FINE: Mostra ultimi WINDOW_SEC secondi
          minX = Math.max(0, maxDataSec - WINDOW_SEC);
          maxX = maxDataSec;
      } else {
          // CENTRO: Finestra centrata sul cursore
          minX = clampedSec - halfWin;
          maxX = clampedSec + halfWin;
      }
  }
  
  // Applica la finestra ai grafici
  if (sockCharts.left) {
      sockCharts.left.setScale('x', {min: minX, max: maxX});
  }
  if (sockCharts.right) {
      sockCharts.right.setScale('x', {min: minX, max: maxX});
  }
}


function goLive() {
  // 1) esci dalla modalità replay
  isReplayMode = false;
  replayCursorSec = null;

  // 2) aggiorna slider (ora updateReplayUiBounds vede isReplayMode=false
  updateReplayUiBounds();

  // 3) route progressiva e mappa
  clearProgressRouteSegments();
  rebuildColoredProgressRouteToTime(getSessionEndMs(), 2.0);

  // 4) grafici calzini: finestra ultimi 4s
  ["left", "right"].forEach(side => {
    const ch = sockCharts[side];
    const d  = sockChartData[side];
    if (!ch || !d || !d[0]?.length) return;

    const WINSEC = 4;
    const xMax = d[0][d[0].length - 1];
    const xMin = Math.max(0, xMax - WINSEC);
    ch.setScale("x", { min: xMin, max: xMax + 0.1 });
    ch.redraw();
  });

  // 5) metriche live (speed, dist, bpm)
  if (gpsSamples.length) {
    var lastG = gpsSamples[gpsSamples.length - 1];
    updateSpeedDistanceUI(lastG.speedKmh, lastG.cumDistM);
    if (mapMarker) mapMarker.setLatLng([lastG.lat, lastG.lng]);
    if (map) map.panTo([lastG.lat, lastG.lng], { animate: false });
    updateProgressRouteToTime(getSessionEndMs());
  }
  if (lastLiveBpm !== "--") updateBpmValue(lastLiveBpm);
}


function normalizeLivePayload(p) {
  if (!p || typeof p !== "object") return null;
  const o = { ...p };

  // Nome sensore (supporta anche sensor_name come nei log)
  o.sensorname = o.sensorname ?? o.sensorName ?? o.sensor_name ?? o.name ?? null;

  // IMU (supporta accel_x ecc)
  o.accelx = o.accelx ?? o.accelX ?? o.accel_x;
  o.accely = o.accely ?? o.accelY ?? o.accel_y;
  o.accelz = o.accelz ?? o.accelZ ?? o.accel_z;

  o.gyrox = o.gyrox ?? o.gyroX ?? o.gyro_x;
  o.gyroy = o.gyroy ?? o.gyroY ?? o.gyro_y;
  o.gyroz = o.gyroz ?? o.gyroZ ?? o.gyro_z;

  o.magx = o.magx ?? o.magX ?? o.mag_x;
  o.magy = o.magy ?? o.magY ?? o.mag_y;
  o.magz = o.magz ?? o.magZ ?? o.mag_z;

  // Pressioni (supporta pressure_0 ecc)
  o.pressure0 = o.pressure0 ?? o.pressure_0 ?? o.p0;
  o.pressure1 = o.pressure1 ?? o.pressure_1 ?? o.p1;
  o.pressure2 = o.pressure2 ?? o.pressure_2 ?? o.p2;

  return o;
}

// --- HELPER FILTRO SEGNALE ---
function filterVal(newVal, oldVal, maxDelta) {
  if (!Number.isFinite(oldVal)) return newVal;
  if (!Number.isFinite(newVal)) return oldVal;
  
  const delta = Math.abs(newVal - oldVal);
  if (delta > maxDelta) {
    // Se il salto è troppo grande (es. errore di trasmissione), mantieni il vecchio valore
    // oppure limita la variazione (clamping). Qui usiamo un clamping semplice.
    if (newVal > oldVal) return oldVal + maxDelta;
    else return oldVal - maxDelta;
  }
  return newVal;
}


// ==========================================
// SENSOR UPDATE (parsing calzini)

function processIncomingData(data) {
  lastDataTimestamp = Date.now();
  lastDataTime = Date.now();
  isStreamActive = true;

  // 0. Unwrap: a volte arriva {sensorname: "...",  {...}}
  let payload = data;
  if (typeof data === 'object' && data.data && typeof data.data === 'object') {
    payload = data.data; // unwrap
  }
  if (!payload || typeof payload !== 'object') return;

  // 1. Trova nome sensore
  const outerName = (typeof data === 'object') ? (data.sensorname ?? data.sensorName ?? data.name) : null;
  const sensorName = String(payload.sensorname ?? payload.sensorName ?? payload.name ?? outerName ?? "").trim();
  if (!sensorName) return;

  // 2. Normalizza campi in un oggetto unico
  const p = { ...payload, sensorname: sensorName, name: sensorName };
  
  // Timestamp: non forziamo conversioni qui, il resto del codice usa Date.now() se manca
  p.timestamp = p.timestamp ?? p.ts ?? p.time ?? p.t;

  // --- IMU: normalizzazione base ---
  let ax = p.accelx ?? p.accelx ?? p.accelX ?? p.AccelX;
  let ay = p.accely ?? p.accely ?? p.accelY ?? p.AccelY;
  let az = p.accelz ?? p.accelz ?? p.accelZ ?? p.AccelZ;
  
  let gx = p.gyrox ?? p.gyrox ?? p.gyroX ?? p.GyroX;
  let gy = p.gyroy ?? p.gyroy ?? p.gyroY ?? p.GyroY;
  let gz = p.gyroz ?? p.gyroz ?? p.gyroZ ?? p.GyroZ;
  
  let mx = p.magx ?? p.magx ?? p.magX ?? p.MagX;
  let my = p.magy ?? p.magy ?? p.magY ?? p.MagY;
  let mz = p.magz ?? p.magz ?? p.magZ ?? p.MagZ;

  // FILTRO DELTA (ANTI-SPIKE) - Opzionale ma consigliato
  if (!lastValidIMU[sensorName]) {
    lastValidIMU[sensorName] = { ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0, mx: 0, my: 0, mz: 0 };
  }
  const last = lastValidIMU[sensorName];
  const MAX_DELTA_ACCEL = 500; 
  const MAX_DELTA_GYRO = 800;
  const MAX_DELTA_MAG = 500;

  p.accelx = last.ax = filterVal(ax, last.ax, MAX_DELTA_ACCEL);
  p.accely = last.ay = filterVal(ay, last.ay, MAX_DELTA_ACCEL);
  p.accelz = last.az = filterVal(az, last.az, MAX_DELTA_ACCEL);
  
  p.gyrox = last.gx = filterVal(gx, last.gx, MAX_DELTA_GYRO);
  p.gyroy = last.gy = filterVal(gy, last.gy, MAX_DELTA_GYRO);
  p.gyroz = last.gz = filterVal(gz, last.gz, MAX_DELTA_GYRO);
  
  p.magx = last.mx = filterVal(mx, last.mx, MAX_DELTA_MAG);
  p.magy = last.my = filterVal(my, last.my, MAX_DELTA_MAG);
  p.magz = last.mz = filterVal(mz, last.mz, MAX_DELTA_MAG);

  // --- Pressioni ---
  p.pressure0 = p.pressure0 ?? p.pressure0 ?? p.p0;
  p.pressure1 = p.pressure1 ?? p.pressure1 ?? p.p1;
  p.pressure2 = p.pressure2 ?? p.pressure2 ?? p.p2;
  // Alias p0/p1/p2
  p.p0 = p.p0 ?? p.pressure0;
  p.p1 = p.p1 ?? p.pressure1;
  p.p2 = p.p2 ?? p.pressure2;

  // 3. Timeline
  const tMs = getNowMs();
  ensureSessionStart(tMs);

  // 4. Calzini: aggiorna UI grafico mini + BI + RAW
  const nameLower = sensorName.toLowerCase();
  const isSock = nameLower.includes("calzino") || nameLower.includes("sock");
  const isLeft = nameLower.includes("sx") || nameLower.includes("left");
  const isRight = nameLower.includes("dx") || nameLower.includes("right");

  if (isSock && (isLeft || isRight)) {
    const v0 = Number(p.pressure0);
    const v1 = Number(p.pressure1);
    const v2 = Number(p.pressure2);
    
    const p0 = Number.isFinite(v0) ? v0 : 0;
    const p1 = Number.isFinite(v1) ? v1 : 0;
    const p2 = Number.isFinite(v2) ? v2 : 0;

    const bi = calculateBI(p);
    
    // Oggetto COMPLETO da salvare per il Replay
    const fullSample = {
      t: tMs,
      p0: p0, p1: p1, p2: p2,
      bi: bi,
      // Dati Raw Normalizzati
      accelx: p.accelx, accely: p.accely, accelz: p.accelz,
      gyrox: p.gyrox, gyroy: p.gyroy, gyroz: p.gyroz,
      magx: p.magx, magy: p.magy, magz: p.magz,
      // Dati originali (utile per debug o altri campi)
      sensorname: sensorName,
      ...p
    };

    if (isLeft) {
      leftSockSamples.push(fullSample);
      if (!isReplayMode) {
        // LIVE UI: calcola BI medio su finestra 1500ms
        const biAvg = avgBiInWindow(leftSockSamples, tMs, BI_AVG_WINDOW_MS);
        updateSocksUI('left', { p0, p1, p2 }, biAvg);
      }
    } else if (isRight) {
      rightSockSamples.push(fullSample);
      if (!isReplayMode) {
        // LIVE UI: calcola BI medio su finestra 1500ms
        const biAvg = avgBiInWindow(rightSockSamples, tMs, BI_AVG_WINDOW_MS);
        updateSocksUI('right', { p0, p1, p2 }, biAvg);
      }
    }

  }

  if (!isReplayMode) {
    sensors[sensorName] = p; // se serve storico globale
    updateSensorCardUI(sensorName, p); // Già chiamato sopra per i calzini
    updateChartsUI(sensorName, p); // Se usi uPlot real-time per accel/gyro
  }
}



// Quale asse considerare latero-laterale: 'x' | 'y' | 'z'
const BILATERAL_AXIS = 'z';
const BI_AVG_WINDOW_MS = 1500;

const biAgg = {
  left: { sum: 0, n: 0, last: null },
  right:{ sum: 0, n: 0, last: null }
};

let biAvgTimer = null;


function calculateBI(payload) {
  const ax = Number(payload.accelx ?? payload.ax ?? payload.accelX ?? payload.AccelX);
  const ay = Number(payload.accely ?? payload.ay ?? payload.accelY ?? payload.AccelY);
  const az = Number(payload.accelz ?? payload.az ?? payload.accelZ ?? payload.AccelZ);

  if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az)) return 0;

  const norm = Math.sqrt(ax*ax + ay*ay + az*az);
  if (!Number.isFinite(norm) || norm < 1e-6) return 0;

  const aLat = (BILATERAL_AXIS === "z") ? az : (BILATERAL_AXIS === "y") ? ay : ax;
  return Math.abs(aLat / norm) * 100;
}

function ensureSockChartSize(side) {
  const el = document.getElementById(side === "left" ? "chart-left-p" : "chart-right-p");
  const chart = sockCharts[side];
  if (!el || !chart) return;

  const w = Math.max(10, el.clientWidth || el.offsetWidth || 0);
  const h = Math.max(240, el.clientHeight || 240);

  // se uPlot è partito con width 0 o size vecchia, correggi
  chart.setSize({ width: w, height: h });
}


function initSockCharts() {
  const leftEl = document.getElementById("chart-left-p");
  const rightEl = document.getElementById("chart-right-p");
  if (!leftEl || !rightEl) return;

  const makeOpts = (container, title) => ({
    width: Math.max(container.offsetWidth, container.clientWidth),
    height: Math.max(240, container.clientHeight),
    plugins: [centerLinePlugin()],
    scales: {
      x: { time: false }, // secondi dall'inizio attività
      y: { auto: false, range: [0, 1100] }
    },
    series: [
      {},
      { label: "Lat Int",    stroke: "#ffb74d", width: 2, points: { show: false } }, // ex P0 (giallo)
      { label: "Lat Est",    stroke: "#e91e63", width: 2, points: { show: false } }, // ex P1 (rosso)
      { label: "Posteriore", stroke: "#4fc3f7", width: 2, points: { show: false } }, // ex P2 (blu)
    ],
    axes: [{ show: false }, { show: false }],
    legend: { show: false },
    cursor: { show: true, sync: { key: "socks" } }
  });

  if (!sockCharts.left) {
    sockCharts.left = new uPlot(makeOpts(leftEl, "SX"), sockChartData.left, leftEl);
  }
  if (!sockCharts.right) {
    sockCharts.right = new uPlot(makeOpts(rightEl, "DX"), sockChartData.right, rightEl);
  }
}

// --- CORREZIONE 2: Fix per grafico live che non scorre ---
function scheduleSockRender(side) {
  if (sockRenderScheduled[side]) return;
  sockRenderScheduled[side] = true;

  requestAnimationFrame(() => {
    sockRenderScheduled[side] = false;
    const chart = sockCharts[side];
    if (!chart) return;

    const d = sockChartData[side];
    ensureSockChartSize(side);
    chart.setData(d);

    // Finestra visibile in live (secondi)
    const WINSEC = 4;
    // Prendi l'ultimo X valido
    const xMax = (d[0].length > 0) ? d[0][d[0].length - 1] : 0;
    
    // Safety check: se xMax non è valido, esci
    if (!Number.isFinite(xMax)) return;

    const xMin = Math.max(0, xMax - WINSEC);
    
    // Aggiungi +0.1 a xMax per dare un po' di "respiro" al grafico a destra
    chart.setScale("x", { min: xMin, max: xMax + 0.1 });
  });
}

function updateSockNumbers(side, data, bi) {
  const prefix = (side === "left") ? "l" : "r";

  // BI
  const biEl = document.getElementById(`bi-val-${side}`);
  if (biEl && bi != null && isFinite(bi)) {
    biEl.textContent = `BI ${bi.toFixed(1)}%`;
    biEl.style.color = (bi < 40) ? "#ff4444" : SENSORIA_GREEN;
  }

  // Valori pressioni nelle label grandi
  const val0 = data.p0 ?? data.pressure0 ?? 0;
  const val1 = data.p1 ?? data.pressure1 ?? 0;
  const val2 = data.p2 ?? data.pressure2 ?? 0;

  const elPost = document.getElementById(`${prefix}-posteriore`);
  const elSin  = document.getElementById(`${prefix}-sinistra`);
  const elDes  = document.getElementById(`${prefix}-destra`);

  if (side === "left") {
    if (elPost) elPost.textContent = Math.round(val2); // posteriore = P2
    if (elSin)  elSin.textContent  = Math.round(val0); // sinistra   = P0
    if (elDes)  elDes.textContent  = Math.round(val1); // destra     = P1
  } else {
    if (elPost) elPost.textContent = Math.round(val2); // posteriore = P2
    if (elSin)  elSin.textContent  = Math.round(val1); // sinistra   = P1
    if (elDes)  elDes.textContent  = Math.round(val0); // destra     = P0
  }
}

// FUNZIONE AGGIORNATA: updateSocksUI
function updateSocksUI(side, data, bi) {
  console.log("updateSocksUI called", side, bi, data);

  // 1) Aggiorna solo numeri/BI (valido in live e replay)
  updateSockNumbers(side, data, bi);

  // 2) Se siamo in replay, STOP: non aggiornare grafico live
  if (isReplayMode) return;

  // --- Da qui in giù resta la logica del live che avevi ---
  const val0 = data.p0 ?? data.pressure0 ?? 0;
  const val1 = data.p1 ?? data.pressure1 ?? 0;
  const val2 = data.p2 ?? data.pressure2 ?? 0;

  if (!sockCharts.left && !sockCharts.right) initSockCharts();
  const chart = sockCharts[side];
  if (!chart) return;
  const d = sockChartData[side];

  let x = sessionStartTimeMs ? (Date.now() - sessionStartTimeMs) / 1000 : 0;

  // reset se il tempo torna indietro tanto (nuova sessione)
  if (x < sockLastX[side] - 1.0) {
    sockChartData[side] = [[], [], [], []];
    sockLastX[side] = 0;
    chart.setData(sockChartData[side]);
  }

  if (x < sockLastX[side] + 0.001) {
    x = sockLastX[side] + 0.001;
  }
  sockLastX[side] = x;

  const d0 = d[0];
  const lastX = d0.length ? d0[d0.length - 1] : null;
  if (lastX != null && x < lastX - 1) {
    sockChartData[side] = [[], [], [], []];
    sockLastX[side] = 0;
    chart.setData(sockChartData[side]);
  }

  const d1 = d[1], d2 = d[2], d3 = d[3];

  d0.push(x);
  d1.push(val0);
  d2.push(val1);
  d3.push(val2);

  const MAXPOINTS = 600;
  if (d0.length > MAXPOINTS) {
    const cut = d0.length - MAXPOINTS;
    [d0, d1, d2, d3].forEach(arr => arr.splice(0, cut));
  }

  chart.setData(d);
  scheduleSockRender(side);
}


// ==========================================
// SENSOR CARDS UI (minimal)
// ==========================================

function createSensorCard(name, data) {
    var grid = document.getElementById('sensors-grid');
    if (!grid) return;

    var div = document.createElement('div');
    div.className = "sensor-card sensor-col connected";
    div.setAttribute('data-sensor', name);

    // Controlla quali dati sono presenti nel primo pacchetto
    const hasAccel = (data.accelx != null || data.accel_x != null);
    const hasGyro = (data.gyrox != null || data.gyro_x != null);
    const hasMag = (data.magx != null || data.mag_x != null);
    
    // Controlla se ci sono pressioni (normalizzate o grezze)
    const p0 = data.pressure0 ?? data.pressure_0 ?? data.p0;
    const hasPressure = (p0 != null && Number.isFinite(Number(p0)));

    let rows = '';

    if (hasAccel) {
        rows += `
          <div class="sensor-data-row"><span class="sensor-data-label">Acc<span style="color:#97c93e;">X</span></span><span class="sensor-value" data-key="accelx">--</span></div>
          <div class="sensor-data-row"><span class="sensor-data-label">Acc<span style="color:#97c93e;">Y</span></span><span class="sensor-value" data-key="accely">--</span></div>
          <div class="sensor-data-row"><span class="sensor-data-label">Acc<span style="color:#97c93e;">Z</span></span><span class="sensor-value" data-key="accelz">--</span></div>
        `;
    }

    if (hasGyro) {
        rows += `
          <div class="sensor-data-row"><span class="sensor-data-label">Gyr<span style="color:#97c93e;">X</span></span><span class="sensor-value" data-key="gyrox">--</span></div>
          <div class="sensor-data-row"><span class="sensor-data-label">Gyr<span style="color:#97c93e;">Y</span></span><span class="sensor-value" data-key="gyroy">--</span></div>
          <div class="sensor-data-row"><span class="sensor-data-label">Gyr<span style="color:#97c93e;">Z</span></span><span class="sensor-value" data-key="gyroz">--</span></div>
        `;
    }

    if (hasMag) {
        rows += `
          <div class="sensor-data-row"><span class="sensor-data-label">Mag<span style="color:#97c93e;">X</span></span><span class="sensor-value" data-key="magx">--</span></div>
          <div class="sensor-data-row"><span class="sensor-data-label">Mag<span style="color:#97c93e;">Y</span></span><span class="sensor-value" data-key="magy">--</span></div>
          <div class="sensor-data-row"><span class="sensor-data-label">Mag<span style="color:#97c93e;">Z</span></span><span class="sensor-value" data-key="magz">--</span></div>
        `;
    }

    const nameLower = name.toLowerCase();
    const isSock = nameLower.includes("calzino") || nameLower.includes("sock");

    // Pressioni (solo calzini)
    if (hasPressure && isSock) {
        rows += `
          <div class="sensor-data-row"><span class="sensor-data-label">Prs<span style="color:#ffb74d;">0</span></span><span class="sensor-value" data-key="pressure0">--</span></div>
          <div class="sensor-data-row"><span class="sensor-data-label">Prs<span style="color:#e91e63;">1</span></span><span class="sensor-value" data-key="pressure1">--</span></div>
          <div class="sensor-data-row"><span class="sensor-data-label">Prs<span style="color:#4fc3f7;">2</span></span><span class="sensor-value" data-key="pressure2">--</span></div>
        `;
    }

    div.innerHTML = `
        <div class="sensor-header">
            <span class="name">${name}</span>
            <div class="status-indicator active"></div>
        </div>
        <div class="sensor-data-section">
            ${rows}
        </div>
    `;

    grid.appendChild(div);
}

function updateSensorCardUI(sensorName, data) {
    if (!sensorName || !data) return;

    const isLeft = sensorName.toLowerCase().includes("sx") || sensorName.toLowerCase().includes("left");
    const suffix = isLeft ? "sx" : "dx"; 
    // Nota: verifica che nel tuo HTML gli ID siano tipo "accel-x-sx", "gyro-z-dx", ecc.

    // Helper formattazione
    const f = (n) => (n != null && Number.isFinite(Number(n))) ? Number(n).toFixed(2) : "--";

    // --- ACCELEROMETRO ---
    const axEl = document.getElementById(`accel-x-${suffix}`);
    if (axEl) axEl.textContent = f(data.accelx);
    const ayEl = document.getElementById(`accel-y-${suffix}`);
    if (ayEl) ayEl.textContent = f(data.accely);
    const azEl = document.getElementById(`accel-z-${suffix}`);
    if (azEl) azEl.textContent = f(data.accelz);

    // --- GIROSCOPIO ---
    const gxEl = document.getElementById(`gyro-x-${suffix}`);
    if (gxEl) gxEl.textContent = f(data.gyrox);
    const gyEl = document.getElementById(`gyro-y-${suffix}`);
    if (gyEl) gyEl.textContent = f(data.gyroy);
    const gzEl = document.getElementById(`gyro-z-${suffix}`);
    if (gzEl) gzEl.textContent = f(data.gyroz);
    
    // --- MAGNETOMETRO (Opzionale) ---
    const mxEl = document.getElementById(`mag-x-${suffix}`);
    if (mxEl) mxEl.textContent = f(data.magx);
    const myEl = document.getElementById(`mag-y-${suffix}`);
    if (myEl) myEl.textContent = f(data.magy);
    const mzEl = document.getElementById(`mag-z-${suffix}`);
    if (mzEl) mzEl.textContent = f(data.magz);
}


function updateSensorCardUI(name, data) {
    if (!name || !data) return;

    // Cerca la card, se non c'è creala
    let card = document.querySelector(`[data-sensor="${CSS.escape(name)}"]`);
    if (!card) {
        createSensorCard(name, data);
        card = document.querySelector(`[data-sensor="${CSS.escape(name)}"]`);
    }
    if (!card) return;

    // Aggiorna valori
    const setVal = (key, val, decimals) => {
        const el = card.querySelector(`[data-key="${key}"]`);
        if (el) {
            const n = Number(val);
            if (!Number.isFinite(n)) return;
            el.textContent = (typeof decimals === 'number') ? n.toFixed(decimals) : String(Math.round(n));
        }
    };

    // Mappa i dati normalizzati
    setVal('accelx', data.accelx, 3);
    setVal('accely', data.accely, 3);
    setVal('accelz', data.accelz, 3);
    setVal('gyrox', data.gyrox, 3);
    setVal('gyroy', data.gyroy, 3);
    setVal('gyroz', data.gyroz, 3);
    setVal('magx', data.magx, 3);
    setVal('magy', data.magy, 3);
    setVal('magz', data.magz, 3);

    // Pressioni (gestisce anche underscore)
    const p0 = data.pressure0 ?? data.pressure_0 ?? data.p0;
    const p1 = data.pressure1 ?? data.pressure_1 ?? data.p1;
    const p2 = data.pressure2 ?? data.pressure_2 ?? data.p2;

    setVal('pressure0', p0, 0);
    setVal('pressure1', p1, 0);
    setVal('pressure2', p2, 0);
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
  modal.style.cssText =
    "position:fixed; inset:0; z-index:99999; background:rgba(0,0,0,0.65);" +
    "display:flex; align-items:center; justify-content:center; padding:18px;";

  // NOTA: qui dentro ci DEVONO essere logs-status e logs-list
  modal.innerHTML = `
    <div style="width:min(620px,96vw); background:#111; border:1px solid #333; border-radius:14px;
                box-shadow:0 18px 48px rgba(0,0,0,0.65); overflow:hidden;">
      <div style="display:flex; justify-content:space-between; align-items:center;
                  padding:14px 16px; border-bottom:1px solid #222;">
        <div style="font-weight:900; color:#fff;">Carica attività passata</div>
        <button id="logs-close" style="background:transparent; color:#fff; border:0;
                                       font-size:18px; cursor:pointer;">✕</button>
      </div>

      <div style="padding:14px 16px;">
        <div id="logs-status" style="color:#aaa; font-size:12px; margin-bottom:8px;">
          Caricamento lista...
        </div>

        <!-- PROGRESS (nascosto finché non clicchi un log) -->
        <div id="logs-progress-container" style="display:none; margin-bottom:10px;">
          <div style="height:10px; background:#222; border:1px solid #333; border-radius:999px; overflow:hidden;">
            <div id="logs-progress-bar" style="height:100%; width:0%; background:#97c93e;"></div>
          </div>
          <div id="logs-progress-pct" style="margin-top:4px; color:#777; font-size:11px;">0%</div>
        </div>

        <div id="logs-list" style="display:flex; flex-direction:column; gap:8px; max-height:55vh; overflow:auto;"></div>
      </div>
    </div>
  `;

  // chiudi cliccando fuori
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });

  document.body.appendChild(modal);

  // query SOLO dentro la modale (robusto)
  const closeBtn = modal.querySelector("#logs-close");
  const status = modal.querySelector("#logs-status");
  const list = modal.querySelector("#logs-list");
  const progressContainer = modal.querySelector("#logs-progress-container");

  if (closeBtn) closeBtn.onclick = () => modal.remove();

  // se manca qualcosa, evita crash
  if (!status || !list) {
    console.error("openLogsModal: logs-status o logs-list non trovati nella modale.");
    return;
  }

  try {
    const resp = await fetch("/api/logs");
    const json = await resp.json();
    const logs = Array.isArray(json) ? json : (json.logs || []);

    status.textContent = logs.length ? "Seleziona un log" : "Nessun log trovato.";
    list.innerHTML = "";

    logs.forEach((item) => {
      const row = document.createElement("button");
      row.type = "button";
      row.style.cssText =
        "text-align:left; padding:10px 12px; border-radius:10px; border:1px solid #2a2a2a;" +
        "background:#161616; color:#fff; cursor:pointer;";

      const dt = item.mtime ? new Date(item.mtime * 1000).toLocaleString() : "--";
      const kb = item.size != null ? Math.round(item.size / 1024) : "--";

      row.innerHTML = `
        <div style="font-weight:800;">${item.name}</div>
        <div style="font-size:12px; color:#999; margin-top:2px;">${dt} · ${kb} KB</div>
      `;

      row.onclick = async () => {
        // mostra progress SOLO ora (quando clicchi)
        if (progressContainer) progressContainer.style.display = "block";

        // disabilita lista per evitare multi-click
        Array.from(list.querySelectorAll("button")).forEach((b) => (b.disabled = true));

        status.textContent = `Caricamento ${item.name}...`;

        try {
          await loadPastActivity(item.name);   // qui userai la tua progress bar dentro loadPastActivity
          modal.remove();                      // chiudi solo a fine load
        } catch (e) {
          console.error(e);
          status.textContent = "Errore nel caricamento del log.";
          // riabilita lista
          Array.from(list.querySelectorAll("button")).forEach((b) => (b.disabled = false));
          if (progressContainer) progressContainer.style.display = "none";
        }
      };

      list.appendChild(row);
    });
  } catch (e) {
    console.error(e);
    status.textContent = "Errore nel caricamento lista log.";
  }
}

function resetLiveState() {
  // timeline
  sessionStartTimeMs = null;
  sessionEndTimeMs = null;
  isReplayMode = false;

  // dati
  gpsSamples = [];
  bpmSamples = [];
  lastLiveBpm = "--";

  leftSockSamples = [];
  rightSockSamples = [];

  sockChartData.left  = [[], [], [], []];
  sockChartData.right = [[], [], [], []];

  sockLastX = { left: 0, right: 0 };
  sockRenderScheduled = { left: false, right: false };

  // mappa
  clearFullRouteSegments();
  clearProgressRouteSegments();

  // UI cards
  updateBpmValue("--");
  updateSpeedDistanceUI(null, null);

  // svuota subito i grafici calzini (così spariscono i “dati vecchi”)
  if (sockCharts.left) {
    sockCharts.left.setData(sockChartData.left);
    sockCharts.left.setScale("x", { min: 0, max: 4 }); // finestra come prima (4s)
    sockCharts.left.redraw();
  }
  if (sockCharts.right) {
    sockCharts.right.setData(sockChartData.right);
    sockCharts.right.setScale("x", { min: 0, max: 4 }); // finestra come prima (4s)
    sockCharts.right.redraw();
  }
}

function resetReplayState() {
  gpsSamples = [];
  bpmSamples = [];
  leftSockSamples = [];
  rightSockSamples = [];
  clearFullRouteSegments();
  clearProgressRouteSegments();


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


  updateBpmValue("--");
  updateSpeedDistanceUI(null, null);
}

async function loadPastActivity(logName) {
  const yieldUI = () => new Promise((r) => setTimeout(r, 0));

  // --- UI progress (dentro la modale) ---
  const statusEl = document.getElementById("logs-status");
  const contEl = document.getElementById("logs-progress-container");
  const barEl = document.getElementById("logs-progress-bar");
  const pctEl = document.getElementById("logs-progress-pct");

  const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
  const setProgress = (p) => {
    const v = Math.max(0, Math.min(100, Number(p) || 0));
    if (barEl) barEl.style.width = v.toFixed(1) + "%";
    if (pctEl) pctEl.textContent = Math.round(v) + "%";
  };

  // --- helpers parsing (stream log) ---
  const extractJsonFromLine = (line) => {
    if (!line) return null;
    const a = line.indexOf("{");
    const b = line.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(line.slice(a, b + 1)); } catch { return null; }
  };

  const parseTimeMs = (obj) => {
    if (!obj || typeof obj !== "object") return null;

    const numToMs = (n) => (n < 1e12 ? Math.round(n * 1000) : Math.round(n));

    for (const k of ["t", "time", "ts"]) {
      if (obj[k] != null) {
        const v = obj[k];
        if (typeof v === "number" && Number.isFinite(v)) return numToMs(v);
        if (typeof v === "string" && v.trim().match(/^\d+(\.\d+)?$/)) return numToMs(Number(v));
      }
    }

    if (obj.timestamp) {
      const d = new Date(obj.timestamp);
      const ms = d.getTime();
      if (!Number.isNaN(ms)) return ms;
    }

    return null;
  };

  const getLastByTime = (arr) => {
    if (!arr || !arr.length) return null;
    return arr.reduce((best, cur) => {
      const bt = (best && best.t != null) ? Number(best.t)
        : (best && best.timestamp) ? new Date(best.timestamp).getTime()
        : -Infinity;
      const ct = (cur && cur.t != null) ? Number(cur.t)
        : (cur && cur.timestamp) ? new Date(cur.timestamp).getTime()
        : -Infinity;
      return ct >= bt ? cur : best;
    }, arr[0]);
  };

  const normSensorItem = (x) => {
    if (!x || typeof x !== "object") return x;
    // normalizza alias più comuni (minimo indispensabile per calculateBI / pressioni)
    const o = { ...x };
    if (o.accelx == null && o.accel_x != null) o.accelx = o.accel_x;
    if (o.accely == null && o.accel_y != null) o.accely = o.accel_y;
    if (o.accelz == null && o.accel_z != null) o.accelz = o.accel_z;

    if (o.gyrox == null && o.gyro_x != null) o.gyrox = o.gyro_x;
    if (o.gyroy == null && o.gyro_y != null) o.gyroy = o.gyro_y;
    if (o.gyroz == null && o.gyro_z != null) o.gyroz = o.gyro_z;

    if (o.magx == null && o.mag_x != null) o.magx = o.mag_x;
    if (o.magy == null && o.mag_y != null) o.magy = o.mag_y;
    if (o.magz == null && o.mag_z != null) o.magz = o.mag_z;

    if (o.pressure0 == null && o.pressure_0 != null) o.pressure0 = o.pressure_0;
    if (o.pressure1 == null && o.pressure_1 != null) o.pressure1 = o.pressure_1;
    if (o.pressure2 == null && o.pressure_2 != null) o.pressure2 = o.pressure_2;

    return o;
  };

  try {
    // mostra barra solo DURANTE load
    if (contEl) contEl.style.display = "block";
    setProgress(0);
    setStatus(`Caricamento ${logName}...`);

    // ============================================================
    // 1) DOWNLOAD + PARSE (stream se disponibile)
    // ============================================================
    const data = { name: logName, gps: [], bpm: [], profile: [], sensors: [] };

    let usedStreaming = false;

    // prova streaming
    try {
      setStatus(`Download ${logName}...`);
      const resp = await fetch(`/api/logs/raw?name=${encodeURIComponent(logName)}`);

      if (resp.ok && resp.body) {
        usedStreaming = true;

        const total =
          Number(resp.headers.get("Content-Length")) ||
          Number(resp.headers.get("X-Total-Bytes")) ||
          0;

        const reader = resp.body.getReader();
        const decoder = new TextDecoder("utf-8");

        let received = 0;
        let buf = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          received += value.byteLength;

          // 0..55% durante download
          if (total > 0) setProgress(Math.min(55, (received / total) * 55));

          buf += decoder.decode(value, { stream: true });

          const lines = buf.split(/\r?\n/);
          buf = lines.pop() || "";

          for (const line of lines) {
            const obj = extractJsonFromLine(line);
            if (!obj) continue;

            const tMs = parseTimeMs(obj);
            if (tMs != null) obj.t = tMs;

            // BPM
            if (obj.bpm != null || obj.heartrate != null || obj.heart_rate != null) {
              const v = Number(obj.bpm ?? obj.heartrate ?? obj.heart_rate);
              if (Number.isFinite(v) && v > 0) data.bpm.push({ t: obj.t, bpm: v });
              continue;
            }

            // GPS
            if (obj.latitude != null && obj.longitude != null) {
              data.gps.push(obj);
              continue;
            }

            // PROFILO
            const isProfile =
              obj.sensor_name === "PROFILE_INFO" ||
              (obj.name != null && (obj.age != null || obj.eta != null || obj.weight != null || obj.weightKg != null || obj.peso != null));
            if (isProfile) {
              data.profile.push(obj);
              continue;
            }

            // SENSORI (imu/pressure)
            const isSensor =
              (obj.accelx != null || obj.accel_x != null) ||
              (obj.gyrox != null || obj.gyro_x != null) ||
              (obj.magx != null || obj.mag_x != null) ||
              (obj.pressure0 != null || obj.pressure_0 != null || obj.p0 != null);
            if (isSensor) {
              data.sensors.push(normSensorItem(obj));
              continue;
            }
          }

          // lascia respirare UI durante download+parse
          await yieldUI();
        }

        // flush decoder finale (in genere buf rimane solo parziale/vuoto)
        buf += decoder.decode();
        // (se vuoi, puoi parsare anche l'ultima riga: spesso non serve)

        setProgress(60);
      } else {
        throw new Error("Streaming non disponibile o endpoint non OK");
      }
    } catch (e) {
      // fallback: vecchio endpoint JSON (nessun progresso durante download)
      setStatus(`Download ${logName}...`);
      setProgress(5);

      const resp = await fetch(`/api/logs/load?name=${encodeURIComponent(logName)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const j = await resp.json();

      data.gps = Array.isArray(j.gps) ? j.gps : [];
      data.bpm = Array.isArray(j.bpm) ? j.bpm : [];
      data.profile = Array.isArray(j.profile) ? j.profile : [];
      data.sensors = Array.isArray(j.sensors) ? j.sensors.map(normSensorItem) : [];

      setProgress(60);
    }

    // ============================================================
    // 2) RESET stato replay (usa la tua funzione se esiste)
    // ============================================================
    setStatus("Reset stato...");
    if (typeof resetReplayState === "function") {
      resetReplayState();
    } else {
      // fallback minimale se resetReplayState non esiste
      gpsSamples = [];
      bpmSamples = [];
      leftSockSamples = [];
      rightSockSamples = [];
      sockChartData.left = [[], [], [], []];
      sockChartData.right = [[], [], [], []];
      speedBySec = [];
      secPos = [];
      lastSpeedKmh = 0;
      lastSpeedSec = null;
      lastSecFix = null;
      lastLiveBpm = "--";
      sessionStartTimeMs = null;
      sessionEndTimeMs = null;
      isReplayMode = false;
      gpsTimeUnit = null;
      lastGpsTRaw = null;
      if (typeof clearFullRouteSegments === "function") clearFullRouteSegments();
      if (typeof clearProgressRouteSegments === "function") clearProgressRouteSegments();
      updateBpmValue("--");
      updateSpeedDistanceUI(null, null);
    }

    setProgress(65);
    await yieldUI();

    // ============================================================
    // 3) PROFILO (aggiorna header)
    // ============================================================
    setStatus("Parsing profilo...");
    const lastProf = getLastByTime(data.profile);
    if (lastProf) updateProfileUI(lastProf);
    setProgress(68);

    // ============================================================
    // 4) Calcola sessionStartTimeMs (min timestamp tra streams)
    // ============================================================
    const times = [];
    if (data.gps.length) times.push(Number(data.gps[0].t));
    if (data.bpm.length) times.push(Number(data.bpm[0].t));
    if (data.sensors.length) times.push(Number(data.sensors[0].t));
    if (data.profile.length) times.push(Number(data.profile[0].t));

    const finiteTimes = times.filter((t) => Number.isFinite(t));
    if (finiteTimes.length) sessionStartTimeMs = Math.min(...finiteTimes);
    if (sessionStartTimeMs == null) sessionStartTimeMs = Date.now();

    // --- 5 SENSORI: parsing completo e corretto ---
    setStatus("Parsing sensori...");

    // Reset
    allSensorSamples = {}; 
    leftSockSamples = [];
    rightSockSamples = [];
    sockChartData.left = [[], [], [], []];
    sockChartData.right = [[], [], [], []];

    for (const sensorItemRaw of data.sensors) {
        const sensorItem = normSensorItem(sensorItemRaw);
        const tMs = (sensorItem && sensorItem.t != null) ? Number(sensorItem.t) : null;
        if (!Number.isFinite(tMs)) continue;

        // --- CORREZIONE NOME: Supporta sensor_name (dal log JSON) ---
        const nameRaw = String(
            sensorItem.sensor_name ?? // <--- FONDAMENTALE per i tuoi log
            sensorItem.sensorname ?? 
            sensorItem.sensorName ?? 
            sensorItem.name ?? 
            sensorItem.sensor ?? 
            "Unknown"
        ).trim();
        
        const nameLower = nameRaw.toLowerCase();
        const tRelSec = (tMs - sessionStartTimeMs) / 1000;

        // --- CORREZIONE PRESSIONI: Supporta pressure_0 (dal log JSON) ---
        const p0 = Number(sensorItem.pressure0 ?? sensorItem.pressure_0 ?? sensorItem.p0 ?? 0);
        const p1 = Number(sensorItem.pressure1 ?? sensorItem.pressure_1 ?? sensorItem.p1 ?? 0);
        const p2 = Number(sensorItem.pressure2 ?? sensorItem.pressure_2 ?? sensorItem.p2 ?? 0);

        // Dati IMU (accelerometro ecc...)
        // normSensorItem gestisce già accel_x -> accelx, quindi usiamo i campi normalizzati
        // ma per sicurezza controlliamo entrambi
        const sample = {
            t: tMs,
            sensorname: nameRaw, 

            // Dati IMU completi
            accelx: sensorItem.accelx ?? sensorItem.accel_x, 
            accely: sensorItem.accely ?? sensorItem.accel_y, 
            accelz: sensorItem.accelz ?? sensorItem.accel_z,
            gyrox: sensorItem.gyrox ?? sensorItem.gyro_x, 
            gyroy: sensorItem.gyroy ?? sensorItem.gyro_y, 
            gyroz: sensorItem.gyroz ?? sensorItem.gyro_z,
            magx: sensorItem.magx ?? sensorItem.mag_x, 
            magy: sensorItem.magy ?? sensorItem.mag_y, 
            magz: sensorItem.magz ?? sensorItem.mag_z,

            // Pressioni
            pressure0: p0, pressure1: p1, pressure2: p2,
            p0: p0, p1: p1, p2: p2,
            
            bi: (typeof calculateBI === "function") ? calculateBI(sensorItem) : 0
        };

        // 1. Salviamo TUTTO nel dizionario globale
        if (!allSensorSamples[nameRaw]) {
            allSensorSamples[nameRaw] = [];
        }
        allSensorSamples[nameRaw].push(sample);

        // 2. Logica specifica Calzini (per i grafici dedicati)
        const isLeft = nameLower.includes("sx") || nameLower.includes("left") || nameLower.includes("sinistro");
        const isRight = nameLower.includes("dx") || nameLower.includes("right") || nameLower.includes("destro");
        // Escludiamo "ginocchio" o altri sensori che potrebbero avere "sx/dx" nel nome ma non sono calzini
        const isSock = nameLower.includes("calzino") || nameLower.includes("sock"); 

        if (isSock && isLeft) {
            leftSockSamples.push(sample);
            sockChartData.left[0].push(tRelSec);
            sockChartData.left[1].push(p0);
            sockChartData.left[2].push(p1);
            sockChartData.left[3].push(p2);
        } else if (isSock && isRight) {
            rightSockSamples.push(sample);
            sockChartData.right[0].push(tRelSec);
            sockChartData.right[1].push(p0);
            sockChartData.right[2].push(p1);
            sockChartData.right[3].push(p2);
        }
    }

    // Ordina per tempo
    Object.values(allSensorSamples).forEach(arr => arr.sort((a, b) => a.t - b.t));



    setProgress(72);
    await yieldUI();

    // ============================================================
    // 6) GPS bulk-load (progress 72..92)
    // ============================================================
    setStatus("Parsing GPS...");
    if (!data.gps.length) {
      setStatus("Nessun GPS nel log.");
      setProgress(100);
      if (contEl) contEl.style.display = "none";
      return;
    }

    isBulkLoading = true;
    const CHUNK = 1200;

    for (let i = 0; i < data.gps.length; i += CHUNK) {
      const end = Math.min(i + CHUNK, data.gps.length);
      const frac = data.gps.length ? (end / data.gps.length) : 1;
      setProgress(72 + frac * 20);
      setStatus(`Parsing GPS... ${end}/${data.gps.length}`);

      for (let j = i; j < end; j++) {
        // onGpsUpdate nel tuo file accetta opts {updateUi, updateMap}
        onGpsUpdate(data.gps[j], { updateUi: false, updateMap: false });
      }
      await yieldUI();
    }

    isBulkLoading = false;

    // ============================================================
    // 7) BPM -> bpmSamples
    // ============================================================
    setStatus("Parsing BPM...");
    for (const b of data.bpm) {
      const tMs = (b && b.t != null) ? Number(b.t) : null;
      if (!Number.isFinite(tMs)) continue;
      const v = Number(b.bpm ?? b.value ?? b.heartrate ?? b.heart_rate ?? 0);
      bpmSamples.push({ t: tMs, bpm: Number.isFinite(v) ? v : 0 });
    }

    setProgress(94);
    await yieldUI();

    // ============================================================
    // 8) Rendering grafici + mappa + replay
    // ============================================================
    setStatus("Rendering grafici calzini...");
    if (typeof initSockCharts === "function") {
      initSockCharts();
      if (sockCharts.left) sockCharts.left.setData(sockChartData.left);
      if (sockCharts.right) sockCharts.right.setData(sockChartData.right);
    }

    setStatus("Rendering mappa...");
    if (gpsSamples.length) {
      const first = gpsSamples[0];
      ensureMapInitialized(first.lat, first.lng);
      rebuildColoredFullRouteFromGpsSamples(2.0);
      if (mapMarker) mapMarker.setLatLng([first.lat, first.lng]);
    }

    setStatus("Finalizzazione replay...");
    sessionEndTimeMs = getSessionEndMs();
    rebuildSpeedBySecFromGps();
    // Siamo in REPLAY (log caricato), quindi abilita modalità replay PRIMA di mostrare overlay/slider
    isReplayMode = true;

    updateReplayUiBounds();
    showReplayOverlayIfReady();
    enterReplayAtSecond(0);   // posiziona a inizio (o metti getDurationSec() per andare alla fine)
    showReplayOverlayIfReady(); // ridondante ma utile se in futuro cambi enterReplayAtSecond


    setProgress(100);
    setStatus(usedStreaming ? "Caricato (stream)." : "Caricato.");
    if (contEl) contEl.style.display = "none";

  } catch (error) {
    isBulkLoading = false;
    console.error("Errore durante il caricamento dell'attività:", error);
    setStatus("Errore durante il caricamento dell'attività.");
    setProgress(0);
    if (contEl) contEl.style.display = "none";
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
