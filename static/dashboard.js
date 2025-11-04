// ==============================
// ⚙️ DASHBOARD SENSORIA v2.0
// ==============================
// - Filtro complementare (gyro + accel)
// - Calcolo angolo ginocchio (°)
// - Velocità angolare (°/s)
// - Campionamento ottimizzato 100Hz
// - UI invariata e compatibile
// ==============================

// --- Connessione Socket.IO ULTRA-VELOCE ---
var socket = io({
    reconnection: true,
    reconnectionDelay: 100,
    reconnectionDelayMax: 1000,
    reconnectionAttempts: 5,
    transports: ['websocket'],
    upgrade: false,
});

// --- Costanti e fattori di scala ---
var S_ACC = 4096;     // accelerometro → g
var S_GYRO = 65.54;   // giroscopio → °/s
var S_MAG = 0.3;      // magnetometro → µT
var ALPHA = 0.98;     // filtro complementare
var TARGET_DT = 0.01; // ≈ 100Hz

// --- Stato globale ---
var sensors = {};
var isConnected = false;
var frameCount = 0;
var lastFrameTime = Date.now();
var currentFps = 0;
var lastDataTime = Date.now();
var heartbeatTimer;

// --- Stato per inclinazione ---
var pitchSup = 0;
var pitchInf = 0;
var calibrationOffset = 0;

// --- Filtro complementare e temporizzazione ---
var lastTimestampSup = Date.now();
var lastTimestampInf = Date.now();
var lastKneeAngle = 0;
var angularVelocity = 0;

// ==============================
// 🔧 FUNZIONI DI CONVERSIONE
// ==============================

function convertAccelerometerRaw(raw) {
    return raw / S_ACC;
}

function convertGyroscopeRaw(raw) {
    return raw / S_GYRO;
}

function convertMagnetometerRaw(raw) {
    return raw * S_MAG;
}

// ==============================
// 📐 CALCOLO INCLINAZIONE
// ==============================

// Calcolo del pitch solo da accelerometro (°)
function calculatePitchFromAccel(ax, ay, az) {
    var pitchRad = Math.atan2(ax, Math.sqrt(ay * ay + az * az));
    return pitchRad * (180 / Math.PI);
}

// Filtro complementare (gyro + accel)
function updatePitchComplementary(prevPitch, gyroRate, accPitch, dt) {
    var gyroDelta = gyroRate * dt; // °/s * s = °
    return ALPHA * (prevPitch + gyroDelta) + (1 - ALPHA) * accPitch;
}

// ==============================
// ⚡️ INIZIALIZZAZIONE BASE
// ==============================

document.addEventListener('DOMContentLoaded', function() {
    initializeSocketListeners();
    fetchInitialData();
    startFpsCounter();
});

function resetHeartbeat() {
    lastDataTime = Date.now();
    clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(function() {
        console.warn('⚠️ Heartbeat fallito');
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

// ==============================
// 📡 SOCKET.IO — RICEZIONE DATI
// ==============================

function initializeSocketListeners() {
    socket.on('connect', function() {
        console.log('✅ Connesso al server');
        isConnected = true;
        updateConnectionStatus(true);
        resetHeartbeat();
    });

    socket.on('disconnect', function() {
        console.log('❌ Disconnesso dal server');
        isConnected = false;
        updateConnectionStatus(false);
        clearTimeout(heartbeatTimer);
    });

    socket.on('connection_response', function(data) {
        console.log('🔗 Risposta connessione:', data);
        if (data.sensors) {
            sensors = data.sensors;
            renderSensors();
        }
        resetHeartbeat();
    });

    // ==========================
    // 📈 RICEZIONE DATI SENSORI
    // ==========================
    socket.on('sensor_update', function(data) {
        frameCount++;
        resetHeartbeat();

        var sensorName = data.sensor_name;
        var sensorData = data.data;

        // Conversione unità
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

        // Calcola dt dinamico (tempo trascorso tra frame)
        var now = Date.now();
        var dt = (now - lastDataTime) / 1000;
        if (dt <= 0 || dt > 0.1) dt = TARGET_DT; // stabilizza
        lastDataTime = now;

        // Calcolo pitch da accelerometro
        var accPitch = calculatePitchFromAccel(
            convertedData.accel_x,
            convertedData.accel_y,
            convertedData.accel_z
        );

        var n = sensorName.toLowerCase();

        // ==========================
        // 🎯 FILTRO COMPLEMENTARE
        // ==========================
        if (n.includes('sup') || n.includes('sopra') || n.includes('upper') || n.includes('top')) {
            pitchSup = updatePitchComplementary(pitchSup, convertedData.gyro_y, accPitch, dt);
            lastTimestampSup = now;
        }

        if (n.includes('inf') || n.includes('sotto') || n.includes('lower') || n.includes('bottom')) {
            pitchInf = updatePitchComplementary(pitchInf, convertedData.gyro_y, accPitch, dt);
            lastTimestampInf = now;
        }

        // ==========================
        // 📐 CALCOLO ANGOLO GINOCCHIO
        // ==========================
        var kneeAngle = pitchSup - pitchInf;
        var calibratedAngle = kneeAngle - calibrationOffset;

        // ==========================
        // ⚡️ VELOCITÀ ANGOLARE (°/s)
        // ==========================
        angularVelocity = (kneeAngle - lastKneeAngle) / dt;
        lastKneeAngle = kneeAngle;

        // Aggiorna UI
        updateSensorDirectly(sensorName, convertedData);
        updateKneeAngleDisplay(calibratedAngle, angularVelocity);
    });

    socket.on('sensor_disconnected', function(data) {
        console.log('🔴 Sensore disconnesso: ' + data.sensor_name);
        var sensorCard = document.querySelector('[data-sensor="' + data.sensor_name + '"]');
        if (sensorCard) {
            sensorCard.classList.add('disconnected');
        }
    });

    socket.on('data_cleared', function() {
        console.log('🧹 Dati puliti');
        sensors = {};
        pitchSup = 0;
        pitchInf = 0;
        calibrationOffset = 0;
        renderSensors();
        resetHeartbeat();
    });
}

// ==============================
// 🎯 CALIBRAZIONE GINOCCHIO
// ==============================
function calibrateKnee() {
    if (pitchSup === 0 && pitchInf === 0) {
        alert('⚠️ Impossibile calibrare: attendi i dati da entrambi i sensori');
        return;
    }

    calibrationOffset = pitchSup - pitchInf;

    console.log('✅ Calibrazione completata: offset = ' + calibrationOffset.toFixed(1) + '°');
    console.log('   pitchSup = ' + pitchSup.toFixed(1) + '°');
    console.log('   pitchInf = ' + pitchInf.toFixed(1) + '°');

    updateKneeAngleDisplay(pitchSup - pitchInf - calibrationOffset, angularVelocity);
}

// ==============================
// 📐 CALCOLO ANGOLO GINOCCHIO
// ==============================
function getKneeAngle() {
    var currentAngle = pitchSup - pitchInf;
    var calibratedAngle = currentAngle - calibrationOffset;
    return Math.round(calibratedAngle);
}

// ==============================
// 🖥️ DISPLAY ANGOLO + VELOCITÀ
// ==============================
function updateKneeAngleDisplay(angle, velocity) {
    var kneeAngleEl = document.getElementById('knee-angle-display');
    if (!kneeAngleEl) return;

    if (!sensors || Object.keys(sensors).length < 2) {
        kneeAngleEl.innerHTML = `
            <div style="color: #666; text-align: center; padding: 20px;">
                ⏳ In attesa di entrambi i sensori...
            </div>`;
        return;
    }

    if (angle === undefined) angle = getKneeAngle();
    if (velocity === undefined) velocity = angularVelocity;

    kneeAngleEl.innerHTML = `
        <div style="
            background: linear-gradient(135deg, #97c93e 0%, #6fa52d 100%);
            border-radius: 12px;
            padding: 20px;
            text-align: center;
            color: #000;">
            
            <div style="font-size: 14px; font-weight: 600; opacity: 0.9;">
                ANGOLO GINOCCHIO
            </div>
            
            <div style="font-size: 64px; font-weight: 700; margin: 12px 0;">
                ${angle.toFixed(1)}°
            </div>

            <div style="font-size: 18px; font-weight: 600; color: #222;">
                Velocità: ${velocity.toFixed(1)} °/s
            </div>

            <div style="font-size: 12px; opacity: 0.8; margin-top: 6px;">
                Offset: ${Math.round(calibrationOffset)}°
            </div>

            <button onclick="calibrateKnee()" 
                style="
                    margin-top: 12px;
                    padding: 10px 20px;
                    background: rgba(0,0,0,0.3);
                    border: none;
                    border-radius: 6px;
                    color: inherit;
                    font-weight: 600;
                    cursor: pointer;
                    font-size: 13px;">
                📍 Calibra (dritto)
            </button>
        </div>
    `;
}

// ==============================
// 🔁 AGGIORNAMENTO CARD SENSORI
// ==============================
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
        if (statusIndicator.timeoutId) clearTimeout(statusIndicator.timeoutId);
        statusIndicator.timeoutId = setTimeout(() => {
            statusIndicator.classList.remove('active');
        }, 50);
    }
}

// ==============================
// ⚙️ CREAZIONE CARD SENSORI
// ==============================
function createSensorCardFast(sensorName, data) {
    var grid = document.getElementById('sensors-grid');
    var currentSensors = grid.querySelectorAll('[data-sensor]').length;
    if (currentSensors >= 6) return;
    
    var emoji = getSensorEmoji(sensorName);
    var template = document.createElement('div');
    template.className = 'sensor-col connected';
    template.setAttribute('data-sensor', sensorName);
    
    function safe(val) { return (val !== undefined) ? val.toFixed(3) : '---'; }
    
    template.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <div class="sensor-header">${emoji} ${sensorName}</div>
            <div class="status-indicator active"></div>
        </div>
        <div class="sensor-data-row"><b>Accel X:</b> <span class="sensor-value">${safe(data.accel_x)}</span> <span class="sensor-unit">g</span></div>
        <div class="sensor-data-row"><b>Accel Y:</b> <span class="sensor-value">${safe(data.accel_y)}</span> <span class="sensor-unit">g</span></div>
        <div class="sensor-data-row"><b>Accel Z:</b> <span class="sensor-value">${safe(data.accel_z)}</span> <span class="sensor-unit">g</span></div>
        <div class="sensor-data-row"><b>Gyro X:</b> <span class="sensor-value">${safe(data.gyro_x)}</span> <span class="sensor-unit">°/s</span></div>
        <div class="sensor-data-row"><b>Gyro Y:</b> <span class="sensor-value">${safe(data.gyro_y)}</span> <span class="sensor-unit">°/s</span></div>
        <div class="sensor-data-row"><b>Gyro Z:</b> <span class="sensor-value">${safe(data.gyro_z)}</span> <span class="sensor-unit">°/s</span></div>
        <div class="sensor-data-row"><b>Mag X:</b> <span class="sensor-value">${safe(data.mag_x)}</span> <span class="sensor-unit">µT</span></div>
        <div class="sensor-data-row"><b>Mag Y:</b> <span class="sensor-value">${safe(data.mag_y)}</span> <span class="sensor-unit">µT</span></div>
        <div class="sensor-data-row"><b>Mag Z:</b> <span class="sensor-value">${safe(data.mag_z)}</span> <span class="sensor-unit">µT</span></div>
        <div style="margin-top:12px; font-size:11px; color:#666; text-align:center;">
            <span class="sensor-timestamp">--:--:--</span>
        </div>`;
    
    var emptySlot = grid.querySelector('.sensor-col:not([data-sensor])');
    if (emptySlot) emptySlot.replaceWith(template);
    else grid.appendChild(template);
    
    var emptyState = document.getElementById('empty-state');
    if (Object.keys(sensors).length > 0) {
        if (emptyState) emptyState.classList.remove('visible');
        grid.style.display = 'grid';
    }
}

// ==============================
// 🌐 STATUS CONNESSIONE E FPS
// ==============================
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

// ==============================
// 🧩 RENDER SENSORI
// ==============================
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
        createSensorCardFast(name, data);
    });
    
    for (var i = sensorsToShow.length; i < 6; i++) {
        var slot = document.createElement('div');
        slot.className = 'sensor-col';
        slot.innerHTML = `
            <div class="sensor-header">Slot ${i + 1}</div>
            <p style="text-align:center; color:#666; margin-top:20px;">In attesa...</p>`;
        grid.appendChild(slot);
    }
    
    updateConnectionStatus(isConnected);
    updateKneeAngleDisplay();
}

// ==============================
// 🧭 EMOJI SENSORI E RESET DATI
// ==============================
function getSensorEmoji(name) {
    var n = name.toLowerCase();
    if (n.includes('ginocchio') || n.includes('knee') || n.includes('gamba')) return '🦿';
    if (n.includes('piede') || n.includes('foot') || n.includes('calzino') || n.includes('socks')) return '🧦';
    if (n.includes('braccio') || n.includes('arm')) return '🦾';
    return '📱';
}

function clearAllData() {
    if (!confirm('Vuoi davvero pulire tutti i dati?')) return;
    
    fetch('/api/clear', { method: 'POST' })
        .then(() => {
            sensors = {};
            pitchSup = 0;
            pitchInf = 0;
            calibrationOffset = 0;
            renderSensors();
            console.log('🧹 Dati puliti');
        })
        .catch(error => {
            console.error('Errore:', error);
        });
}