// Connessione Socket.IO
const socket = io();

// Stato applicazione
let sensors = {};
let isConnected = false;

// Inizializzazione
document.addEventListener('DOMContentLoaded', () => {
    initializeSocketListeners();
    fetchInitialData();
});

// Inizializza i listener WebSocket
function initializeSocketListeners() {
    socket.on('connect', () => {
        console.log('✅ Connesso al server');
        isConnected = true;
        updateConnectionStatus(true);
    });

    socket.on('disconnect', () => {
        console.log('❌ Disconnesso dal server');
        isConnected = false;
        updateConnectionStatus(false);
    });

    socket.on('connection_response', (data) => {
        console.log('📡 Risposta connessione:', data);
    });

    socket.on('sensor_update', (data) => {
        console.log('📊 Aggiornamento sensore:', data);
        updateSensorData(data.sensor_name, data.data);
    });

    socket.on('sensor_status_update', (data) => {
        console.log('🔄 Stato sensore aggiornato:', data);
        updateSensorStatus(data.sensor_name, data.status);
    });

    socket.on('data_cleared', () => {
        console.log('🗑️ Dati puliti');
        sensors = {};
        renderSensors();
    });
}

// Recupera i dati iniziali
async function fetchInitialData() {
    try {
        const response = await fetch('/api/sensors');
        const data = await response.json();
        
        sensors = data.sensors;
        
        // Aggiorna gli stati
        for (const [name, status] of Object.entries(data.status)) {
            if (!sensors[name]) sensors[name] = [];
        }
        
        renderSensors();
    } catch (error) {
        console.error('❌ Errore caricamento dati:', error);
    }
}

// Aggiorna lo stato di connessione
function updateConnectionStatus(connected) {
    const statusEl = document.getElementById('connection-status');
    if (connected) {
        statusEl.classList.remove('disconnected');
        statusEl.innerHTML = '<span class="dot"></span> Connesso';
    } else {
        statusEl.classList.add('disconnected');
        statusEl.innerHTML = '<span class="dot"></span> Disconnesso';
    }
}

// Aggiorna i dati di un sensore
function updateSensorData(sensorName, data) {
    if (!sensors[sensorName]) {
        sensors[sensorName] = [];
    }
    
    sensors[sensorName].push(data);
    
    // Mantieni solo gli ultimi 100 campioni
    if (sensors[sensorName].length > 100) {
        sensors[sensorName].shift();
    }
    
    renderSensors();
}

// Aggiorna lo stato di un sensore
function updateSensorStatus(sensorName, status) {
    // Implementa logica stato se necessario
    renderSensors();
}

// Renderizza tutti i sensori
function renderSensors() {
    const grid = document.getElementById('sensors-grid');
    grid.innerHTML = '';

    // Prendi al massimo 6 sensori
    const sensorNames = Object.keys(sensors).slice(0, 6);

    sensorNames.forEach(name => {
        const readings = sensors[name];
        const latest = readings && readings.length > 0 ? readings[readings.length-1] : {};
        let rows = '';

        // Mostra ogni valore ricevuto
        for (const key in latest) {
            if (key !== "timestamp") {
                rows += `<div class="sensor-data-row"><b>${key}:</b> ${latest[key]}</div>`;
            }
        }

        grid.innerHTML += `
            <div class="sensor-col">
                <div class="sensor-header">${name}</div>
                <div>${rows || "<i>Nessun dato</i>"}</div>
            </div>
        `;
    });

    // Se meno di 6 sensori, mostra colonne vuote
    for (let i = sensorNames.length; i < 6; i++) {
        grid.innerHTML += `<div class="sensor-col"><div class="sensor-header">Slot libero</div></div>`;
    }
}

// Polling continuo ogni 2 s (o mantieni WebSocket)
setInterval(async () => {
    const resp = await fetch('/api/sensors');
    const data = await resp.json();
    sensors = data.sensors || {};
    renderSensors();
}, 2000);

document.addEventListener('DOMContentLoaded', renderSensors);


// Crea la card di un sensore
function createSensorCard(sensorName) {
    const sensorData = sensors[sensorName];
    const latestData = sensorData[sensorData.length - 1] || {};
    
    const emoji = getSensorEmoji(sensorName);
    const isConnected = sensorData.length > 0;
    
    return `
        <div class="sensor-card ${isConnected ? 'connected' : ''}">
            <div class="sensor-header">
                <div class="sensor-title">
                    <span class="sensor-icon">${emoji}</span>
                    <span class="sensor-name">${sensorName}</span>
                </div>
                <span class="sensor-badge ${isConnected ? 'connected' : 'disconnected'}">
                    ${isConnected ? 'Attivo' : 'Inattivo'}
                </span>
            </div>
            
            <div class="sensor-data">
                <!-- Accelerometro -->
                <div class="data-group">
                    <div class="data-group-title">📐 Accelerometro</div>
                    <div class="data-values">
                        <div class="data-item">
                            <span class="data-label">X</span>
                            <span class="data-value">${latestData.accel_x || '---'}</span>
                        </div>
                        <div class="data-item">
                            <span class="data-label">Y</span>
                            <span class="data-value">${latestData.accel_y || '---'}</span>
                        </div>
                        <div class="data-item">
                            <span class="data-label">Z</span>
                            <span class="data-value">${latestData.accel_z || '---'}</span>
                        </div>
                    </div>
                </div>
                
                <!-- Giroscopio -->
                <div class="data-group">
                    <div class="data-group-title">🔄 Giroscopio</div>
                    <div class="data-values">
                        <div class="data-item">
                            <span class="data-label">X</span>
                            <span class="data-value">${latestData.gyro_x || '---'}</span>
                        </div>
                        <div class="data-item">
                            <span class="data-label">Y</span>
                            <span class="data-value">${latestData.gyro_y || '---'}</span>
                        </div>
                        <div class="data-item">
                            <span class="data-label">Z</span>
                            <span class="data-value">${latestData.gyro_z || '---'}</span>
                        </div>
                    </div>
                </div>
                
                <!-- Magnetometro -->
                <div class="data-group">
                    <div class="data-group-title">🧭 Magnetometro</div>
                    <div class="data-values">
                        <div class="data-item">
                            <span class="data-label">X</span>
                            <span class="data-value">${latestData.mag_x || '---'}</span>
                        </div>
                        <div class="data-item">
                            <span class="data-label">Y</span>
                            <span class="data-value">${latestData.mag_y || '---'}</span>
                        </div>
                        <div class="data-item">
                            <span class="data-label">Z</span>
                            <span class="data-value">${latestData.mag_z || '---'}</span>
                        </div>
                    </div>
                </div>
            </div>
            
            ${latestData.timestamp ? `
                <div class="sensor-timestamp">
                    Ultimo aggiornamento: ${formatTimestamp(latestData.timestamp)}
                </div>
            ` : ''}
        </div>
    `;
}

// Ottieni emoji per il nome del sensore
function getSensorEmoji(name) {
    const nameLower = name.toLowerCase();
    if (nameLower.includes('ginocchio') || nameLower.includes('knee')) return '🦵';
    if (nameLower.includes('piede') || nameLower.includes('foot')) return '🦶';
    if (nameLower.includes('braccio') || nameLower.includes('arm')) return '💪';
    if (nameLower.includes('cuore') || nameLower.includes('heart')) return '❤️';
    return '📱';
}

// Formatta timestamp
function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleString('it-IT', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

// Pulisci tutti i dati
async function clearAllData() {
    if (!confirm('Sei sicuro di voler pulire tutti i dati?')) return;
    
    try {
        await fetch('/api/clear', { method: 'POST' });
        sensors = {};
        renderSensors();
    } catch (error) {
        console.error('❌ Errore pulizia dati:', error);
        alert('Errore durante la pulizia dei dati');
    }
}
