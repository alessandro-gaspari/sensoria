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

// Inizializza listener WebSocket
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
        // ⭐ Carica dati iniziali
        if (data.sensors) {
            sensors = data.sensors;
            renderSensors();
        }
    });

    // ⭐ Aggiornamento REAL-TIME
    socket.on('sensor_update', (data) => {
        console.log('🔥 Update:', data.sensor_name);
        sensors[data.sensor_name] = data.data;
        renderSensors();
    });

    socket.on('data_cleared', () => {
        console.log('🗑️ Dati puliti');
        sensors = {};
        renderSensors();
    });
}

// Recupera dati iniziali (solo al caricamento)
async function fetchInitialData() {
    try {
        const response = await fetch('/api/sensors');
        const data = await response.json();
        sensors = data.sensors || {};
        renderSensors();
    } catch (error) {
        console.error('❌ Errore caricamento:', error);
    }
}

// Aggiorna stato connessione
function updateConnectionStatus(connected) {
    const statusEl = document.getElementById('connection-status');
    const countEl = document.getElementById('sensor-count');
    
    if (connected) {
        statusEl.classList.remove('disconnected');
        statusEl.innerHTML = '<span class="dot"></span> Connesso';
    } else {
        statusEl.classList.add('disconnected');
        statusEl.innerHTML = '<span class="dot"></span> Disconnesso';
    }
    
    const count = Object.keys(sensors).length;
    countEl.textContent = `${count} Sensor${count !== 1 ? 'i' : 'e'}`;
}

// Renderizza sensori
function renderSensors() {
    const grid = document.getElementById('sensors-grid');
    const emptyState = document.getElementById('empty-state');
    
    const sensorNames = Object.keys(sensors);
    
    // Mostra empty state se nessun sensore
    if (sensorNames.length === 0) {
        grid.style.display = 'none';
        emptyState.classList.add('visible');
        return;
    }
    
    grid.style.display = 'grid';
    emptyState.classList.remove('visible');
    grid.innerHTML = '';
    
    // Mostra fino a 6 sensori
    const sensorsToShow = sensorNames.slice(0, 6);
    
    sensorsToShow.forEach(name => {
        const data = sensors[name];
        grid.innerHTML += createSensorCard(name, data);
    });
    
    // Riempi slot vuoti
    for (let i = sensorsToShow.length; i < 6; i++) {
        grid.innerHTML += `
            <div class="sensor-col">
                <div class="sensor-header">Slot ${i + 1}</div>
                <p style="text-align:center; color:#666; margin-top:20px;">In attesa...</p>
            </div>
        `;
    }
    
    updateConnectionStatus(isConnected);
}

// Crea card sensore
function createSensorCard(name, data) {
    const emoji = getSensorEmoji(name);
    const timestamp = data.timestamp ? formatTimestamp(data.timestamp) : '---';
    
    return `
        <div class="sensor-col connected">
            <div class="sensor-header">${emoji} ${name}</div>
            <div class="sensor-data-row"><b>Accel X:</b> ${data.accel_x || '---'}</div>
            <div class="sensor-data-row"><b>Accel Y:</b> ${data.accel_y || '---'}</div>
            <div class="sensor-data-row"><b>Accel Z:</b> ${data.accel_z || '---'}</div>
            <div class="sensor-data-row"><b>Gyro X:</b> ${data.gyro_x || '---'}</div>
            <div class="sensor-data-row"><b>Gyro Y:</b> ${data.gyro_y || '---'}</div>
            <div class="sensor-data-row"><b>Gyro Z:</b> ${data.gyro_z || '---'}</div>
            <div class="sensor-data-row"><b>Mag X:</b> ${data.mag_x || '---'}</div>
            <div class="sensor-data-row"><b>Mag Y:</b> ${data.mag_y || '---'}</div>
            <div class="sensor-data-row"><b>Mag Z:</b> ${data.mag_z || '---'}</div>
            <div style="margin-top:12px; font-size:11px; color:#666; text-align:center;">
                ${timestamp}
            </div>
        </div>
    `;
}

// Emoji sensore
function getSensorEmoji(name) {
    const n = name.toLowerCase();
    if (n.includes('ginocchio') || n.includes('knee') || n.includes('gamba')) return '🦿';
    if (n.includes('piede') || n.includes('foot') || n.includes('calzino') || n.includes('calzini') || n.includes('socks')) return '🧦';
    if (n.includes('braccio') || n.includes('arm')) return '🦾';
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

// Pulisci dati
async function clearAllData() {
    if (!confirm('Vuoi davvero pulire tutti i dati?')) return;
    
    try {
        await fetch('/api/clear', { method: 'POST' });
        sensors = {};
        renderSensors();
    } catch (error) {
        console.error('❌ Errore:', error);
    }
}
