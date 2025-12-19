// ==========================================
// dashboard.js (Sensoria Dashboard - Full Version)
// ==========================================

// Socket Configuration
var socket = io({
  transports: ['websocket'],
  reconnection: true,
  reconnectionDelay: 500
});

// UI Colors & Constants
const SENSORIA_GREEN = '#97c93e';
const METRIC_CARD_W = 190;
const METRIC_CARD_H = 64;

// =========================
// STATE VARIABLES
// =========================
var sensors = {};

// Time & Session
var sessionStartTimeMs = null;
var sessionEndTimeMs = null;
var isReplayMode = false;

// Data Storage
var gpsSamples = []; // { t, lat, lng, acc, cumDistM, speedKmh }
var bpmSamples = []; // { t, bpm }
var lastLiveBpm = "--";

// Map Objects
var map = null;
var mapMarker = null;
var isMapInitialized = false;
var fullRoute = null;      // Polyline completa
var progressRoute = null;  // Polyline fino al punto corrente (replay/live)
var currentMapPos = null;
var mapRotationDeg = 0;
var isUserInteracting = false; // Per evitare auto-pan se l'utente sposta la mappa

// Charts Objects (uPlot)
var charts = { accel: null, gyro: null, mag: null, pressure: null };
var chartData = {
  accel: [[], [], [], []],
  gyro: [[], [], [], []],
  mag: [[], [], [], []],
  pressure: [[], [], [], []]
};
var selectedSensor = null;
var chartsInitialized = false;

// Socks Specific
var leftSockSamples = [];  
var rightSockSamples = []; 
var sockCharts = { left: null, right: null };
var sockChartData = { left: [[], [], [], []], right: [[], [], [], []] };


// ==========================================
// INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', function () {
  initSocket();
  ensureMapDomOverlay();
  ensureMetricsCardsUI();
  initPastActivityLoader();

  // Gestione Dropdown Selezione Sensore per Grafici IMU
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
// SOCKET HANDLING
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

  // Routing dei messaggi in arrivo
  socket.on('sensor_update', (data) => processIncomingData(data));
  socket.on('bpm_update', (val) => onBpmUpdate(val));
  socket.on('profile_update', (data) => updateProfileUI(data));
  socket.on('gps_update', (data) => onGpsUpdate(data));

  // Reset Remoto
  socket.on('data_cleared', () => {
    location.reload(); // Il modo più pulito per resettare tutto
  });
}


// ==========================================
// TIME & MATH UTILS
// ==========================================
function getNowMs() { return Date.now(); }

function ensureSessionStart(tMs) {
  if (sessionStartTimeMs == null) sessionStartTimeMs = tMs;
}

function getSessionEndMs() {
  if (!gpsSamples.length) return sessionStartTimeMs || Date.now();
  const lastGps = gpsSamples[gpsSamples.length - 1].t;
  // Safety check: se dura più di 4 ore, tronca (evita bug timestamp)
  if ((lastGps - sessionStartTimeMs) > 14400000) return sessionStartTimeMs + (gpsSamples.length * 1000);
  return lastGps;
}

function getDurationSec() {
  if (!sessionStartTimeMs) return 0;
  return Math.max(0, (getSessionEndMs() - sessionStartTimeMs) / 1000);
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

// -- HAVERSINE FORMULA (Distanza in Metri) --
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

// -- CALCOLO PURO METRICHE (Distanza + Velocità) --
// Logica identica per Live e Replay
function calculateStepMetrics(prev, curr) {
  // 1. Distanza Geometrica
  const distM = haversineMeters(prev.lat, prev.lng, curr.lat, curr.lng);
  
  // 2. Tempo trascorso (secondi)
  let dt = (curr.t - prev.t) / 1000;
  if (dt <= 0) dt = 1.0; // evita divisione per zero
  
  // 3. Velocità Fisica (m/s -> km/h)
  const speedKmh = (distM / dt) * 3.6;

  return { distM, speedKmh };
}

// -- BONGIORNO INDEX (Intensità Movimento) --
function calculateBI(payload) {
    if (payload.accel_x == null || payload.accel_y == null || payload.accel_z == null) return 0;
    
    const ax = payload.accel_x;
    const ay = payload.accel_y;
    const az = payload.accel_z;
    
    // Magnitudo Vettore
    const norm = Math.sqrt(ax*ax + ay*ay + az*az);
    
    // Sottrai Gravità (1g circa 1000 o 9.8)
    // Se norm > 2000 è un movimento forte, se è ~1000 è fermo
    const GRAVITY_REF = 1000; 
    const diff = Math.abs(norm - GRAVITY_REF);
    
    // Normalizza: 1000 unità extra = 100% intensity
    let index = (diff / 1000) * 100;
    return Math.min(100, index);
}

// Formattazione
function formatKmh(v) { return (v != null && isFinite(v)) ? Math.max(0, v).toFixed(1) : "--"; }
function formatKmFromMeters(m) { return (m != null && isFinite(m)) ? (Math.max(0, m) / 1000).toFixed(2) : "--"; }


// ==========================================
// METRIC CARDS UI (Top Right)
// ==========================================
function ensureMetricsCardsUI() {
  let oldBpm = document.getElementById('bpm-display');
  if (oldBpm) oldBpm.style.display = 'none';

  let wrap = document.getElementById('metrics-stack');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'metrics-stack';
    wrap.style.cssText = `position:absolute; top:16px; right:16px; z-index:20000; display:flex; flex-direction:column; gap:10px; align-items:flex-end; pointer-events:none;`;
    const mapDiv = document.getElementById('map');
    (mapDiv || document.body).appendChild(wrap);
  }

  const cards = [
    { id: 'metric-bpm', emoji: '❤️', label: 'BPM LIVE', color: 'rgba(255, 65, 54, 0.95)', valId: 'bpm-value', unit: '' },
    { id: 'metric-speed', emoji: '⚡', label: 'VELOCITÀ', color: 'rgba(255, 149, 0, 0.95)', valId: 'speed-value', unit: 'km/h' },
    { id: 'metric-dist', emoji: '📍', label: 'DISTANZA', color: 'rgba(255, 214, 10, 0.95)', valId: 'distance-value', unit: 'km' }
  ];

  cards.forEach(c => {
    if (!document.getElementById(c.id)) {
      wrap.appendChild(buildMetricCard(c));
    }
  });
}

function buildMetricCard({ id, emoji, label, color, valId, unit }) {
  const div = document.createElement('div');
  div.id = id;
  div.style.cssText = `width:${METRIC_CARD_W}px; height:${METRIC_CARD_H}px; border-radius:12px; padding:10px 12px; display:flex; align-items:center; gap:12px; background: rgba(0,0,0,0.35); border: 1px solid ${color}; box-shadow: 0 10px 22px rgba(0,0,0,0.45); pointer-events:auto; overflow:hidden;`;
  div.innerHTML = `
    <div style="font-size:26px; width:34px; text-align:center;">${emoji}</div>
    <div style="flex:1; display:flex; flex-direction:column; align-items:flex-start; gap:2px;">
      <div id="${valId}" style="font-family:monospace; font-size:14px; font-weight:900; color:#fff;">-- ${unit}</div>
      <div style="font-size:10px; font-weight:900; letter-spacing:1px; color:${color};">${label}</div>
    </div>`;
  return div;
}

function updateBpmValue(val) {
  const el = document.getElementById('bpm-value');
  if (el) el.textContent = String(val);
}

function updateSpeedDistanceUI(speedKmh, distMeters) {
  const sEl = document.getElementById('speed-value');
  const dEl = document.getElementById('distance-value');
  if (sEl) sEl.textContent = `${formatKmh(speedKmh)} km/h`;
  if (dEl) dEl.textContent = `${formatKmFromMeters(distMeters)} km`;
}


// ==========================================
// CORE DATA LOGIC: BPM
// ==========================================
function onBpmUpdate(val) {
  const bpmInt = parseInt(val);
  if (isNaN(bpmInt) || bpmInt <= 0) return;
  
  const tMs = getNowMs();
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
// CORE DATA LOGIC: GPS (Live Update)
// ==========================================
function onGpsUpdate(data) {
  if (!data) return;
  const lat = Number(data.latitude);
  const lng = Number(data.longitude);
  const tMs = data.t || (data.timestamp ? new Date(data.timestamp).getTime() : Date.now());

  // Ignora coordinate invalide
  if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return;
  ensureSessionStart(tMs);

  const curr = { t: tMs, lat, lng, acc: data.accuracy || 0, cumDistM: 0, speedKmh: 0 };

  // Primo punto
  if (gpsSamples.length === 0) {
    gpsSamples.push(curr);
    ensureMapInitialized(lat, lng);
    return;
  }

  // Calcolo Differenziale
  const prev = gpsSamples[gpsSamples.length - 1];
  const metrics = calculateStepMetrics(prev, curr);
  
  // Aggiorna Cumulativi
  curr.cumDistM = prev.cumDistM + metrics.distM;
  curr.speedKmh = metrics.speedKmh;
  
  gpsSamples.push(curr);

  // Aggiorna UI se siamo Live
  if (!isReplayMode) {
    updateSpeedDistanceUI(curr.speedKmh, curr.cumDistM);
    
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
}


// ==========================================
// MAP & MAP CONTROLS
// ==========================================
function ensureMapDomOverlay() {
  const d = document.getElementById('map');
  if (d) d.style.position = 'relative';
}

function ensureMapInitialized(lat, lng) {
  if (isMapInitialized) return;
  
  const section = document.getElementById('map-section');
  if (section) section.style.display = 'block';
  ensureMapDomOverlay();

  // Init Leaflet
  map = L.map('map', { attributionControl: false, zoomControl: true }).setView([lat, lng], 19);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 20 }).addTo(map);

  // Layers Panes
  map.createPane('routePane'); map.getPane('routePane').style.zIndex = 450;
  map.createPane('markerPane'); map.getPane('markerPane').style.zIndex = 650;

  // Marker & Polylines
  const icon = L.divIcon({ className: 'custom-div-icon', html: "<div class='pulsating-marker'></div>", iconSize: [24,24], iconAnchor: [12,12] });
  mapMarker = L.marker([lat, lng], { icon: icon, pane: 'markerPane' }).addTo(map);

  fullRoute = L.polyline([], { pane: 'routePane', color: SENSORIA_GREEN, weight: 4, opacity: 0.45 }).addTo(map);
  progressRoute = L.polyline([], { pane: 'routePane', color: SENSORIA_GREEN, weight: 7, opacity: 0.95 }).addTo(map);

  // Events
  map.on('mousedown touchstart', () => { isUserInteracting = true; });
  map.on('mouseup touchend', () => { setTimeout(() => isUserInteracting = false, 3000); }); // Auto-resume dopo 3 sec

  createReplayOverlayControls();
  createRotateControl();
  isMapInitialized = true;
  setTimeout(() => map.invalidateSize(), 120);
}

function createRotateControl() {
  if (document.getElementById('rotate-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'rotate-btn';
  btn.innerHTML = '⤾';
  btn.style.cssText = `position:absolute; top:90px; left:10px; width:28px; height:28px; background:rgba(0,0,0,0.7); color:#fff; border:none; z-index:20000; cursor:pointer; font-size:16px; border-radius:4px; display:flex; align-items:center; justify-content:center;`;
  
  btn.onclick = () => {
    mapRotationDeg = (mapRotationDeg + 90) % 360;
    const p = map.getContainer().querySelector('.leaflet-map-pane');
    if (p) {
       p.style.transition = 'transform 0.25s ease-out';
       p.style.transform = `rotate(${mapRotationDeg}deg)`;
       setTimeout(() => map.invalidateSize(), 260);
    }
  };
  document.getElementById('map').appendChild(btn);
}


// ==========================================
// REPLAY SYSTEM (Slider & Logic)
// ==========================================
function createReplayOverlayControls() {
  if (document.getElementById('replay-overlay')) return;
  const div = document.createElement('div');
  div.id = 'replay-overlay';
  div.style.cssText = `position:absolute; left:16px; right:16px; bottom:16px; z-index:30000; display:none; align-items:center; gap:12px; padding:10px 12px; border-radius:12px; background:rgba(10,10,10,0.85); backdrop-filter:blur(6px); border:1px solid rgba(255,255,255,0.1);`;
  
  div.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:2px; min-width:64px;">
      <div style="font-size:10px; font-weight:700; color:#9aa;">TIME</div>
      <div id="replay-time-label" style="font-family:monospace; font-size:13px; color:#fff; font-weight:700;">00:00</div>
    </div>
    <input id="replay-slider" type="range" min="0" max="0" step="0.1" value="0" style="flex:1; accent-color:${SENSORIA_GREEN}; cursor:pointer;" />
    <button id="btn-live" style="padding:6px 12px; border-radius:8px; border:1px solid ${SENSORIA_GREEN}; background:rgba(151,201,62,0.18); color:${SENSORIA_GREEN}; font-weight:800; font-size:11px; cursor:pointer;">LIVE</button>
  `;
  document.getElementById('map').appendChild(div);

  const slider = document.getElementById('replay-slider');
  slider.addEventListener('input', (e) => enterReplayAtSecond(parseFloat(e.target.value)));
  document.getElementById('btn-live').onclick = goLive;
  
  if (L.DomEvent) { L.DomEvent.disableClickPropagation(div); L.DomEvent.disableScrollPropagation(div); }
}

function showReplayOverlayIfReady() {
  const o = document.getElementById('replay-overlay');
  if (o && getDurationSec() > 0 && gpsSamples.length > 1) o.style.display = 'flex';
}

function updateReplayUiBounds() {
  const s = document.getElementById('replay-slider');
  if (!s) return;
  const max = getDurationSec();
  s.max = max;
  if (!isReplayMode) {
    s.value = max;
    updateReplayTimeLabel(max);
  }
}

function updateReplayTimeLabel(sec) {
  const l = document.getElementById('replay-time-label');
  if (!l) return;
  const m = Math.floor(sec / 60).toString().padStart(2,'0');
  const s = Math.floor(sec % 60).toString().padStart(2,'0');
  l.textContent = `${m}:${s}`;
}

// -- HELPER INTERPOLAZIONE REPLAY --
function getSampleAtTime(arr, tMs, key) {
  if (!arr.length) return 0;
  // Ricerca semplice inversa (efficiente per playback sequenziale)
  for(let i=arr.length-1; i>=0; i--) {
    if (arr[i].t <= tMs) return arr[i][key];
  }
  return arr[0][key]; 
}

function getInterpolatedGps(tMs) {
  if (!gpsSamples.length) return null;
  // Trova indice
  let idx = 0;
  while(idx < gpsSamples.length && gpsSamples[idx].t < tMs) idx++;
  
  if (idx === 0) return gpsSamples[0];
  if (idx >= gpsSamples.length) return gpsSamples[gpsSamples.length-1];
  
  const b = gpsSamples[idx];
  const a = gpsSamples[idx-1];
  const alpha = (tMs - a.t) / (b.t - a.t); // 0..1
  
  return {
    lat: a.lat + (b.lat - a.lat)*alpha,
    lng: a.lng + (b.lng - a.lng)*alpha
  };
}

// Funzione principale spostamento nel tempo
function enterReplayAtSecond(sec) {
  if (sessionStartTimeMs == null) return;
  isReplayMode = true;
  
  const tMs = sessionStartTimeMs + (sec * 1000);
  updateReplayTimeLabel(sec);

  // 1. Mappa
  const pos = getInterpolatedGps(tMs);
  if (pos && mapMarker) {
      mapMarker.setLatLng([pos.lat, pos.lng]);
      if (!isUserInteracting) map.panTo([pos.lat, pos.lng]);
      
      // Update Traccia parziale
      updateProgressRouteToTime(tMs);
  }

  // 2. Metriche (mostra lo stato a quel secondo)
  const spd = getSampleAtTime(gpsSamples, tMs, 'speedKmh');
  const dst = getSampleAtTime(gpsSamples, tMs, 'cumDistM');
  const bpm = getSampleAtTime(bpmSamples, tMs, 'bpm');
  
  updateSpeedDistanceUI(spd, dst);
  updateBpmValue(bpm || "--");

  // 3. Calzini Charts Sync (Zoom Finestra temporale)
  const winHalf = 5;
  const tMin = Math.max(0, sec - winHalf);
  const tMax = tMin + 10;
  if (sockCharts.left) sockCharts.left.setScale("x", { min: tMin, max: tMax });
  if (sockCharts.right) sockCharts.right.setScale("x", { min: tMin, max: tMax });
  
  // 4. Update Numeri Calzini (Pressioni al tempo T)
  const lS = findSampleAtTime(leftSockSamples, tMs);
  if (lS) updateSocksUI('left', lS, lS.bi);
  
  const rS = findSampleAtTime(rightSockSamples, tMs);
  if (rS) updateSocksUI('right', rS, rS.bi);
}

function updateProgressRouteToTime(tMs) {
    if (!progressRoute || !gpsSamples.length) return;
    // Trova l'indice dell'ultimo punto valido per il tempo tMs
    let pts = [];
    for(let i=0; i<gpsSamples.length; i++) {
        if(gpsSamples[i].t > tMs) break;
        pts.push([gpsSamples[i].lat, gpsSamples[i].lng]);
    }
    progressRoute.setLatLngs(pts);
}

function findSampleAtTime(arr, tMs) {
    if (!arr || !arr.length) return null;
    for(let i=arr.length-1; i>=0; i--) {
        if (arr[i].t <= tMs) return arr[i];
    }
    return arr[0];
}

function goLive() {
  isReplayMode = false;
  const last = gpsSamples[gpsSamples.length - 1];
  if (last) {
    updateSpeedDistanceUI(last.speedKmh, last.cumDistM);
    if (mapMarker) mapMarker.setLatLng([last.lat, last.lng]);
    updateProgressRouteToTime(last.t);
  }
  updateReplayUiBounds();
}


// ==========================================
// IMU & SOCKS DATA PROCESSING
// ==========================================
function processIncomingData(data) {
  const payload = (data.data || data);
  if (!payload || (!payload.sensor_name && !payload.name)) return;
  
  const name = (payload.sensor_name || payload.name).toLowerCase();
  const tMs = Date.now();
  ensureSessionStart(tMs);
  
  // BI
  const bi = calculateBI(payload);

  // Parsing Pressioni
  const pData = {
     p0: payload.pressure_0 ?? payload.p0 ?? 0,
     p1: payload.pressure_1 ?? payload.p1 ?? 0,
     p2: payload.pressure_2 ?? payload.p2 ?? 0,
     bi: bi // Alleghiamo BI ai dati
  };

  if (name.includes("sx") || name.includes("left")) {
     leftSockSamples.push({ t: tMs, ...pData });
     if (!isReplayMode) updateSocksUI('left', pData, bi);
  } 
  else if (name.includes("dx") || name.includes("right")) {
     rightSockSamples.push({ t: tMs, ...pData });
     if (!isReplayMode) updateSocksUI('right', pData, bi);
  }
  
  // Grafici IMU generici
  if (selectedSensor && name === selectedSensor.toLowerCase()) {
      updateChartsUI(payload);
  }

  // Card
  sensors[payload.sensor_name || payload.name] = payload;
  updateSensorCardUI(payload.sensor_name || payload.name, payload);
}


function updateSocksUI(side, data, bi) {
    if(!data) return;
    
    // 1. BI Display
    const biEl = document.getElementById(`bi-val-${side}`);
    if (biEl) {
        biEl.textContent = `BI: ${bi.toFixed(1)}%`;
        biEl.style.color = bi > 40 ? '#ff4444' : SENSORIA_GREEN;
    }
    
    // 2. Numeri
    const prefix = side === 'left' ? 'l' : 'r';
    ['p0','p1','p2'].forEach(k => {
       const el = document.getElementById(`${prefix}-${k}`);
       if (el) el.textContent = Math.round(data[k] || 0);
    });

    // 3. Chart Append (Solo Live)
    if (!isReplayMode && sockCharts[side]) {
       const d = sockChartData[side];
       const tRel = (Date.now() - sessionStartTimeMs) / 1000;
       d[0].push(tRel); 
       d[1].push(data.p0); d[2].push(data.p1); d[3].push(data.p2);
       if (d[0].length > 100) d.forEach(a => a.shift());
       sockCharts[side].setData(d);
    }
}


// ==========================================
// SENSOR CARDS UI (Auto-Generated)
// ==========================================
function createSensorCard(name, data) {
    const grid = document.getElementById('sensors-grid');
    if (!grid) return;
    
    // Emoji detect
    let emoji = '📱';
    const n = name.toLowerCase();
    if(n.includes('knee')) emoji = '🦿';
    if(n.includes('sock')) emoji = '🧦';

    const div = document.createElement('div');
    div.className = 'sensor-card sensor-col connected';
    div.setAttribute('data-sensor', name);
    
    let html = `<div class="sensor-header"><span>${emoji} ${name}</span><div class="status-indicator active"></div></div>`;
    
    // Sezioni Dinamiche
    if(data.accel_x !== undefined) {
        html += `<div class="sensor-data-section"><div class="sensor-data-section-title">Accelerometro</div>
        <div class="sensor-data-row"><span class="sensor-data-label">AX</span> <span class="sensor-value" data-key="accel_x">0</span></div>
        <div class="sensor-data-row"><span class="sensor-data-label">AY</span> <span class="sensor-value" data-key="accel_y">0</span></div>
        <div class="sensor-data-row"><span class="sensor-data-label">AZ</span> <span class="sensor-value" data-key="accel_z">0</span></div></div>`;
    }
    if(data.pressure_0 !== undefined) {
        html += `<div class="sensor-data-section" style="border:none;"><div class="sensor-data-section-title">Pressioni</div>
        <div class="sensor-data-row"><span class="sensor-data-label">P0</span> <span class="sensor-value" style="color:#ffce56;" data-key="pressure_0">0</span></div>
        <div class="sensor-data-row"><span class="sensor-data-label">P1</span> <span class="sensor-value" style="color:#ffce56;" data-key="pressure_1">0</span></div>
        <div class="sensor-data-row"><span class="sensor-data-label">P2</span> <span class="sensor-value" style="color:#ffce56;" data-key="pressure_2">0</span></div></div>`;
    }
    
    div.innerHTML = html;
    grid.appendChild(div);
    updateSensorSelector();
}

function updateSensorCardUI(name, data) {
    let card = document.querySelector(`[data-sensor="${name}"]`);
    if(!card) { createSensorCard(name, data); return; }
    
    Object.keys(data).forEach(k => {
        const el = card.querySelector(`[data-key="${k}"]`);
        if(el) el.textContent = Math.round(data[k]);
    });
}

function updateSensorSelector() {
    const sel = document.getElementById('chart-sensor-select');
    if(!sel) return;
    sel.innerHTML = '<option value="">-- Seleziona sensore --</option>';
    Object.keys(sensors).forEach(n => {
        const opt = document.createElement('option');
        opt.value = n; opt.textContent = n;
        sel.appendChild(opt);
    });
}

// ==========================================
// UPLOT CHARTS (IMU)
// ==========================================
function initCharts() {
  const container = document.getElementById('charts-container');
  if (!container) return;
  container.innerHTML = ''; 

  const opts = (title, color) => ({
    title: title, width: container.offsetWidth - 20, height: 180,
    series: [ {}, { stroke: "red" }, { stroke: "green" }, { stroke: "blue" } ],
    scales: { x: { time: false } }
  });

  const d1 = document.createElement('div'); container.appendChild(d1);
  const d2 = document.createElement('div'); container.appendChild(d2);
  const d3 = document.createElement('div'); container.appendChild(d3);

  charts.accel = new uPlot(opts("Accelerometro"), chartData.accel, d1);
  charts.gyro = new uPlot(opts("Giroscopio"), chartData.gyro, d2);
  charts.mag = new uPlot(opts("Magnetometro"), chartData.mag, d3);
  
  // Init Socks Charts (se esistono i div)
  initSockCharts();
}

function updateChartsUI(data) {
  if (!chartsInitialized || !charts.accel) return;
  const tRel = (Date.now() - sessionStartTimeMs) / 1000;

  const push = (arr, v) => {
     arr[0].push(tRel);
     arr[1].push(v[0]); arr[2].push(v[1]); arr[3].push(v[2]);
     if (arr[0].length > 200) arr.forEach(s => s.shift());
  };

  if (data.accel_x != null) {
      push(chartData.accel, [data.accel_x, data.accel_y, data.accel_z]);
      charts.accel.setData(chartData.accel);
  }
  if (data.gyro_x != null) {
      push(chartData.gyro, [data.gyro_x, data.gyro_y, data.gyro_z]);
      charts.gyro.setData(chartData.gyro);
  }
  if (data.mag_x != null) {
      push(chartData.mag, [data.mag_x, data.mag_y, data.mag_z]);
      charts.mag.setData(chartData.mag);
  }
}

function resetChartData() {
  chartData = { accel: [[],[],[],[]], gyro: [[],[],[],[]], mag: [[],[],[],[]], pressure: [[],[],[],[]] };
}

function initSockCharts() {
    const l = document.getElementById('chart-left-p');
    const r = document.getElementById('chart-right-p');
    if (!l || !r) return;

    const opts = (tit) => ({
        title: tit, width: l.offsetWidth, height: 130,
        scales: { x: { time: false }, y: { auto: false, range: [0, 4096] } },
        series: [{}, { stroke: "#ffb74d" }, { stroke: "#e91e63" }, { stroke: "#4fc3f7" }]
    });

    sockCharts.left = new uPlot(opts("Pressioni SX"), sockChartData.left, l);
    sockCharts.right = new uPlot(opts("Pressioni DX"), sockChartData.right, r);
}

// ==========================================
// PROFILE UI
// ==========================================
function updateProfileUI(data) {
  const div = document.getElementById('user-profile-display');
  if (!data || !data.name || !div) return;
  div.style.display = 'flex';
  
  const nameEl = document.getElementById('profile-name');
  if (nameEl) nameEl.textContent = String(data.name).toUpperCase();
  
  const detEl = document.getElementById('profile-details');
  if (detEl) detEl.textContent = `${data.age} anni | ${data.weight} kg`;
}

// ==========================================
// FILE LOADER (Replay from JSON)
// ==========================================
function initPastActivityLoader() {
    window.loadActivityData = function(jsonLines) {
        // Reset
        gpsSamples = []; bpmSamples = []; leftSockSamples = []; rightSockSamples = [];
        sessionStartTimeMs = null;
        if(fullRoute) fullRoute.setLatLngs([]);
        if(progressRoute) progressRoute.setLatLngs([]);
        
        const lines = jsonLines.split('\n');
        lines.forEach(line => {
            if(!line.trim()) return;
            try {
                const d = JSON.parse(line);
                // Smistamento
                if (d.latitude) onGpsUpdate(d); // Usa la STESSA logica del live
                else if (d.sensor_name) processIncomingData(d);
                else if (d.bpm) onBpmUpdate(d.bpm);
            } catch(e) { }
        });
        
        // Fit mappa
        if(map && fullRoute && fullRoute.getLatLngs().length) {
            map.fitBounds(fullRoute.getBounds());
        }
        updateReplayUiBounds();
    };
}
