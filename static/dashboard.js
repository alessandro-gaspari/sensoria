var socket = io({
    reconnection: true,
    reconnectionDelay: 100,
    reconnectionDelayMax: 1000,
    reconnectionAttempts: 5,
    transports: ['websocket'],
    upgrade: false,
});

var S_GYRO = 65.54;

var SMOOTH_WINDOW = 15;
var OUTLIER_THRESHOLD = 80;
var CALIBRATION_SAMPLES = 100;

var sensors = {};
var isConnected = false;
var frameCount = 0;
var lastFrameTime = Date.now();
var currentFps = 0;
var lastUpdateTime = Date.now();

var smoothSupGX = [];
var smoothSupGY = [];
var smoothInfGX = [];
var smoothInfGY = [];

var calibSamplesSup = [];
var calibSamplesInf = [];
var gyroBiasSup = 0;
var gyroBiasInf = 0;
var biasCalibrationDone = false;

var angleSup = 0;
var angleInf = 0;
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
    
    if (delta > OUTLIER_THRESHOLD) {
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

function calibrateGyroBias() {
    if (calibSamplesSup.length < CALIBRATION_SAMPLES || calibSamplesInf.length < CALIBRATION_SAMPLES) {
        var prog = Math.max(calibSamplesSup.length, calibSamplesInf.length);
        console.log('⏳ Bias: ' + prog + '/' + CALIBRATION_SAMPLES);
        return false;
    }
    
    var sumSup = 0, sumInf = 0;
    for (var i = 0; i < CALIBRATION_SAMPLES; i++) {
        sumSup += calibSamplesSup[i];
        sumInf += calibSamplesInf[i];
    }
    
    gyroBiasSup = sumSup / CALIBRATION_SAMPLES;
    gyroBiasInf = sumInf / CALIBRATION_SAMPLES;
    
    console.log('✅ BIAS: SUP=' + gyroBiasSup.toFixed(2) + ' INF=' + gyroBiasInf.toFixed(2));
    
    biasCalibrationDone = true;
    calibSamplesSup = [];
    calibSamplesInf = [];
    
    updateKneeAngleDisplay();
    return true;
}

function initializeSocketListeners() {
    socket.on('connect', function() {
        console.log('✅ Connesso');
        isConnected = true;
        updateConnectionStatus(true);
    });

    socket.on('disconnect', function() {
        console.log('❌ Disconnesso');
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

        // ⭐ FASE 1: Calibrazione bias (primi 100 campioni)
        if (!biasCalibrationDone) {
            if (n.indexOf('sup') !== -1 || n.indexOf('sopra') !== -1) {
                calibSamplesSup.push(gx);
            }
            if (n.indexOf('inf') !== -1 || n.indexOf('sotto') !== -1) {
                calibSamplesInf.push(gx);
            }
            
            if (calibSamplesSup.length >= CALIBRATION_SAMPLES && calibSamplesInf.length >= CALIBRATION_SAMPLES) {
                calibrateGyroBias();
            }
            return;
        }

        // ⭐ FASE 2: Integrazione
        if (n.indexOf('sup') !== -1 || n.indexOf('sopra') !== -1) {
            var gx_smooth = smoothWithOutlierDetection(smoothSupGX, gx);
            var gy_smooth = smoothWithOutlierDetection(smoothSupGY, gy);
            
            var dominant = Math.abs(gy_smooth) > Math.abs(gx_smooth) ? gy_smooth : gx_smooth;
            
            var dominant_corrected = dominant;
            if (Math.abs(dominant) < 50) {
                dominant_corrected = dominant - gyroBiasSup;
            }
            
            angleSup = angleSup + (dominant_corrected * deltaTime);
        }

        if (n.indexOf('inf') !== -1 || n.indexOf('sotto') !== -1) {
            var gx_smooth = smoothWithOutlierDetection(smoothInfGX, gx);
            var gy_smooth = smoothWithOutlierDetection(smoothInfGY, gy);
            
            var dominant = Math.abs(gy_smooth) > Math.abs(gx_smooth) ? gy_smooth : gx_smooth;
            
            var dominant_corrected = dominant;
            if (Math.abs(dominant) < 50) {
                dominant_corrected = dominant - gyroBiasInf;
            }
            
            angleInf = angleInf + (dominant_corrected * deltaTime);
        }

        updateKneeAngleDisplay();
        updateSensorDirectly(sensorName, sensorData);
    });

    socket.on('data_cleared', function() {
        resetCalibration();
    });
}

// ⭐ UN SOLO PULSANTE: Resetta bias e calibrazione angolo
function calibrateButton() {
    // Se bias non fatto, non fa nulla
    if (!biasCalibrationDone) {
        alert('⏳ Aspetta la calibrazione automatica!\n\nTieni fermo per 2 secondi...');
        return;
    }
    
    // Resetta angoli e salva come nuovi offset
    calibrationOffsetKnee = {
        sup: angleSup,
        inf: angleInf
    };
    
    console.log('✅ CALIBRAZIONE ANGOLO');
    console.log('   SUP offset: ' + angleSup.toFixed(1) + '°');
    console.log('   INF offset: ' + angleInf.toFixed(1) + '°');
    
    updateKneeAngleDisplay();
    alert('✅ Calibrato! I gradi ripartono da 0°');
}

function resetCalibration() {
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
}

function getKneeAngle() {
    if (calibrationOffsetKnee === null) {
        // Se non calibrato, mostra differenza diretta
        return Math.round(angleSup - angleInf);
    }
    
    // Se calibrato, sottrai gli offset
    var sup_rel = angleSup - calibrationOffsetKnee.sup;
    var inf_rel = angleInf - calibrationOffsetKnee.inf;
    
    return Math.round(sup_rel - inf_rel);
}

function updateKneeAngleDisplay() {
    var el = document.getElementById('knee-angle-display');
    if (!el) return;
    
    var statusBias = biasCalibrationDone ? '✅' : '⏳';
    var statusCal = calibrationOffsetKnee !== null ? '✅' : '✗';
    var angle = getKneeAngle();
    
    el.innerHTML =
        '<div style="background: linear-gradient(135deg, #97c93e 0%, #6fa52d 100%); border-radius: 12px; padding: 20px; text-align: center; color: #000; box-shadow: 0 4px 15px rgba(0,0,0,0.3);">' +
            '<div style="font-size: 12px; opacity: 0.8; margin-bottom: 8px;">Bias: ' + statusBias + ' | Calibrato: ' + statusCal + '</div>' +
            '<div style="font-size: 72px; font-weight: 700; font-family: monospace; margin: 8px 0;">' + angle + '°</div>' +
            '<div style="font-size: 10px; opacity: 0.7; margin-bottom: 12px;">SUP: ' + angleSup.toFixed(1) + '° | INF: ' + angleInf.toFixed(1) + '°</div>' +
            '<button onclick="calibrateButton()" style="margin-top: 12px; padding: 10px 20px; background: rgba(0,0,0,0.25); border: 1px solid rgba(0,0,0,0.5); border-radius: 6px; color: inherit; font-weight: 600; cursor: pointer; font-size: 13px; width: 100%;">📍 CALIBRA ANGOLO</button>' +
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
    fetch('/api/sensors').then(r => r.json()).then(d => { sensors = d.sensors || {}; renderSensors(); });
}

function updateConnectionStatus(connected) {
    var el = document.getElementById('connection-status');
    if (el) el.innerHTML = connected ? '<span style="color: #97c93e;">✅ Connesso</span>' : '<span style="color: #FF6B6B;">❌ Disconnesso</span>';
}

function renderSensors() {
    var grid = document.getElementById('sensors-grid');
    if (!grid) return;
    var names = Object.keys(sensors);
    if (names.length === 0) { grid.innerHTML = '<div style="color: #666; text-align: center; padding: 20px;">⏳ Sensori...</div>'; return; }
    grid.innerHTML = '';
    names.slice(0, 6).forEach(name => {
        var card = document.createElement('div');
        card.className = 'sensor-col';
        card.setAttribute('data-sensor', name);
        card.innerHTML = '<div style="font-weight: 600; margin-bottom: 10px;">' + name + '</div>' +
            '<div style="font-size: 12px; color: #888;">GX: <span class="sensor-value">0.0</span>°/s</div>' +
            '<div style="font-size: 12px; color: #888;">GY: <span class="sensor-value">0.0</span>°/s</div>' +
            '<div style="font-size: 12px; color: #888;">GZ: <span class="sensor-value">0.0</span>°/s</div>';
        grid.appendChild(card);
    });
}

function clearAllData() {
    if (!confirm('Reset?')) return;
    fetch('/api/clear', { method: 'POST' }).then(() => { resetCalibration(); });
}
