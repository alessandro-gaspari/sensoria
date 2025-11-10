var socket = io({transports: ['websocket']});

// --- Config e stato Pressioni ---
var BODY_WEIGHT_KG = 1; // Inserisci qui il peso in kg!
var BASELINE_WARMUP = 20; // quante letture per baseline
var BASELINE_ALPHA = 0.003; // drift lento del baseline
var PRESS_MIN_DELTA = 8; // soglia variazione vera
var PRESS_ALPHA = 0.22;  // smoothing EMA
var PU_CLAMP = 1000; // max visualizzabile
var sensors = {};

var pressState = {}; // {sensore: {pressure_0:{...}, ... }}

// Funz di stato pressione con buffer baseline e ema smoothing
function ps(sensorName) {
  if (!pressState[sensorName]) pressState[sensorName] = {};
  return pressState[sensorName];
}
function initPressureSlot(sensorName, key) {
  var s = ps(sensorName);
  if (!s[key]) s[key] = { count: 0, sum: 0, baseline: null, ema: 0 };
}

// 3 sensori, PU/kg, smoothing, baseline
function computePressurePUkg(sensorName, key, raw) {
  initPressureSlot(sensorName, key);
  var slot = ps(sensorName)[key];
  // Baseline warmup
  if (slot.baseline === null && slot.count < BASELINE_WARMUP) {
    slot.count++;
    slot.sum += raw;
    if (slot.count >= BASELINE_WARMUP) slot.baseline = slot.sum / slot.count;
    return 0;
  }
  if (slot.baseline === null) slot.baseline = raw;
  // Aggiorna lentamente baseline
  if (Math.abs(raw - slot.baseline) < 5) slot.baseline = slot.baseline * (1 - BASELINE_ALPHA) + raw * BASELINE_ALPHA;
  var deltaP = -(raw - slot.baseline); // negativo → pressione
  if (Math.abs(deltaP) < PRESS_MIN_DELTA) deltaP = 0;
  var pu = deltaP / BODY_WEIGHT_KG;
  pu = Math.max(0, Math.min(PU_CLAMP, pu));
  slot.ema = slot.ema * (1 - PRESS_ALPHA) + pu * PRESS_ALPHA;
  return slot.ema;
}

// --- IMU prettamente in g/°/s ---
function convertAccelerometerRaw(raw) { return raw / 4096; }
function convertGyroscopeRaw(raw)     { return raw / 65.54; }
function convertMagnetometerRaw(raw)  { return raw * 0.3; }

// --- Socket + Rendering ---
document.addEventListener('DOMContentLoaded', function() {
  initializeSocketListeners();
  fetchInitialData();
  startFpsCounter();
  startRenderLoop();
});
function initializeSocketListeners() {
  socket.on('connect', function() { updateConnectionStatus(true); });
  socket.on('disconnect', function() { updateConnectionStatus(false); });
  socket.on('connection_response', function(data) { sensors = data.sensors; renderSensors(); });
  socket.on('sensor_update', function(data) {
    var sensorName = data.sensor_name;
    var d = data.data;
    // Converte IMU
    var c = {timestamp: d.timestamp};
    c.accel_x   = convertAccelerometerRaw(d.accel_x);
    c.accel_y   = convertAccelerometerRaw(d.accel_y);
    c.accel_z   = convertAccelerometerRaw(d.accel_z);
    c.gyro_x    = convertGyroscopeRaw(d.gyro_x);
    c.gyro_y    = convertGyroscopeRaw(d.gyro_y);
    c.gyro_z    = convertGyroscopeRaw(d.gyro_z);
    c.mag_x     = convertMagnetometerRaw(d.mag_x);
    c.mag_y     = convertMagnetometerRaw(d.mag_y);
    c.mag_z     = convertMagnetometerRaw(d.mag_z);
    // Copia 3 pressioni
    for (var k in d) if (k.startsWith('pressure_')) c[k] = d[k];
    sensors[sensorName] = c;
    updateSensorCard(sensorName, c);
  });
  socket.on('data_cleared', function() { sensors = {}; pressState = {}; renderSensors(); });
}

function updateSensorCard(sensorName, d) {
  var card = document.querySelector('[data-sensor="' + sensorName + '"]');
  if (!card) {
    createSensorCard(sensorName, d);
    return;
  }
  var v = card.querySelectorAll('.sensor-value');
  // IMU aggiorno sempre (protezione outlier)
  if (v.length >= 9) {
    [d.accel_x, d.accel_y, d.accel_z, d.gyro_x, d.gyro_y, d.gyro_z, d.mag_x, d.mag_y, d.mag_z].forEach(function(val, i) {
      if (Math.abs(val) > 2000) return;
      v[i].textContent = val !== undefined ? val.toFixed(3) : '---';
    });
  }
  // PRESSIONI SEMPRE 3 (stabili, PU/kg filtrate)
  var pdiv = card.querySelector('.sensor-pressures');
  if (pdiv) {
    var html = '';
    var tot = 0, count = 0;
    ['pressure_0','pressure_1','pressure_2'].forEach(function(key, i) {
      var val = (d[key] !== undefined ? computePressurePUkg(sensorName, key, d[key]) : 0);
      tot += val; if (val > 0) count++;
      var lab = ['Laterale','Mediale','Tallone'][i];
      var col = val < 1 ? '#444' : (val<2?'#97c93e':val<5?'#ffa500':'#ff4444');
      html += `<div style="display:flex;justify-content:space-between;font-size:12px;"><span style="color:${col}">${lab}:</span><span><b>${val.toFixed(2)}</b> <span style="color:#888;font-size:10px;">PU/kg</span></span></div>`;
    });
    pdiv.innerHTML = `<div style="margin-top:10px;padding:10px 5px 5px 5px;background:rgba(151,201,62,0.08);border-radius:6px;">
      <div style="font-size:10px;color:#97c93e;font-weight:700;margin-bottom:3px;display:flex;justify-content:space-between;">🦶 PRESS.<span style="color:#fff;background:#222;padding:3px 8px;border-radius:3px;">Σ ${tot.toFixed(2)} PU/kg</span></div>${html}</div>`;
  }
  var ts = card.querySelector('.sensor-timestamp');
  if (ts && d.timestamp) ts.textContent = d.timestamp.substr(11, 8);
}

function createSensorCard(sensorName, d) {
  var grid = document.getElementById('sensors-grid');
  var emoji = '🧦';
  var t = document.createElement('div');
  t.className = 'sensor-col connected';
  t.setAttribute('data-sensor', sensorName);
  t.innerHTML = `
    <div class="sensor-header"><div>${emoji} ${sensorName}</div><div class="status-indicator active"></div></div>
    <div class="sensor-data-section">
      <div class="sensor-data-section-title">📊 Acc (g)</div>
      <div class="sensor-data-row"><span class="sensor-data-label">X:</span><span class="sensor-value">---</span></div>
      <div class="sensor-data-row"><span class="sensor-data-label">Y:</span><span class="sensor-value">---</span></div>
      <div class="sensor-data-row"><span class="sensor-data-label">Z:</span><span class="sensor-value">---</span></div>
    </div>
    <div class="sensor-data-section">
      <div class="sensor-data-section-title">🌀 Gyro (°/s)</div>
      <div class="sensor-data-row"><span class="sensor-data-label">X:</span><span class="sensor-value">---</span></div>
      <div class="sensor-data-row"><span class="sensor-data-label">Y:</span><span class="sensor-value">---</span></div>
      <div class="sensor-data-row"><span class="sensor-data-label">Z:</span><span class="sensor-value">---</span></div>
    </div>
    <div class="sensor-data-section">
      <div class="sensor-data-section-title">🧲 Mag (µT)</div>
      <div class="sensor-data-row"><span class="sensor-data-label">X:</span><span class="sensor-value">---</span></div>
      <div class="sensor-data-row"><span class="sensor-data-label">Y:</span><span class="sensor-value">---</span></div>
      <div class="sensor-data-row"><span class="sensor-data-label">Z:</span><span class="sensor-value">---</span></div>
    </div>
    <div class="sensor-pressures"></div>
    <span class="sensor-timestamp">--:--:--</span>
  `;
  grid.appendChild(t);
}

// rendering, status, fetch, calibrate, clear: come in versione tua precedente

function renderSensors() {
  var grid = document.getElementById('sensors-grid');
  var emptyState = document.getElementById('empty-state');
  var sensorNames = Object.keys(sensors);
  grid.innerHTML = '';
  if (sensorNames.length === 0) {
    grid.style.display = 'none'; emptyState.classList.add('visible'); return;
  }
  grid.style.display = 'grid'; emptyState.classList.remove('visible');
  sensorNames.forEach(function(name) { createSensorCard(name, sensors[name]); });
}
function fetchInitialData() {
  fetch('/api/sensors').then(res=>res.json()).then(data=>{
    sensors = data.sensors || {}; renderSensors();
  });
}
function updateConnectionStatus(connected) {
  var statusEl = document.getElementById('connection-status'), countEl = document.getElementById('sensor-count');
  if (statusEl) statusEl.innerHTML = connected ? '<span class="dot"></span> Connesso' : '<span class="dot"></span> Disconnesso';
  if (countEl) {
    var count = Object.keys(sensors).length;
    countEl.textContent = count + ' Sensore' + (count !== 1 ? 'i' : '');
  }
}
function startFpsCounter() {
  setInterval(function() {
    var fpsEl = document.getElementById('fps-counter');
    currentFps = Math.max(currentFps, 0); // puoi calcolare davvero se vuoi
    if (fpsEl) fpsEl.textContent = currentFps + ' Hz';
  }, 1000);
}
function startRenderLoop() {requestAnimationFrame(startRenderLoop);}
function calibrateKnee() {} // disattivato per ora (solo ginocchio)
function clearAllData() {
  if (!confirm('Pulire dati?')) return;
  fetch('/api/clear', { method: 'POST' }).then(()=>{ sensors={}; pressState={}; renderSensors(); });
}
