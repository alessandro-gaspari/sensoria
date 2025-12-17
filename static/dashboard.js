// ==========================================
// CONFIGURAZIONE GLOBALE
// ==========================================
var socket = io({
  transports: ['websocket'],
  reconnection: true,
  reconnectionDelay: 500
});

const SENSORIA_GREEN = '#97c93e';

// --- SENSORI ---
var sensors = {};

// --- MAPPA ---
var map = null;
var mapMarker = null;
var isMapInitialized = false;
var mapRotationDeg = 0;

// Route layers
var fullRoute = null;      // cresce sempre con i GPS ricevuti
var progressRoute = null;  // mostra progressione fino al tempo selezionato (o live)

// --- TIMELINE (time-based) ---
var sessionStartTimeMs = null;  // set al primo evento (gps/bpm)
var sessionEndTimeMs = null;    // se arriva "data_cleared"
var isReplayMode = false;

// campioni
var gpsSamples = []; // { t, lat, lng, acc, cumDistM, speedKmh }
var bpmSamples = []; // { t, bpm }

// cache UI live
var lastLiveBpm = "--";

// --- ANIMAZIONE MARKER LIVE ---
var currentMapPos = null;
var targetMapPos = null;
var animationStartTime = null;
var startMapPos = null;
var animationFrameId = null;
const ANIMATION_DURATION = 700;

// --- GRAFICI ---
var charts = { accel: null, gyro: null, mag: null, pressure: null };
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
// INIZIALIZZAZIONE
// ==========================================
document.addEventListener('DOMContentLoaded', function () {
  initSocket();
  ensureMapDomOverlay();
  ensureBpmOnTop();
  ensureBpmExtrasUI();

  var sel = document.getElementById('chart-sensor-select');
  if (sel) {
    sel.addEventListener('change', function (e) {
      selectedSensor = e.target.value || null;
      resetChartData();

      var container = document.getElementById('charts-container');
      if (selectedSensor) {
        container.style.display = 'block';
        if (!chartsInitialized) {
          initCharts();
          chartsInitialized = true;
        }
      } else {
        container.style.display = 'none';
      }
    });
  }
});

function initSocket() {
  socket.on('connect', () => {
    var el = document.getElementById('connection-status');
    if (el) { el.className = ''; el.innerHTML = '<span class="dot"></span> Connesso'; }
  });

  socket.on('disconnect', () => {
    var el = document.getElementById('connection-status');
    if (el) { el.className = 'disconnected'; el.innerHTML = '<span class="dot"></span> Disconnesso'; }
  });

  socket.on('sensor_update', (data) => processIncomingData(data));
  socket.on('bpm_update', (val) => onBpmUpdate(val));
  socket.on('profile_update', (data) => updateProfileUI(data));
  socket.on('gps_update', (data) => onGpsUpdate(data));

  // Fine attività: NON cancelliamo (tu vuoi che rimanga fino a refresh)
  socket.on('data_cleared', () => {
    if (sessionStartTimeMs != null) {
      sessionEndTimeMs = getNowMs();
      updateReplayUiBounds();
      showReplayOverlayIfReady();
      // rimane in live se non stai scrub-bando
    }
  });
}

// ==========================================
// TIME HELPERS
// ==========================================
function getNowMs() {
  return Date.now();
}

function ensureSessionStart(tMs) {
  if (sessionStartTimeMs == null) sessionStartTimeMs = tMs;
}

function getSessionEndMs() {
  var last = sessionStartTimeMs || getNowMs();
  if (gpsSamples.length) last = Math.max(last, gpsSamples[gpsSamples.length - 1].t);
  if (bpmSamples.length) last = Math.max(last, bpmSamples[bpmSamples.length - 1].t);
  if (sessionEndTimeMs != null) last = Math.max(last, sessionEndTimeMs);
  return last;
}

function getDurationSec() {
  if (sessionStartTimeMs == null) return 0;
  var end = getSessionEndMs();
  return Math.max(0, Math.floor((end - sessionStartTimeMs) / 1000));
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

// ==========================================
// DISTANCE + SPEED (HAVERSINE)
// ==========================================
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) *
    Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function formatKmh(v) {
  if (v == null || !isFinite(v)) return "--";
  return (Math.max(0, v)).toFixed(1);
}

function formatKmFromMeters(m) {
  if (m == null || !isFinite(m)) return "--";
  return (Math.max(0, m) / 1000).toFixed(2);
}

// ==========================================
// BPM UI (BPM + SPEED + DIST)
// ==========================================
function ensureBpmOnTop() {
  var bpmBox = document.getElementById('bpm-display');
  if (!bpmBox) return;
  bpmBox.style.zIndex = '20000';
  if (!bpmBox.style.position) bpmBox.style.position = 'absolute';
}

function ensureBpmExtrasUI() {
  const bpmBox = document.getElementById('bpm-display');
  if (!bpmBox) return;

  ensureBpmOnTop();

  // Wrapper colonna a destra (trasparente)
  let wrap = document.getElementById('metrics-stack');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'metrics-stack';
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
    const mapDiv = document.getElementById('map');
    (mapDiv || document.body).appendChild(wrap);
  }

  // Aggancia BPM box al wrapper (senza modificarne i figli)
  if (bpmBox.parentElement !== wrap) {
    bpmBox.style.position = 'relative';
    bpmBox.style.margin = '0';
    bpmBox.style.pointerEvents = 'auto';
    bpmBox.style.width = '190px';
    bpmBox.style.minHeight = '64px';
    wrap.appendChild(bpmBox);
  }

  const CARD_W = '190px';
  const CARD_H = '64px';

  function forceCardBox(el) {
    el.style.setProperty('width', CARD_W, 'important');
    el.style.setProperty('min-height', CARD_H, 'important');
    el.style.setProperty('height', CARD_H, 'important');
    el.style.setProperty('box-sizing', 'border-box', 'important');
    el.style.setProperty('padding', '10px 12px', 'important');
    el.style.setProperty('display', 'flex', 'important');
    el.style.setProperty('align-items', 'center', 'important');
    el.style.setProperty('justify-content', 'space-between', 'important');
    el.style.setProperty('overflow', 'hidden', 'important');
  }

  forceCardBox(bpmBox);


  // Crea SPEED/DIST se non esistono
  if (document.getElementById('speed-card')) return;

  const cardBase = (borderColor) => `
    width:190px;
    min-height:64px;
    box-sizing:border-box;
    border-radius:12px;
    padding:10px 12px;
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:12px;
    pointer-events:auto;
    background: rgba(0,0,0,0.35);
    border: 1px solid ${borderColor};
    box-shadow: 0 10px 22px rgba(0,0,0,0.45);
  `;

  function buildMetricCard({ id, emoji, label, labelColor, valueId, borderColor, unitText }) {
    const card = document.createElement('div');
    card.id = id;
    card.style.cssText = cardBase(borderColor);

    card.innerHTML = `
      <div style="font-size:26px; line-height:1; width:34px; text-align:center;">
        ${emoji}
      </div>

      <div style="flex:1; display:flex; flex-direction:column; align-items:flex-start; gap:1px;">
        <div id="${valueId}" style="font-family:monospace; font-size:14px; font-weight:900; color:#fff;">
          -- ${unitText}
        </div>
        <div style="font-size:10px; font-weight:900; letter-spacing:1px; color:${labelColor};">
          ${label}
        </div>
      </div>
    `;
    return card;
  }

  const speedCard = buildMetricCard({
    id: 'speed-card',
    emoji: '⚡',
    label: 'VELOCITÀ',
    labelColor: 'rgba(255, 149, 0, 0.95)',
    valueId: 'speed-value',
    borderColor: 'rgba(255, 149, 0, 0.70)',
    unitText: 'km/h'
  });

  const distCard = buildMetricCard({
    id: 'dist-card',
    emoji: '📍',
    label: 'DISTANZA',
    labelColor: 'rgba(255, 214, 10, 0.95)',
    valueId: 'distance-value',
    borderColor: 'rgba(255, 214, 10, 0.70)',
    unitText: 'km'
  });

  wrap.appendChild(speedCard);
  wrap.appendChild(distCard);
}



function updateSpeedDistanceUI(speedKmh, distMeters) {
  const sEl = document.getElementById('speed-value');
  const dEl = document.getElementById('distance-value');
  if (sEl) sEl.textContent = `${formatKmh(speedKmh)} km/h`;
  if (dEl) dEl.textContent = `${formatKmFromMeters(distMeters)} km`;
}

function updateBpmBox(val, isReplay) {
  var div = document.getElementById('bpm-display');
  if (!div) return;

  div.style.display = 'flex';
  ensureBpmOnTop();

  var vEl = document.getElementById('bpm-value');
  if (vEl) vEl.textContent = String(val);

  var icon = div.querySelector('.heart-icon');
  if (icon) {
    icon.style.animation = 'none';
    icon.style.animationDuration = '0s';
  }
}


// ==========================================
// BPM (LIVE + TIMELINE)
// ==========================================
function onBpmUpdate(val) {
  var bpmInt = parseInt(val);
  if (isNaN(bpmInt) || bpmInt <= 0) return;

  var tMs = getNowMs();
  ensureSessionStart(tMs);

  lastLiveBpm = bpmInt;
  bpmSamples.push({ t: tMs, bpm: bpmInt });

  if (!isReplayMode) {
    updateBpmBox(bpmInt, false);
    updateReplayUiBounds();
    showReplayOverlayIfReady();
  }
}

// ==========================================
// GPS (LIVE + TIMELINE + MAP)
// ==========================================
function onGpsUpdate(data) {
  if (!data) return;
  var lat = Number(data.latitude);
  var lng = Number(data.longitude);
  if (!isFinite(lat) || !isFinite(lng)) return;
  if (lat === 0 && lng === 0) return;

  var acc = (data.accuracy != null) ? Number(data.accuracy) : null;
  var tMs = data.timestamp ? new Date(data.timestamp).getTime() : getNowMs();
  ensureSessionStart(tMs);

  // --- calcolo distanza e velocità (cumulativa + km/h) ---
  let cumDistM = 0;
  let speedKmh = 0;

  if (gpsSamples.length > 0) {
    const prev = gpsSamples[gpsSamples.length - 1];
    const dtS = Math.max(0, (tMs - prev.t) / 1000);

    let dM = haversineMeters(prev.lat, prev.lng, lat, lng);
    if (!isFinite(dM) || dM < 0.5) dM = 0; // jitter minimo

    cumDistM = (prev.cumDistM || 0) + dM;

    // velocità (istantanea) km/h
    if (dtS >= 0.3 && dM >= 1.0) speedKmh = (dM / dtS) * 3.6;
    else speedKmh = prev.speedKmh || 0;
  }

  gpsSamples.push({ t: tMs, lat: lat, lng: lng, acc: acc, cumDistM: cumDistM, speedKmh: speedKmh });

  ensureMapInitialized(lat, lng);

  // aggiorna route completa sempre
  if (fullRoute) fullRoute.addLatLng([lat, lng]);

  if (!isReplayMode) {
    updateProgressRouteToTime(getSessionEndMs());

    // marker animato
    if (!currentMapPos) currentMapPos = { lat: lat, lng: lng };
    targetMapPos = { lat: lat, lng: lng };
    startMapPos = { ...currentMapPos };
    animationStartTime = performance.now();
    if (!animationFrameId) animateMarkerLoop();

    var accEl = document.getElementById('gps-accuracy');
    if (accEl && acc != null && isFinite(acc)) accEl.textContent = Math.round(acc);

    // aggiorna speed+dist live
    const last = gpsSamples[gpsSamples.length - 1];
    updateSpeedDistanceUI(last.speedKmh, last.cumDistM);

    updateReplayUiBounds();
    showReplayOverlayIfReady();
  }
}

// ==========================================
// MAP INIT + PANES + OVERLAY
// ==========================================
function ensureMapDomOverlay() {
  var mapDiv = document.getElementById('map');
  if (!mapDiv) return;
  mapDiv.style.position = 'relative';
}

function createRotateControl() {
  const mapDiv = document.getElementById('map');
  if (!mapDiv) return;
  if (document.getElementById('rotate-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'rotate-btn';
  btn.innerHTML = '⤾';
  btn.title = 'Ruota mappa';
  btn.style.cssText = `
    position:absolute;
    top:56px;
    left:10px;
    width:28px;
    height:28px;
    border-radius:4px;
    border:none;
    background: rgba(0,0,0,0.7);
    color:#fff;
    font-size:16px;
    line-height:1;
    cursor:pointer;
    z-index: 20000;
    display:flex;
    align-items:center;
    justify-content:center;
  `;

  btn.addEventListener('click', () => {
    // toggle 0° / 90° (puoi cambiare step a 45° o 180°)
    mapRotationDeg = (mapRotationDeg + 90) % 360;
    const outer = mapDiv.closest('.map-outer') || mapDiv;
    outer.style.transformOrigin = '50% 50%';
    outer.style.transition = 'transform 0.25s ease-out';
    outer.style.transform = `rotate(${mapRotationDeg}deg)`;
    setTimeout(() => map.invalidateSize(), 300);
  });

  mapDiv.appendChild(btn);
}

function ensureMapInitialized(lat, lng) {
  if (isMapInitialized) return;

  var section = document.getElementById('map-section');
  if (section) section.style.display = 'block';

  ensureMapDomOverlay();
  ensureBpmOnTop();
  ensureBpmExtrasUI();

  map = L.map('map', { attributionControl: false, zoomControl: true }).setView([lat, lng], 19);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20
  }).addTo(map);

  createRotateControl();

  // PANE route + marker (ordine stabile) [web:21][web:29]
  map.createPane('routePane');
  map.getPane('routePane').style.zIndex = 450;

  map.createPane('markerPane');
  map.getPane('markerPane').style.zIndex = 650;

  var pulseIcon = L.divIcon({
    className: 'custom-div-icon',
    html: "<div class='pulsating-marker'></div>",
    iconSize: [24, 24],
    iconAnchor: [12, 12]
  });

  mapMarker = L.marker([lat, lng], { icon: pulseIcon, pane: 'markerPane' }).addTo(map);

  fullRoute = L.polyline([], {
    pane: 'routePane',
    color: SENSORIA_GREEN,
    weight: 4,
    opacity: 0.45,
    lineJoin: 'round',
    lineCap: 'round'
  }).addTo(map);

  progressRoute = L.polyline([], {
    pane: 'routePane',
    color: SENSORIA_GREEN,
    weight: 7,
    opacity: 0.95,
    lineJoin: 'round',
    lineCap: 'round'
  }).addTo(map);

  createReplayOverlayControls();

  isMapInitialized = true;
  setTimeout(() => map.invalidateSize(), 120);
}

// ==========================================
// MARKER ANIMATION LOOP (LIVE)
// ==========================================
function animateMarkerLoop() {
  if (!startMapPos || !targetMapPos || !mapMarker || isReplayMode) {
    animationFrameId = null;
    return;
  }

  var now = performance.now();
  var elapsed = now - animationStartTime;
  var progress = elapsed / ANIMATION_DURATION;
  if (progress > 1) progress = 1;

  var lat = startMapPos.lat + (targetMapPos.lat - startMapPos.lat) * progress;
  var lng = startMapPos.lng + (targetMapPos.lng - startMapPos.lng) * progress;

  currentMapPos = { lat: lat, lng: lng };
  mapMarker.setLatLng([lat, lng]);

  if (progress < 1) animationFrameId = requestAnimationFrame(animateMarkerLoop);
  else animationFrameId = null;
}

// ==========================================
// REPLAY OVERLAY (time-based)
// ==========================================
function createReplayOverlayControls() {
  var mapDiv = document.getElementById('map');
  if (!mapDiv) return;
  if (document.getElementById('replay-overlay')) return;

  var overlay = document.createElement('div');
  overlay.id = 'replay-overlay';
  overlay.style.cssText = `
    position:absolute;
    left: 16px;
    right: 16px;
    bottom: 16px;
    z-index: 30000;
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
    <div style="min-width:64px; display:flex; flex-direction:column; gap:2px;">
      <div style="font-size:10px; letter-spacing:1px; color:#9aa; font-weight:700;">TEMPO</div>
      <div id="replay-time-label" style="font-family:monospace; font-size:13px; color:#fff; font-weight:700;">00:00</div>
    </div>

    <input id="replay-slider" type="range" min="0" max="0" value="0"
      style="flex:1; accent-color:${SENSORIA_GREEN}; cursor:pointer;" />

    <button id="btn-live" type="button"
      style="
        padding:6px 12px;
        border-radius:8px;
        border: 1px solid ${SENSORIA_GREEN};
        background: rgba(151,201,62,0.18);
        color: ${SENSORIA_GREEN};
        font-weight:800;
        font-size:11px;
        letter-spacing:1px;
        cursor:pointer;
      ">LIVE</button>
  `;

  mapDiv.appendChild(overlay);

  var slider = document.getElementById('replay-slider');
  var btnLive = document.getElementById('btn-live');

  slider.addEventListener('input', function (e) {
    var sec = parseInt(e.target.value || "0");
    enterReplayAtSecond(sec);
  });

  btnLive.addEventListener('click', function () {
    goLive();
  });
}

function showReplayOverlayIfReady() {
  var overlay = document.getElementById('replay-overlay');
  if (!overlay) return;

  if (getDurationSec() > 0 && (gpsSamples.length > 1 || bpmSamples.length > 1)) {
    overlay.style.display = 'flex';
  }
}

function updateReplayUiBounds() {
  var slider = document.getElementById('replay-slider');
  if (!slider) return;

  var maxSec = getDurationSec();
  slider.max = String(maxSec);

  if (!isReplayMode) {
    slider.value = String(maxSec);
    updateReplayTimeLabel(maxSec);
  }
}

function updateReplayTimeLabel(sec) {
  var lab = document.getElementById('replay-time-label');
  if (!lab) return;
  var m = Math.floor(sec / 60).toString().padStart(2, '0');
  var s = (sec % 60).toString().padStart(2, '0');
  lab.textContent = `${m}:${s}`;
}

function enterReplayAtSecond(sec) {
  if (sessionStartTimeMs == null) return;

  isReplayMode = true;
  cancelAnimationFrame(animationFrameId);
  animationFrameId = null;

  var maxSec = getDurationSec();
  var clampedSec = clamp(sec, 0, maxSec);
  updateReplayTimeLabel(clampedSec);

  var tMs = sessionStartTimeMs + clampedSec * 1000;

  // GPS: pos interpolata
  var pos = getInterpolatedGpsAtTime(tMs);
  if (pos && mapMarker) {
    mapMarker.setLatLng([pos.lat, pos.lng]);
    currentMapPos = { lat: pos.lat, lng: pos.lng };
  }

  // route progress fino al tempo
  updateProgressRouteToTime(tMs);

  // BPM storico
  var bpm = getBpmAtTime(tMs);
  if (bpm != null) updateBpmBox(bpm, true);

  // Speed + Distance storiche (interpolate)
  var distM = getDistanceAtTime(tMs);
  var spd = getSpeedAtTime(tMs);
  updateSpeedDistanceUI(spd, distM);
}

function goLive() {
  isReplayMode = false;

  updateReplayUiBounds();

  if (gpsSamples.length && mapMarker) {
    var last = gpsSamples[gpsSamples.length - 1];
    mapMarker.setLatLng([last.lat, last.lng]);
    currentMapPos = { lat: last.lat, lng: last.lng };
    targetMapPos = { lat: last.lat, lng: last.lng };
  }

  updateProgressRouteToTime(getSessionEndMs());

  if (lastLiveBpm !== "--") updateBpmBox(lastLiveBpm, false);

  if (gpsSamples.length) {
    var lastG = gpsSamples[gpsSamples.length - 1];
    updateSpeedDistanceUI(lastG.speedKmh, lastG.cumDistM);
  }
}

// ==========================================
// LOOKUP (binary search)
// ==========================================
function upperBoundByTime(arr, tMs) {
  var lo = 0, hi = arr.length;
  while (lo < hi) {
    var mid = (lo + hi) >> 1;
    if (arr[mid].t <= tMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function getInterpolatedGpsAtTime(tMs) {
  if (!gpsSamples.length) return null;
  if (gpsSamples.length === 1) return { lat: gpsSamples[0].lat, lng: gpsSamples[0].lng };

  var idx = upperBoundByTime(gpsSamples, tMs);
  if (idx <= 0) return { lat: gpsSamples[0].lat, lng: gpsSamples[0].lng };
  if (idx >= gpsSamples.length) {
    var last = gpsSamples[gpsSamples.length - 1];
    return { lat: last.lat, lng: last.lng };
  }

  var a = gpsSamples[idx - 1];
  var b = gpsSamples[idx];
  if (b.t === a.t) return { lat: b.lat, lng: b.lng };

  var alpha = (tMs - a.t) / (b.t - a.t);
  alpha = clamp(alpha, 0, 1);

  return {
    lat: a.lat + (b.lat - a.lat) * alpha,
    lng: a.lng + (b.lng - a.lng) * alpha
  };
}

function getBpmAtTime(tMs) {
  if (!bpmSamples.length) return null;
  var idx = upperBoundByTime(bpmSamples, tMs);
  if (idx <= 0) return bpmSamples[0].bpm;
  return bpmSamples[idx - 1].bpm;
}

function getDistanceAtTime(tMs) {
  if (!gpsSamples.length) return null;
  if (gpsSamples.length === 1) return gpsSamples[0].cumDistM || 0;

  var idx = upperBoundByTime(gpsSamples, tMs);
  if (idx <= 0) return gpsSamples[0].cumDistM || 0;
  if (idx >= gpsSamples.length) return gpsSamples[gpsSamples.length - 1].cumDistM || 0;

  var a = gpsSamples[idx - 1];
  var b = gpsSamples[idx];
  var alpha = clamp((tMs - a.t) / Math.max(1, (b.t - a.t)), 0, 1);

  var da = a.cumDistM || 0;
  var db = b.cumDistM || da;
  return da + (db - da) * alpha;
}

function getSpeedAtTime(tMs) {
  if (!gpsSamples.length) return null;
  if (gpsSamples.length === 1) return gpsSamples[0].speedKmh || 0;

  var idx = upperBoundByTime(gpsSamples, tMs);
  if (idx <= 0) return gpsSamples[0].speedKmh || 0;
  if (idx >= gpsSamples.length) return gpsSamples[gpsSamples.length - 1].speedKmh || 0;

  var a = gpsSamples[idx - 1];
  var b = gpsSamples[idx];
  var alpha = clamp((tMs - a.t) / Math.max(1, (b.t - a.t)), 0, 1);

  var sa = a.speedKmh || 0;
  var sb = b.speedKmh || sa;
  return sa + (sb - sa) * alpha;
}

function updateProgressRouteToTime(tMs) {
  if (!progressRoute) return;
  if (!gpsSamples.length) { progressRoute.setLatLngs([]); return; }

  var idx = upperBoundByTime(gpsSamples, tMs);
  idx = clamp(idx, 0, gpsSamples.length);

  var pts = [];
  for (var i = 0; i < idx; i++) pts.push([gpsSamples[i].lat, gpsSamples[i].lng]);

  if (idx > 0 && idx < gpsSamples.length) {
    var interp = getInterpolatedGpsAtTime(tMs);
    if (interp) pts.push([interp.lat, interp.lng]);
  }

  progressRoute.setLatLngs(pts);
}

// ==========================================
// PARSING SENSOR UPDATE (robusto)
// ==========================================
function processIncomingData(data) {
  var str = (typeof data === 'object') ? JSON.stringify(data) : String(data);

  // BPM sporco dentro sensor_update
  var bpmMatch = str.match(/"bpm"\s*:\s*(\d+)/);
  if (bpmMatch && bpmMatch[1]) {
    var v = parseInt(bpmMatch[1]);
    if (!isNaN(v) && v > 0) {
      onBpmUpdate(v);
      return;
    }
  }

  var payload = null;
  if (typeof data === 'object') {
    payload = data.data || data;
  } else {
    var jsonStart = str.indexOf('{');
    var jsonEnd = str.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      try { payload = JSON.parse(str.substring(jsonStart, jsonEnd + 1)); } catch (e) {}
    }
  }

  if (payload && payload.sensor_name) {
    var name = payload.sensor_name;
    if (name.includes("COOSPO") || name === "HRM") return;
    if (name === 'PROFILE_INFO') { updateProfileUI(payload); return; }

    sensors[name] = payload;

    var empty = document.getElementById('empty-state');
    if (empty) empty.style.display = 'none';

    updateSensorCardUI(name, payload);
    updateChartsUI(name, payload);
  }
}

// ==========================================
// UI: SENSOR CARDS
// ==========================================
function createSensorCard(name, data) {
  var hasAccel = data.accel_x !== undefined;
  var hasGyro = data.gyro_x !== undefined;
  var hasMag = data.mag_x !== undefined;
  var hasPressure = data.pressure_0 !== undefined;
  if (!hasAccel && !hasGyro && !hasMag && !hasPressure) return;

  var grid = document.getElementById('sensors-grid');
  if (!grid) return;

  var existing = document.querySelector(`[data-sensor="${name}"]`);
  if (existing) return;

  var div = document.createElement('div');
  div.className = 'sensor-card sensor-col connected';
  div.setAttribute('data-sensor', name);

  var emoji = '📱';
  var n = String(name).toLowerCase();
  if (n.includes('knee') || n.includes('ginocchio')) emoji = '🦿';
  if (n.includes('foot') || n.includes('sock') || n.includes('calzino')) emoji = '🧦';

  var html = `<div class="sensor-header">
    <span>${emoji} ${name}</span>
    <div class="status-indicator active"></div>
  </div>`;

  if (hasAccel) {
    html += `<div class="sensor-data-section">
      <div class="sensor-data-section-title">Accelerometro</div>
      <div class="sensor-data-row"><span class="sensor-data-label">AX</span> <span class="sensor-value" data-key="accel_x">0</span></div>
      <div class="sensor-data-row"><span class="sensor-data-label">AY</span> <span class="sensor-value" data-key="accel_y">0</span></div>
      <div class="sensor-data-row"><span class="sensor-data-label">AZ</span> <span class="sensor-value" data-key="accel_z">0</span></div>
    </div>`;
  }

  if (hasGyro) {
    html += `<div class="sensor-data-section">
      <div class="sensor-data-section-title">Giroscopio</div>
      <div class="sensor-data-row"><span class="sensor-data-label">GX</span> <span class="sensor-value" data-key="gyro_x">0</span></div>
      <div class="sensor-data-row"><span class="sensor-data-label">GY</span> <span class="sensor-value" data-key="gyro_y">0</span></div>
      <div class="sensor-data-row"><span class="sensor-data-label">GZ</span> <span class="sensor-value" data-key="gyro_z">0</span></div>
    </div>`;
  }

  if (hasMag) {
    html += `<div class="sensor-data-section">
      <div class="sensor-data-section-title">Magnetometro</div>
      <div class="sensor-data-row"><span class="sensor-data-label">MX</span> <span class="sensor-value" data-key="mag_x">0</span></div>
      <div class="sensor-data-row"><span class="sensor-data-label">MY</span> <span class="sensor-value" data-key="mag_y">0</span></div>
      <div class="sensor-data-row"><span class="sensor-data-label">MZ</span> <span class="sensor-value" data-key="mag_z">0</span></div>
    </div>`;
  }

  if (hasPressure) {
    html += `<div class="sensor-data-section" style="border:none;">
      <div class="sensor-data-section-title">Pressioni</div>
      <div class="sensor-data-row"><span class="sensor-data-label">P0</span> <span class="sensor-value" style="color:#ffce56;" data-key="pressure_0">0</span></div>
      <div class="sensor-data-row"><span class="sensor-data-label">P1</span> <span class="sensor-value" style="color:#ffce56;" data-key="pressure_1">0</span></div>
      <div class="sensor-data-row"><span class="sensor-data-label">P2</span> <span class="sensor-value" style="color:#ffce56;" data-key="pressure_2">0</span></div>
    </div>`;
  }

  div.innerHTML = html;
  grid.appendChild(div);
}

function updateSensorCardUI(name, data) {
  var card = document.querySelector(`[data-sensor="${name}"]`);
  if (!card) { createSensorCard(name, data); updateSelector(); return; }

  Object.keys(data).forEach(k => {
    var el = card.querySelector(`[data-key="${k}"]`);
    if (el) el.textContent = Math.round(data[k]);
  });
}

function updateSelector() {
  var sel = document.getElementById('chart-sensor-select');
  var container = document.getElementById('selector-container');
  if (!sel || !container) return;

  var current = sel.value;
  var names = Object.keys(sensors);

  sel.innerHTML = '<option value="">-- Seleziona sensore --</option>';
  names.forEach(n => {
    var opt = document.createElement('option');
    opt.value = n; opt.textContent = n;
    sel.appendChild(opt);
  });

  if (names.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = 'block';
  if (current && sensors[current]) sel.value = current;
  else if (!selectedSensor && names.length > 0) {
    sel.value = names[0];
    sel.dispatchEvent(new Event('change'));
  }
}

// ==========================================
// UI: PROFILO
// ==========================================
function updateProfileUI(data) {
  var div = document.getElementById('user-profile-display');
  if (!data || !data.name || !div) return;

  div.style.display = 'flex';
  var nameEl = document.getElementById('profile-name');
  var avEl = document.getElementById('profile-avatar');
  var detEl = document.getElementById('profile-details');

  if (nameEl) nameEl.textContent = String(data.name).toUpperCase();
  if (avEl) avEl.textContent = data.avatar || "👤";

  var gender = data.gender === 'M' ? '♂' : (data.gender === 'F' ? '♀' : '');
  if (detEl) detEl.textContent = `${data.age} anni | ${data.weight} kg | ${gender}`;
}

// ==========================================
// GRAFICI (uPlot)
// ==========================================
function updateChartsUI(sensorName, data) {
  if (selectedSensor !== sensorName || !chartsInitialized) return;

  var timestamp = Date.now() / 1000;
  var cCont = document.getElementById('charts-container');
  if (cCont && cCont.style.display === 'none') cCont.style.display = 'block';

  const push = (arr, vals) => {
    arr[0].push(timestamp);
    vals.forEach((v, i) => arr[i + 1].push(v || 0));
    if (arr[0].length > 1000) arr.forEach(s => s.shift());
  };

  if (data.accel_x !== undefined && charts.accel) {
    push(chartData.accel, [data.accel_x, data.accel_y, data.accel_z]);
    charts.accel.setData(chartData.accel);
    autoScroll(charts.accel, chartData.accel);
  }
  if (data.gyro_x !== undefined && charts.gyro) {
    push(chartData.gyro, [data.gyro_x, data.gyro_y, data.gyro_z]);
    charts.gyro.setData(chartData.gyro);
    autoScroll(charts.gyro, chartData.gyro);
  }
  if (data.mag_x !== undefined && charts.mag) {
    push(chartData.mag, [data.mag_x, data.mag_y, data.mag_z]);
    charts.mag.setData(chartData.mag);
    autoScroll(charts.mag, chartData.mag);
  }
  if (data.pressure_0 !== undefined && charts.pressure) {
    push(chartData.pressure, [data.pressure_0, data.pressure_1, data.pressure_2]);
    charts.pressure.setData(chartData.pressure);
    autoScroll(charts.pressure, chartData.pressure);

    var pc = document.getElementById('pressure-chart-container');
    if (pc) pc.style.display = 'block';
  } else {
    var pc2 = document.getElementById('pressure-chart-container');
    if (pc2) pc2.style.display = 'none';
  }
}

function autoScroll(u, data) {
  if (!isUserInteracting) {
    var xData = data[0];
    if (xData.length < 2) return;
    var lastTime = xData[xData.length - 1];
    var minX = lastTime - 10;
    if (xData[0] > minX) minX = xData[0];
    u.setScale('x', { min: minX, max: lastTime });
  }
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

function initCharts() {
  var accelDiv = document.getElementById('accel-chart');
  var gyroDiv = document.getElementById('gyro-chart');
  var magDiv = document.getElementById('mag-chart');
  var pressureDiv = document.getElementById('pressure-chart');
  if (!accelDiv || !gyroDiv || !magDiv || !pressureDiv) return;

  accelDiv.innerHTML = ''; gyroDiv.innerHTML = ''; magDiv.innerHTML = ''; pressureDiv.innerHTML = '';

  var commonOpts = () => ({
    width: accelDiv.offsetWidth,
    height: 200,
    cursor: { show: true, drag: { x: true, y: false } },
    scales: { x: { time: true }, y: { auto: true } },
    axes: [
      { stroke: SENSORIA_GREEN, grid: { stroke: '#333' }, values: (u, vals) => vals.map(v => new Date(v * 1000).toLocaleTimeString()) },
      { stroke: SENSORIA_GREEN, grid: { stroke: '#333' }, size: 50 }
    ],
    plugins: [wheelZoomPlugin()]
  });

  var opts1 = commonOpts();
  opts1.series = [{}, { label: 'X', stroke: '#ff6384', width: 2 }, { label: 'Y', stroke: '#36a2eb', width: 2 }, { label: 'Z', stroke: '#4bc0c0', width: 2 }];
  charts.accel = new uPlot(opts1, chartData.accel, accelDiv);
  addInteraction(charts.accel);

  var opts2 = commonOpts();
  opts2.series = [{}, { label: 'X', stroke: '#ff9f40', width: 2 }, { label: 'Y', stroke: '#9966ff', width: 2 }, { label: 'Z', stroke: '#ffcd56', width: 2 }];
  charts.gyro = new uPlot(opts2, chartData.gyro, gyroDiv);
  addInteraction(charts.gyro);

  var opts3 = commonOpts();
  opts3.series = [{}, { label: 'X', stroke: '#c9cbcf', width: 2 }, { label: 'Y', stroke: '#4bc0c0', width: 2 }, { label: 'Z', stroke: '#ff6384', width: 2 }];
  charts.mag = new uPlot(opts3, chartData.mag, magDiv);
  addInteraction(charts.mag);

  var opts4 = commonOpts();
  opts4.height = 250;
  opts4.scales.y = { auto: false, range: [0, 1024] };
  opts4.series = [{}, { label: 'P0', stroke: '#ff6384', width: 3 }, { label: 'P1', stroke: '#36a2eb', width: 3 }, { label: 'P2', stroke: '#ffce56', width: 3 }];
  charts.pressure = new uPlot(opts4, chartData.pressure, pressureDiv);
  addInteraction(charts.pressure);
}

function wheelZoomPlugin() {
  return {
    hooks: {
      init: (u) => {
        u.over.addEventListener("wheel", e => {
          e.preventDefault();
          var { min, max } = u.scales.x;
          var range = max - min;
          var factor = e.deltaY < 0 ? 0.9 : 1.1;
          var newRange = range * factor;
          if (newRange < MIN_ZOOM_RANGE) newRange = MIN_ZOOM_RANGE;
          var center = min + range / 2;
          u.setScale('x', { min: center - newRange / 2, max: center + newRange / 2 });
        });
        u.over.addEventListener("dblclick", () => { isUserInteracting = false; });
      }
    }
  };
}

function addInteraction(u) {
  u.over.addEventListener('mousedown', () => isUserInteracting = true);
  u.over.addEventListener('wheel', () => isUserInteracting = true);
}

