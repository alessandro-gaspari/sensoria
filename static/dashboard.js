// Connessione Socket.IO ULTRA-VELOCE
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

// Parametri per inclinazione
var ALPHA = 0.98;
var DELTA_T = 0.01;

// Stato applicazione
var sensors = {};
var isConnected = false;
var frameCount = 0;
var lastFrameTime = Date.now();
var currentFps = 0;
var lastDataTime = Date.now();
var heartbeatTimer;

// State per inclinazione
var sensorStates = {};
var calibrationOffsets = {
    sup: 0,    // Offset per sensore superiore
    inf: 0,    // Offset per sensore inferiore
    knee: 0    // Offset totale ginocchio
};

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

// ⭐ Calcola pitch dall'accelerometro
function calculatePitchFromAccel(ax, ay, az) {
    var sqrtYZ = Math.sqrt(ay * ay + az * az);
    var pitchRad = Math.atan2(ax, sqrtYZ);
    var pitchDeg = pitchRad * (180 / Math.PI);
    return pitchDeg;
}

// ⭐ CORRETTO: Complementary filter per inclinazione
function updatePitchWithComplementaryFilter(sensorId, ax, ay, az, gyroX) {
    // Inizializza state se non esiste
    if (!sensorStates[sensorId]) {
        sensorStates[sensorId] = {
            pitch: calculatePitchFromAccel(ax, ay, az),
            lastTime: Date.now()
        };
        console.log('[' + sensorId + '] Initialized pitch: ' + sensorStates[sensorId].pitch.toFixed(1));
        return sensorStates[sensorId].pitch;
    }
    
    var state = sensorStates[sensorId];
    
    var pitchAcc = calculatePitchFromAccel(ax, ay, az);
    
    var now = Date.now();
    var deltaT = (now - state.lastTime) / 1000;
    state.lastTime = now;
    
    // Complementary filter
    var pitchFiltered = ALPHA * (state.pitch + gyroX * deltaT) + (1 - ALPHA) * pitchAcc;
    
    state.pitch = pitchFiltered;
    
    return pitchFiltered;
}

// ⭐ CORRETTO: Calcola angolo ginocchio da due sensori
function calculateKneeAngle(supData, infData) {
    if (!supData || !infData) return null;
    
    // Calcola pitch per sensore superiore
    var pitchSup = updatePitchWithComplementaryFilter(
        'sup',
        supData.accel_x, supData.accel_y, supData.accel_z,
        supData.gyro_x
    );
    
    // Calcola pitch per sensore inferiore
    var pitchInf = updatePitchWithComplementaryFilter(
        'inf',
        infData.accel_x, infData.accel_y, infData.accel_z,
        infData.gyro_x
    );
    
    // Angolo ginocchio = differenza
    var kneeAngle = pitchSup - pitchInf;
    
    return kneeAngle;
}

// ⭐ CORRETTO: Calibrazione - salva gli offset attuali
function calibrateKnee() {
    var supData = null;
    var infData = null;
    
    for (var name in sensors) {
        var n = name.toLowerCase();
        if (n.indexOf('sup') !== -1 || n.indexOf('sopra') !== -1 || n.indexOf('upper') !== -1 || n.indexOf('top') !== -1) {
            supData = sensors[name];
        }
        if (n.indexOf('inf') !== -1 || n.indexOf('sotto') !== -1 || n.indexOf('lower') !== -1 || n.indexOf('bottom') !== -1) {
            infData = sensors[name];
        }
    }
    
    if (!supData || !infData) {
        alert('Impossibile calibrare: attendi i dati da entrambi i sensori');
        return;
    }
    
    // Calcola pitch corrente per entrambi
    var pitchSup = calculatePitchFromAccel(supData.accel_x, supData.accel_y, supData.accel_z);
    var pitchInf = calculatePitchFromAccel(infData.accel_x, infData.accel_y, infData.accel_z);
    var currentAngle = pitchSup - pitchInf;
    
    // Salva come offset
    calibrationOffsets.knee = currentAngle;
    
    console.log('✅ Calibrazione ginocchio: offset = ' + calibrationOffsets.knee.toFixed(1) + '°');
    
    // Aggiorna display immediato
    updateKneeAngleDisplay();
}

// ⭐ CORRETTO: Ottieni angolo ginocchio calibrato
function getCalibratedKneeAngle(supData, infData) {
    var angle = calculateKneeAngle(supData, infData);
    if (angle === null) return null;
    
    // Sottrai offset e arrotonda a intero
    var calibratedAngle = angle - calibrationOffsets.knee;
    return Math.round(calibratedAngle);  // ⭐ ARROTONDA A INTERO
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
        updateSensorDirectly(sensorName, convertedData);
        
        // Aggiorna angolo ginocchio
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
        sensorStates = {};
        calibrationOffsets = { sup: 0, inf: 0, knee: 0 };  // ⭐ Resetta offset
        renderSensors();
        resetHeartbeat();
    });
}

// ⭐ CORRETTO: Aggiorna display angolo ginocchio
function updateKneeAngleDisplay() {
    var supData = null;
    var infData = null;
    
    for (var name in sensors) {
        var n = name.toLowerCase();
        if (n.indexOf('sup') !== -1 || n.indexOf('sopra') !== -1 || n.indexOf('upper') !== -1 || n.indexOf('top') !== -1) {
            supData = sensors[name];
        }
        if (n.indexOf('inf') !== -1 || n.indexOf('sotto') !== -1 || n.indexOf('lower') !== -1 || n.indexOf('bottom') !== -1) {
            infData = sensors[name];
        }
    }
    
    var kneeAngleEl = document.getElementById('knee-angle-display');
    if (!kneeAngleEl) return;
    
    if (!supData || !infData) {
        kneeAngleEl.innerHTML = '<div style="color: #666; text-align: center; padding: 20px;">⏳ In attesa di entrambi i sensori...</div>';
        return;
    }
    
    var kneeAngle = getCalibratedKneeAngle(supData, infData);
    
    // ⭐ ARROTONDATO A INTERO, DISPLAY PIU' GRANDE
    kneeAngleEl.innerHTML =
        '<div style="background: linear-gradient(135deg, #97c93e 0%, #6fa52d 100%); border-radius: 12px; padding: 20px; text-align: center; color: #000;">' +
            '<div style="font-size: 14px; font-weight: 600; opacity: 0.9;">ANGOLO GINOCCHIO</div>' +
            '<div style="font-size: 64px; font-weight: 700; margin: 12px 0;">' + kneeAngle + '°</div>' +
            '<div style="font-size: 12px; opacity: 0.8;">Inclinazione relativa</div>' +
            '<button onclick="calibrateKnee()" style="margin-top: 12px; padding: 10px 20px; background: rgba(0,0,0,0.3); border: none; border-radius: 6px; color: inherit; font-weight: 600; cursor: pointer; font-size: 13px;">📍 Calibra (ginocchio dritto)</button>' +
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
            sensorStates = {};
            calibrationOffsets = { sup: 0, inf: 0, knee: 0 };
            renderSensors();
            console.log('Dati puliti');
        })
        .catch(function(error) {
            console.error('Errore:', error);
        });
}
