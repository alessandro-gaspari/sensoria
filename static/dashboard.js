var socket = io({
    reconnection: true,
    reconnectionDelay: 100,
    reconnectionDelayMax: 1000,
    reconnectionAttempts: 5,
    transports: ['websocket'],
    upgrade: false,
});

var S_MAG = 0.3;

// ⭐ SMOOTHING BUFFERS
var smoothBufferSupMX = [];
var smoothBufferSupMY = [];
var smoothBufferSupMZ = [];
var smoothBufferInfMX = [];
var smoothBufferInfMY = [];
var smoothBufferInfMZ = [];
var SMOOTH_WINDOW = 10;
var OUTLIER_THRESHOLD = 5;  // ⭐ Scarta picchi > 5µT dalla media

var sensors = {};
var isConnected = false;
var frameCount = 0;
var lastFrameTime = Date.now();
var currentFps = 0;
var lastDataTime = Date.now();
var heartbeatTimer;

var angleSup = 0;  
var angleInf = 0;
var calibrationOffset = 0;
var isCalibrated = false;

document.addEventListener('DOMContentLoaded', function() {
    initializeSocketListeners();
    fetchInitialData();
    startFpsCounter();
});

function resetHeartbeat() {
    lastDataTime = Date.now();
    clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(function() {}, 2000);
}

function startFpsCounter() {
    setInterval(function() {
        var now = Date.now();
        var elapsed = (now - lastFrameTime) / 1000;
        currentFps = Math.round(frameCount / elapsed);
        frameCount = 0;
        lastFrameTime = now;
    }, 1000);
}

function convertMagnetometerRaw(raw) {
    return raw * S_MAG;
}

// ⭐ OUTLIER DETECTION - Scarta picchi anomali
function outlierFilter(buffer, newValue, maxDelta) {
    if (buffer.length === 0) {
        buffer.push(newValue);
        return newValue;
    }
    
    var avg = 0;
    for (var i = 0; i < buffer.length; i++) {
        avg += buffer[i];
    }
    avg = avg / buffer.length;
    
    var delta = Math.abs(newValue - avg);
    
    // Se delta > soglia, scarta il valore
    if (delta > maxDelta) {
        console.log('⚠️ OUTLIER SCARTATO: ' + newValue.toFixed(2) + ' µT (media: ' + avg.toFixed(2) + ', delta: ' + delta.toFixed(2) + ')');
        return avg;
    }
    
    buffer.push(newValue);
    if (buffer.length > SMOOTH_WINDOW) {
        buffer.shift();
    }
    
    var newAvg = 0;
    for (var i = 0; i < buffer.length; i++) {
        newAvg += buffer[i];
    }
    return newAvg / buffer.length;
}

// ⭐ CALCOLA TILT DA MAGNETOMETRO
function calculateTiltFromMagZ(mz, mx, my) {
    var mx_norm = mx;
    var my_norm = my;
    var mz_norm = mz;
    
    var mag_total = Math.sqrt(mx_norm*mx_norm + my_norm*my_norm + mz_norm*mz_norm);
    if (mag_total === 0) return 0;
    
    var tilt = Math.acos(mz_norm / mag_total) * (180 / Math.PI);
    return tilt;
}

function initializeSocketListeners() {
    socket.on('connect', function() {
        console.log('✅ Connesso');
        isConnected = true;
        updateConnectionStatus(true);
        resetHeartbeat();
    });

    socket.on('disconnect', function() {
        console.log('❌ Disconnesso');
        isConnected = false;
        updateConnectionStatus(false);
        clearTimeout(heartbeatTimer);
    });

    socket.on('connection_response', function(data) {
        if (data.sensors) {
            sensors = data.sensors;
            renderSensors();
        }
        resetHeartbeat();
    });

    socket.on('sensor_update', function(data) {
        frameCount++;
        resetHeartbeat();
        
        var sensorName = data.sensor_name;
        var sensorData = data.data;
        
        var convertedData = {
            timestamp: sensorData.timestamp,
            mag_x: convertMagnetometerRaw(sensorData.mag_x),
            mag_y: convertMagnetometerRaw(sensorData.mag_y),
            mag_z: convertMagnetometerRaw(sensorData.mag_z),
            accel_x: sensorData.accel_x,
            accel_y: sensorData.accel_y,
            accel_z: sensorData.accel_z,
            gyro_x: sensorData.gyro_x,
            gyro_y: sensorData.gyro_y,
            gyro_z: sensorData.gyro_z,
        };
        
        sensors[sensorName] = convertedData;
        
        var n = sensorName.toLowerCase();
        
        // ⭐ SUP - Outlier Filter + Smooth
        if (n.indexOf('sup') !== -1 || n.indexOf('sopra') !== -1 || n.indexOf('upper') !== -1) {
            var mx_filtered = outlierFilter(smoothBufferSupMX, convertedData.mag_x, OUTLIER_THRESHOLD);
            var my_filtered = outlierFilter(smoothBufferSupMY, convertedData.mag_y, OUTLIER_THRESHOLD);
            var mz_filtered = outlierFilter(smoothBufferSupMZ, convertedData.mag_z, OUTLIER_THRESHOLD);
            
            var tiltSup = calculateTiltFromMagZ(mz_filtered, mx_filtered, my_filtered);
            angleSup = tiltSup;
            
            console.log('[SUP] MX:' + mx_filtered.toFixed(2) + ' MY:' + my_filtered.toFixed(2) + ' MZ:' + mz_filtered.toFixed(2) + ' → TILT:' + angleSup.toFixed(1) + '°');
        }
        
        // ⭐ INF - Outlier Filter + Smooth
        if (n.indexOf('inf') !== -1 || n.indexOf('sotto') !== -1 || n.indexOf('lower') !== -1) {
            var mx_filtered = outlierFilter(smoothBufferInfMX, convertedData.mag_x, OUTLIER_THRESHOLD);
            var my_filtered = outlierFilter(smoothBufferInfMY, convertedData.mag_y, OUTLIER_THRESHOLD);
            var mz_filtered = outlierFilter(smoothBufferInfMZ, convertedData.mag_z, OUTLIER_THRESHOLD);
            
            var tiltInf = calculateTiltFromMagZ(mz_filtered, mx_filtered, my_filtered);
            angleInf = tiltInf;
            
            console.log('[INF] MX:' + mx_filtered.toFixed(2) + ' MY:' + my_filtered.toFixed(2) + ' MZ:' + mz_filtered.toFixed(2) + ' → TILT:' + angleInf.toFixed(1) + '°');
        }
        
        updateSensorDirectly(sensorName, convertedData);
        updateKneeAngleDisplay();
    });

    socket.on('data_cleared', function() {
        sensors = {};
        angleSup = 0;
        angleInf = 0;
        calibrationOffset = 0;
        isCalibrated = false;
        smoothBufferSupMX = [];
        smoothBufferSupMY = [];
        smoothBufferSupMZ = [];
        smoothBufferInfMX = [];
        smoothBufferInfMY = [];
        smoothBufferInfMZ = [];
        renderSensors();
        resetHeartbeat();
    });
}

function calibrateKnee() {
    console.log('📍 CALIBRAZIONE GINOCCHIO');
    console.log('   SUP: ' + angleSup.toFixed(2) + '°');
    console.log('   INF: ' + angleInf.toFixed(2) + '°');
    console.log('   Differenza: ' + (angleSup - angleInf).toFixed(2) + '°');
    
    calibrationOffset = angleSup - angleInf;
    isCalibrated = true;
    
    console.log('✅ CALIBRATO - Offset: ' + calibrationOffset.toFixed(1) + '°');
    updateKneeAngleDisplay();
    alert('✅ Calibrato!\nOffset: ' + calibrationOffset.toFixed(1) + '°\n\nOra muovi il ginocchio!');
}

function getKneeAngle() {
    var currentDifference = angleSup - angleInf;
    var relativeAngle = currentDifference - calibrationOffset;
    return Math.round(relativeAngle);
}

function updateKneeAngleDisplay() {
    var kneeAngleEl = document.getElementById('knee-angle-display');
    if (!kneeAngleEl) return;
    
    if (!sensors || Object.keys(sensors).length < 2) {
        kneeAngleEl.innerHTML = '<div style="color: #666; text-align: center; padding: 20px;">⏳ Attendi 2 sensori...</div>';
        return;
    }
    
    var kneeAngle = getKneeAngle();
    var statusText = isCalibrated ? '✓ Calibrato' : '✗ Non calibrato';
    var statusColor = isCalibrated ? '#97c93e' : '#ff9500';
    
    kneeAngleEl.innerHTML =
        '<div style="background: linear-gradient(135deg, #97c93e 0%, #6fa52d 100%); border-radius: 12px; padding: 20px; text-align: center; color: #000; box-shadow: 0 4px 15px rgba(0,0,0,0.3);">' +
            '<div style="font-size: 12px; font-weight: 600; opacity: 0.9;">ANGOLO GINOCCHIO</div>' +
            '<div style="font-size: 72px; font-weight: 700; margin: 8px 0; font-family: monospace;">' + kneeAngle + '°</div>' +
            '<div style="font-size: 11px; opacity: 0.8;"><span style="color: ' + statusColor + '; font-weight: 700;">' + statusText + '</span></div>' +
            '<button onclick="calibrateKnee()" style="margin-top: 12px; padding: 8px 16px; background: rgba(0,0,0,0.25); border: 1px solid rgba(0,0,0,0.5); border-radius: 6px; color: inherit; font-weight: 600; cursor: pointer; font-size: 12px; width: 100%;">📍 Calibra (dritto)</button>' +
        '</div>';
}

function updateSensorDirectly(sensorName, data) {
    var sensorCard = document.querySelector('[data-sensor="' + sensorName + '"]');
    if (!sensorCard) {
        createSensorCardFast(sensorName, data);
        return;
    }
    
    var valueElements = sensorCard.querySelectorAll('.sensor-value');
    var fields = ['mag_x', 'mag_y', 'mag_z'];
    
    for (var i = 0; i < Math.min(valueElements.length, fields.length); i++) {
        var value = data[fields[i]];
        if (value !== undefined) {
            valueElements[i].textContent = value.toFixed(3);
        }
    }
    
    var timestampEl = sensorCard.querySelector('.sensor-timestamp');
    if (timestampEl && data.timestamp) {
        var date = new Date(data.timestamp);
        timestampEl.textContent = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0') + ':' + String(date.getSeconds()).padStart(2, '0');
    }
}

function createSensorCardFast(sensorName, data) {
    var grid = document.getElementById('sensors-grid');
    var currentSensors = grid.querySelectorAll('[data-sensor]').length;
    if (currentSensors >= 6) return;
    
    var emoji = getSensorEmoji(sensorName);
    var template = document.createElement('div');
    template.className = 'sensor-col connected';
    template.setAttribute('data-sensor', sensorName);
    
    var mx = (data.mag_x !== undefined) ? data.mag_x.toFixed(3) : '---';
    var my = (data.mag_y !== undefined) ? data.mag_y.toFixed(3) : '---';
    var mz = (data.mag_z !== undefined) ? data.mag_z.toFixed(3) : '---';
    
    template.innerHTML = 
        '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">' +
            '<div class="sensor-header">' + emoji + ' ' + sensorName + '</div>' +
        '</div>' +
        '<div style="background: #1a1a2a; padding: 8px; border-radius: 4px; margin: 8px 0; border: 2px solid #88a;">' +
            '<div style="font-size: 12px; color: #88a; margin-bottom: 8px; font-weight: 600;">🧲 MAGNETOMETRO (µT)</div>' +
            '<div class="sensor-data-row"><b>MX:</b> <span class="sensor-value" style="color: #88a; font-weight: bold;">' + mx + '</span></div>' +
            '<div class="sensor-data-row"><b>MY:</b> <span class="sensor-value" style="color: #88a; font-weight: bold;">' + my + '</span></div>' +
            '<div class="sensor-data-row"><b>MZ:</b> <span class="sensor-value" style="color: #88a; font-weight: bold;">' + mz + '</span></div>' +
        '</div>' +
        '<div style="margin-top:12px; font-size:11px; color:#666; text-align:center;"><span class="sensor-timestamp">--:--:--</span></div>';
    
    var emptySlot = grid.querySelector('.sensor-col:not([data-sensor])');
    if (emptySlot) {
        emptySlot.replaceWith(template);
    } else {
        grid.appendChild(template);
    }
}

function fetchInitialData() {
    fetch('/api/sensors')
        .then(function(response) { return response.json(); })
        .then(function(data) {
            sensors = data.sensors || {};
            renderSensors();
        });
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

function renderSensors() {
    var grid = document.getElementById('sensors-grid');
    var emptyState = document.getElementById('empty-state');
    var sensorNames = Object.keys(sensors);
    
    if (sensorNames.length === 0) {
        grid.style.display = 'none';
        emptyState.classList.add('visible');
        return;
    }
    
    grid.style.display = 'grid';
    emptyState.classList.remove('visible');
    grid.innerHTML = '';
    
    var sensorsToShow = sensorNames.slice(0, 6);
    sensorsToShow.forEach(function(name) {
        var data = sensors[name];
        var emoji = getSensorEmoji(name);
        var card = document.createElement('div');
        card.className = 'sensor-col connected';
        card.setAttribute('data-sensor', name);
        
        var mx = (data.mag_x !== undefined) ? data.mag_x.toFixed(3) : '---';
        var my = (data.mag_y !== undefined) ? data.mag_y.toFixed(3) : '---';
        var mz = (data.mag_z !== undefined) ? data.mag_z.toFixed(3) : '---';
        
        card.innerHTML =
            '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">' +
                '<div class="sensor-header">' + emoji + ' ' + name + '</div>' +
            '</div>' +
            '<div style="background: #1a1a2a; padding: 8px; border-radius: 4px; margin: 8px 0; border: 2px solid #88a;">' +
                '<div style="font-size: 12px; color: #88a; margin-bottom: 8px; font-weight: 600;">🧲 MAGNETOMETRO (µT)</div>' +
                '<div class="sensor-data-row"><b>MX:</b> <span class="sensor-value" style="color: #88a; font-weight: bold;">' + mx + '</span></div>' +
                '<div class="sensor-data-row"><b>MY:</b> <span class="sensor-value" style="color: #88a; font-weight: bold;">' + my + '</span></div>' +
                '<div class="sensor-data-row"><b>MZ:</b> <span class="sensor-value" style="color: #88a; font-weight: bold;">' + mz + '</span></div>' +
            '</div>' +
            '<div style="margin-top:12px; font-size:11px; color:#666; text-align:center;"><span class="sensor-timestamp">--:--:--</span></div>';
        grid.appendChild(card);
    });
    
    for (var i = sensorsToShow.length; i < 6; i++) {
        var slot = document.createElement('div');
        slot.className = 'sensor-col';
        slot.innerHTML = '<div class="sensor-header">Slot ' + (i + 1) + '</div>';
        grid.appendChild(slot);
    }
    
    updateConnectionStatus(isConnected);
    updateKneeAngleDisplay();
}

function getSensorEmoji(name) {
    var n = name.toLowerCase();
    if (n.indexOf('ginocchio') !== -1 || n.indexOf('knee') !== -1) return '🦿';
    if (n.indexOf('piede') !== -1 || n.indexOf('foot') !== -1) return '🧦';
    return '📱';
}

function clearAllData() {
    if (!confirm('Pulire dati?')) return;
    fetch('/api/clear', { method: 'POST' })
        .then(function() {
            sensors = {};
            angleSup = 0;
            angleInf = 0;
            calibrationOffset = 0;
            isCalibrated = false;
            smoothBufferSupMX = [];
            smoothBufferSupMY = [];
            smoothBufferSupMZ = [];
            smoothBufferInfMX = [];
            smoothBufferInfMY = [];
            smoothBufferInfMZ = [];
            renderSensors();
        });
}
