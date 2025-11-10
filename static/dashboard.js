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
var FILTER_ALPHA = 0.12;
var BUFFER_SIZE = 8;
var OUTLIER_THRESHOLD = 15;

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

// ⭐ BASELINE PRESSIONI (calibrazione automatica)
var pressureBaselines = {};

// ⭐ PESO CORPOREO (da impostare o rilevare)
var BODY_WEIGHT_KG = 75; // Modifica con il peso dell'atleta

// ⭐ CONVERSIONE PRESSIONE - FORMULA SCIENTIFICA
function initPressureBaseline(sensorName, sensorKey, rawValue) {
    if (!pressureBaselines[sensorName]) {
        pressureBaselines[sensorName] = {};
    }
    
    if (!pressureBaselines[sensorName][sensorKey]) {
        // Calibra baseline: media prime 20 letture
        if (!pressureBaselines[sensorName][sensorKey + '_buffer']) {
            pressureBaselines[sensorName][sensorKey + '_buffer'] = [];
        }
        
        var buffer = pressureBaselines[sensorName][sensorKey + '_buffer'];
        buffer.push(rawValue);
        
        if (buffer.length >= 20) {
            var sum = 0;
            for (var i = 0; i < buffer.length; i++) sum += buffer[i];
            pressureBaselines[sensorName][sensorKey] = sum / buffer.length;
        }
    }
}

function convertPressureToPUperKg(sensorName, sensorKey, rawValue) {
    // Inizializza baseline
    initPressureBaseline(sensorName, sensorKey, rawValue);
    
    var baseline = pressureBaselines[sensorName][sensorKey];
    if (!baseline) return 0; // Baseline non ancora calibrato
    
    // ⭐ FORMULA: ΔP = P_raw - P_baseline
    var deltaP = rawValue - baseline;
    
    // ⭐ Variazioni negative = aumento pressione (inverti segno)
    deltaP = -deltaP;
    
    // ⭐ NORMALIZZAZIONE: P_norm = ΔP / Peso(kg)
    var pNorm = deltaP / BODY_WEIGHT_KG;
    
    // Solo valori positivi (pressione)
    if (pNorm < 0) return 0;
    
    return pNorm;
}

// ⭐ BONGIORNO INDEX - FORMULA SCIENTIFICA
function calculateBongiornoIndex(ax, ay, az) {
    // BI = (|az| / √(ax² + ay² + az²)) × 100
    var magnitude = Math.sqrt(ax * ax + ay * ay + az * az);
    
    if (magnitude === 0) return 0;
    
    var bi = (Math.abs(az) / magnitude) * 100;
    
    return bi;
}

document.addEventListener('DOMContentLoaded', function() {
    initializeSocketListeners();
    fetchInitialData();
    startFpsCounter();
    startRenderLoop();
});

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
        if (fpsEl) fpsEl.textContent = currentFps + ' Hz';
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
        
        // ⭐ CALCOLA BONGIORNO INDEX
        convertedData.bongiorno_index = calculateBongiornoIndex(
            convertedData.accel_x,
            convertedData.accel_y,
            convertedData.accel_z
        );
        
        // Copia pressioni RAW (convertiamo dopo con baseline)
        for (var key in sensorData) {
            if (key.startsWith('pressure_')) {
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
        pressureBaselines = {};
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
            pressures: card.querySelector('.sensor-pressures'),
            bongiornoIndex: card.querySelector('.bongiorno-index')
        };
    }
    
    var cached = domCache[cacheKey];
    var fields = ['accel_x', 'accel_y', 'accel_z', 'gyro_x', 'gyro_y', 'gyro_z', 'mag_x', 'mag_y', 'mag_z'];
    
    for (var i = 0; i < Math.min(cached.values.length, fields.length); i++) {
        var value = data[fields[i]];
        if (value !== undefined) {
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
    
    // ⭐ BONGIORNO INDEX
    if (cached.bongiornoIndex && data.bongiorno_index !== undefined) {
        var bi = data.bongiorno_index;
        var biColor = '#97c93e';
        if (bi > 50) biColor = '#ffa500';
        if (bi > 70) biColor = '#ff4444';
        
        cached.bongiornoIndex.innerHTML = 
            '<div style="background:rgba(151,201,62,0.1); padding:8px; border-radius:6px; margin-top:10px;">' +
            '<div style="font-size:10px; color:#97c93e; font-weight:700; margin-bottom:4px;">⚡ BONGIORNO INDEX</div>' +
            '<div style="font-size:24px; font-weight:700; color:' + biColor + ';">' + bi.toFixed(1) + '%</div>' +
            '</div>';
    }
    
    // ⭐ AGGIORNA 3 PRESSIONI (S0, S1, S2)
    var pressureHtml = '';
    var hasPressure = false;
    var totalPressure = 0;
    var sensorLabels = ['S0 (Lat)', 'S1 (Med)', 'S2 (Heel)'];
    
    for (var i = 0; i <= 2; i++) {
        var raw = data['pressure_' + i];
        if (raw !== undefined) {
            hasPressure = true;
            
            var puPerKg = convertPressureToPUperKg(sensorName, 'pressure_' + i, raw);
            totalPressure += puPerKg;
            
            var color = '#666';
            if (puPerKg > 1) color = '#97c93e';
            if (puPerKg > 3) color = '#ffa500';
            if (puPerKg > 5) color = '#ff4444';
            
            pressureHtml += '<div style="font-size:11px; margin:4px 0; display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05);">' +
                '<span style="color:' + color + '; font-weight:700;">' + sensorLabels[i] + ':</span>' +
                '<span><strong>' + puPerKg.toFixed(2) + '</strong> <span style="color:#888; font-size:9px;">PU/kg</span></span>' +
                '</div>';
        }
    }
    
    if (hasPressure && cached.pressures) {
        cached.pressures.innerHTML = '<div style="margin-top:12px; padding:10px; background:rgba(151,201,62,0.08); border-radius:8px; border:1px solid rgba(151,201,62,0.2);">' +
            '<div style="font-size:11px; color:#97c93e; font-weight:700; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">' +
                '<span>🦶 PRESSIONI</span>' +
                '<span style="background:rgba(151,201,62,0.3); padding:3px 8px; border-radius:4px; font-size:9px;">Σ ' + totalPressure.toFixed(2) + ' PU/kg</span>' +
            '</div>' +
            pressureHtml +
            '</div>';
    }
    
    if (!updateKneeAngleOptimized.lastCall || Date.now() - updateKneeAngleOptimized.lastCall > 50) {
        updateKneeAngleOptimized();
        updateKneeAngleOptimized.lastCall = Date.now();
    }
}

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
        '<div class="bongiorno-index"></div>' +
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
            pressureBaselines = {};
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
