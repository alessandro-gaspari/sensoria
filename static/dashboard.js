var socket = io({ reconnection: true, reconnectionDelay: 100, reconnectionDelayMax: 1000, reconnectionAttempts: 5, transports: ['websocket'], upgrade: false });

var sensors = {};
var isConnected = false;
var frameCount = 0;
var lastFrameTime = Date.now();
var currentFps = 0;

var kneeAngle = 0;
var calibrated = false;

document.addEventListener('DOMContentLoaded', function() {
  initializeSocketListeners();
  fetchInitialData();
  startFpsCounter();
});

function startFpsCounter() {
  setInterval(function() {
    var now = Date.now();
    var elapsed = (now - lastFrameTime) / 1000;
    currentFps = Math.round(frameCount / elapsed);
    frameCount = 0;
    lastFrameTime = now;
    updateConnectionStatus(isConnected);
  }, 1000);
}

function initializeSocketListeners() {
  socket.on('connect', function() { isConnected = true; updateConnectionStatus(true); });
  socket.on('disconnect', function() { isConnected = false; updateConnectionStatus(false); });

  socket.on('connection_response', function(data) {
    sensors = data.sensors || {};
    if (data.knee_angle) {
      kneeAngle = data.knee_angle.angle || 0;
      calibrated = !!data.knee_angle.calibrated;
    }
    renderSensors();
    updateKneeAngleDisplay();
  });

  socket.on('sensor_update', function(payload) {
    frameCount++;
    const name = payload.sensor_name;
    const d = payload.data || {};
    const conv = {
      timestamp: d.timestamp,
      ax: d.accel_x_ms2 ?? d.accel_x,
      ay: d.accel_y_ms2 ?? d.accel_y,
      az: d.accel_z_ms2 ?? d.accel_z,
      gx: d.gyro_x_dps ?? d.gyro_x,
      gy: d.gyro_y_dps ?? d.gyro_y,
      gz: d.gyro_z_dps ?? d.gyro_z,
      mx: d.mag_x_uT   ?? d.mag_x,
      my: d.mag_y_uT   ?? d.mag_y,
      mz: d.mag_z_uT   ?? d.mag_z,
    };
    sensors[name] = conv;
    updateSensorDirectly(name, conv);
  });

  socket.on('knee_angle_update', function(msg) {
    kneeAngle = msg.angle || 0;
    calibrated = !!msg.calibrated;
    updateKneeAngleDisplay();
  });

  socket.on('data_cleared', function() {
    sensors = {}; kneeAngle = 0; calibrated = false;
    renderSensors(); updateKneeAngleDisplay();
  });
}

function fetchInitialData() {
  fetch('/api/sensors')
    .then(r => r.json())
    .then(data => {
      sensors = data.sensors || {};
      if (data.knee_angle) {
        kneeAngle = data.knee_angle.angle || 0;
        calibrated = !!data.knee_angle.calibrated;
      }
      renderSensors(); updateKneeAngleDisplay();
    });
}

function updateKneeAngleDisplay() {
  var el = document.getElementById('knee-angle-display');
  if (!el) return;
  const statusText = calibrated ? '✓ Calibrato' : '✗ Non calibrato';
  const statusColor = calibrated ? '#97c93e' : '#ff9500';
  el.innerHTML =
    '<div style="background: linear-gradient(135deg, #97c93e 0%, #6fa52d 100%); border-radius: 12px; padding: 20px; text-align: center; color: #000; box-shadow: 0 4px 15px rgba(0,0,0,0.3);">' +
      '<div style="font-size: 12px; font-weight: 600; opacity: 0.9;">ANGOLO GINOCCHIO</div>' +
      '<div style="font-size: 72px; font-weight: 700; margin: 8px 0; font-family: monospace;">' + kneeAngle + '°</div>' +
      '<div style="font-size: 11px; opacity: 0.8;"><span style="color: ' + statusColor + '; font-weight: 700;">' + statusText + '</span></div>' +
    '</div>';
}

function renderSensors() {
  var grid = document.getElementById('sensors-grid');
  var emptyState = document.getElementById('empty-state');
  var names = Object.keys(sensors);

  if (names.length === 0) {
    grid.style.display = 'none'; emptyState.classList.add('visible'); return;
  }
  grid.style.display = 'grid'; emptyState.classList.remove('visible'); grid.innerHTML = '';

  var toShow = names.slice(0, 6);
  toShow.forEach(function(name) {
    var data = sensors[name];
    var emoji = getSensorEmoji(name);
    var card = document.createElement('div');
    card.className = 'sensor-col connected';
    card.setAttribute('data-sensor', name);

    card.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
        '<div class="sensor-header">' + emoji + ' ' + name + '</div>' +
      '</div>' +
      '<div class="sensor-grid" style="background:#1a1a2a;padding:8px;border-radius:4px;margin:8px 0;border:2px solid #88a;">' +
        '<div class="sensor-row" data-k="ax"><b>AX:</b> <span class="sensor-value" style="color:#88a;font-weight:bold;">--</span> m/s²</div>' +
        '<div class="sensor-row" data-k="ay"><b>AY:</b> <span class="sensor-value" style="color:#88a;font-weight:bold;">--</span> m/s²</div>' +
        '<div class="sensor-row" data-k="az"><b>AZ:</b> <span class="sensor-value" style="color:#88a;font-weight:bold;">--</span> m/s²</div>' +
        '<div class="sensor-row" data-k="gx"><b>GX:</b> <span class="sensor-value" style="color:#88a;font-weight:bold;">--</span> °/s</div>' +
        '<div class="sensor-row" data-k="gy"><b>GY:</b> <span class="sensor-value" style="color:#88a;font-weight:bold;">--</span> °/s</div>' +
        '<div class="sensor-row" data-k="gz"><b>GZ:</b> <span class="sensor-value" style="color:#88a;font-weight:bold;">--</span> °/s</div>' +
        '<div class="sensor-row" data-k="mx"><b>MX:</b> <span class="sensor-value" style="color:#88a;font-weight:bold;">--</span> µT</div>' +
        '<div class="sensor-row" data-k="my"><b>MY:</b> <span class="sensor-value" style="color:#88a;font-weight:bold;">--</span> µT</div>' +
        '<div class="sensor-row" data-k="mz"><b>MZ:</b> <span class="sensor-value" style="color:#88a;font-weight:bold;">--</span> µT</div>' +
      '</div>' +
      '<div style="margin-top:12px;font-size:11px;color:#666;text-align:center;"><span class="sensor-timestamp">--:--:--</span></div>';

    grid.appendChild(card);
    updateSensorDirectly(name, data);
  });

  for (var i = toShow.length; i < 6; i++) {
    var slot = document.createElement('div');
    slot.className = 'sensor-col';
    slot.innerHTML = '<div class="sensor-header">Slot ' + (i + 1) + '</div>';
    grid.appendChild(slot);
  }

  updateConnectionStatus(isConnected);
}

function updateSensorDirectly(sensorName, data) {
  var sensorCard = document.querySelector('[data-sensor="' + sensorName + '"]');
  if (!sensorCard) return;

  const rows = [
    { key: 'ax', unit: 'm/s²' },
    { key: 'ay', unit: 'm/s²' },
    { key: 'az', unit: 'm/s²' },
    { key: 'gx', unit: '°/s' },
    { key: 'gy', unit: '°/s' },
    { key: 'gz', unit: '°/s' },
    { key: 'mx', unit: 'µT' },
    { key: 'my', unit: 'µT' },
    { key: 'mz', unit: 'µT' },
  ];

  rows.forEach(r => {
    const row = sensorCard.querySelector('.sensor-row[data-k="'+r.key+'"] .sensor-value');
    if (!row) return;
    const v = data[r.key];
    if (v !== undefined && v !== null && !Number.isNaN(v)) {
      row.textContent = Number(v).toFixed(2);
    }
  });

  var timestampEl = sensorCard.querySelector('.sensor-timestamp');
  if (timestampEl && data.timestamp) {
    var date = new Date(data.timestamp);
    timestampEl.textContent = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0') + ':' + String(date.getSeconds()).padStart(2, '0');
  }
}

function getSensorEmoji(name) {
  var n = name.toLowerCase();
  if (n.indexOf('ginocchio') !== -1 || n.indexOf('knee') !== -1) return '🦿';
  if (n.indexOf('piede') !== -1 || n.indexOf('foot') !== -1) return '🧦';
  return '📱';
}

function updateConnectionStatus(connected) {
  var statusEl = document.getElementById('connection-status');
  var countEl = document.getElementById('sensor-count');
  var fpsEl = document.getElementById('fps-counter');

  if (statusEl) {
    statusEl.classList.toggle('disconnected', !connected);
    statusEl.innerHTML = connected ? '<span class="dot"></span> Connesso' : '<span class="dot"></span> Disconnesso';
  }
  if (countEl) {
    var count = Object.keys(sensors).length;
    countEl.textContent = count + ' Sensore' + (count !== 1 ? 'i' : '');
  }
  if (fpsEl) {
    fpsEl.textContent = currentFps + ' Hz';
  }
}
