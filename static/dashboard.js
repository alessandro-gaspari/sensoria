// ⭐ SENSORIA DASHBOARD - Ottimizzato per 8 sensori di pressione
var socket = io({
    reconnection: true,
    reconnectionDelay: 100,
    reconnectionDelayMax: 1000,
    reconnectionAttempts: 5,
    transports: ['websocket'],
    upgrade: false,
});

// ⭐ SCALE FACTORS
var S_ACC = 4096;
var S_GYRO = 65.54;
var S_MAG = 0.3;

// ⭐ FILTERING PARAMETERS
var FILTER_ALPHA = 0.12;
var BUFFER_SIZE = 8;
var OUTLIER_THRESHOLD = 15;

// ⭐ STATE
var sensors = {};
var isConnected = false;
var frameCount = 0;
var lastFrameTime = Date.now();
var currentFps = 0;
var lastDataTime = Date.now();
var heartbeatTimer;

var pitchSupBuffer = [];
var pitchInfBuffer = [];
var filteredPitchSup = 0;
var filteredPitchInf = 0;
var calibrationOffset = 0;
var isCalibrated = false;

var domCache = {};
var pendingUpdates = {};

// ⭐ CONVERSIONE IMU
function convertAccelerometerRaw(raw) {
    return raw / S_ACC;
}

function convertGyroscopeRaw(raw) {
    return raw / S_GYRO;
}

function convertMagnetometerRaw(raw) {
    return raw * S_MAG;
}

// ⭐ BUFFER E FILTRI
function getBufferAverage(buffer) {
    if (buffer.length === 0) return 0;
    var sum = 0;
    for (var i = 0; i < buffer.length; i++) sum += buffer[i];
    return sum / buffer.length;
}

function addToBuffer(buffer, value, maxSize) {
    buffer.push(value);
    if (buffer.length > maxSize) buffer.shift();
}

function calculatePitch(ax, az) {
    return Math.atan2(ax, az) * (180 / Math.PI);
}

function advancedFilterWithOutlierRemoval(newValue, filteredValue, alpha, buffer, bufferSize, threshold) {
    var bufferAverage = getBufferAverage(buffer);
    var deviation = Math.abs(newValue - bufferAverage);
    
    if (buffer.length > 2 && deviation > threshold) {
        return filteredValue;
    }
    
    addToBuffer(buffer, newValue, bufferSize);
    var avg = getBufferAverage(buffer);
    return alpha * avg + (1 - alpha) * filteredValue;
}

// ⭐ INIT
document.addEventListener('DOMContentLoaded', function() {
    initializeSocketListeners();
    fetchInitialData();
    startFpsCounter();
    startRenderLoop();
});

// ⭐ RENDER LOOP
function startRenderLoop() {
    function render() {
        if (Object.keys(pendingUpdates).length > 0) {
            batchUpdateDOM();
        }
        requestAnimationFrame(render);
    }
    requestAnimationFrame(render);
}

function batchUpdateDOM() {
    Object.keys(pendingUpdates).forEach(function(sensorName) {
        var data = pendingUpdates[sensorName];
        updateSensorCardOptimized(sensorName, data);
    });
    pendingUpdates = {};
}

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
        
        var fpsEl = document.getElementById('fps-counter');
        if (fpsEl) fpsEl.textContent = (currentFps || 0) + ' Hz';
    }, 1000);
}

// ⭐ SOCKET LISTENERS
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
            accel_x: convertAccelerometerRaw(sensorData.accel_x || 0),
            accel_y: convertAccelerometerRaw(sensorData.accel_y || 0),
            accel_z: convertAccelerometerRaw(sensorData.accel_z || 0),
            gyro_x: convertGyroscopeRaw(sensorData.gyro_x || 0),
            gyro_y: convertGyroscopeRaw(sensorData.gyro_y || 0),
            gyro_z: convertGyroscopeRaw(sensorData.gyro_z || 0),
            mag_x: convertMagnetometerRaw(sensorData.mag_x || 0),
            mag_y: convertMagnetometerRaw(sensorData.mag_y || 0),
            mag_z: convertMagnetometerRaw(sensorData.mag_z || 0),
        };
        
        // ⭐ Copia TUTTE le pressioni (0-7)
        for (var i = 0; i <= 7; i++) {
            var key = 'pressure_' + i;
            if (sensorData[key] !== undefined) {
                convertedData[key] = sensorData[key];
            }
        }
        
        sensors[sensorName] = convertedData;
        pendingUpdates[sensorName] = convertedData;
        
        var n = sensorName.toLowerCase();
        var pitch = calculatePitch(convertedData.accel_x, convertedData.accel_z);
        
        if (n.indexOf('sup') !== -1 || n.indexOf('sopra') !== -1 || n.indexOf('upper') !== -1 || n.indexOf('top') !== -1) {
            filteredPitchSup = advancedFilterWithOutlierRemoval(
                pitch, filteredPitchSup, FILTER_ALPHA, pitchSupBuffer, BUFFER_SIZE, OUTLIER_THRESHOLD
            );
        }
        
        if (n.indexOf('inf') !== -1 || n.indexOf('sotto') !== -1 || n.indexOf('lower') !== -1 || n.indexOf('bottom') !== -1) {
            filteredPitchInf = advancedFilterWithOutlierRemoval(
                pitch, filteredPitchInf, FILTER_ALPHA, pitchInfBuffer, BUFFER_SIZE, OUTLIER_THRESHOLD
            );
        }
    });

    socket.on('sensor_disconnected', function(data) {
        var sensorCard = document.querySelector('[data-sensor="' + data.sensor_name + '"]');
        if (sensorCard) {
            sensorCard.classList.add('disconnected');
        }
    });

    socket.on('data_cleared', function() {
        sensors = {};
        pitchSupBuffer = [];
        pitchInfBuffer = [];
        filteredPitchSup = 0;
        filteredPitchInf = 0;
        calibrationOffset = 0;
        isCalibrated = false;
        renderSensors();
        resetHeartbeat();
    });
}

// ⭐ GINOCCHIO
function calibrateKnee() {
    calibrationOffset = filteredPitchSup - filteredPitchInf;
    isCalibrated = true;
    updateKneeAngleOptimized();
    alert('✅ Calibrato!\nOffset: ' + calibrationOffset.toFixed(1) + '°');
}

function getKneeAngle() {
    var currentDifference = filteredPitchSup - filteredPitchInf;
    var relativeAngle = currentDifference - calibrationOffset;
    return Math.round(relativeAngle);
}

function updateKneeAngleOptimized() {
    var kneeAngleEl = document.getElementById('knee-angle-display');
    if (!kneeAngleEl) return;
    
    if (!sensors || Object.keys(sensors).length < 2) {
        if (kneeAngleEl.innerHTML.indexOf('Attendi') === -1) {
            kneeAngleEl.innerHTML = '<div style="color: #666; text-align: center; padding: 20px;">⏳ Attendi sensori...</div>';
        }
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
            '<button onclick="calibrateKnee()" style="margin-top: 12px; padding: 8px 16px; background: rgba(0,0,0,0.25); border: 1px solid rgba(0,0,0,0.5); border-radius: 6px; color: inherit; font-weight: 600; cursor: pointer; font-size: 12px; width: 100%;">📍 Calibra</button>' +
        '</div>';
}

// ⭐ UPDATE CARD
function updateSensorCardOptimized(sensorName, data) {
    var cacheKey = 'card-' + sensorName;
    
    if (!domCache[cacheKey]) {
        var card = document.querySelector('[data-sensor="' + sensorName + '"]');
        if (!card) {
            createSensorCardFast(sensorName, data);
            return;
        }
        
        domCache[cacheKey] = {
            card: card,
            values: card.querySelectorAll('.sensor-value'),
            timestamp: card.querySelector('.sensor-timestamp'),
            status: card.querySelector('.status-indicator'),
            pressures: card.querySelector('.sensor-pressures')
        };
    }
    
    var cached = domCache[cacheKey];
    var fields = ['accel_x', 'accel_y', 'accel_z', 'gyro_x', 'gyro_y', 'gyro_z', 'mag_x', 'mag_y', 'mag_z'];
    
    for (var i = 0; i < Math.min(cached.values.length, fields.length); i++) {
        var value = data[fields[i]];
        if (value !== undefined && Math.abs(value) < 2000) {
            cached.values[i].textContent = value.toFixed(3);
        }
    }
    
    if (cached.timestamp && data.timestamp) {
        var date = new Date(data.timestamp);
        cached.timestamp.textContent = 
            String(date.getHours()).padStart(2, '0') + ':' +
            String(date.getMinutes()).padStart(2, '0') + ':' +
            String(date.getSeconds()).padStart(2, '0');
    }
    
    if (cached.status) {
        cached.status.classList.add('active');
        if (cached.status.timeoutId) clearTimeout(cached.status.timeoutId);
        cached.status.timeoutId = setTimeout(function() {
            cached.status.classList.remove('active');
        }, 50);
    }
    
    // ⭐ PRESSIONI RAW - 8 SENSORI (S0-S7)
    var pressureHtml = '';
    var hasPressure = false;
    var sensorLabels = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'];
    
    for (var i = 0; i <= 7; i++) {
        var raw = data['pressure_' + i];
        if (raw !== undefined) {
            hasPressure = true;
            
            // Colore basato su valore assoluto
            var absVal = Math.abs(raw);
            var color = '#666';
            if (absVal > 100) color = '#97c93e';
            if (absVal > 1000) color = '#ffa500';
            if (absVal > 5000) color = '#ff4444';
            
            pressureHtml += '<div style="font-size:10px; margin:2px 0; display:flex; justify-content:space-between; padding:2px 0; border-bottom:1px solid rgba(255,255,255,0.05);">' +
                '<span style="color:' + color + '; font-weight:700;">' + sensorLabels[i] + ':</span>' +
                '<span><strong>' + raw.toFixed(0) + '</strong> <span style="color:#888; font-size:8px;">RAW</span></span>' +
                '</div>';
        }
    }
    
    if (hasPressure && cached.pressures) {
        cached.pressures.innerHTML = '<div style="margin-top:10px; padding:8px; background:rgba(151,201,62,0.08); border-radius:6px; border:1px solid rgba(151,201,62,0.2);">' +
            '<div style="font-size:10px; color:#97c93e; font-weight:700; margin-bottom:6px;">🦶 PRESSIONI RAW</div>' +
            pressureHtml +
            '</div>';
    }
    
    if (!updateKneeAngleOptimized.lastCall || Date.now() - updateKneeAngleOptimized.lastCall > 50) {
        updateKneeAngleOptimized();
        updateKneeAngleOptimized.lastCall = Date.now();
    }
}

// ⭐ CREATE CARD
function createSensorCardFast(sensorName, data) {
    var grid = document.getElementById('sensors-grid');
    var currentSensors = grid.querySelectorAll('[data-sensor]').length;
    if (currentSensors >= 10) return;
    
    var emoji = getSensorEmoji(sensorName);
    var template = document.createElement('div');
    template.className = 'sensor-col connected';
    template.setAttribute('data-sensor', sensorName);
    
    template.innerHTML = 
        '<div class="sensor-header">' +
            '<div>' + emoji + ' ' + sensorName + '</div>' +
            '<div class="status-indicator active"></div>' +
        '</div>' +
        '<div class="sensor-data-section">' +
            '<div class="sensor-data-section-title">📊 Acc (g)</div>' +
            '<div class="sensor-data-row"><span class="sensor-data-label">X:</span><span class="sensor-value">---</span></div>' +
            '<div class="sensor-data-row"><span class="sensor-data-label">Y:</span><span class="sensor-value">---</span></div>' +
            '<div class="sensor-data-row"><span class="sensor-data-label">Z:</span><span class="sensor-value">---</span></div>' +
        '</div>' +
        '<div class="sensor-data-section">' +
            '<div class="sensor-data-section-title">🌀 Gyro (°/s)</div>' +
            '<div class="sensor-data-row"><span class="sensor-data-label">X:</span><span class="sensor-value">---</span></div>' +
            '<div class="sensor-data-row"><span class="sensor-data-label">Y:</span><span class="sensor-value">---</span></div>' +
            '<div class="sensor-data-row"><span class="sensor-data-label">Z:</span><span class="sensor-value">---</span></div>' +
        '</div>' +
        '<div class="sensor-data-section">' +
            '<div class="sensor-data-section-title">🧲 Mag (µT)</div>' +
            '<div class="sensor-data-row"><span class="sensor-data-label">X:</span><span class="sensor-value">---</span></div>' +
            '<div class="sensor-data-row"><span class="sensor-data-label">Y:</span><span class="sensor-value">---</span></div>' +
            '<div class="sensor-data-row"><span class="sensor-data-label">Z:</span><span class="sensor-value">---</span></div>' +
        '</div>' +
        '<div class="sensor-pressures"></div>' +
        '<span class="sensor-timestamp">--:--:--</span>';
    
    grid.appendChild(template);
    
    var emptyState = document.getElementById('empty-state');
    if (emptyState) {
        emptyState.classList.remove('visible');
        grid.style.display = 'grid';
    }
}

function renderSensors() {
    var grid = document.getElementById('sensors-grid');
    var emptyState = document.getElementById('empty-state');
    
    if (!grid || !emptyState) return;
    
    var sensorNames = Object.keys(sensors);
    
    if (sensorNames.length === 0) {
        grid.style.display = 'none';
        emptyState.classList.add('visible');
        return;
    }
    
    grid.style.display = 'grid';
    emptyState.classList.remove('visible');
    
    updateConnectionStatus(isConnected);
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
    
    if (statusEl) {
        statusEl.innerHTML = connected ? '<span class="dot"></span> Connesso' : '<span class="dot"></span> Disconnesso';
    }
    if (countEl) {
        var count = Object.keys(sensors).length;
        countEl.textContent = count + ' Sensore' + (count !== 1 ? 'i' : '');
    }
}

function getSensorEmoji(name) {
    var n = name.toLowerCase();
    if (n.indexOf('ginocchio') !== -1 || n.indexOf('knee') !== -1) return '🦿';
    if (n.indexOf('piede') !== -1 || n.indexOf('foot') !== -1 || n.indexOf('calzino') !== -1) return '🧦';
    if (n.indexOf('braccio') !== -1) return '🦾';
    return '📱';
}

function clearAllData() {
    if (!confirm('Pulire dati?')) return;
    fetch('/api/clear', { method: 'POST' })
        .then(function() {
            sensors = {};
            pitchSupBuffer = [];
            pitchInfBuffer = [];
            filteredPitchSup = 0;
            filteredPitchInf = 0;
            calibrationOffset = 0;
            isCalibrated = false;
            domCache = {};
            renderSensors();
        });
}
