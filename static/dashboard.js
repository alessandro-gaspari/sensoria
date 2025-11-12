var socket = io({
    reconnection: true,
    reconnectionDelay: 100,
    reconnectionDelayMax: 1000,
    reconnectionAttempts: 5,
    transports: ['websocket'],
    upgrade: false,
});

var sensors = {};
var isConnected = false;
var frameCount = 0;
var lastFrameTime = Date.now();
var currentFps = 0;
var domCache = {};
var pendingUpdates = {};

document.addEventListener('DOMContentLoaded', function() {
    initializeSocketListeners();
    fetchInitialData();
    startFpsCounter();
    startRenderLoop();
});

function startRenderLoop() {
    function render() {
        if (Object.keys(pendingUpdates).length > 0) batchUpdateDOM();
        requestAnimationFrame(render);
    }
    requestAnimationFrame(render);
}

function batchUpdateDOM() {
    Object.keys(pendingUpdates).forEach(function(sensorName) {
        updateSensorCardDynamic(sensorName, pendingUpdates[sensorName]);
    });
    pendingUpdates = {};
}

function startFpsCounter() {
    setInterval(function() {
        var now = Date.now();
        var elapsed = (now - lastFrameTime) / 1000;
        currentFps = Math.round(frameCount / elapsed);
        frameCount = 0;
        lastFrameTime = now;
        var fpsEl = document.getElementById('fps-counter');
        if (fpsEl) fpsEl.textContent = (currentFps || 0) + ' Hz';
    }, 1000);
}

function initializeSocketListeners() {
    socket.on('connect', function() {
        isConnected = true;
        updateConnectionStatus(true);
    });
    socket.on('disconnect', function() {
        isConnected = false;
        updateConnectionStatus(false);
    });
    socket.on('connection_response', function(data) {
        if (data.sensors) {
            sensors = data.sensors;
            renderSensors();
        }
    });
    socket.on('sensor_update', function(data) {
        frameCount++;
        var sensorName = data.sensor_name;
        var sensorData = data.data;
        sensors[sensorName] = sensorData;
        pendingUpdates[sensorName] = sensorData;
    });
    socket.on('sensor_disconnected', function(data) {
    if (!data.sensor_name) return;
    
    // Rimuovi i dati sensore localmente
    delete sensors[data.sensor_name];
    delete pendingUpdates[data.sensor_name];
    
    // Rimuovi la card dal DOM
    var card = document.querySelector('[data-sensor="' + data.sensor_name + '"]');
    if (card) card.remove();
    
    // Aggiorna la visualizzazione sensori
    renderSensors();
    });

    socket.on('data_cleared', function() {
        sensors = {};
        domCache = {};
        renderSensors();
    });
}

function updateSensorCardDynamic(sensorName, data) {
    var cacheKey = 'card-' + sensorName;
    if (!domCache[cacheKey]) {
        var card = document.querySelector('[data-sensor="' + sensorName + '"]');
        if (!card) {
            createSensorCardDynamic(sensorName, data);
            return;
        }
        domCache[cacheKey] = {
            card: card,
            content: card.querySelector('.sensor-fields'),
            timestamp: card.querySelector('.sensor-timestamp'),
            status: card.querySelector('.status-indicator')
        };
    }
    var cached = domCache[cacheKey];

    // Render all fields raw (skip sensor_name & timestamp for table, shown below)
    let html = '';
    Object.keys(data).forEach(function(key) {
        if (key === 'timestamp' || key === 'sensor_name') return;
        html += '<div class="sensor-data-row">' +
            '<span class="sensor-data-label">' + key + ':</span>' +
            '<span class="sensor-value">' + data[key] + '</span>' +
            '</div>';
    });
    if (cached.content) cached.content.innerHTML = html;

    // Show timestamp
    if (cached.timestamp && data.timestamp) {
        var date = new Date(data.timestamp);
        cached.timestamp.textContent =
            String(date.getHours()).padStart(2, '0') + ':' +
            String(date.getMinutes()).padStart(2, '0') + ':' +
            String(date.getSeconds()).padStart(2, '0');
    }
    // Flash indicator
    if (cached.status) {
        cached.status.classList.add('active');
        if (cached.status.timeoutId) clearTimeout(cached.status.timeoutId);
        cached.status.timeoutId = setTimeout(function () {
            cached.status.classList.remove('active');
        }, 50);
    }
}

function createSensorCardDynamic(sensorName, data) {
    var grid = document.getElementById('sensors-grid');
    var emoji = getSensorEmoji(sensorName);
    var template = document.createElement('div');
    template.className = 'sensor-col connected';
    template.setAttribute('data-sensor', sensorName);
    template.innerHTML =
        '<div class="sensor-header">' +
            '<div>' + emoji + ' ' + sensorName + '</div>' +
            '<div class="status-indicator active"></div>' +
        '</div>' +
        '<div class="sensor-fields"></div>' +
        '<span class="sensor-timestamp">--:--:--</span>';
    grid.appendChild(template);
    var emptyState = document.getElementById('empty-state');
    if (emptyState) {
        emptyState.classList.remove('visible');
        grid.style.display = 'grid';
    }
}

function renderSensors() {
    var grid = document.getElementById('sensors-grid');
    var emptyState = document.getElementById('empty-state');
    if (!grid || !emptyState) return;
    var sensorNames = Object.keys(sensors);
    grid.innerHTML = '';
    domCache = {};
    if (sensorNames.length === 0) {
        grid.style.display = 'none';
        emptyState.classList.add('visible');
        return;
    }
    sensorNames.forEach(function(name) {
        createSensorCardDynamic(name, sensors[name]);
    });
    grid.style.display = 'grid';
    emptyState.classList.remove('visible');
    updateConnectionStatus(isConnected);
}

function fetchInitialData() {
    fetch('/api/sensors')
        .then(function(response) { return response.json(); })
        .then(function(data) {
            sensors = data.sensors || {};
            renderSensors();
        });
}

function updateConnectionStatus(connected) {
    var statusEl = document.getElementById('connection-status');
    var countEl = document.getElementById('sensor-count');
    if (statusEl) {
        statusEl.innerHTML = connected ? '<span class="dot"></span> Connesso' : '<span class="dot"></span> Disconnesso';
    }
    if (countEl) {
        var count = Object.keys(sensors).length;
        countEl.textContent = count + ' Sensor' + (count !== 1 ? 'i' : 'e');
    }
}

function getSensorEmoji(name) {
    var n = name.toLowerCase();
    if (n.indexOf('ginocchio') !== -1 || n.indexOf('knee') !== -1) return '🦿';
    if (n.indexOf('piede') !== -1 || n.indexOf('foot') !== -1 || n.indexOf('calzino') !== -1) return '🧦';
    if (n.indexOf('braccio') !== -1) return '🦾';
    return '📱';
}

function clearAllData() {
    if (!confirm('Pulire dati?')) return;
    fetch('/api/clear', { method: 'POST' })
        .then(function() {
            sensors = {};
            domCache = {};
            renderSensors();
        });
}
