var socket = io({
    reconnection: true,
    reconnectionDelay: 100,
    reconnectionDelayMax: 1000,
    reconnectionAttempts: 5,
    transports: ['websocket'],
    upgrade: false,
});

// ⭐ SCALE FACTOR
var S_ACC = 4096;
var S_GYRO = 65.54;
var S_MAG = 0.3;

// ⭐ FILTERING PARAMETERS
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

// ⭐ PERFORMANCE OPTIMIZATION: DOM CACHING
var domCache = {};
var pendingUpdates = {};

document.addEventListener('DOMContentLoaded', function() {
    initializeSocketListeners();
    fetchInitialData();
    startFpsCounter();
    startRenderLoop();
});

// ⭐ CONVERSIONE PRESSIONE RAW → kg/m²
function convertPressureToKgM2(raw) {
    // Conversione empirica: normalizza il valore raw
    // Assumiamo che i valori raw vadano da -32768 a 32767
    // E che 0 = nessuna pressione, valori positivi = pressione
    
    // Formula semplice: prendi il valore assoluto e scala
    // Se hai calibrazione specifica del sensore, modifica qui
    var absRaw = Math.abs(raw);
    
    // Scala approssimativa: 1000 raw units ≈ 1 kg/m²
    // Modifica questo fattore in base ai tuoi test
    var kgM2 = absRaw / 100.0;
    
    return kgM2;
}

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
        
        // ⭐ COPIA PRESSIONI
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

// ⭐ UPDATE SENSOR CARD CON PRESSIONI
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
    
    // ⭐ AGGIORNA PRESSIONI
    var pressureHtml = '';
    var hasPressure = false;
    for (var i = 1; i <= 9; i++) {
        var raw = data['pressure_' + i];
        if (raw !== undefined) {
            hasPressure = true;
            var kgM2 = convertPressureToKgM2(raw);
            pressureHtml += '<div style="font-size:11px; margin:2px 0; display:flex; justify-content:space-between;">' +
                '<span style="color:#97c93e;">P' + i + ':</span>' +
                '<span>' + kgM2.toFixed(2) + ' <span style="color:#888;">kg/m²</span></span>' +
                '</div>';
        }
    }
    
    if (hasPressure && cached.pressures) {
        cached.pressures.innerHTML = '<div style="margin-top:12px; padding:8px; background:rgba(151,201,62,0.1); border-radius:6px;">' +
            '<div style="font-size:10px; color:#97c93e; font-weight:600; margin-bottom:6px;">🦶 PRESSIONI PLANTARI</div>' +
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
    
    var accelX = (data.accel_x !== undefined) ? data.accel_x.toFixed(3) : '---';
    var accelY = (data.accel_y !== undefined) ? data.accel_y.toFixed(3) : '---';
    var accelZ = (data.accel_z !== undefined) ? data.accel_z.toFixed(3) : '---';
    var gyroX = (data.gyro_x !== undefined) ? data.gyro_x.toFixed(3) : '---';
    var gyroY = (data.gyro_y !== undefined) ? data.gyro_y.toFixed(3) : '---';
    var gyroZ = (data.gyro_z !== undefined) ? data.gyro_z.toFixed(3) : '---';
    var magX = (data.mag_x !== undefined) ? data.mag_x.toFixed(3) : '---';
    var magY = (data.mag_y !== undefined) ? data.mag_y.toFixed(3) : '---';
    var magZ = (data.mag_z !== undefined) ? data.mag_z.toFixed(3) : '---';
    
    template.innerHTML = 
        '<div class="sensor-header">' +
            '<div>' + emoji + ' ' + sensorName + '</div>' +
            '<div class="status-indicator active"></div>' +
        '</div>' +
        '<div class="sensor-data-section">' +
            '<div class="sensor-data-section-title">📊 Acc (g)</div>' +
            '<div class="sensor-data-row"><span class="sensor-data-label">X:</span><span class="sensor-value">' + accelX + '</span></div>' +
            '<div class="sensor-data-row"><span class="sensor-data-label">Y:</span><span class="sensor-value">' + accelY + '</span></div>' +
            '<div class="sensor-data-row"><span class="sensor-data-label">Z:</span><span class="sensor-value">' + accelZ + '</span></div>' +
        '</div>' +
        '<div class="sensor-data-section">' +
            '<div class="sensor-data-section-title">🌀 Gyro (°/s)</div>' +
            '<div class="sensor-data-row"><span class="sensor-data-label">X:</span><span class="sensor-value">' + gyroX + '</span></div>' +
            '<div class="sensor-data-row"><span class="sensor-data-label">Y:</span><span class="sensor-value">' + gyroY + '</span></div>' +
            '<div class="sensor-data-row"><span class="sensor-data-label">Z:</span><span class="sensor-value">' + gyroZ + '</span></div>' +
        '</div>' +
        '<div class="sensor-data-section">' +
            '<div class="sensor-data-section-title">🧲 Mag (µT)</div>' +
            '<div class="sensor-data-row"><span class="sensor-data-label">X:</span><span class="sensor-value">' + magX + '</span></div>' +
            '<div class="sensor-data-row"><span class="sensor-data-label">Y:</span><span class="sensor-value">' + magY + '</span></div>' +
            '<div class="sensor-data-row"><span class="sensor-data-label">Z:</span><span class="sensor-value">' + magZ + '</span></div>' +
        '</div>' +
        '<div class="sensor-pressures"></div>' +  // ⭐ Qui vanno le pressioni
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
