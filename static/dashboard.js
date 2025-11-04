// Connessione Socket.IO
var socket = io({
    reconnection: true,
    reconnectionDelay: 100,
    reconnectionDelayMax: 1000,
    reconnectionAttempts: 5,
    transports: ['websocket'],
    upgrade: false,
});

// Scale factor Sensoria
var S_ACC = 4096;
var S_GYRO = 65.54;
var S_MAG = 0.3;

// ⭐ NUOVO: Filtro passa-basso (smoothing forte)
var FILTER_ALPHA = 0.1;  // 0.1 = filtra 90%, 0.9 = filtra 10%

// Stato applicazione
var sensors = {};
var isConnected = false;
var frameCount = 0;
var lastFrameTime = Date.now();
var currentFps = 0;
var lastDataTime = Date.now();
var heartbeatTimer;

// ⭐ NUOVO: Valori filtrati (smoothed)
var filteredPitchSup = 0;
var filteredPitchInf = 0;
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
    
    heartbeatTimer = setTimeout(function() {
        console.warn('Heartbeat fallito');
    }, 2000);
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

// ⭐ NUOVO: Filtro passa-basso semplice
function lowPassFilter(currentValue, filteredValue, alpha) {
    return alpha * currentValue + (1 - alpha) * filteredValue;
}

// ⭐ Calcola pitch dall'accelerometro
function calculatePitchFromAccel(ax, ay, az) {
    var sqrtYZ = Math.sqrt(ay * ay + az * az);
    var pitchRad = Math.atan2(ax, sqrtYZ);
    var pitchDeg = pitchRad * (180 / Math.PI);
    return pitchDeg;
}

function initializeSocketListeners() {
    socket.on('connect', function() {
        console.log('Connesso al server');
        isConnected = true;
        updateConnectionStatus(true);
        resetHeartbeat();
    });

    socket.on('disconnect', function() {
        console.log('Disconnesso dal server');
        isConnected = false;
        updateConnectionStatus(false);
        clearTimeout(heartbeatTimer);
    });

    socket.on('connection_response', function(data) {
        console.log('Risposta connessione:', data);
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
        
        sensors[sensorName] = convertedData;
        
        // ⭐ CALCOLA PITCH CON FILTRAGGIO
        var n = sensorName.toLowerCase();
        if (n.indexOf('sup') !== -1 || n.indexOf('sopra') !== -1 || n.indexOf('upper') !== -1 || n.indexOf('top') !== -1) {
            var pitchRaw = calculatePitchFromAccel(convertedData.accel_x, convertedData.accel_y, convertedData.accel_z);
            // ⭐ APPLICA FILTRO PASSA-BASSO
            filteredPitchSup = lowPassFilter(pitchRaw, filteredPitchSup, FILTER_ALPHA);
            console.log('[Sup] Raw: ' + pitchRaw.toFixed(1) + '° | Filtered: ' + filteredPitchSup.toFixed(1) + '°');
        }
        if (n.indexOf('inf') !== -1 || n.indexOf('sotto') !== -1 || n.indexOf('lower') !== -1 || n.indexOf('bottom') !== -1) {
            var pitchRaw = calculatePitchFromAccel(convertedData.accel_x, convertedData.accel_y, convertedData.accel_z);
            // ⭐ APPLICA FILTRO PASSA-BASSO
            filteredPitchInf = lowPassFilter(pitchRaw, filteredPitchInf, FILTER_ALPHA);
            console.log('[Inf] Raw: ' + pitchRaw.toFixed(1) + '° | Filtered: ' + filteredPitchInf.toFixed(1) + '°');
        }
        
        updateSensorDirectly(sensorName, convertedData);
        updateKneeAngleDisplay();
    });

    socket.on('sensor_disconnected', function(data) {
        console.log('Sensore disconnesso: ' + data.sensor_name);
        
        var sensorCard = document.querySelector('[data-sensor="' + data.sensor_name + '"]');
        if (sensorCard) {
            sensorCard.classList.add('disconnected');
        }
    });

    socket.on('data_cleared', function() {
        console.log('Dati puliti');
        sensors = {};
        filteredPitchSup = 0;
        filteredPitchInf = 0;
        calibrationOffset = 0;
        isCalibrated = false;
        renderSensors();
        resetHeartbeat();
    });
}

// ⭐ CORRETTO: Calibrazione
function calibrateKnee() {
    if (filteredPitchSup === 0 && filteredPitchInf === 0) {
        alert('Impossibile calibrare: attendi i dati da entrambi i sensori');
        return;
    }
    
    // Salva l'offset corrente
    calibrationOffset = filteredPitchSup - filteredPitchInf;
    isCalibrated = true;
    
    console.log('✅ CALIBRAZIONE ESEGUITA');
    console.log('   Pitch Sup Filtrato: ' + filteredPitchSup.toFixed(1) + '°');
    console.log('   Pitch Inf Filtrato: ' + filteredPitchInf.toFixed(1) + '°');
    console.log('   Offset salvato: ' + calibrationOffset.toFixed(1) + '°');
    
    updateKneeAngleDisplay();
}

// Calcola angolo ginocchio
function getKneeAngle() {
    var currentAngle = filteredPitchSup - filteredPitchInf;
    var calibratedAngle = currentAngle - calibrationOffset;
    return Math.round(calibratedAngle);
}

// Aggiorna display
function updateKneeAngleDisplay() {
    var kneeAngleEl = document.getElementById('knee-angle-display');
    if (!kneeAngleEl) return;
    
    if (!sensors || Object.keys(sensors).length < 2) {
        kneeAngleEl.innerHTML = '<div style="color: #666; text-align: center; padding: 20px;">⏳ In attesa di entrambi i sensori...</div>';
        return;
    }
    
    var kneeAngle = getKneeAngle();
    var statusText = isCalibrated ? 'Calibrato ✓' : 'Non calibrato';
    var statusColor = isCalibrated ? '#97c93e' : '#ff9500';
    
    kneeAngleEl.innerHTML =
        '<div style="background: linear-gradient(135deg, #97c93e 0%, #6fa52d 100%); border-radius: 12px; padding: 20px; text-align: center; color: #000;">' +
            '<div style="font-size: 14px; font-weight: 600; opacity: 0.9;">ANGOLO GINOCCHIO</div>' +
            '<div style="font-size: 64px; font-weight: 700; margin: 12px 0;">' + kneeAngle + '°</div>' +
            '<div style="font-size: 12px; opacity: 0.8;">Offset: ' + Math.round(calibrationOffset) + '° | <span style="color: ' + statusColor + '; font-weight: 600;">' + statusText + '</span></div>' +
            '<button onclick="calibrateKnee()" style="margin-top: 12px; padding: 10px 20px; background: rgba(0,0,0,0.3); border: none; border-radius: 6px; color: inherit; font-weight: 600; cursor: pointer; font-size: 13px; width: 100%;">📍 Calibra Ora (ginocchio dritto)</button>' +
        '</div>';
}

function updateSensorDirectly(sensorName, data) {
    var sensorCard = document.querySelector('[data-sensor="' + sensorName + '"]');
    
    if (!sensorCard) {
        createSensorCardFast(sensorName, data);
        return;
    }
    
    var valueElements = sensorCard.querySelectorAll('.sensor-value');
    var unitsElements = sensorCard.querySelectorAll('.sensor-unit');
    
    var fields = ['accel_x', 'accel_y', 'accel_z', 'gyro_x', 'gyro_y', 'gyro_z', 'mag_x', 'mag_y', 'mag_z'];
    var units = ['g', 'g', 'g', '°/s', '°/s', '°/s', 'µT', 'µT', 'µT'];
    
    for (var i = 0; i < Math.min(valueElements.length, fields.length); i++) {
        var value = data[fields[i]];
        if (value !== undefined) {
            valueElements[i].textContent = value.toFixed(3);
            if (unitsElements[i]) {
                unitsElements[i].textContent = units[i];
            }
        }
    }
    
    var timestampEl = sensorCard.querySelector('.sensor-timestamp');
    if (timestampEl && data.timestamp) {
        var date = new Date(data.timestamp);
        var hours = String(date.getHours()).padStart(2, '0');
        var minutes = String(date.getMinutes()).padStart(2, '0');
        var seconds = String(date.getSeconds()).padStart(2, '0');
        timestampEl.textContent = hours + ':' + minutes + ':' + seconds;
    }
    
    var statusIndicator = sensorCard.querySelector('.status-indicator');
    if (statusIndicator) {
        statusIndicator.classList.add('active');
        if (statusIndicator.timeoutId) {
            clearTimeout(statusIndicator.timeoutId);
        }
        statusIndicator.timeoutId = setTimeout(function() {
            statusIndicator.classList.remove('active');
        }, 50);
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
        '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">' +
            '<div class="sensor-header">' + emoji + ' ' + sensorName + '</div>' +
            '<div class="status-indicator active"></div>' +
        '</div>' +
        '<div class="sensor-data-row"><b>Accel X:</b> <span class="sensor-value">' + accelX + '</span> <span class="sensor-unit">g</span></div>' +
        '<div class="sensor-data-row"><b>Accel Y:</b> <span class="sensor-value">' + accelY + '</span> <span class="sensor-unit">g</span></div>' +
        '<div class="sensor-data-row"><b>Accel Z:</b> <span class="sensor-value">' + accelZ + '</span> <span class="sensor-unit">g</span></div>' +
        '<div class="sensor-data-row"><b>Gyro X:</b> <span class="sensor-value">' + gyroX + '</span> <span class="sensor-unit">°/s</span></div>' +
        '<div class="sensor-data-row"><b>Gyro Y:</b> <span class="sensor-value">' + gyroY + '</span> <span class="sensor-unit">°/s</span></div>' +
        '<div class="sensor-data-row"><b>Gyro Z:</b> <span class="sensor-value">' + gyroZ + '</span> <span class="sensor-unit">°/s</span></div>' +
        '<div class="sensor-data-row"><b>Mag X:</b> <span class="sensor-value">' + magX + '</span> <span class="sensor-unit">µT</span></div>' +
        '<div class="sensor-data-row"><b>Mag Y:</b> <span class="sensor-value">' + magY + '</span> <span class="sensor-unit">µT</span></div>' +
        '<div class="sensor-data-row"><b>Mag Z:</b> <span class="sensor-value">' + magZ + '</span> <span class="sensor-unit">µT</span></div>' +
        '<div style="margin-top:12px; font-size:11px; color:#666; text-align:center;">' +
            '<span class="sensor-timestamp">--:--:--</span>' +
        '</div>';
    
    var emptySlot = grid.querySelector('.sensor-col:not([data-sensor])');
    if (emptySlot) {
        emptySlot.replaceWith(template);
    } else {
        grid.appendChild(template);
    }
    
    var emptyState = document.getElementById('empty-state');
    if (Object.keys(sensors).length > 0) {
        if (emptyState) {
            emptyState.classList.remove('visible');
        }
        grid.style.display = 'grid';
    }
}

function fetchInitialData() {
    fetch('/api/sensors')
        .then(function(response) { return response.json(); })
        .then(function(data) {
            sensors = data.sensors || {};
            renderSensors();
        })
        .catch(function(error) {
            console.error('Errore caricamento:', error);
        });
}

function updateConnectionStatus(connected) {
    var statusEl = document.getElementById('connection-status');
    var countEl = document.getElementById('sensor-count');
    var fpsEl = document.getElementById('fps-counter');
    
    if (statusEl) {
        if (connected) {
            statusEl.classList.remove('disconnected');
            statusEl.innerHTML = '<span class="dot"></span> Connesso';
        } else {
            statusEl.classList.add('disconnected');
            statusEl.innerHTML = '<span class="dot"></span> Disconnesso';
        }
    }
    
    if (countEl) {
        var count = Object.keys(sensors).length;
        var label = (count !== 1) ? 'Sensori' : 'Sensore';
        countEl.textContent = count + ' ' + label;
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
        
        var accelX = (data.accel_x !== undefined) ? data.accel_x.toFixed(3) : '---';
        var accelY = (data.accel_y !== undefined) ? data.accel_y.toFixed(3) : '---';
        var accelZ = (data.accel_z !== undefined) ? data.accel_z.toFixed(3) : '---';
        var gyroX = (data.gyro_x !== undefined) ? data.gyro_x.toFixed(3) : '---';
        var gyroY = (data.gyro_y !== undefined) ? data.gyro_y.toFixed(3) : '---';
        var gyroZ = (data.gyro_z !== undefined) ? data.gyro_z.toFixed(3) : '---';
        var magX = (data.mag_x !== undefined) ? data.mag_x.toFixed(3) : '---';
        var magY = (data.mag_y !== undefined) ? data.mag_y.toFixed(3) : '---';
        var magZ = (data.mag_z !== undefined) ? data.mag_z.toFixed(3) : '---';
        
        card.innerHTML =
            '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">' +
                '<div class="sensor-header">' + emoji + ' ' + name + '</div>' +
                '<div class="status-indicator"></div>' +
            '</div>' +
            '<div class="sensor-data-row"><b>Accel X:</b> <span class="sensor-value">' + accelX + '</span> <span class="sensor-unit">g</span></div>' +
            '<div class="sensor-data-row"><b>Accel Y:</b> <span class="sensor-value">' + accelY + '</span> <span class="sensor-unit">g</span></div>' +
            '<div class="sensor-data-row"><b>Accel Z:</b> <span class="sensor-value">' + accelZ + '</span> <span class="sensor-unit">g</span></div>' +
            '<div class="sensor-data-row"><b>Gyro X:</b> <span class="sensor-value">' + gyroX + '</span> <span class="sensor-unit">°/s</span></div>' +
            '<div class="sensor-data-row"><b>Gyro Y:</b> <span class="sensor-value">' + gyroY + '</span> <span class="sensor-unit">°/s</span></div>' +
            '<div class="sensor-data-row"><b>Gyro Z:</b> <span class="sensor-value">' + gyroZ + '</span> <span class="sensor-unit">°/s</span></div>' +
            '<div class="sensor-data-row"><b>Mag X:</b> <span class="sensor-value">' + magX + '</span> <span class="sensor-unit">µT</span></div>' +
            '<div class="sensor-data-row"><b>Mag Y:</b> <span class="sensor-value">' + magY + '</span> <span class="sensor-unit">µT</span></div>' +
            '<div class="sensor-data-row"><b>Mag Z:</b> <span class="sensor-value">' + magZ + '</span> <span class="sensor-unit">µT</span></div>' +
            '<div style="margin-top:12px; font-size:11px; color:#666; text-align:center;">' +
                '<span class="sensor-timestamp">--:--:--</span>' +
            '</div>';
        grid.appendChild(card);
    });
    
    for (var i = sensorsToShow.length; i < 6; i++) {
        var slot = document.createElement('div');
        slot.className = 'sensor-col';
        slot.innerHTML =
            '<div class="sensor-header">Slot ' + (i + 1) + '</div>' +
            '<p style="text-align:center; color:#666; margin-top:20px;">In attesa...</p>';
        grid.appendChild(slot);
    }
    
    updateConnectionStatus(isConnected);
    updateKneeAngleDisplay();
}

function getSensorEmoji(name) {
    var n = name.toLowerCase();
    if (n.indexOf('ginocchio') !== -1 || n.indexOf('knee') !== -1 || n.indexOf('gamba') !== -1) return '🦿';
    if (n.indexOf('piede') !== -1 || n.indexOf('foot') !== -1 || n.indexOf('calzino') !== -1 || n.indexOf('calzini') !== -1 || n.indexOf('socks') !== -1) return '🧦';
    if (n.indexOf('braccio') !== -1 || n.indexOf('arm') !== -1) return '🦾';
    return '📱';
}

function clearAllData() {
    if (!confirm('Vuoi davvero pulire tutti i dati?')) return;
    
    fetch('/api/clear', { method: 'POST' })
        .then(function() {
            sensors = {};
            filteredPitchSup = 0;
            filteredPitchInf = 0;
            calibrationOffset = 0;
            isCalibrated = false;
            renderSensors();
            console.log('Dati puliti');
        })
        .catch(function(error) {
            console.error('Errore:', error);
        });
}
