// ==========================================
// dashboard.js (Sensoria Dashboard - FULL SIMPLIFIED)
// ==========================================

// --- CONFIGURAZIONE SOCKET ---
var socket = io({
  transports: ['websocket'],
  reconnection: true,
  reconnectionDelay: 500
});

const SENSORIA_GREEN = '#97c93e';

// --- STATO SESSIONE ---
var gpsSamples = [];      // { t, lat, lng, cumDistM, speedKmh }
var bpmSamples = [];      // { t, bpm }
var sessionStartTimeMs = null;
var sessionEndTimeMs = null;
var isReplayMode = false;
var lastLiveBpm = "--";

// --- MAPPA & UI ---
var map = null;
var mapMarker = null;
var isMapInitialized = false;
var fullRoute = null;      
var progressRoute = null;  
var currentMapPos = null;

const METRIC_CARD_W = 190;
const METRIC_CARD_H = 64;

// ==========================================
// 1. INIZIALIZZAZIONE & DOM
// ==========================================
document.addEventListener('DOMContentLoaded', function () {
  initSocket();
  ensureMetricsCardsUI();
  initPastActivityLoader();
});

function initSocket() {
  socket.on('connect', () => console.log("🔌 Dashboard Connessa"));
  socket.on('gps_update', data => onGpsUpdate(data));
  socket.on('bpm_update', val => onBpmUpdate(val));
}

// ==========================================
// 2. LOGICA GPS (Distanza/Velocità Punto-Punto)
// ==========================================
function onGpsUpdate(data) {
  if (!data) return;
  const lat = Number(data.latitude), lng = Number(data.longitude);
  if (!isFinite(lat) || (lat === 0 && lng === 0)) return;

  const tMs = data.t || (data.timestamp ? new Date(data.timestamp).getTime() : Date.now());
  ensureSessionStart(tMs);

  let distStep = 0, speed = 0, totalDist = 0;
  const prev = gpsSamples.length > 0 ? gpsSamples[gpsSamples.length - 1] : null;

  if (prev) {
    // Distanza semplice Haversine
    distStep = haversineMeters(prev.lat, prev.lng, lat, lng);
    totalDist = prev.cumDistM + distStep;

    // Velocità semplice = Distanza / Tempo
    const dt = (tMs - prev.t) / 1000;
    if (dt > 0) speed = (distStep / dt) * 3.6;
  }

  const sample = { t: tMs, lat, lng, cumDistM: totalDist, speedKmh: speed };
  gpsSamples.push(sample);

  if (!isReplayMode) {
    ensureMapInitialized(lat, lng);
    if (mapMarker) mapMarker.setLatLng([lat, lng]);
    if (fullRoute) fullRoute.addLatLng([lat, lng]);
    if (progressRoute) progressRoute.addLatLng([lat, lng]);
    
    updateSpeedDistanceUI(speed, totalDist);
    updateReplayUiBounds();
    showReplayOverlayIfReady();
  }
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ==========================================
// 3. REPLAY ENGINE (Sincronizzazione Totale)
// ==========================================
function enterReplayAtSecond(sec) {
  if (sessionStartTimeMs == null) return;
  isReplayMode = true;
  const tMs = sessionStartTimeMs + (sec * 1000);

  // Mappa
  const pos = getInterpolatedGpsAtTime(tMs);
  if (pos && mapMarker) mapMarker.setLatLng([pos.lat, pos.lng]);
  updateProgressRouteToTime(tMs);

  // Metriche Sincronizzate
  const speed = getSpeedAtTime(tMs);
  const dist = getDistanceAtTime(tMs);
  const bpm = getBpmAtTime(tMs);

  updateSpeedDistanceUI(speed, dist);
  if (bpm) updateBpmValue(bpm);

  updateReplayTimeLabel(sec);
}

function goLive() {
  isReplayMode = false;
  if (gpsSamples.length > 0) {
    const last = gpsSamples[gpsSamples.length - 1];
    if (mapMarker) mapMarker.setLatLng([last.lat, last.lng]);
    updateSpeedDistanceUI(last.speedKmh, last.cumDistM);
  }
  updateProgressRouteToTime(getSessionEndMs());
}

// ==========================================
// 4. CARICAMENTO LOG ATTIVITÀ
// ==========================================
async function initPastActivityLoader() {
  const container = document.getElementById('past-activities-list');
  if (!container) return;
  
  try {
    const resp = await fetch('/api/logs/list');
    const logs = await resp.json();
    
    container.innerHTML = logs.map(log => `
      <div class="activity-row" onclick="loadPastActivity('${log.name}')">
        <span>${log.date || log.name}</span>
        <span style="color:${SENSORIA_GREEN}">CARICA</span>
      </div>
    `).join('');
  } catch (e) { console.error("Errore caricamento lista attività", e); }
}

async function loadPastActivity(logName) {
  const resp = await fetch(`/api/logs/load?name=${encodeURIComponent(logName)}`);
  const data = await resp.json();

  gpsSamples = []; bpmSamples = []; 
  
  if (data.gps && data.gps.length > 0) {
    data.gps.forEach(p => onGpsUpdate(p));
    sessionStartTimeMs = gpsSamples[0].t;
  }
  
  if (data.bpm) {
    data.bpm.forEach(b => {
      const t = b.t || new Date(b.timestamp).getTime();
      bpmSamples.push({ t, bpm: b.bpm || b.value });
    });
  }

  updateReplayUiBounds();
  showReplayOverlayIfReady();
  enterReplayAtSecond(0);
}

// ==========================================
// 5. METRICHE UI (Box in alto a destra)
// ==========================================
function ensureMetricsCardsUI() {
  let wrap = document.getElementById('metrics-stack');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'metrics-stack';
    wrap.style.cssText = 'position:absolute;top:16px;right:16px;z-index:20000;display:flex;flex-direction:column;gap:10px;pointer-events:none;';
    document.getElementById('map').appendChild(wrap);
  }

  const cards = [
    { id: 'bpm', emoji: '❤️', label: 'BPM LIVE', color: '#ff4136', valId: 'bpm-value' },
    { id: 'speed', emoji: '⚡', label: 'VELOCITÀ', color: '#ff9500', valId: 'speed-value' },
    { id: 'dist', emoji: '📍', label: 'DISTANZA', color: '#ffd60a', valId: 'distance-value' }
  ];

  cards.forEach(c => {
    if (!document.getElementById(`metric-${c.id}`)) {
      const div = document.createElement('div');
      div.id = `metric-${c.id}`;
      div.style.cssText = `width:${METRIC_CARD_W}px;height:${METRIC_CARD_H}px;background:rgba(0,0,0,0.6);border:1px solid ${c.color};border-radius:12px;padding:10px;display:flex;align-items:center;gap:12px;pointer-events:auto;backdrop-filter:blur(4px);`;
      div.innerHTML = `<div style="font-size:24px">${c.emoji}</div><div><div id="${c.valId}" style="color:#fff;font-family:monospace;font-weight:bold;font-size:16px">--</div><div style="color:${c.color};font-size:10px;font-weight:bold">${c.label}</div></div>`;
      wrap.appendChild(div);
    }
  });
}

function updateSpeedDistanceUI(s, d) {
  document.getElementById('speed-value').textContent = `${s.toFixed(1)} km/h`;
  document.getElementById('distance-value').textContent = `${(d/1000).toFixed(2)} km`;
}

function updateBpmValue(v) { document.getElementById('bpm-value').textContent = v; }

function onBpmUpdate(val) {
  const bpmInt = parseInt(val);
  if (isNaN(bpmInt)) return;
  const t = Date.now();
  ensureSessionStart(t);
  bpmSamples.push({ t, bpm: bpmInt });
  if (!isReplayMode) updateBpmValue(bpmInt);
}

// ==========================================
// 6. MAPPA & HELPERS
// ==========================================
function ensureMapInitialized(lat, lng) {
  if (isMapInitialized) return;
  map = L.map('map', { attributionControl: false }).setView([lat, lng], 19);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png').addTo(map);
  fullRoute = L.polyline([], { color: SENSORIA_GREEN, weight: 3, opacity: 0.3 }).addTo(map);
  progressRoute = L.polyline([], { color: SENSORIA_GREEN, weight: 6, opacity: 0.9 }).addTo(map);
  mapMarker = L.marker([lat, lng], { icon: L.divIcon({ className: 'pulsating-marker' }) }).addTo(map);
  isMapInitialized = true;
  createReplayOverlayControls();
}

function ensureSessionStart(t) { if (!sessionStartTimeMs) sessionStartTimeMs = t; }
function getSessionEndMs() { return gpsSamples.length ? gpsSamples[gpsSamples.length-1].t : Date.now(); }
function getDurationSec() { return sessionStartTimeMs ? (getSessionEndMs() - sessionStartTimeMs)/1000 : 0; }

function findSampleAtTime(arr, tMs) {
  if (!arr.length) return null;
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    let mid = (lo + hi) >> 1;
    if (arr[mid].t <= tMs) lo = mid + 1; else hi = mid;
  }
  return lo > 0 ? arr[lo - 1] : arr[0];
}

function getSpeedAtTime(tMs) { const s = findSampleAtTime(gpsSamples, tMs); return s ? s.speedKmh : 0; }
function getDistanceAtTime(tMs) { const s = findSampleAtTime(gpsSamples, tMs); return s ? s.cumDistM : 0; }
function getBpmAtTime(tMs) { const b = findSampleAtTime(bpmSamples, tMs); return b ? b.bpm : null; }

function getInterpolatedGpsAtTime(tMs) {
  if (!gpsSamples.length) return null;
  const idx = gpsSamples.findIndex(s => s.t > tMs);
  if (idx <= 0) return gpsSamples[gpsSamples.length - 1];
  const a = gpsSamples[idx - 1], b = gpsSamples[idx];
  const alpha = (tMs - a.t) / (b.t - a.t);
  return { lat: a.lat + (b.lat - a.lat) * alpha, lng: a.lng + (b.lng - a.lng) * alpha };
}

function updateProgressRouteToTime(tMs) {
  if (!progressRoute) return;
  const idx = gpsSamples.findIndex(s => s.t > tMs);
  const pts = gpsSamples.slice(0, idx > 0 ? idx : gpsSamples.length).map(p => [p.lat, p.lng]);
  progressRoute.setLatLngs(pts);
}

// --- OVERLAY REPLAY (Slider) ---
function createReplayOverlayControls() {
  if (document.getElementById('replay-overlay')) return;
  const ov = document.createElement('div');
  ov.id = 'replay-overlay';
  ov.style.cssText = 'position:absolute;left:16px;right:16px;bottom:16px;z-index:30000;display:none;align-items:center;gap:12px;padding:12px;border-radius:12px;background:rgba(10,10,10,0.8);backdrop-filter:blur(8px);';
  ov.innerHTML = `
    <div id="replay-time-label" style="color:#fff;font-family:monospace;font-size:14px;min-width:50px">00:00</div>
    <input id="replay-slider" type="range" min="0" max="0" step="0.1" style="flex:1;accent-color:${SENSORIA_GREEN}">
    <button id="btn-live" style="background:${SENSORIA_GREEN};border:none;border-radius:6px;padding:6px 12px;font-weight:bold;cursor:pointer">LIVE</button>
  `;
  document.getElementById('map').appendChild(ov);
  
  const slider = document.getElementById('replay-slider');
  slider.addEventListener('input', (e) => enterReplayAtSecond(parseFloat(e.target.value)));
  document.getElementById('btn-live').addEventListener('click', goLive);
}

function showReplayOverlayIfReady() {
  const ov = document.getElementById('replay-overlay');
  if (ov && getDurationSec() > 2) ov.style.display = 'flex';
}

function updateReplayUiBounds() {
  const s = document.getElementById('replay-slider');
  if (s) { s.max = getDurationSec(); if (!isReplayMode) s.value = s.max; }
}

function updateReplayTimeLabel(sec) {
  const el = document.getElementById('replay-time-label');
  if (el) {
    const m = Math.floor(sec/60).toString().padStart(2,'0');
    const s = Math.floor(sec%60).toString().padStart(2,'0');
    el.textContent = `${m}:${s}`;
  }
}
