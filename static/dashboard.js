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

function convertAccelerometerRaw(raw) {
    return raw / S_ACC;
}

function convertGyroscopeRaw(raw) {
    return raw / S_GYRO;
}

function convertMagnetometerRaw(raw) {
    return raw * S_MAG;
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
    if (calibSamplesSup.length < CALIBRATION_SAMPLES || 
        calibSamplesInf.length < CALIBRATION_SAMPLES) {
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

        // ⭐ CONVERSIONI
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

        var gx = convertedData.gyro_x;
        var n = sensorName.toLowerCase();

        // ⭐ FASE 1: Calibrazione bias
        if (!biasCalibrationDone) {
            if (n.indexOf('sup') !== -1 || n.indexOf('sopra') !== -1) {
                calibSamplesSup.push(gx);
            }
            if (n.indexOf('inf') !== -1 || n.indexOf('sotto') !== -1) {
                calibSamplesInf.push(gx);
            }

            if (calibSamplesSup.length >= CALIBRATION_SAMPLES && 
                calibSamplesInf.length >= CALIBRATION_SAMPLES) {
                calibrateGyroBias();
            }
            updateSensorDirectly(sensorName, convertedData);
            return;
        }

        // ⭐ FASE 2: Integrazione
        if (n.indexOf('sup') !== -1 || n.indexOf('sopra') !== -1) {
            var gx_smooth = smoothWithOutlierDetection(smoothSupGX, gx);
            var dominant_corrected = gx_smooth;
            if (Math.abs(gx_smooth) < 50) {
                dominant_corrected = gx_smooth - gyroBiasSup;
            }
            angleSup = angleSup + (dominant_corrected * deltaTime);
        }

        if (n.indexOf('inf') !== -1 || n.indexOf('sotto') !== -1) {
            var gx_smooth = smoothWithOutlierDetection(smoothInfGX, gx);
            var dominant_corrected = gx_smooth;
            if (Math.abs(gx_smooth) < 50) {
                dominant_corrected = gx_smooth - gyroBiasInf;
            }
            angleInf = angleInf + (dominant_corrected * deltaTime);
        }

        updateKneeAngleDisplay();
        updateSensorDirectly(sensorName, convertedData);
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
        console.log('🔄 Reset');
    });
}

function calibrateButton() {
    if (!biasCalibrationDone) {
        alert('⏳ Aspetta!\n\nTieni fermo per 2 secondi...');
        return;
    }

    calibrationOffsetKnee = {
        sup: angleSup,
        inf: angleInf
    };

    console.log('✅ CALIBRAZIONE ANGOLO: SUP=' + angleSup.toFixed(1) + '° INF=' + angleInf.toFixed(1) + '°');
    updateKneeAngleDisplay();
    alert('✅ Calibrato!');
}

function getKneeAngle() {
    if (calibrationOffsetKnee === null) {
        return 0;
    }

    var sup_rel = angleSup - calibrationOffsetKnee.sup;
    var inf_rel = angleInf - calibrationOffsetKnee.inf;

    return Math.round(sup_rel - inf_rel);
}

function updateKneeAngleDisplay() {
    var el = document.getElementById('knee-angle-display');
    if (!el) return;

    var bias = biasCalibrationDone ? '✅' : '⏳';
    var cal = calibrationOffsetKnee !== null ? '✅' : '✗';
    var angle = getKneeAngle();

    el.innerHTML =
        '<div style="background: linear-gradient(135deg, #97c93e 0%, #6fa52d 100%); border-radius: 12px; padding: 20px; text-align: center; color: #000; box-shadow: 0 4px 15px rgba(0,0,0,0.3);">' +
            '<div style="font-size: 12px; opacity: 0.8; margin-bottom: 8px;">Bias: ' + bias + ' | Cal: ' + cal + '</div>' +
            '<div style="font-size: 72px; font-weight: 700; font-family: monospace; margin: 8px 0;">' + angle + '°</div>' +
            '<div style="font-size: 10px; opacity: 0.7; margin-bottom: 12px;">SUP: ' + angleSup.toFixed(1) + '° | INF: ' + angleInf.toFixed(1) + '°</div>' +
            '<button onclick="calibrateButton()" style="margin-top: 12px; padding: 10px 20px; background: rgba(0,0,0,0.25); border: 1px solid rgba(0,0,0,0.5); border-radius: 6px; color: inherit; font-weight: 600; cursor: pointer; font-size: 13px; width: 100%;">📍 CALIBRA ANGOLO</button>' +
        '</div>';
}

// ⭐ NUOVO: Aggiorna sensore con TUTTI i dati ordinati
function updateSensorDirectly(sensorName, data) {
    var card = document.querySelector('[data-sensor="' + sensorName + '"]');
    if (!card) {
        createSensorCard(sensorName, data);
        return;
    }

    // Accelerometro
    card.querySelector('.accel_x').textContent = data.accel_x.toFixed(2);
    card.querySelector('.accel_y').textContent = data.accel_y.toFixed(2);
    card.querySelector('.accel_z').textContent = data.accel_z.toFixed(2);

    // Giroscopio
    card.querySelector('.gyro_x').textContent = data.gyro_x.toFixed(2);
    card.querySelector('.gyro_y').textContent = data.gyro_y.toFixed(2);
    card.querySelector('.gyro_z').textContent = data.gyro_z.toFixed(2);

    // Magnetometro
    card.querySelector('.mag_x').textContent = data.mag_x.toFixed(2);
    card.querySelector('.mag_y').textContent = data.mag_y.toFixed(2);
    card.querySelector('.mag_z').textContent = data.mag_z.toFixed(2);
}

// ⭐ NUOVO: Crea card sensore con layout moderno
function createSensorCard(sensorName, data) {
    var grid = document.getElementById('sensors-grid');
    if (!grid) return;

    var card = document.createElement('div');
    card.className = 'sensor-col connected';
    card.setAttribute('data-sensor', sensorName);

    var emoji = sensorName.toLowerCase().indexOf('sup') !== -1 ? '🦿 SUP' : '🦿 INF';

    card.innerHTML =
        '<div style="font-weight: bold; font-size: 1.1em; margin-bottom: 12px; color: #97c93e;">' + emoji + ' - ' + sensorName + '</div>' +

        '<div style="background: #222; padding: 10px; border-radius: 6px; margin-bottom: 8px; border-left: 3px solid #8a8;">' +
            '<div style="font-size: 11px; color: #8a8; font-weight: 600; margin-bottom: 6px;">📊 ACCELEROMETRO (g)</div>' +
            '<div style="font-size: 12px; color: #ccc;"><b>X:</b> <span class="accel_x">0.00</span>  <b>Y:</b> <span class="accel_y">0.00</span>  <b>Z:</b> <span class="accel_z">0.00</span></div>' +
        '</div>' +

        '<div style="background: #1a2a1a; padding: 10px; border-radius: 6px; margin-bottom: 8px; border-left: 3px solid #4f4;">' +
            '<div style="font-size: 11px; color: #4f4; font-weight: 600; margin-bottom: 6px;">🌀 GIROSCOPIO (°/s)</div>' +
            '<div style="font-size: 12px; color: #ccc;"><b>X:</b> <span class="gyro_x">0.00</span>  <b>Y:</b> <span class="gyro_y">0.00</span>  <b>Z:</b> <span class="gyro_z">0.00</span></div>' +
        '</div>' +

        '<div style="background: #1a1a2a; padding: 10px; border-radius: 6px; border-left: 3px solid #88a;">' +
            '<div style="font-size: 11px; color: #88a; font-weight: 600; margin-bottom: 6px;">🧲 MAGNETOMETRO (µT)</div>' +
            '<div style="font-size: 12px; color: #ccc;"><b>X:</b> <span class="mag_x">0.00</span>  <b>Y:</b> <span class="mag_y">0.00</span>  <b>Z:</b> <span class="mag_z">0.00</span></div>' +
        '</div>';

    grid.appendChild(card);
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
    var el = document.getElementById('connection-status');
    if (el) {
        el.innerHTML = connected ? '<span style="color: #97c93e;">✅ Connesso</span>' : '<span style="color: #FF6B6B;">❌ Disconnesso</span>';
    }
}

function renderSensors() {
    var grid = document.getElementById('sensors-grid');
    if (!grid) return;

    var names = Object.keys(sensors);
    if (names.length === 0) {
        grid.innerHTML = '<div style="color: #666; text-align: center; padding: 20px;">⏳ Sensori...</div>';
        return;
    }

    grid.innerHTML = '';
    names.slice(0, 6).forEach(function(name) {
        createSensorCard(name, sensors[name]);
    });
}

function clearAllData() {
    if (!confirm('Reset?')) return;
    fetch('/api/clear', { method: 'POST' }).then(function() {
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
