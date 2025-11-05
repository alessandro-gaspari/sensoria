var socket = io({
    reconnection: true,
    reconnectionDelay: 100,
    reconnectionDelayMax: 1000,
    reconnectionAttempts: 5,
    transports: ['websocket'],
    upgrade: false,
});

var S_GYRO = 65.54;

// ⭐ CONFIG
var SMOOTH_WINDOW = 15;
var OUTLIER_THRESHOLD = 60;  // ⭐ AUMENTATO A 60°/s - accetta 456 come valore stabile
var CALIBRATION_SAMPLES = 100;

// ⭐ STATO GLOBALE
var sensors = {};
var isConnected = false;
var frameCount = 0;
var lastFrameTime = Date.now();
var currentFps = 0;
var lastUpdateTime = Date.now();

// ⭐ SMOOTHING BUFFERS - GX E GY
var smoothSupGX = [];
var smoothSupGY = [];
var smoothInfGX = [];
var smoothInfGY = [];

// ⭐ CALIBRAZIONE BIAS
var calibSamplesSup = [];
var calibSamplesInf = [];
var gyroBiasSup = 0;
var gyroBiasInf = 0;
var biasCalibrationDone = false;

// ⭐ ANGOLI ATTUALI
var angleSup = 0;
var angleInf = 0;

// ⭐ CALIBRAZIONE ANGOLO GINOCCHIO
var calibrationOffsetKnee = null;

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
    }, 1000);
}

function convertGyroscopeRaw(raw) {
    return raw / S_GYRO;
}

// ⭐ SMOOTHING CON OUTLIER - Più aggressivo
function smoothWithOutlierDetection(buffer, value) {
    if (buffer.length === 0) {
        buffer.push(value);
        return value;
    }
    
    var sum = 0;
    for (var i = 0; i < buffer.length; i++) {
        sum += buffer[i];
    }
    var avg = sum / buffer.length;
    
    var delta = Math.abs(value - avg);
    
    // Scarta outliers
    if (delta > OUTLIER_THRESHOLD) {
        console.log('⚠️ OUTLIER: ' + value.toFixed(1) + '°/s (media: ' + avg.toFixed(1) + ', delta: ' + delta.toFixed(1) + ')');
        return avg;
    }
    
    buffer.push(value);
    if (buffer.length > SMOOTH_WINDOW) {
        buffer.shift();
    }
    
    var newSum = 0;
    for (var i = 0; i < buffer.length; i++) {
        newSum += buffer[i];
    }
    return newSum / buffer.length;
}

// ⭐ CALIBRAZIONE BIAS
function calibrateGyroBias() {
    if (calibSamplesSup.length < CALIBRATION_SAMPLES || calibSamplesInf.length < CALIBRATION_SAMPLES) {
        var prog = Math.max(calibSamplesSup.length, calibSamplesInf.length);
        console.log('⏳ Calibrazione bias: ' + prog + '/' + CALIBRATION_SAMPLES);
        return false;
    }
    
    var sumSup = 0, sumInf = 0;
    for (var i = 0; i < CALIBRATION_SAMPLES; i++) {
        sumSup += calibSamplesSup[i];
        sumInf += calibSamplesInf[i];
    }
    
    gyroBiasSup = sumSup / CALIBRATION_SAMPLES;
    gyroBiasInf = sumInf / CALIBRATION_SAMPLES;
    
    console.log('✅ BIAS CALIBRATO: SUP=' + gyroBiasSup.toFixed(2) + '°/s | INF=' + gyroBiasInf.toFixed(2) + '°/s');
    
    biasCalibrationDone = true;
    calibSamplesSup = [];
    calibSamplesInf = [];
    
    updateKneeAngleDisplay();
    return true;
}

function initializeSocketListeners() {
    socket.on('connect', function() {
        console.log('✅ WebSocket Connesso');
        isConnected = true;
        updateConnectionStatus(true);
    });

    socket.on('disconnect', function() {
        console.log('❌ WebSocket Disconnesso');
        isConnected = false;
        updateConnectionStatus(false);
    });

    socket.on('sensor_update', function(data) {
        frameCount++;
        
        var sensorName = data.sensor_name;
        var sensorData = data.data;
        var now = Date.now();
        var deltaTime = (now - lastUpdateTime) / 1000;
        lastUpdateTime = now;
        
        if (deltaTime > 0.5) deltaTime = 0.01;

        var gx = convertGyroscopeRaw(sensorData.gyro_x);
        var gy = convertGyroscopeRaw(sensorData.gyro_y);
        var n = sensorName.toLowerCase();

        // ⭐ FASE 1: Calibrazione bias (da GX e GY)
        if (!biasCalibrationDone) {
            if (n.indexOf('sup') !== -1 || n.indexOf('sopra') !== -1) {
                // Media di GX e GY per bias stabile
                var avgGyro = (Math.abs(gx) + Math.abs(gy)) / 2;
                calibSamplesSup.push(avgGyro);
            }
            if (n.indexOf('inf') !== -1 || n.indexOf('sotto') !== -1) {
                var avgGyro = (Math.abs(gx) + Math.abs(gy)) / 2;
                calibSamplesInf.push(avgGyro);
            }
            
            if (calibSamplesSup.length >= CALIBRATION_SAMPLES && calibSamplesInf.length >= CALIBRATION_SAMPLES) {
                calibrateGyroBias();
            }
            return;
        }

        // ⭐ FASE 2: Processa dati (dopo bias calibrato)
        if (n.indexOf('sup') !== -1 || n.indexOf('sopra') !== -1) {
            var gx_smooth = smoothWithOutlierDetection(smoothSupGX, gx);
            var gy_smooth = smoothWithOutlierDetection(smoothSupGY, gy);
            
            // ⭐ USA GY quando è grande (456), altrimenti usa GX
            var dominant;
            if (Math.abs(gy_smooth) > Math.abs(gx_smooth)) {
                dominant = gy_smooth;
                console.log('[SUP] Usa GY');
            } else {
                dominant = gx_smooth;
                console.log('[SUP] Usa GX');
            }
            
            var dominant_corrected = dominant - gyroBiasSup;
            angleSup = angleSup + (dominant_corrected * deltaTime);
            
            console.log('[SUP] GX:' + gx.toFixed(1) + '°/s GY:' + gy.toFixed(1) + '°/s → Dominant:' + dominant.toFixed(1) + ' → Corrected:' + dominant_corrected.toFixed(1) + ' → Angle:' + angleSup.toFixed(1) + '°');
        }

        if (n.indexOf('inf') !== -1 || n.indexOf('sotto') !== -1) {
            var gx_smooth = smoothWithOutlierDetection(smoothInfGX, gx);
            var gy_smooth = smoothWithOutlierDetection(smoothInfGY, gy);
            
            var dominant;
            if (Math.abs(gy_smooth) > Math.abs(gx_smooth)) {
                dominant = gy_smooth;
                console.log('[INF] Usa GY');
            } else {
                dominant = gx_smooth;
                console.log('[INF] Usa GX');
            }
            
            var dominant_corrected = dominant - gyroBiasInf;
            angleInf = angleInf + (dominant_corrected * deltaTime);
            
            console.log('[INF] GX:' + gx.toFixed(1) + '°/s GY:' + gy.toFixed(1) + '°/s → Dominant:' + dominant.toFixed(1) + ' → Corrected:' + dominant_corrected.toFixed(1) + ' → Angle:' + angleInf.toFixed(1) + '°');
        }

        updateKneeAngleDisplay();
        updateSensorDirectly(sensorName, sensorData);
    });

    socket.on('data_cleared', function() {
        sensors = {};
        angleSup = 0;
        angleInf = 0;
        calibrationOffsetKnee = null;
        biasCalibrationDone = false;
        calibSamplesSup = [];
        calibSamplesInf = [];
        smoothSupGX = [];
        smoothSupGY = [];
        smoothInfGX = [];
        smoothInfGY = [];
        renderSensors();
        updateKneeAngleDisplay();
        console.log('🔄 Reset completo');
    });
}

function calibrateKneeAngle() {
    if (!biasCalibrationDone) {
        alert('❌ Aspetta la calibrazione del bias!\n\nTieni fermo per 2 secondi.');
        return;
    }
    
    calibrationOffsetKnee = {
        sup: angleSup,
        inf: angleInf
    };
    
    console.log('📍 CALIBRAZIONE ANGOLO GINOCCHIO');
    console.log('   SUP: ' + angleSup.toFixed(2) + '°');
    console.log('   INF: ' + angleInf.toFixed(2) + '°');
    
    updateKneeAngleDisplay();
    alert('✅ Angolo calibrato!\nOra i gradi partiranno da 0°');
}

function getKneeAngle() {
    if (calibrationOffsetKnee === null) {
        return 0;
    }
    
    var sup_relative = angleSup - calibrationOffsetKnee.sup;
    var inf_relative = angleInf - calibrationOffsetKnee.inf;
    var kneeAngle = sup_relative - inf_relative;
    
    return Math.round(kneeAngle);
}

function updateKneeAngleDisplay() {
    var el = document.getElementById('knee-angle-display');
    if (!el) return;
    
    var statusBias = biasCalibrationDone ? '✓' : '⏳';
    var statusCal = calibrationOffsetKnee !== null ? '✓' : '✗';
    var kneeAngle = getKneeAngle();
    
    el.innerHTML =
        '<div style="background: linear-gradient(135deg, #97c93e 0%, #6fa52d 100%); border-radius: 12px; padding: 20px; text-align: center; color: #000; box-shadow: 0 4px 15px rgba(0,0,0,0.3);">' +
            '<div style="font-size: 11px; font-weight: 600; opacity: 0.9;">ANGOLO GINOCCHIO</div>' +
            '<div style="font-size: 12px; opacity: 0.8; margin-bottom: 8px;">Bias: ' + statusBias + ' | Calibrato: ' + statusCal + '</div>' +
            '<div style="font-size: 72px; font-weight: 700; margin: 8px 0; font-family: monospace;">' + kneeAngle + '°</div>' +
            '<button onclick="calibrateKneeAngle()" style="margin-top: 12px; padding: 8px 16px; background: rgba(0,0,0,0.25); border: 1px solid rgba(0,0,0,0.5); border-radius: 6px; color: inherit; font-weight: 600; cursor: pointer; font-size: 12px; width: 100%;">📍 Calibra Angolo</button>' +
        '</div>';
}

function updateSensorDirectly(sensorName, data) {
    var card = document.querySelector('[data-sensor="' + sensorName + '"]');
    if (!card) return;
    
    var els = card.querySelectorAll('.sensor-value');
    if (els.length >= 3) {
        els[0].textContent = (data.gyro_x / S_GYRO).toFixed(1);
        els[1].textContent = (data.gyro_y / S_GYRO).toFixed(1);
        els[2].textContent = (data.gyro_z / S_GYRO).toFixed(1);
    }
}

function fetchInitialData() {
    fetch('/api/sensors')
        .then(function(r) { return r.json(); })
        .then(function(d) {
            sensors = d.sensors || {};
            renderSensors();
        });
}

function updateConnectionStatus(connected) {
    var statusEl = document.getElementById('connection-status');
    if (statusEl) {
        statusEl.innerHTML = connected ? '<span style="color: #97c93e;">✅ Connesso</span>' : '<span style="color: #FF6B6B;">❌ Disconnesso</span>';
    }
}

function renderSensors() {
    var grid = document.getElementById('sensors-grid');
    if (!grid) return;
    
    var names = Object.keys(sensors);
    if (names.length === 0) {
        grid.innerHTML = '<div style="color: #666; text-align: center; padding: 20px;">⏳ In attesa sensori...</div>';
        return;
    }
    
    grid.innerHTML = '';
    names.slice(0, 6).forEach(function(name) {
        var card = document.createElement('div');
        card.className = 'sensor-col';
        card.setAttribute('data-sensor', name);
        card.innerHTML =
            '<div style="font-weight: 600; margin-bottom: 10px;">' + name + '</div>' +
            '<div style="font-size: 12px; color: #888;">GX: <span class="sensor-value">0.0</span>°/s</div>' +
            '<div style="font-size: 12px; color: #888;">GY: <span class="sensor-value">0.0</span>°/s</div>' +
            '<div style="font-size: 12px; color: #888;">GZ: <span class="sensor-value">0.0</span>°/s</div>';
        grid.appendChild(card);
    });
}

function clearAllData() {
    if (!confirm('Ripulisci?')) return;
    fetch('/api/clear', { method: 'POST' })
        .then(function() {
            sensors = {};
            angleSup = 0;
            angleInf = 0;
            calibrationOffsetKnee = null;
            biasCalibrationDone = false;
            calibSamplesSup = [];
            calibSamplesInf = [];
            smoothSupGX = [];
            smoothSupGY = [];
            smoothInfGX = [];
            smoothInfGY = [];
            renderSensors();
            updateKneeAngleDisplay();
        });
}
