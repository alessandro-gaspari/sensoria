// Connessione Socket.IO ottimizzata
const socket = io({
    reconnection: true,
    reconnectionDelay: 100,
    reconnectionDelayMax: 1000,
    reconnectionAttempts: 5,
    transports: ['websocket', 'polling'],
});

// Stato applicazione
let sensors = {};
let isConnected = false;
let frameCount = 0;
let lastFrameTime = Date.now();
let currentFps = 0;

// Inizializzazione
document.addEventListener('DOMContentLoaded', () => {
    initializeSocketListeners();
    fetchInitialData();
    startFpsCounter();
});

// ⭐ NUOVO: Contatore FPS
function startFpsCounter() {
    setInterval(() => {
        const now = Date.now();
        const elapsed = (now - lastFrameTime) / 1000;
        currentFps = Math.round(frameCount / elapsed);
        frameCount = 0;
        lastFrameTime = now;
    }, 1000);
}

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
        if (data.sensors) {
            sensors = data.sensors;
            renderSensors();
        }
    });

    // ⭐ AGGIORNAMENTO REAL-TIME A 100Hz SENZA THROTTLING
    socket.on('sensor_update', (data) => {
        frameCount++;
        
        const sensorName = data.sensor_name;
        const sensorData = data.data;
        
        // Aggiorna lo stato globale
        sensors[sensorName] = sensorData;
        
        // Aggiorna il DOM direttamente (FAST PATH)
        updateSensorDirectly(sensorName, sensorData);
        
        // Log minimal (commenta per performance)
        // console.log(`📦 [${sensorName}] @ ${currentFps} Hz`);
    });

    socket.on('data_cleared', () => {
        console.log('🗑️ Dati puliti');
        sensors = {};
        renderSensors();
    });
}

// ⭐ OTTIMIZZATO: Aggiorna sensore direttamente nel DOM
function updateSensorDirectly(sensorName, data) {
    // Trova la card del sensore
    const sensorCard = document.querySelector(`[data-sensor="${sensorName}"]`);
    
    if (!sensorCard) {
        // Se non esiste, crea la card
        createSensorCardIfNotExists(sensorName, data);
        return;
    }
    
    // ⭐ FAST UPDATE: Aggiorna solo i valori numerici
    const fields = ['accel_x', 'accel_y', 'accel_z', 'gyro_x', 'gyro_y', 'gyro_z', 'mag_x', 'mag_y', 'mag_z'];
    const rows = sensorCard.querySelectorAll('.sensor-data-row');
    
    rows.forEach((row, idx) => {
        if (idx < fields.length) {
            const fieldName = fields[idx];
            const value = data[fieldName];
            const valueSpan = row.querySelector('.sensor-value');
            
            if (valueSpan && value !== undefined) {
                // Formatta a 2 decimali
                const formatted = typeof value === 'number' ? value.toFixed(2) : value;
                valueSpan.textContent = formatted;
            }
        }
    });
    
    // Aggiorna timestamp
    const timestampEl = sensorCard.querySelector('.sensor-timestamp');
    if (timestampEl && data.timestamp) {
        timestampEl.textContent = formatTimestamp(data.timestamp);
    }
    
    // Aggiorna indicatore di stato
    const statusIndicator = sensorCard.querySelector('.status-indicator');
    if (statusIndicator) {
        statusIndicator.classList.add('active');
        // Rimuovi active dopo 100ms per effetto blink
        setTimeout(() => statusIndicator.classList.remove('active'), 100);
    }
}

// ⭐ NUOVO: Crea card se non esiste
function createSensorCardIfNotExists(sensorName, data) {
    const grid = document.getElementById('sensors-grid');
    
    // Controlla se esiste già
    if (document.querySelector(`[data-sensor="${sensorName}"]`)) {
        return;
    }
    
    // Crea card
    const card = createSensorCard(sensorName, data);
    const emptySlot = grid.querySelector('.sensor-col:not([data-sensor])');
    
    if (emptySlot) {
        // Sostituisci slot vuoto
        emptySlot.replaceWith(createCardElement(card));
    } else {
        // Aggiungi se c'è spazio
        if (grid.querySelectorAll('[data-sensor]').length < 6) {
            grid.innerHTML += card;
        }
    }
    
    // Nascondi empty state
    const emptyState = document.getElementById('empty-state');
    if (emptyState && Object.keys(sensors).length > 0) {
        emptyState.classList.remove('visible');
        grid.style.display = 'grid';
    }
    
    updateConnectionStatus(isConnected);
}

// Helper per creare elemento HTML
function createCardElement(htmlString) {
    const temp = document.createElement('div');
    temp.innerHTML = htmlString.trim();
    return temp.firstChild;
}

// Recupera dati iniziali
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
    const fpsEl = document.getElementById('fps-counter');
    
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
        const count = Object.keys(sensors).length;
        countEl.textContent = `${count} Sensor${count !== 1 ? 'i' : 'e'}`;
    }
    
    if (fpsEl) {
        fpsEl.textContent = `${currentFps} Hz`;
    }
}

// Renderizza sensori (SOLO AL CARICAMENTO INIZIALE)
function renderSensors() {
    const grid = document.getElementById('sensors-grid');
    const emptyState = document.getElementById('empty-state');
    
    const sensorNames = Object.keys(sensors);
    
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

// ⭐ OTTIMIZZATO: Crea card sensore con span per fast update
function createSensorCard(name, data) {
    const emoji = getSensorEmoji(name);
    const timestamp = data.timestamp ? formatTimestamp(data.timestamp) : '---';
    
    return `
        <div class="sensor-col connected" data-sensor="${name}">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <div class="sensor-header">${emoji} ${name}</div>
                <div class="status-indicator"></div>
            </div>
            <div class="sensor-data-row"><b>Accel X:</b> <span class="sensor-value">${data.accel_x ? data.accel_x.toFixed(2) : '---'}</span></div>
            <div class="sensor-data-row"><b>Accel Y:</b> <span class="sensor-value">${data.accel_y ? data.accel_y.toFixed(2) : '---'}</span></div>
            <div class="sensor-data-row"><b>Accel Z:</b> <span class="sensor-value">${data.accel_z ? data.accel_z.toFixed(2) : '---'}</span></div>
            <div class="sensor-data-row"><b>Gyro X:</b> <span class="sensor-value">${data.gyro_x ? data.gyro_x.toFixed(2) : '---'}</span></div>
            <div class="sensor-data-row"><b>Gyro Y:</b> <span class="sensor-value">${data.gyro_y ? data.gyro_y.toFixed(2) : '---'}</span></div>
            <div class="sensor-data-row"><b>Gyro Z:</b> <span class="sensor-value">${data.gyro_z ? data.gyro_z.toFixed(2) : '---'}</span></div>
            <div class="sensor-data-row"><b>Mag X:</b> <span class="sensor-value">${data.mag_x ? data.mag_x.toFixed(2) : '---'}</span></div>
            <div class="sensor-data-row"><b>Mag Y:</b> <span class="sensor-value">${data.mag_y ? data.mag_y.toFixed(2) : '---'}</span></div>
            <div class="sensor-data-row"><b>Mag Z:</b> <span class="sensor-value">${data.mag_z ? data.mag_z.toFixed(2) : '---'}</span></div>
            <div style="margin-top:12px; font-size:11px; color:#666; text-align:center;">
                <span class="sensor-timestamp">${timestamp}</span>
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
        second: '2-digit',
        fractionalSecondDigits: 2
    });
}

// Pulisci dati
async function clearAllData() {
    if (!confirm('Vuoi davvero pulire tutti i dati?')) return;
    
    try {
        await fetch('/api/clear', { method: 'POST' });
        sensors = {};
        renderSensors();
        console.log('✅ Dati puliti');
    } catch (error) {
        console.error('❌ Errore:', error);
    }
}
