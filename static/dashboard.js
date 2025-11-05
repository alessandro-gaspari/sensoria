var socket = io({
    reconnection: true,
    reconnectionDelay: 100,
    reconnectionDelayMax: 1000,
    reconnectionAttempts: 5,
    transports: ['websocket'],
    upgrade: false,
});

var S_ACC = 4096;
var S_GYRO = 65.54;
var S_MAG = 0.3;

// ⭐ SMOOTHING BUFFERS - Solo Gyro
var smoothBufferSupGX = [];
var smoothBufferInfGX = [];
var SMOOTH_WINDOW = 10;

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
var lastUpdateTime = Date.now();

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

function convertAccelerometerRaw(raw) {
    return raw / S_ACC;
}

function convertGyroscopeRaw(raw) {
    return raw / S_GYRO;
}

function convertMagnetometerRaw(raw) {
    return raw * S_MAG;
}

// ⭐ SMOOTHING
function smoothValue(buffer, value) {
    buffer.push(value);
    if (buffer.length > SMOOTH_WINDOW) {
        buffer.shift();
    }
    
    var sum = 0;
    for (var i = 0; i < buffer.length; i++) {
        sum += buffer[i];
    }
    return sum / buffer.length;
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
        var now = Date.now();
        var deltaTime = (now - lastUpdateTime) / 1000;
        lastUpdateTime = now;

        // Converte raw
        var convertedData = {
            timestamp: sensorData.timestamp,
            accel_x: convertAccelerometerRaw(sensorData.accel_x),
            accel_y: convertAccelerometerRaw(sensorData.accel_y),
            accel_z: convertAccelerometerRaw(sensorData.accel_z),
            gyro_x: convertGyroscopeRaw(sensorData.gyro_x),
            gyro_y: convertGyroscopeRaw(sensorData.gyro_y),
            gyro_z: convertGyroscopeRaw(sensorData.gyro_z),
            mag_x: convertMagnetometerRaw(sensorData.mag_x),
            mag_y: convertMagnetometerRaw(sensorData.mag_y),
            mag_z: convertMagnetometerRaw(sensorData.mag_z),
        };
        
        sensors[sensorName] = convertedData;
        
        var n = sensorName.toLowerCase();
        
        // ⭐ SUP - SOLO GYRO INTEGRATO
        if (n.indexOf('sup') !== -1 || n.indexOf('sopra') !== -1 || n.indexOf('upper') !== -1) {
            var gx_smooth = smoothValue(smoothBufferSupGX, convertedData.gyro_x);
            
            // Integra nel tempo
            angleSup = angleSup + (gx_smooth * deltaTime);
            
            console.log('[SUP] GX:' + gx_smooth.toFixed(1) + '°/s (ΔT:' + deltaTime.toFixed(3) + 's) → ANGLE:' + angleSup.toFixed(1) + '°');
        }
        
        // ⭐ INF - SOLO GYRO INTEGRATO
        // ⚠️ Se il sensore è capovolto, inverti il segno!
        if (n.indexOf('inf') !== -1 || n.indexOf('sotto') !== -1 || n.indexOf('lower') !== -1) {
            var gx_smooth = smoothValue(smoothBufferInfGX, convertedData.gyro_x);
            
            // Inverti il segno se montato capovolto
            angleInf = angleInf + (gx_smooth * deltaTime);
            
            console.log('[INF] GX:' + gx_smooth.toFixed(1) + '°/s (ΔT:' + deltaTime.toFixed(3) + 's) → ANGLE:' + angleInf.toFixed(1) + '°');
        }
        
        // Calcola differenza
        var currentDifference = angleSup - angleInf;
        var relativeAngle = currentDifference - calibrationOffset;
        
        console.log('[KNEE] SUP:' + angleSup.toFixed(1) + '° - INF:' + angleInf.toFixed(1) + '° - Offset:' + calibrationOffset.toFixed(1) + '° = ' + relativeAngle.toFixed(1) + '°');
        
        updateSensorDirectly(sensorName, convertedData);
        updateKneeAngleDisplay();
    });

    socket.on('data_cleared', function() {
        sensors = {};
        angleSup = 0;
        angleInf = 0;
        calibrationOffset = 0;
        isCalibrated = false;
        smoothBufferSupGX = [];
        smoothBufferInfGX = [];
        renderSensors();
        resetHeartbeat();
    });
}

function calibrateKnee() {
    console.log('📍 CALIBRAZIONE');
    console.log('   SUP: ' + angleSup.toFixed(2) + '°');
    console.log('   INF: ' + angleInf.toFixed(2) + '°');
    
    calibrationOffset = angleSup - angleInf;
    isCalibrated = true;
    
    console.log('✅ CALIBRATO - Offset: ' + calibrationOffset.toFixed(1) + '°');
    updateKneeAngleDisplay();
    alert('✅ Calibrato!\nOffset: ' + calibrationOffset.toFixed(1) + '°');
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
    var fields = ['accel_x', 'accel_y', 'accel_z', 'gyro_x', 'gyro_y', 'gyro_z', 'mag_x', 'mag_y', 'mag_z'];
    
    for (var i = 0; i < Math.min(valueElements.length, fields.length); i++) {
        var value = data[fields[i]];
        if (value !== undefined) {
            valueElements[i].textContent = value.toFixed(2);
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
    
    var ax = (data.accel_x !== undefined) ? data.accel_x.toFixed(2) : '---';
    var ay = (data.accel_y !== undefined) ? data.accel_y.toFixed(2) : '---';
    var az = (data.accel_z !== undefined) ? data.accel_z.toFixed(2) : '---';
    var gx = (data.gyro_x !== undefined) ? data.gyro_x.toFixed(1) : '---';
    var gy = (data.gyro_y !== undefined) ? data.gyro_y.toFixed(1) : '---';
    var gz = (data.gyro_z !== undefined) ? data.gyro_z.toFixed(1) : '---';
    var mx = (data.mag_x !== undefined) ? data.mag_x.toFixed(2) : '---';
    var my = (data.mag_y !== undefined) ? data.mag_y.toFixed(2) : '---';
    var mz = (data.mag_z !== undefined) ? data.mag_z.toFixed(2) : '---';
    
    template.innerHTML = 
        '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">' +
            '<div class="sensor-header">' + emoji + ' ' + sensorName + '</div>' +
        '</div>' +
        '<div style="background: #222; padding: 8px; border-radius: 4px; margin: 6px 0; border-left: 3px solid #8a8;">' +
            '<div style="font-size: 10px; color: #8a8; font-weight: 600;">📊 ACCEL (g)</div>' +
            '<div class="sensor-data-row"><b>X:</b> <span class="sensor-value">' + ax + '</span> <b>Y:</b> <span class="sensor-value">' + ay + '</span> <b>Z:</b> <span class="sensor-value">' + az + '</span></div>' +
        '</div>' +
        '<div style="background: #1a2a1a; padding: 8px; border-radius: 4px; margin: 6px 0; border-left: 3px solid #4f4;">' +
            '<div style="font-size: 10px; color: #4f4; font-weight: 600;">🌀 GYRO (°/s) ⭐ USATO</div>' +
            '<div class="sensor-data-row"><b>X:</b> <span class="sensor-value">' + gx + '</span> <b>Y:</b> <span class="sensor-value">' + gy + '</span> <b>Z:</b> <span class="sensor-value">' + gz + '</span></div>' +
        '</div>' +
        '<div style="background: #1a1a2a; padding: 8px; border-radius: 4px; margin: 6px 0; border-left: 3px solid #88a;">' +
            '<div style="font-size: 10px; color: #88a; font-weight: 600;">🧲 MAG (µT)</div>' +
            '<div class="sensor-data-row"><b>X:</b> <span class="sensor-value">' + mx + '</span> <b>Y:</b> <span class="sensor-value">' + my + '</span> <b>Z:</b> <span class="sensor-value">' + mz + '</span></div>' +
        '</div>' +
        '<div style="margin-top:6px; font-size:9px; color:#666; text-align:center;"><span class="sensor-timestamp">--:--:--</span></div>';
    
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
        if (emptyState) emptyState.classList.add('visible');
        return;
    }
    
    grid.style.display = 'grid';
    if (emptyState) emptyState.classList.remove('visible');
    grid.innerHTML = '';
    
    var sensorsToShow = sensorNames.slice(0, 6);
    sensorsToShow.forEach(function(name) {
        var data = sensors[name];
        var emoji = getSensorEmoji(name);
        var card = document.createElement('div');
        card.className = 'sensor-col connected';
        card.setAttribute('data-sensor', name);
        
        var ax = (data.accel_x !== undefined) ? data.accel_x.toFixed(2) : '---';
        var ay = (data.accel_y !== undefined) ? data.accel_y.toFixed(2) : '---';
        var az = (data.accel_z !== undefined) ? data.accel_z.toFixed(2) : '---';
        var gx = (data.gyro_x !== undefined) ? data.gyro_x.toFixed(1) : '---';
        var gy = (data.gyro_y !== undefined) ? data.gyro_y.toFixed(1) : '---';
        var gz = (data.gyro_z !== undefined) ? data.gyro_z.toFixed(1) : '---';
        var mx = (data.mag_x !== undefined) ? data.mag_x.toFixed(2) : '---';
        var my = (data.mag_y !== undefined) ? data.mag_y.toFixed(2) : '---';
        var mz = (data.mag_z !== undefined) ? data.mag_z.toFixed(2) : '---';
        
        card.innerHTML =
            '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">' +
                '<div class="sensor-header">' + emoji + ' ' + name + '</div>' +
            '</div>' +
            '<div style="background: #222; padding: 8px; border-radius: 4px; margin: 6px 0; border-left: 3px solid #8a8;">' +
                '<div style="font-size: 10px; color: #8a8; font-weight: 600;">📊 ACCEL (g)</div>' +
                '<div class="sensor-data-row"><b>X:</b> <span class="sensor-value">' + ax + '</span> <b>Y:</b> <span class="sensor-value">' + ay + '</span> <b>Z:</b> <span class="sensor-value">' + az + '</span></div>' +
            '</div>' +
            '<div style="background: #1a2a1a; padding: 8px; border-radius: 4px; margin: 6px 0; border-left: 3px solid #4f4;">' +
                '<div style="font-size: 10px; color: #4f4; font-weight: 600;">🌀 GYRO (°/s) ⭐ USATO</div>' +
                '<div class="sensor-data-row"><b>X:</b> <span class="sensor-value">' + gx + '</span> <b>Y:</b> <span class="sensor-value">' + gy + '</span> <b>Z:</b> <span class="sensor-value">' + gz + '</span></div>' +
            '</div>' +
            '<div style="background: #1a1a2a; padding: 8px; border-radius: 4px; margin: 6px 0; border-left: 3px solid #88a;">' +
                '<div style="font-size: 10px; color: #88a; font-weight: 600;">🧲 MAG (µT)</div>' +
                '<div class="sensor-data-row"><b>X:</b> <span class="sensor-value">' + mx + '</span> <b>Y:</b> <span class="sensor-value">' + my + '</span> <b>Z:</b> <span class="sensor-value">' + mz + '</span></div>' +
            '</div>' +
            '<div style="margin-top:6px; font-size:9px; color:#666; text-align:center;"><span class="sensor-timestamp">--:--:--</span></div>';
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
            smoothBufferSupGX = [];
            smoothBufferInfGX = [];
            renderSensors();
        });
}
