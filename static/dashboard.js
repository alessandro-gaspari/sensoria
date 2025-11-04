// ===========================
// ⚙️ CONFIGURAZIONE PRINCIPALE
// ===========================

const ALPHA = 0.98; // peso del filtro complementare
const SENSOR_TIMEOUT = 3000; // ms di timeout per perdita segnale
let sensors = {};
let frameCount = 0;

let pitchSup = 0; // Pitch sensore superiore
let pitchInf = 0; // Pitch sensore inferiore
let lastTimestamp = Date.now();
let lastKneeAngle = 0;
let angularVelocity = 0;
let calibratedOffset = 0;

// ===========================
// 🔄 FUNZIONI DI CONVERSIONE
// ===========================

// Converti raw → g
function convertAccelerometerRaw(raw) {
    return raw / 16384; // ±2g (LSB = 16384)
}

// Converti raw → °/s
function convertGyroscopeRaw(raw) {
    return raw / 131; // ±250°/s (LSB = 131)
}

// Converti raw → µT
function convertMagnetometerRaw(raw) {
    return raw * 0.15; // conversione tipica
}

// ===========================
// 📐 CALCOLI ANGOLARI
// ===========================

// Calcola il pitch (inclinazione) da accelerometro
function calculatePitchFromAccel(ax, ay, az) {
    return Math.atan2(ax, Math.sqrt(ay * ay + az * az)) * 180 / Math.PI;
}

// ===========================
// ⚡️ CALCOLO ANGOLO GINOCCHIO
// ===========================

function updateKneeAngleDisplay(kneeAngle, angularVelocity) {
    const angleElem = document.getElementById("kneeAngle");
    const velocityElem = document.getElementById("kneeVelocity");

    if (angleElem) angleElem.textContent = (kneeAngle - calibratedOffset).toFixed(2) + "°";
    if (velocityElem) velocityElem.textContent = angularVelocity.toFixed(2) + " °/s";
}

// ===========================
// ❤️ GESTIONE CONNESSIONE BLE
// ===========================

function resetHeartbeat() {
    clearTimeout(window.heartbeatTimeout);
    window.heartbeatTimeout = setTimeout(() => {
        console.warn("⚠️ Nessun dato ricevuto — sensore disconnesso");
    }, SENSOR_TIMEOUT);
}

// ===========================
// 📡 GESTIONE DATI SENSORIALI
// ===========================

socket.on('sensor_update', function(data) {
    frameCount++;
    resetHeartbeat();

    let sensorName = data.sensor_name;
    let sensorData = data.data;

    // --- Conversione dati ---
    let convertedData = {
        timestamp: sensorData.timestamp,
        accel_x: convertAccelerometerRaw(sensorData.accel_x),
        accel_y: convertAccelerometerRaw(sensorData.accel_y),
        accel_z: convertAccelerometerRaw(sensorData.accel_z),
        gyro_x: convertGyroscopeRaw(sensorData.gyro_x),
        gyro_y: convertGyroscopeRaw(sensorData.gyro_y),
        gyro_z: convertGyroscopeRaw(sensorData.gyro_z),
        mag_x: convertMagnetometerRaw(sensorData.mag_x),
        mag_y: convertMagnetometerRaw(sensorData.mag_y),
        mag_z: convertMagnetometerRaw(sensorData.mag_z)
    };

    sensors[sensorName] = convertedData;

    // --- Calcolo delta tempo ---
    let now = Date.now();
    let dt = (now - lastTimestamp) / 1000; // secondi
    lastTimestamp = now;

    // --- Calcolo pitch da accelerometro ---
    let pitchAccel = calculatePitchFromAccel(
        convertedData.accel_x,
        convertedData.accel_y,
        convertedData.accel_z
    );

    let n = sensorName.toLowerCase();

    // --- Aggiornamento con filtro complementare ---
    if (n.includes('sup') || n.includes('sopra') || n.includes('upper') || n.includes('top')) {
        pitchSup = ALPHA * (pitchSup + convertedData.gyro_x * dt) + (1 - ALPHA) * pitchAccel;
    }

    if (n.includes('inf') || n.includes('sotto') || n.includes('lower') || n.includes('bottom')) {
        pitchInf = ALPHA * (pitchInf + convertedData.gyro_x * dt) + (1 - ALPHA) * pitchAccel;
    }

    // --- Calcolo angolo del ginocchio ---
    let kneeAngle = pitchSup - pitchInf;

    // --- Calcolo velocità angolare ---
    angularVelocity = (kneeAngle - lastKneeAngle) / dt;
    lastKneeAngle = kneeAngle;

    // --- Aggiornamento dashboard ---
    updateSensorDirectly(sensorName, convertedData);
    updateKneeAngleDisplay(kneeAngle, angularVelocity);
});

// ===========================
// 🧭 CALIBRAZIONE INIZIALE
// ===========================

function calibrateKneeAngle() {
    calibratedOffset = pitchSup - pitchInf;
    console.log("✅ Calibrazione completata. Offset:", calibratedOffset.toFixed(2), "°");
}

// Puoi legarla a un bottone per esempio:
document.getElementById("calibrateBtn")?.addEventListener("click", calibrateKneeAngle);

// ===========================
// 🔁 AGGIORNAMENTO LIVE SENSOR
// ===========================

function updateSensorDirectly(name, data) {
    const el = document.getElementById(name);
    if (!el) return;

    el.querySelector(".ax").textContent = data.accel_x.toFixed(2);
    el.querySelector(".ay").textContent = data.accel_y.toFixed(2);
    el.querySelector(".az").textContent = data.accel_z.toFixed(2);
    el.querySelector(".gx").textContent = data.gyro_x.toFixed(2);
    el.querySelector(".gy").textContent = data.gyro_y.toFixed(2);
    el.querySelector(".gz").textContent = data.gyro_z.toFixed(2);
}