// ==========================================
// dashboard.js (Sensoria Dashboard)
// ==========================================

// Socket
var socket = io({
  transports: ['websocket'],
  reconnection: true,
  reconnectionDelay: 500
});

// UI colors
const SENSORIA_GREEN = '#97c93e';

// =========================
// SENSORI / DATI
// =========================
var sensors = {};

// --- TIMELINE (time-based) ---
var sessionStartTimeMs = null;
var sessionEndTimeMs = null;
var isReplayMode = false;

var gpsSamples = []; // { t, lat, lng, acc, cumDistM, speedKmh }
var bpmSamples = []; // { t, bpm }
var lastLiveBpm = "--";

// =========================
// MAPPA
// =========================
var map = null;
var mapMarker = null;
var isMapInitialized = false;

var fullRoute = null;      // polilinea intera
var progressRoute = null;  // polilinea fino al tempo (replay/live)

var currentMapPos = null;
var targetMapPos = null;
var startMapPos = null;
var animationStartTime = null;
var animationFrameId = null;
const ANIMATION_DURATION = 700;

// rotation
var mapRotationDeg = 0;

// =========================
// METRIC CARDS (BPM/SPEED/DIST)
// =========================
const METRIC_CARD_W = 190;
const METRIC_CARD_H = 64;

// =========================
// GRAFICI
// =========================
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
var leftSockSamples = [];  
var rightSockSamples = []; 

var sockCharts = { left: null, right: null };
var sockChartData = { left: [[], [], [], []], right: [[], [], [], []] };

function initSockCharts() {
    const leftEl = document.getElementById('chart-left-p');
    const rightEl = document.getElementById('chart-right-p');
    if (!leftEl || !rightEl) return;

    const makeOpts = (container, title) => ({
        width: container.offsetWidth,
        height: 130,
        scales: { 
            x: { time: false }, // Usiamo secondi dall'inizio attività
            y: { auto: false, range: [0, 1100] } 
        },
        series: [
            {}, // Tempo (Asse X)
            { label: "P0", stroke: "#ffb74d", width: 2, points: { show: false } },
            { label: "P1", stroke: "#e91e63", width: 2, points: { show: false } },
            { label: "P2", stroke: "#4fc3f7", width: 2, points: { show: false } }
        ],
        axes: [{ show: false }, { show: false }],
        legend: { show: true, live: false }, // Legenda cliccabile
        cursor: { show: true, sync: { key: "socks" } }
    });

    if (!sockCharts.left) sockCharts.left = new uPlot(makeOpts(leftEl, "SX"), sockChartData.left, leftEl);
    if (!sockCharts.right) sockCharts.right = new uPlot(makeOpts(rightEl, "DX"), sockChartData.right, rightEl);
}


// Aggiorna UI Calzini (Chiamala da processIncomingData e enterReplayAtSecond)
function updateSocksAnalysisUI(side, data, bi) {
    if (!sockCharts.left) initSockCharts();

    const t = Date.now() / 1000;
    const targetData = sockChartData[side];
    const targetChart = sockCharts[side];

    // Aggiorna Dati Grafico
    targetData[0].push(t);
    targetData[1].push(data.pressure_0);
    targetData[2].push(data.pressure_1);
    targetData[3].push(data.pressure_2);
    
    // Mantieni ultimi 100 punti
    if (targetData[0].length > 100) targetData.forEach(arr => arr.shift());
    targetChart.setData(targetData);

    // Aggiorna Valore BI (Bongiorno Index)
    const biDisplay = document.getElementById('bi-value-display');
    if (biDisplay) {
        biDisplay.textContent = `${bi.toFixed(1)}%`;
        // Colora in base all'intensità (opzionale)
        biDisplay.style.color = bi > 40 ? '#ff4444' : '#97c93e';
    }
}


function calculateBI(payload) {
    if (payload.accel_x == null || payload.accel_y == null || payload.accel_z == null) return 0;
    const ax = payload.accel_x;
    const ay = payload.accel_y;
    const az = payload.accel_z;
    const norm = Math.sqrt(ax*ax + ay*ay + az*az);
    return norm > 0.1 ? (Math.abs(ax) / norm) * 100 : 0;
}

function updateSocksUI(side, data, bi) {
    const prefix = side === 'left' ? 'l' : 'r';
    
    // 1. Aggiorna BI
    const biEl = document.getElementById(`bi-val-${side}`);
    if (biEl) {
        biEl.textContent = `BI: ${bi.toFixed(1)}%`;
        biEl.style.color = bi > 40 ? '#ff4444' : SENSORIA_GREEN;
    }

    // 2. Aggiorna Numeri (Gestione p0 vs pressure_0)
    const val0 = data.p0 ?? data.pressure_0 ?? 0;
    const val1 = data.p1 ?? data.pressure_1 ?? 0;
    const val2 = data.p2 ?? data.pressure_2 ?? 0;

    const el0 = document.getElementById(`${prefix}-p0`);
    const el1 = document.getElementById(`${prefix}-p1`);
    const el2 = document.getElementById(`${prefix}-p2`);

    if (el0) el0.textContent = Math.round(val0);
    if (el1) el1.textContent = Math.round(val1);
    if (el2) el2.textContent = Math.round(val2);

    // 3. Update Grafico Live
    if (!isReplayMode && sockCharts[side]) {
        const d = sockChartData[side];
        const tRel = (Date.now() - sessionStartTimeMs) / 1000;
        d[0].push(tRel); d[1].push(val0); d[2].push(val1); d[3].push(val2);
        if (d[0].length > 100) d.forEach(a => a.shift());
        sockCharts[side].setData(d);
    }
}


// ==========================================
// INIZIALIZZAZIONE
// ==========================================
document.addEventListener('DOMContentLoaded', function () {
  initSocket();
  ensureMapDomOverlay();
  ensureMetricsCardsUI();
  initPastActivityLoader();

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

// ==========================================
// SOCKET
// ==========================================
function initSocket() {
  socket.on('connect', () => {
    var el = document.getElementById('connection-status');
    if (el) {
      el.className = '';
      el.innerHTML = '<span class="dot"></span> Connesso';
    }
  });

  socket.on('disconnect', () => {
    var el = document.getElementById('connection-status');
    if (el) {
      el.className = 'disconnected';
      el.innerHTML = '<span class="dot"></span> Disconnesso';
    }
  });

  socket.on('sensor_update', (data) => processIncomingData(data));
  socket.on('bpm_update', (val) => onBpmUpdate(val));
  socket.on('profile_update', (data) => updateProfileUI(data));
  socket.on('gps_update', (data) => onGpsUpdate(data));

  socket.on('data_cleared', () => {
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
function getNowMs() { return Date.now(); }

function ensureSessionStart(tMs) {
  if (sessionStartTimeMs == null) sessionStartTimeMs = tMs;
}

function getSessionEndMs() {
  if (!gpsSamples.length) return sessionStartTimeMs || Date.now();
  
  // Prendi l'ultimo GPS valido
  const lastGps = gpsSamples[gpsSamples.length - 1].t;
  
  // Se la sessione supera le 2 ore, probabilmente c'è un timestamp errato
  const diff = lastGps - sessionStartTimeMs;
  if (diff > 7200000) { // 2 ore
      console.warn("Rilevato timestamp anomalo, tronco la durata.");
      return sessionStartTimeMs + (gpsSamples.length * 1000); // Fallback: 1 sec per campione
  }
  return lastGps;
}

function getDurationSec() {
  if (!sessionStartTimeMs) return 0;
  const duration = (getSessionEndMs() - sessionStartTimeMs) / 1000;
  return Math.max(0, duration);
}


function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

// ==========================================
// HAVERSINE + FORMAT
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
// METRIC CARDS UI (3 card identiche)
// ==========================================
function ensureMetricsCardsUI() {
  // Nascondi vecchio #bpm-display (se presente nell'HTML originale)
  var oldBpm = document.getElementById('bpm-display');
  if (oldBpm) oldBpm.style.display = 'none';

  // wrapper top-right
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
  } else {
    const mapDiv = document.getElementById('map');
    if (mapDiv && wrap.parentElement !== mapDiv) mapDiv.appendChild(wrap);
  }

  if (!document.getElementById('metric-bpm')) {
    wrap.appendChild(buildMetricCard({
      id: 'metric-bpm',
      emoji: '❤️',
      label: 'BPM LIVE',
      labelColor: 'rgba(255, 65, 54, 0.95)',
      borderColor: 'rgba(255, 65, 54, 0.70)',
      valueId: 'bpm-value',
      unitText: ''
    }));
  }

  if (!document.getElementById('metric-speed')) {
    wrap.appendChild(buildMetricCard({
      id: 'metric-speed',
      emoji: '⚡',
      label: 'VELOCITÀ',
      labelColor: 'rgba(255, 149, 0, 0.95)',
      borderColor: 'rgba(255, 149, 0, 0.70)',
      valueId: 'speed-value',
      unitText: 'km/h'
    }));
  }

  if (!document.getElementById('metric-dist')) {
    wrap.appendChild(buildMetricCard({
      id: 'metric-dist',
      emoji: '📍',
      label: 'DISTANZA',
      labelColor: 'rgba(255, 214, 10, 0.95)',
      borderColor: 'rgba(255, 214, 10, 0.70)',
      valueId: 'distance-value',
      unitText: 'km'
    }));
  }
}

function buildMetricCard({ id, emoji, label, labelColor, borderColor, valueId, unitText }) {
  const card = document.createElement('div');
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
    <div style="font-size:26px; line-height:1; width:34px; text-align:center;">
      ${emoji}
    </div>

    <div style="flex:1; display:flex; flex-direction:column; align-items:flex-start; gap:2px;">
      <div id="${valueId}" style="font-family:monospace; font-size:14px; font-weight:900; color:#fff;">
        --
      </div>
      <div style="font-size:10px; font-weight:900; letter-spacing:1px; color:${labelColor};">
        ${label}
      </div>
    </div>
  `;

  if (unitText) {
    const valueEl = card.querySelector(`#${valueId}`);
    if (valueEl) valueEl.textContent = `-- ${unitText}`;
  }

  return card;
}

function updateBpmValue(val) {
  ensureMetricsCardsUI();
  const el = document.getElementById('bpm-value');
  if (!el) return;
  el.textContent = String(val);
}

function updateSpeedDistanceUI(speedKmh, distMeters) {
  ensureMetricsCardsUI();
  const sEl = document.getElementById('speed-value');
  const dEl = document.getElementById('distance-value');
  if (sEl) sEl.textContent = `${formatKmh(speedKmh)} km/h`;
  if (dEl) dEl.textContent = `${formatKmFromMeters(distMeters)} km`;
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
    updateBpmValue(bpmInt);
    updateReplayUiBounds();
    showReplayOverlayIfReady();
  }
}

// ==========================================
// GPS (LIVE + TIMELINE + MAP)
// ==========================================
// --- Variabili di stato per i filtri (mettile fuori dalla funzione) ---

// --- Assicurati che queste siano definite in alto nel file ---
var lastSpeedCalcPos = null; 
var currentSmoothedSpeed = 0; 
const EMA_ALPHA = 0.35;
const MAX_SPEED_PATTINAGGIO = 75;

/**
 * Pipeline GPS Professionale (Stile Strava/Garmin)
 * 1. Filtro Accuracy Pesato
 * 2. Smoothing Spaziale (Soglia dinamica)
 * 3. Derivata Temporale Coerente (Dist/Tempo sulla stessa finestra)
 * 4. Smoothing Temporale (EMA)
 */
function onGpsUpdate(data) {
  const lat = data.latitude;
  const lng = data.longitude;
  const acc = data.accuracy || 10;
  const tMs = data.t || (data.timestamp ? new Date(data.timestamp).getTime() : Date.now());

  // Inizializzazione sessione e mappa
  ensureSessionStart(tMs);
  ensureMapInitialized(lat, lng);

  const prev = gpsSamples.length > 0 ? gpsSamples[gpsSamples.length - 1] : null;
  
  if (!prev) {
    gpsSamples.push({ t: tMs, lat, lng, acc, cumDistM: 0, speed: 0 });
    lastSpeedCalcPos = { lat, lng, t: tMs };
    return;
  }

  // 1. CLAMP DEL DELTA TEMPO (Evita salti temporali del backend/BLE)
  let dtS = (tMs - prev.t) / 1000;
  if (dtS <= 0) return; // Salta campioni duplicati o fuori ordine
  dtS = Math.min(dtS, 5.0); // Se passa troppo tempo (es. tunnel), limita a 5s

  // 2. FILTRO ACCURACY PESATO E SOGLIA RUMORE
  const dM_step = haversineMeters(prev.lat, prev.lng, lat, lng);
  
  // Applichiamo la soglia di 0.8m per eliminare il rumore da fermo (Zitter)
  // E scartiamo se l'accuratezza è pessima (> 25m)
  let validDist = 0;
  if (dM_step > 0.8 && acc < 25) {
      // Peso l'accuratezza: se acc è alta, riduco il contributo (smoothing spaziale)
      const accWeight = acc < 10 ? 1 : (acc < 20 ? 0.5 : 0.2);
      validDist = dM_step * accWeight;
  }

  // 3. AGGIORNAMENTO DISTANZA CUMULATIVA
  const newCumDistM = prev.cumDistM + validDist;
  
  // 4. CALCOLO VELOCITÀ SULLA STESSA FINESTRA (Coerenza Totale)
  // Usiamo una finestra di ~1.5s per evitare fluttuazioni eccessive
  const dtS_win = (tMs - lastSpeedCalcPos.t) / 1000;
  
  if (dtS_win >= 1.5) {
    const dM_win = haversineMeters(lastSpeedCalcPos.lat, lastSpeedCalcPos.lng, lat, lng);
    
    // Filtro di plausibilità sulla finestra
    let rawSpeed = 0;
    if (dM_win > 1.2) { // Soglia minima di movimento nella finestra
       rawSpeed = (dM_win / dtS_win) * 3.6;
    }

    // Limite umano corsa (40 km/h) per evitare picchi GPS (jump)
    rawSpeed = Math.min(rawSpeed, 40.0);

    // 5. SMOOTHING TEMPORALE (EMA)
    // Alpha più alto (0.35) per essere reattivi ma stabili
    const ALPHA = 0.35;
    currentSmoothedSpeed = (rawSpeed * ALPHA) + (currentSmoothedSpeed * (1 - ALPHA));
    
    // Aggiorno il punto di riferimento per la prossima finestra
    lastSpeedCalcPos = { lat, lng, t: tMs };
  }

  // Salvo il campione con i dati processati
  gpsSamples.push({
    t: tMs,
    lat,
    lng,
    acc,
    cumDistM: newCumDistM,
    speed: currentSmoothedSpeed
  });

  // Aggiorno la UI (solo se non siamo in Replay mode)
  if (!isReplayActive) {
    updateDashboardUI(currentSmoothedSpeed, newCumDistM, lat, lng);
  }
}

function updateDashboardUI(speed, distM, lat, lng) {
    const speedEl = document.getElementById('speed-val');
    const distEl = document.getElementById('dist-val');
    
    if (speedEl) speedEl.innerText = speed.toFixed(1);
    if (distEl) distEl.innerText = (distM / 1000).toFixed(2);
    
    // Aggiornamento mappa e tracciati
    if (map && mapMarker) {
        const pos = [lat, lng];
        mapMarker.setLatLng(pos);
        fullRoute.addLatLng(pos);
        progressRoute.addLatLng(pos);
        if (followMarker) map.panTo(pos);
    }
}


// ==========================================
// MAP INIT + PANES
// ==========================================
function ensureMapDomOverlay() {
  var mapDiv = document.getElementById('map');
  if (!mapDiv) return;
  mapDiv.style.position = 'relative';
}

function ensureMapInitialized(lat, lng) {
  if (isMapInitialized) return;

  var section = document.getElementById('map-section');
  if (section) section.style.display = 'block';

  ensureMapDomOverlay();

  map = L.map('map', {
    attributionControl: false,
    zoomControl: true
  }).setView([lat, lng], 19);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20
  }).addTo(map);

  // panes per ordine layer [web:29]
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

  mapMarker = L.marker([lat, lng], {
    icon: pulseIcon,
    pane: 'markerPane'
  }).addTo(map);

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
  createRotateControl();
  ensureMetricsCardsUI();

  isMapInitialized = true;
  setTimeout(() => map.invalidateSize(), 120);
}

// ==========================================
// MARKER ANIMATION (LIVE)
// ==========================================
function animateMarkerLoop() {
  if (!startMapPos || !targetMapPos || !mapMarker || isReplayMode) {
    animationFrameId = null;
    return;
  }

  var now = performance.now();
  var elapsed = now - animationStartTime;
  var p = elapsed / ANIMATION_DURATION;
  if (p > 1) p = 1;

  var lat = startMapPos.lat + (targetMapPos.lat - startMapPos.lat) * p;
  var lng = startMapPos.lng + (targetMapPos.lng - startMapPos.lng) * p;

  currentMapPos = { lat: lat, lng: lng };
  mapMarker.setLatLng([lat, lng]);

  if (p < 1) animationFrameId = requestAnimationFrame(animateMarkerLoop);
  else animationFrameId = null;
}

// ==========================================
// ROTATE CONTROL (button)
// ==========================================
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
    top:90px;
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
    mapRotationDeg = (mapRotationDeg + 90) % 360;
    applyMapRotation(mapRotationDeg);
  });

  mapDiv.appendChild(btn);
}

function applyMapRotation(deg) {
  if (!map) return;

  const container = map.getContainer();
  const mapPane = container.querySelector('.leaflet-map-pane');
  if (!mapPane) return;

  // preserva l'eventuale translate di Leaflet e aggiorna solo la rotate
  const style = window.getComputedStyle(mapPane);
  const current = (style.transform && style.transform !== 'none') ? style.transform : '';

  const cleaned = current.replace(/rotate\([^)]*\)/, '').trim();
  const next = `${cleaned} rotate(${deg}deg)`.trim();

  mapPane.style.transformOrigin = '50% 50%';
  mapPane.style.transition = 'transform 0.25s ease-out';
  mapPane.style.transform = next;

  // forza un refresh dopo la transform (invalidateSize è la chiamata Leaflet standard) [web:21]
  setTimeout(() => {
    map.invalidateSize(true);
    const c = map.getCenter();
    map.panTo(c, { animate: false });
  }, 260);
}


// ==========================================
// REPLAY OVERLAY (slider + LIVE)
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
      <div style="font-size:10px; letter-spacing:1px; color:#9aa; font-weight:700;">TIME</div>
      <div id="replay-time-label" style="font-family:monospace; font-size:13px; color:#fff; font-weight:700;">00:00</div>
    </div>

    <input id="replay-slider" type="range" min="0" max="0" value="0" step="0.1"
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

  // blocca propagazione verso Leaflet (click/scroll)
  if (window.L && L.DomEvent) {
    L.DomEvent.disableClickPropagation(overlay);
    L.DomEvent.disableScrollPropagation(overlay);
  }

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

  function seekToSliderValue() {
    const sec = parseFloat(slider.value || "0");
    enterReplayAtSecond(sec);
  }

  function setSliderFromClientX(clientX) {
    const rect = slider.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, rect.width);
    const pct = rect.width > 0 ? (x / rect.width) : 0;

    const min = parseFloat(slider.min || "0");
    const max = parseFloat(slider.max || "0");

    const val = min + pct * (max - min);
    slider.value = val.toFixed(1);     // precisione 0.1s
    seekToSliderValue();
  }

  // thumb drag (continua)
  slider.addEventListener('input', () => {
    if (!scrubbing) seekToSliderValue();
  });

  // click + drag ovunque sulla barra
  slider.addEventListener('pointerdown', (e) => {
    scrubbing = true;
    slider.setPointerCapture(e.pointerId);
    lockMapInteractions(true);

    setSliderFromClientX(e.clientX);
    e.preventDefault();
    e.stopPropagation();
  });

  slider.addEventListener('pointermove', (e) => {
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

  slider.addEventListener('pointerup', endScrub);
  slider.addEventListener('pointercancel', endScrub);

  // fallback anti-pan
  slider.addEventListener('mousedown', (e) => e.stopPropagation());
  slider.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });

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
  slider.step = "0.1";

  if (!isReplayMode) {
    slider.value = maxSec.toFixed(1);
    updateReplayTimeLabel(maxSec);
  }
}


function updateReplayTimeLabel(sec) {
  var lab = document.getElementById('replay-time-label');
  if (!lab) return;

  // label in mm:ss (arrotondo solo per display)
  var whole = Math.max(0, Math.round(sec));
  var m = Math.floor(whole / 60).toString().padStart(2, '0');
  var s = (whole % 60).toString().padStart(2, '0');
  lab.textContent = `${m}:${s}`;
}


// ==========================================
// LOOKUP / REPLAY
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

/**
 * Sposta l'intera dashboard (mappa, grafici, metriche) a un secondo specifico dell'attività.
 * @param {number} sec - Secondi trascorsi dall'inizio della sessione.
 */
function enterReplayAtSecond(sec) {
  if (sessionStartTimeMs == null) return;

  // Imposta la modalità replay e ferma eventuali animazioni live del marker
  isReplayMode = true;
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  // 1. Calcolo del timestamp assoluto
  const durationSec = getDurationSec();
  const clampedSec = Math.max(0, Math.min(sec, durationSec));
  const tMs = sessionStartTimeMs + (clampedSec * 1000);

  // 2. Aggiornamento Label Temporale mm:ss
  updateReplayTimeLabel(clampedSec);

  // 3. MAPPA: Posizionamento Marker e Tracciato progressivo
  const pos = getInterpolatedGpsAtTime(tMs);
  if (pos && mapMarker) {
    mapMarker.setLatLng([pos.lat, pos.lng]);
    currentMapPos = { lat: pos.lat, lng: pos.lng };
    
    // Se la rotazione è attiva o vuoi centrare la mappa durante il replay
    // map.panTo([pos.lat, pos.lng], { animate: false }); 
  }
  updateProgressRouteToTime(tMs);

  // 4. METRICHE: BPM, Velocità e Distanza al tempo T
  const bpm = getBpmAtTime(tMs);
  if (bpm != null) updateBpmValue(bpm);

  const speed = getSpeedAtTime(tMs);
  const dist = getDistanceAtTime(tMs);
  updateSpeedDistanceUI(speed, dist);

  // 5. GRAFICI CALZINI: Sincronizzazione Finestra Temporale (Zoom)
  // Definiamo una finestra di 10 secondi (5 prima e 5 dopo il punto attuale)
  const windowHalf = 5; 
  const tMin = Math.max(0, clampedSec - windowHalf);
  const tMax = tMin + (windowHalf * 2);

  if (sockCharts.left) {
    sockCharts.left.setScale("x", { min: tMin, max: tMax });
  }
  if (sockCharts.right) {
    sockCharts.right.setScale("x", { min: tMin, max: tMax });
  }

  // 6. UI CALZINI: Valori numerici e Bongiorno Index istantaneo
  const lS = findSampleAtTime(leftSockSamples, tMs);
  if (lS) {
    updateSocksUI('left', { pressure_0: lS.p0, pressure_1: lS.p1, pressure_2: lS.p2 }, lS.bi);
  }

  const rS = findSampleAtTime(rightSockSamples, tMs);
  if (rS) {
    updateSocksUI('right', { pressure_0: rS.p0, pressure_1: rS.p1, pressure_2: rS.p2 }, rS.bi);
  }

  // 7. Sincronizzazione Slider UI (se non è l'utente a trascinarlo)
  const slider = document.getElementById('replay-slider');
  if (slider && Math.abs(parseFloat(slider.value) - clampedSec) > 0.5) {
    slider.value = clampedSec.toFixed(1);
  }
}


// Funzione helper per trovare il campione più vicino nel tempo
function findSampleAtTime(arr, tMs) {
    if (!arr || !arr.length) return null;
    let idx = upperBoundByTime(arr, tMs);
    return idx > 0 ? arr[idx - 1] : arr[0];
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

  if (lastLiveBpm !== "--") updateBpmValue(lastLiveBpm);

  if (gpsSamples.length) {
    var lastG = gpsSamples[gpsSamples.length - 1];
    updateSpeedDistanceUI(lastG.speedKmh, lastG.cumDistM);
  }
}

// ==========================================
// PARSING sensor_update (robusto)
// ==========================================
function processIncomingData(data) {
  var payload = (typeof data === 'object') ? (data.data || data) : data;
  
  if (payload && (payload.sensor_name || payload.name)) {
    const name = (payload.sensor_name || payload.name).toLowerCase();
    const tMs = Date.now();
    ensureSessionStart(tMs);

    // Mappatura flessibile dei campi pressione
    const pData = {
        p0: payload.pressure_0 ?? payload.p0 ?? 0,
        p1: payload.pressure_1 ?? payload.p1 ?? 0,
        p2: payload.pressure_2 ?? payload.p2 ?? 0
    };

    const bi = calculateBI(payload);

    if (name.includes("sx") || name.includes("left")) {
        leftSockSamples.push({ t: tMs, ...pData, bi });
        if (!isReplayMode) updateSocksUI('left', pData, bi);
    } else if (name.includes("dx") || name.includes("right")) {
        rightSockSamples.push({ t: tMs, ...pData, bi });
        if (!isReplayMode) updateSocksUI('right', pData, bi);
    }
    
    // Aggiorna anche le card classiche se presenti
    sensors[payload.sensor_name || payload.name] = payload;
    updateSensorCardUI(payload.sensor_name || payload.name, payload);
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
  if (!card) {
    createSensorCard(name, data);
    updateSelector();
    return;
  }

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
    opt.value = n;
    opt.textContent = n;
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

  accelDiv.innerHTML = '';
  gyroDiv.innerHTML = '';
  magDiv.innerHTML = '';
  pressureDiv.innerHTML = '';

  var commonOpts = () => ({
    width: accelDiv.offsetWidth,
    height: 200,
    cursor: { show: true, drag: { x: true, y: false } },
    scales: { x: { time: true }, y: { auto: true } },
    axes: [
      {
        stroke: SENSORIA_GREEN,
        grid: { stroke: '#333' },
        values: (u, vals) => vals.map(v => new Date(v * 1000).toLocaleTimeString())
      },
      { stroke: SENSORIA_GREEN, grid: { stroke: '#333' }, size: 50 }
    ],
    plugins: [wheelZoomPlugin()]
  });

  var opts1 = commonOpts();
  opts1.series = [
    {},
    { label: 'X', stroke: '#ff6384', width: 2 },
    { label: 'Y', stroke: '#36a2eb', width: 2 },
    { label: 'Z', stroke: '#4bc0c0', width: 2 }
  ];
  charts.accel = new uPlot(opts1, chartData.accel, accelDiv);
  addInteraction(charts.accel);

  var opts2 = commonOpts();
  opts2.series = [
    {},
    { label: 'X', stroke: '#ff9f40', width: 2 },
    { label: 'Y', stroke: '#9966ff', width: 2 },
    { label: 'Z', stroke: '#ffcd56', width: 2 }
  ];
  charts.gyro = new uPlot(opts2, chartData.gyro, gyroDiv);
  addInteraction(charts.gyro);

  var opts3 = commonOpts();
  opts3.series = [
    {},
    { label: 'X', stroke: '#c9cbcf', width: 2 },
    { label: 'Y', stroke: '#4bc0c0', width: 2 },
    { label: 'Z', stroke: '#ff6384', width: 2 }
  ];
  charts.mag = new uPlot(opts3, chartData.mag, magDiv);
  addInteraction(charts.mag);

  var opts4 = commonOpts();
  opts4.height = 250;
  opts4.scales.y = { auto: false, range: [0, 1024] };
  opts4.series = [
    {},
    { label: 'P0', stroke: '#ff6384', width: 3 },
    { label: 'P1', stroke: '#36a2eb', width: 3 },
    { label: 'P2', stroke: '#ffce56', width: 3 }
  ];
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

// ==========================================
// PAST ACTIVITY LOADER (frontend)
// ==========================================
function initPastActivityLoader() {
  const header = document.querySelector('.dashboard-info') ||
                 document.querySelector('.dashboard-header') ||
                 document.body;

  if (document.getElementById('btn-load-activity')) return;

  const btn = document.createElement('button');
  btn.id = 'btn-load-activity';
  btn.type = 'button';
  btn.textContent = 'Carica attività passata';
  btn.style.cssText = `
    padding:8px 12px;
    border-radius:10px;
    border:1px solid rgba(151,201,62,0.8);
    background: rgba(151,201,62,0.12);
    color: ${SENSORIA_GREEN};
    font-weight:800;
    cursor:pointer;
    white-space:nowrap;
  `;

  btn.addEventListener('click', openLogsModal);
  header.appendChild(btn);
}

async function openLogsModal() {
  const old = document.getElementById('logs-modal');
  if (old) old.remove();

  const modal = document.createElement('div');
  modal.id = 'logs-modal';
  modal.style.cssText = `
    position:fixed; inset:0; z-index:99999;
    background: rgba(0,0,0,0.65);
    display:flex; align-items:center; justify-content:center;
    padding: 18px;
  `;

  modal.innerHTML = `
    <div style="
      width:min(620px, 96vw);
      background:#111;
      border:1px solid #333;
      border-radius:14px;
      box-shadow: 0 18px 48px rgba(0,0,0,0.65);
      overflow:hidden;
    ">
      <div style="display:flex; justify-content:space-between; align-items:center; padding:14px 16px; border-bottom:1px solid #222;">
        <div style="font-weight:900; color:#fff;">Carica attività passata</div>
        <button id="logs-close" style="background:transparent; color:#fff; border:0; font-size:18px; cursor:pointer;">✕</button>
      </div>

      <div style="padding:14px 16px;">
        <div id="logs-status" style="color:#aaa; font-size:12px; margin-bottom:10px;">Caricamento lista...</div>
        <div id="logs-list" style="display:flex; flex-direction:column; gap:8px; max-height:55vh; overflow:auto;"></div>
      </div>
    </div>
  `;

  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);

  const closeBtn = document.getElementById('logs-close');
  closeBtn.onclick = () => modal.remove();

  const status = document.getElementById('logs-status');
  const list = document.getElementById('logs-list');

  try {
    const resp = await fetch('/api/logs');
    const json = await resp.json();
    const logs = (json && json.logs) ? json.logs : [];

    status.textContent = logs.length ? 'Seleziona un log:' : 'Nessun log trovato.';
    list.innerHTML = '';

    logs.forEach(item => {
      const row = document.createElement('button');
      row.type = 'button';
      row.style.cssText = `
        text-align:left;
        padding:10px 12px;
        border-radius:10px;
        border:1px solid #2a2a2a;
        background:#161616;
        color:#fff;
        cursor:pointer;
      `;
      const dt = item.mtime ? new Date(item.mtime * 1000).toLocaleString() : '';
      const kb = item.size != null ? Math.round(item.size / 1024) : '--';
      row.innerHTML = `<div style="font-weight:800;">${item.name}</div>
                       <div style="font-size:12px; color:#999; margin-top:2px;">${dt} • ${kb} KB</div>`;

      row.onclick = async () => {
        status.textContent = `Caricamento: ${item.name}...`;
        await loadPastActivity(item.name);
        modal.remove();
      };

      list.appendChild(row);
    });
  } catch (e) {
    status.textContent = 'Errore nel caricamento lista log.';
  }
}

/**
 * Carica un'attività passata dal server e prepara tutti i dati per il Replay.
 * Gestisce il parsing di Sensori (Calzini), GPS e BPM.
 */
/**
 * Carica un'attività passata dal server e prepara tutti i dati per il Replay.
 * Corretto l'errore di riferimento alla variabile 's'.
 */
async function loadPastActivity(logName) {
  try {
    const resp = await fetch(`/api/logs/load?name=${encodeURIComponent(logName)}`);
    const data = await resp.json();

    // 1. Reset totale degli stati e degli array
    gpsSamples = [];
    bpmSamples = [];
    leftSockSamples = [];
    rightSockSamples = [];
    sockChartData.left = [[], [], [], []];  
    sockChartData.right = [[], [], [], []]; 
    
    currentSmoothedSpeed = 0;
    lastSpeedCalcPos = null;

    const sensorsData = Array.isArray(data.sensors) ? data.sensors : [];
    if (sensorsData.length === 0) {
      console.warn("Nessun dato sensore trovato nel log.");
      return;
    }

    // 2. Determina l'inizio sessione in modo sicuro (CORRETTO)
    const firstSensor = sensorsData[0];
    const initialT = firstSensor.t || (firstSensor.timestamp ? new Date(firstSensor.timestamp).getTime() : Date.now());
    
    sessionStartTimeMs = sensorsData.reduce((min, item) => {
        const t = item.t || (item.timestamp ? new Date(item.timestamp).getTime() : min);
        return t < min ? t : min;
    }, initialT);

    // 3. Parsing Sensori e Calzini (Pre-rendering Grafici)
    sensorsData.forEach(sensorItem => {
      const tMs = sensorItem.t || (sensorItem.timestamp ? new Date(sensorItem.timestamp).getTime() : null);
      if (!tMs) return;

      const tRelSec = (tMs - sessionStartTimeMs) / 1000;
      const name = (sensorItem.sensor_name || "").toLowerCase();
      
      const bi = calculateBI(sensorItem);
      const p0 = Number(sensorItem.pressure_0 ?? sensorItem.p0 ?? 0);
      const p1 = Number(sensorItem.pressure_1 ?? sensorItem.p1 ?? 0);
      const p2 = Number(sensorItem.pressure_2 ?? sensorItem.p2 ?? 0);
      
      const sample = { t: tMs, p0, p1, p2, bi };

      if (name.includes("sx") || name.includes("left")) {
        leftSockSamples.push(sample);
        sockChartData.left[0].push(tRelSec);
        sockChartData.left[1].push(p0);
        sockChartData.left[2].push(p1);
        sockChartData.left[3].push(p2);
      } else if (name.includes("dx") || name.includes("right")) {
        rightSockSamples.push(sample);
        sockChartData.right[0].push(tRelSec);
        sockChartData.right[1].push(p0);
        sockChartData.right[2].push(p1);
        sockChartData.right[3].push(p2);
      }
    });

    // 4. Parsing GPS (Ricostruzione distanza e velocità smooth)
    if (Array.isArray(data.gps) && data.gps.length > 0) {
      data.gps.forEach(p => onGpsUpdate(p));
    }

    // 5. Parsing BPM
    if (Array.isArray(data.bpm)) {
      data.bpm.forEach(b => {
        const tMs = b.t || (b.timestamp ? new Date(b.timestamp).getTime() : null);
        if (tMs) bpmSamples.push({ t: tMs, bpm: b.bpm || b.value || 0 });
      });
    }

    // 6. Inizializzazione UI e Grafici
    initSockCharts();
    if (sockCharts.left) sockCharts.left.setData(sockChartData.left);
    if (sockCharts.right) sockCharts.right.setData(sockChartData.right);

    // 7. Imposta fine sessione e attiva Replay Overlay
    sessionEndTimeMs = getSessionEndMs();
    updateReplayUiBounds();
    showReplayOverlayIfReady();

    // Posiziona il replay all'inizio dell'attività
    enterReplayAtSecond(0);

    console.log(`✅ Log "${logName}" caricato. Start: ${sessionStartTimeMs}`);

  } catch (error) {
    console.error("❌ Errore durante il caricamento dell'attività:", error);
  }
}


// ==========================================
// OPTIONAL: CLEAR API CLIENT
// ==========================================
function clearAllData() {
  if (confirm('Pulire tutto?')) fetch('/api/clear', { method: 'POST' });
}
