var socket = io({ reconnection: true, reconnectionDelay: 100, reconnectionDelayMax: 1000, reconnectionAttempts: 5, transports: ['websocket'], upgrade: false });

var sensors = {};
var isConnected = false;
var frameCount = 0;
var lastFrameTime = Date.now();
var currentFps = 0;

var kneeAngle = 0;
var calibrated = false;

const MAG_SCALE = 1; // rimosso doppio 0.3

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
  socket.on('connect', function() {
    isConnected = true; updateConnectionStatus(true);
  });
  socket.on('disconnect', function() {
    isConnected = false; updateConnectionStatus(false);
  });

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
      mag_x: d.mag_x != null ? d.mag_x * MAG_SCALE : undefined,
      mag_y: d.mag_y != null ? d.mag_y * MAG_SCALE : undefined,
      mag_z: d.mag_z != null ? d.mag_z * MAG_SCALE : undefined,
      accel_x: d.accel_x, accel_y: d.accel_y, accel_z: d.accel_z,
      gyro_x: d.gyro_x, gyro_y: d.gyro_y, gyro_z: d.gyro_z,
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

    var mx = (data.mag_x !== undefined) ? (data.mag_x).toFixed(3) : '---';
    var my = (data.mag_y !== undefined) ? (data.mag_y).toFixed(3) : '---';
    var mz = (data.mag_z !== undefined) ? (data.mag_z).toFixed(3) : '---';

    card.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
        '<div class="sensor-header">' + emoji + ' ' + name + '</div>' +
      '</div>' +
      '<div style="background:#1a1a2a;padding:8px;border-radius:4px;margin:8px 0;border:2px solid #88a;">' +
        '<div style="font-size:12px;color:#88a;margin-bottom:8px;font-weight:600;">🧲 MAGNETOMETRO</div>' +
        '<div class="sensor-data-row"><b>MX:</b> <span class="sensor-value" style="color:#88a;font-weight:bold;">' + mx + '</span></div>' +
        '<div class="sensor-data-row"><b>MY:</b> <span class="sensor-value" style="color:#88a;font-weight:bold;">' + my + '</span></div>' +
        '<div class="sensor-data-row"><b>MZ:</b> <span class="sensor-value" style="color:#88a;font-weight:bold;">' + mz + '</span></div>' +
      '</div>' +
      '<div style="margin-top:12px;font-size:11px;color:#666;text-align:center;"><span class="sensor-timestamp">--:--:--</span></div>';
    grid.appendChild(card);
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

  var valueElements = sensorCard.querySelectorAll('.sensor-value');
  var fields = ['mag_x','mag_y','mag_z'];
  for (var i = 0; i < Math.min(valueElements.length, fields.length); i++) {
    var v = data[fields[i]];
    if (v !== undefined) valueElements[i].textContent = v.toFixed(3);
  }

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
