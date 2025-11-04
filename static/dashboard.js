// Connessione SocketIO ULTRA-VELOCE
const socket = io({
    reconnection: true,
    reconnectionDelay: 100,
    reconnectionDelayMax: 1000,
    reconnectionAttempts: 5,
    transports: ['websocket'],
    upgrade: false,
});

// Stato applicazione
let sensors = {};
let isConnected = false;
let frameCount = 0;
let lastFrameTime = Date.now();
let currentFps = 0;
let lastDataTime = Date.now();
let heartbeatTimer;

// Inizializzazione
document.addEventListener('DOMContentLoaded', function() {
    initializeSocketListeners();
    fetchInitialData();
    startFpsCounter();
});

// Heartbeat per rilevare disconnessioni
function resetHeartbeat() {
    lastDataTime = Date.now();
    clearTimeout(heartbeatTimer);
    
    heartbeatTimer = setTimeout(function() {
        console.warn('Heartbeat fallito - possibile disconnessione sensore');
    }, 2000);
}

// Contatore FPS
function startFpsCounter() {
    setInterval(function() {
        var now = Date.now();
        var elapsed = (now - lastFrameTime) / 1000;
        currentFps = Math.round(frameCount / elapsed);
        frameCount = 0;
        lastFrameTime = now;
    }, 1000);
}

// Inizializza listener WebSocket
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

    // Aggiornamento ultra-veloce: ricevi ogni singolo dato a 100Hz
    socket.on('sensor_update', function(data) {
        frameCount++;
        resetHeartbeat();
        
        var sensorName = data.sensor_name;
        var sensorData = data.data;
        
        sensors[sensorName] = sensorData;
        updateSensorDirectly(sensorName, sensorData);
    });

    socket.on('sensor_disconnected', function(data) {
        console.log('Sensore disconnesso: ' + data.sensor_name);
        
        var sensorCard = document.querySelector('[data-sensor="' + data.sensor_name + '"]');
        if (sensorCard) {
            sensorCard.classList.add('disconnected');
        }
    });

    socket.on('data_cleared', function() {
        console.log('Dati puliti - Resettando dashboard');
        sensors = {};
        renderSensors();
        resetHeartbeat();
    });
}

// Ultra-ottimizzato: aggiorna sensore al massimo di velocità
function updateSensorDirectly(sensorName, data) {
    var sensorCard = document.querySelector('[data-sensor="' + sensorName + '"]');
    
    if (!sensorCard) {
        createSensorCardFast(sensorName, data);
        return;
    }
    
    // Velocissimo: solo update dei valori
    var valueElements = sensorCard.querySelectorAll('.sensor-value');
    var fields = ['accel_x', 'accel_y', 'accel_z', 'gyro_x', 'gyro_y', 'gyro_z', 'mag_x', 'mag_y', 'mag_z'];
    
    for (var i = 0; i < Math.min(valueElements.length, fields.length); i++) {
        var value = data[fields[i]];
        if (value !== undefined) {
            valueElements[i].textContent = value.toFixed(2);
        }
    }
    
    // Update timestamp
    var timestampEl = sensorCard.querySelector('.sensor-timestamp');
    if (timestampEl && data.timestamp) {
        var date = new Date(data.timestamp);
        var hours = String(date.getHours()).padStart(2, '0');
        var minutes = String(date.getMinutes()).padStart(2, '0');
        var seconds = String(date.getSeconds()).padStart(2, '0');
        timestampEl.textContent = hours + ':' + minutes + ':' + seconds;
    }
    
    // Status indicator blink
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

// Crea card sensore velocemente
function createSensorCardFast(sensorName, data) {
    var grid = document.getElementById('sensors-grid');
    
    var currentSensors = grid.querySelectorAll('[data-sensor]').length;
    
    if (currentSensors >= 6) return;
    
    var emoji = getSensorEmoji(sensorName);
    var template = document.createElement('div');
    template.className = 'sensor-col connected';
    template.setAttribute('data-sensor', sensorName);
    
    var accelX = (data.accel_x !== undefined) ? data.accel_x.toFixed(2) : '---';
    var accelY = (data.accel_y !== undefined) ? data.accel_y.toFixed(2) : '---';
    var accelZ = (data.accel_z !== undefined) ? data.accel_z.toFixed(2) : '---';
    var gyroX = (data.gyro_x !== undefined) ? data.gyro_x.toFixed(2) : '---';
    var gyroY = (data.gyro_y !== undefined) ? data.gyro_y.toFixed(2) : '---';
    var gyroZ = (data.gyro_z !== undefined) ? data.gyro_z.toFixed(2) : '---';
    var magX = (data.mag_x !== undefined) ? data.mag_x.toFixed(2) : '---';
    var magY = (data.mag_y !== undefined) ? data.mag_y.toFixed(2) : '---';
    var magZ = (data.mag_z !== undefined) ? data.mag_z.toFixed(2) : '---';
    
    template.innerHTML = 
        '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">' +
            '<div class="sensor-header">' + emoji + ' ' + sensorName + '</div>' +
            '<div class="status-indicator active"></div>' +
        '</div>' +
        '<div class="sensor-data-row"><b>Accel X:</b> <span class="sensor-value">' + accelX + '</span></div>' +
        '<div class="sensor-data-row"><b>Accel Y:</b> <span class="sensor-value">' + accelY + '</span></div>' +
        '<div class="sensor-data-row"><b>Accel Z:</b> <span class="sensor-value">' + accelZ + '</span></div>' +
        '<div class="sensor-data-row"><b>Gyro X:</b> <span class="sensor-value">' + gyroX + '</span></div>' +
        '<div class="sensor-data-row"><b>Gyro Y:</b> <span class="sensor-value">' + gyroY + '</span></div>' +
        '<div class="sensor-data-row"><b>Gyro Z:</b> <span class="sensor-value">' + gyroZ + '</span></div>' +
        '<div class="sensor-data-row"><b>Mag X:</b> <span class="sensor-value">' + magX + '</span></div>' +
        '<div class="sensor-data-row"><b>Mag Y:</b> <span class="sensor-value">' + magY + '</span></div>' +
        '<div class="sensor-data-row"><b>Mag Z:</b> <span class="sensor-value">' + magZ + '</span></div>' +
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

// Recupera dati iniziali
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

// Aggiorna stato connessione
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

// Renderizza sensori (caricamento iniziale)
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
        
        var accelX = (data.accel_x !== undefined) ? data.accel_x.toFixed(2) : '---';
        var accelY = (data.accel_y !== undefined) ? data.accel_y.toFixed(2) : '---';
        var accelZ = (data.accel_z !== undefined) ? data.accel_z.toFixed(2) : '---';
        var gyroX = (data.gyro_x !== undefined) ? data.gyro_x.toFixed(2) : '---';
        var gyroY = (data.gyro_y !== undefined) ? data.gyro_y.toFixed(2) : '---';
        var gyroZ = (data.gyro_z !== undefined) ? data.gyro_z.toFixed(2) : '---';
        var magX = (data.mag_x !== undefined) ? data.mag_x.toFixed(2) : '---';
        var magY = (data.mag_y !== undefined) ? data.mag_y.toFixed(2) : '---';
        var magZ = (data.mag_z !== undefined) ? data.mag_z.toFixed(2) : '---';
        
        card.innerHTML =
            '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">' +
                '<div class="sensor-header">' + emoji + ' ' + name + '</div>' +
                '<div class="status-indicator"></div>' +
            '</div>' +
            '<div class="sensor-data-row"><b>Accel X:</b> <span class="sensor-value">' + accelX + '</span></div>' +
            '<div class="sensor-data-row"><b>Accel Y:</b> <span class="sensor-value">' + accelY + '</span></div>' +
            '<div class="sensor-data-row"><b>Accel Z:</b> <span class="sensor-value">' + accelZ + '</span></div>' +
            '<div class="sensor-data-row"><b>Gyro X:</b> <span class="sensor-value">' + gyroX + '</span></div>' +
            '<div class="sensor-data-row"><b>Gyro Y:</b> <span class="sensor-value">' + gyroY + '</span></div>' +
            '<div class="sensor-data-row"><b>Gyro Z:</b> <span class="sensor-value">' + gyroZ + '</span></div>' +
            '<div class="sensor-data-row"><b>Mag X:</b> <span class="sensor-value">' + magX + '</span></div>' +
            '<div class="sensor-data-row"><b>Mag Y:</b> <span class="sensor-value">' + magY + '</span></div>' +
            '<div class="sensor-data-row"><b>Mag Z:</b> <span class="sensor-value">' + magZ + '</span></div>' +
            '<div style="margin-top:12px; font-size:11px; color:#666; text-align:center;">' +
                '<span class="sensor-timestamp">--:--:--</span>' +
            '</div>';
        grid.appendChild(card);
    });
    
    // Riempi slot vuoti
    for (var i = sensorsToShow.length; i < 6; i++) {
        var slot = document.createElement('div');
        slot.className = 'sensor-col';
        slot.innerHTML =
            '<div class="sensor-header">Slot ' + (i + 1) + '</div>' +
            '<p style="text-align:center; color:#666; margin-top:20px;">In attesa...</p>';
        grid.appendChild(slot);
    }
    
    updateConnectionStatus(isConnected);
}

// Emoji sensore
function getSensorEmoji(name) {
    var n = name.toLowerCase();
    if (n.indexOf('ginocchio') !== -1 || n.indexOf('knee') !== -1 || n.indexOf('gamba') !== -1) return '🦿';
    if (n.indexOf('piede') !== -1 || n.indexOf('foot') !== -1 || n.indexOf('calzino') !== -1 || n.indexOf('calzini') !== -1 || n.indexOf('socks') !== -1) return '🧦';
    if (n.indexOf('braccio') !== -1 || n.indexOf('arm') !== -1) return '🦾';
    return '📱';
}

// Pulisci dati
function clearAllData() {
    if (!confirm('Vuoi davvero pulire tutti i dati?')) return;
    
    fetch('/api/clear', { method: 'POST' })
        .then(function() {
            sensors = {};
            renderSensors();
            console.log('Dati puliti');
        })
        .catch(function(error) {
            console.error('Errore:', error);
        });
}
