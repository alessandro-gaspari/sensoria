var socket = io({
    reconnection: true,
    reconnectionDelay: 100,
    reconnectionDelayMax: 1000,
    reconnectionAttempts: 5,
    transports: ['websocket'],
    upgrade: false
});

var sensors = {};
var isConnected = false;
var frameCount = 0;
var lastFrameTime = Date.now();
var currentFps = 0;
var domCache = {};
var pendingUpdates = {};
var lastUpdateTime = 0;

// MAP VARIABLES
var map = null;
var mapMarker = null;
var isMapInitialized = false;

var charts = {
    accel: null,
    gyro: null,
    mag: null,
    pressure: null
};

var chartData = {
    accel: [[], [], [], []],
    gyro: [[], [], [], []],
    mag: [[], [], [], []],
    pressure: [[], [], [], []]
};

var MIN_ZOOM_RANGE = 0.5;
var selectedSensor = null;
var chartsInitialized = false;
var isUserInteracting = false;

document.addEventListener('DOMContentLoaded', function() {
    initializeSocketListeners();
    fetchInitialData();
    startFpsCounter();
    startRenderLoop();

    var selectorElement = document.getElementById('chart-sensor-select');
    if (selectorElement) {
        selectorElement.addEventListener('change', function(e) {
            selectedSensor = e.target.value;
            if (!chartsInitialized && selectedSensor) {
                initCharts();
                chartsInitialized = true;
            }
            resetChartData();
        });
    }
});

function startRenderLoop() {
    function render() {
        var now = performance.now();
        var sensorCount = Object.keys(sensors).length;
        var renderInterval = 33;
        if (sensorCount >= 4) renderInterval = 50;
        if (sensorCount >= 6) renderInterval = 66;
        if (Object.keys(pendingUpdates).length > 0 && (now - lastUpdateTime > renderInterval)) {
            batchUpdateDOM();
            lastUpdateTime = now;
        }
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
        updateCharts(sensorName, sensorData);
    });

    socket.on('sensor_disconnected', function(data) {
        if (!data.sensor_name) return;
        delete sensors[data.sensor_name];
        delete pendingUpdates[data.sensor_name];
        var card = document.querySelector('[data-sensor="' + data.sensor_name + '"]');
        if (card) card.remove();
        renderSensors();
    });

    // --- NUOVO: LISTENER PROFILO ---
    socket.on('profile_update', function(data) {
        updateProfileUI(data);
    });

    // --- NUOVO: LISTENER GPS ---
    socket.on('gps_update', function(data) {
        updateMap(data);
    });

    socket.on('data_cleared', function() {
        sensors = {};
        domCache = {};
        pendingUpdates = {};
        renderSensors();
        
        // Pulisci Profilo UI
        document.getElementById('user-profile-display').style.display = 'none';
        
        // Pulisci Mappa (non la distruggiamo, ma nascondiamo il marker)
        if (mapMarker) {
            map.removeLayer(mapMarker);
            mapMarker = null;
        }
        document.getElementById('map-section').style.display = 'none';
    });
}

// --- FUNZIONI PROFILO ---
function updateProfileUI(data) {
    var container = document.getElementById('user-profile-display');
    var avatarEl = document.getElementById('profile-avatar');
    var nameEl = document.getElementById('profile-name');
    var detailsEl = document.getElementById('profile-details');

    if (container && nameEl) {
        container.style.display = 'flex';
        nameEl.textContent = data.name ? data.name.toUpperCase() : "UTENTE";
        
        var genderIcon = data.gender === "M" ? "♂" : (data.gender === "F" ? "♀" : "");
        var details = (data.age || "--") + " anni | " + (data.weight || "--") + " kg";
        if (genderIcon) details += " | " + genderIcon;
        
        detailsEl.textContent = details;
        avatarEl.textContent = data.avatar || "👤";
    }
}

// --- FUNZIONI MAPPA ---
function initMap() {
    if (isMapInitialized) return;
    
    // Inizializza mappa su coordinate neutre (o Roma)
    map = L.map('map').setView([41.9028, 12.4964], 6);
    
    // Tile Dark Mode (CartoDB Dark Matter) per matchare il tema
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 20
    }).addTo(map);

    isMapInitialized = true;
    
    // Fix rendering Leaflet quando inizialmente hidden
    setTimeout(function() {
        map.invalidateSize();
    }, 500);
}

function updateMap(data) {
    var section = document.getElementById('map-section');
    var accuracyEl = document.getElementById('gps-accuracy');

    if (section.style.display === 'none') {
        section.style.display = 'block';
        if (!isMapInitialized) initMap();
        else setTimeout(function() { map.invalidateSize(); }, 100);
    }

    var lat = data.latitude;
    var lng = data.longitude;
    var acc = data.accuracy;

    if (accuracyEl) accuracyEl.textContent = Math.round(acc);

    if (lat && lng) {
        var latLng = [lat, lng];
        
        // Se non c'è marker, crealo
        if (!mapMarker) {
            // Icona personalizzata verde
            var greenIcon = new L.Icon({
                iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
                shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
                iconSize: [25, 41],
                iconAnchor: [12, 41],
                popupAnchor: [1, -34],
                shadowSize: [41, 41]
            });

            mapMarker = L.marker(latLng, {icon: greenIcon}).addTo(map);
            map.setView(latLng, 18); // Zoom molto alto al primo fix
        } else {
            // Aggiorna posizione
            mapMarker.setLatLng(latLng);
            
            // Auto-center solo se l'utente non sta trascinando la mappa (opzionale, qui lo forziamo per tracking)
            // map.panTo(latLng); 
        }
    }
}

function fetchInitialData() {
    fetch('/api/sensors')
        .then(function(response) { return response.json(); })
        .then(function(data) {
            sensors = data.sensors || {};
            renderSensors();
            
            // Carica dati iniziali profilo/gps se già presenti
            if (data.profile) updateProfileUI(data.profile);
            if (data.gps) updateMap(data.gps);
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
        var valueElements = {};
        card.querySelectorAll('.sensor-data-row').forEach(function(row) {
            var label = row.querySelector('.sensor-data-label');
            var value = row.querySelector('.sensor-value');
            if (label && value) {
                valueElements[label.textContent.replace(':', '').trim()] = value;
            }
        });
        domCache[cacheKey] = {
            card: card,
            timestamp: card.querySelector('.sensor-timestamp'),
            status: card.querySelector('.status-indicator'),
            valueElements: valueElements,
            lastData: {}
        };
    }
    var cached = domCache[cacheKey];
    Object.keys(data).forEach(function(key) {
        if (key === 'timestamp' || key === 'sensor_name') return;
        var newValue = Math.round(data[key]);
        var oldValue = cached.lastData[key];
        if (newValue !== oldValue) {
            var element = cached.valueElements[key];
            if (element) {
                element.textContent = newValue;
                if (key.startsWith('pressure_')) {
                    var colorClass = 'low';
                    if (newValue > 5000) colorClass = 'high';
                    else if (newValue > 1000) colorClass = 'medium';
                    element.className = 'sensor-value ' + colorClass;
                }
            }
            cached.lastData[key] = newValue;
        }
    });

    if (cached.timestamp && data.timestamp) {
        var date = new Date(data.timestamp);
        var timeStr = String(date.getHours()).padStart(2, '0') + ':' +
                      String(date.getMinutes()).padStart(2, '0') + ':' +
                      String(date.getSeconds()).padStart(2, '0');
        if (cached.timestamp.textContent !== timeStr) {
            cached.timestamp.textContent = timeStr;
        }
    }

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

    var imuKeys = [];
    var pressureKeys = [];

    Object.keys(data).forEach(function(key) {
        if (key === 'timestamp' || key === 'sensor_name') return;
        if (key.startsWith('accel_') || key.startsWith('gyro_') || key.startsWith('mag_')) {
            imuKeys.push(key);
        } else if (key === 'pressure_0' || key === 'pressure_1' || key === 'pressure_2') {
            pressureKeys.push(key);
        }
    });

    var html = '<div class="sensor-header">' +
                '<div>' + emoji + ' ' + sensorName + '</div>' +
                '<div class="status-indicator active"></div>' +
               '</div><div class="sensor-fields">';

    if (imuKeys.length > 0) {
        html += '<div class="sensor-data-section">' +
                '<div class="sensor-data-section-title">📊 IMU Data</div>';
        imuKeys.forEach(function(key) {
            html += '<div class="sensor-data-row">' +
                    '<span class="sensor-data-label">' + key + ':</span>' +
                    '<span class="sensor-value">0</span></div>';
        });
        html += '</div>';
    }
    if (pressureKeys.length > 0) {
        html += '<div class="sensor-data-section">' +
                '<div class="sensor-data-section-title">⬇️ Pressioni (S0-S2)</div>';
        pressureKeys.sort().forEach(function(key) {
            html += '<div class="sensor-data-row">' +
                    '<span class="sensor-data-label">' + key + ':</span>' +
                    '<span class="sensor-value low">0</span></div>';
        });
        html += '</div>';
    }
    html += '</div><span class="sensor-timestamp">--:--:--</span>';
    template.innerHTML = html;
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
    pendingUpdates = {};

    if (sensorNames.length === 0) {
        grid.style.display = 'none';
        emptyState.classList.add('visible');
        var chartsContainer = document.getElementById('charts-container');
        if (chartsContainer) chartsContainer.style.display = 'none';
        return;
    }

    sensorNames.forEach(function(name) {
        createSensorCardDynamic(name, sensors[name]);
    });

    grid.style.display = 'grid';
    emptyState.classList.remove('visible');
    updateConnectionStatus(isConnected);
    updateSensorSelector();
}

function updateConnectionStatus(connected) {
    var statusEl = document.getElementById('connection-status');
    var countEl = document.getElementById('sensor-count');
    if (statusEl) {
        statusEl.className = connected ? '' : 'disconnected';
        statusEl.innerHTML = '<span class="dot"></span> ' + (connected ? 'Connesso' : 'Disconnesso');
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
    if (!confirm('Pulire tutti i dati?')) return;
    fetch('/api/clear', { method: 'POST' })
        .then(function() {
            sensors = {};
            domCache = {};
            pendingUpdates = {};
            renderSensors();
            resetChartData();
        });
}

// ======================= GRAFICI (uPlot) =======================
// (Il codice dei grafici rimane identico al tuo precedente, lo ometto per brevità 
// ma nel file finale DEVE esserci tutto il blocco uPlot che hai già)
// Assicurati di copiare anche tutte le funzioni dei grafici (initCharts, updateCharts, etc.)
// che erano nel file precedente.
// ... (INCOLLA QUI IL RESTO DEL CODICE uPlot DAL TUO FILE ORIGINALE) ...
// Per completezza, incollo qui sotto le funzioni grafici necessarie
function wheelZoomPlugin(opts) {
    var factor = opts.factor || 0.75;
    function init(u, opts, data) {
        var over = u.over;
        var rect, xVal;
        var isDragging = false;
        var dragStartX = null;
        var dragStartScale = null;
        over.addEventListener("wheel", function(e) {
            e.preventDefault();
            var xData = u.data[0];
            if (!xData || xData.length < 2) return;
            var dataMin = xData[0];
            var dataMax = xData[xData.length - 1];
            rect = over.getBoundingClientRect();
            xVal = u.posToVal(e.clientX - rect.left, 'x');
            var left = u.scales.x.min;
            var right = u.scales.x.max;
            var range = right - left;
            var pct = xVal == null ? 0.5 : (xVal - left) / range;
            var nRange = e.deltaY < 0 ? range * factor : range / factor;
            if (nRange < MIN_ZOOM_RANGE) nRange = MIN_ZOOM_RANGE;
            var nLeft = xVal - pct * nRange;
            var nRight = nLeft + nRange;
            if (nRange > range) {
                if (nLeft < dataMin) { nLeft = dataMin; nRight = nLeft + nRange; }
                if (nRight > dataMax) { nRight = dataMax; nLeft = nRight - nRange; if (nLeft < dataMin) nLeft = dataMin; }
            }
            u.batch(function() { u.setScale('x', { min: nLeft, max: nRight }); });
        });
        over.addEventListener("mousedown", function(e) {
            if (e.button !== 0) return;
            e.preventDefault();
            isDragging = true;
            dragStartX = e.clientX;
            dragStartScale = { min: u.scales.x.min, max: u.scales.x.max };
            over.style.cursor = "grabbing";
        });
        over.addEventListener("mousemove", function(e) {
            if (!isDragging) return;
            e.preventDefault();
            var currentX = e.clientX;
            var dx = dragStartX - currentX;
            var scaleRange = dragStartScale.max - dragStartScale.min;
            var shift = (dx / u.bbox.width) * scaleRange;
            var nMin = dragStartScale.min + shift;
            var nMax = dragStartScale.max + shift;
            var xData = u.data[0];
            if (xData && xData.length > 0) {
                var dataMin = xData[0];
                var dataMax = xData[xData.length - 1];
                if (nMin < dataMin) { nMin = dataMin; nMax = nMin + scaleRange; }
                if (nMax > dataMax) { nMax = dataMax; nMin = nMax - scaleRange; }
            }
            u.setScale("x", { min: nMin, max: nMax });
        });
        document.addEventListener("mouseup", function(e) {
            if (isDragging) { isDragging = false; dragStartX = null; dragStartScale = null; over.style.cursor = "default"; }
        });
        over.addEventListener("dblclick", function(e) {
            var xData = u.data[0];
            if (!xData || xData.length === 0) return;
            u.setScale('x', { min: xData[0], max: xData[xData.length - 1] });
            isUserInteracting = false; 
        });
    }
    return { hooks: { init: init } };
}

function getBaseOpts(width, height) {
    return {
        width: width, height: height,
        cursor: { show: true, drag: { x: true, y: false } },
        legend: { show: true, live: true },
        scales: { x: { time: true }, y: { auto: true } },
        select: {show: false},
        axes: [
            { stroke: '#97c93e', grid: { stroke: '#333', width: 1 }, values: function(u, ticks) { return ticks.map(function(v) { var d = new Date(v * 1000); return d.toLocaleTimeString('it-IT', { hour12: false }); }); } },
            { stroke: '#97c93e', grid: { stroke: '#333', width: 1 }, size: 50 }
        ],
        plugins: [wheelZoomPlugin({ factor: 0.75 })]
    };
}

function initCharts() {
    var accelDiv = document.getElementById('accel-chart');
    var gyroDiv = document.getElementById('gyro-chart');
    var magDiv = document.getElementById('mag-chart');
    var pressureDiv = document.getElementById('pressure-chart');
    if (!accelDiv || !gyroDiv || !magDiv || !pressureDiv) return;
    if (charts.accel) { accelDiv.innerHTML = ''; charts.accel = null; }
    if (charts.gyro) { gyroDiv.innerHTML = ''; charts.gyro = null; }
    if (charts.mag) { magDiv.innerHTML = ''; charts.mag = null; }
    if (charts.pressure) { pressureDiv.innerHTML = ''; charts.pressure = null; }
    document.getElementById('pressure-chart-container').style.display = 'block';
    pressureDiv.style.minWidth = '400px';
    pressureDiv.style.minHeight = '250px';
    var accelOpts = getBaseOpts(accelDiv.offsetWidth, 200);
    accelOpts.series = [{ show: false }, { label: 'X', stroke: '#ff6384', width: 2 }, { label: 'Y', stroke: '#36a2eb', width: 2 }, { label: 'Z', stroke: '#4bc0c0', width: 2 }];
    charts.accel = new uPlot(accelOpts, chartData.accel, accelDiv);
    addInteractionListeners(charts.accel);
    var gyroOpts = getBaseOpts(gyroDiv.offsetWidth, 200);
    gyroOpts.series = [{ show: false }, { label: 'X', stroke: '#ff9f40', width: 2 }, { label: 'Y', stroke: '#9966ff', width: 2 }, { label: 'Z', stroke: '#ffcd56', width: 2 }];
    charts.gyro = new uPlot(gyroOpts, chartData.gyro, gyroDiv);
    addInteractionListeners(charts.gyro);
    var magOpts = getBaseOpts(magDiv.offsetWidth, 200);
    magOpts.series = [{ show: false }, { label: 'X', stroke: '#c9cbcf', width: 2 }, { label: 'Y', stroke: '#4bc0c0', width: 2 }, { label: 'Z', stroke: '#ff6384', width: 2 }];
    charts.mag = new uPlot(magOpts, chartData.mag, magDiv);
    addInteractionListeners(charts.mag);
    var pressureOpts = {
        width: Math.max(pressureDiv.offsetWidth, 400), height: 250,
        cursor: { show: true, drag: { x: true, y: false } }, select: { show: false }, legend: { show: true, live: true },
        scales: { x: { time: true }, y: { auto: false, range: [0, 1024] } },
        axes: [
            { stroke: '#97c93e', grid: { stroke: '#333', width: 1 }, values: function(u, ticks) { return ticks.map(function(v) { var d = new Date(v * 1000); return d.toLocaleTimeString('it-IT', { hour12: false }); }); } },
            { stroke: '#97c93e', grid: { stroke: '#333', width: 1 }, size: 50 }
        ],
        series: [{}, { label: 'S0', stroke: '#ff6384', width: 3 }, { label: 'S1', stroke: '#36a2eb', width: 3 }, { label: 'S2', stroke: '#ffce56', width: 3 }],
        plugins: [wheelZoomPlugin({ factor: 0.75 })]
    };
    var now = Date.now() / 1000;
    var initData = [[now - 1, now], [0, 0], [0, 0], [0, 0]];
    if(chartData.pressure[0].length > 0) initData = chartData.pressure;
    charts.pressure = new uPlot(pressureOpts, initData, pressureDiv);
    addInteractionListeners(charts.pressure);
    fixLegendMarkerColors();
}

function fixLegendMarkerColors() {
    setTimeout(function() {
        [charts.accel, charts.gyro, charts.mag, charts.pressure].forEach(function(chart) {
            if (!chart) return;
            var legend = chart.root.querySelector('.u-legend');
            if (!legend) return;
            var seriesElements = legend.querySelectorAll('.u-series');
            function updateColors() {
                seriesElements.forEach(function(seriesEl, idx) {
                    if (idx === 0) return;
                    var marker = seriesEl.querySelector('.u-marker');
                    if (!marker) return;
                    var seriesConfig = chart.series[idx];
                    if (seriesConfig && seriesConfig.stroke) {
                        var isOff = seriesEl.classList.contains('u-off');
                        if (isOff) { marker.style.backgroundColor = 'transparent'; marker.style.borderColor = '#666'; marker.style.color = '#666'; } 
                        else { marker.style.backgroundColor = seriesConfig.stroke; marker.style.borderColor = seriesConfig.stroke; marker.style.color = seriesConfig.stroke; }
                    }
                });
            }
            updateColors();
            var observer = new MutationObserver(updateColors);
            observer.observe(legend, { attributes: true, subtree: true, attributeFilter: ['class'] });
        });
    }, 300);
}

function addInteractionListeners(u) {
    var over = u.over;
    over.addEventListener('mousedown', function() { isUserInteracting = true; });
    over.addEventListener('wheel', function() { isUserInteracting = true; });
}

function updateCharts(sensorName, data) {
    if (selectedSensor !== sensorName || !chartsInitialized) return;
    var timestamp = Date.now() / 1000;
    function pushData(targetArr, keys) {
        targetArr[0].push(timestamp);
        keys.forEach((k, i) => { targetArr[i + 1].push(data[k] !== undefined ? data[k] : 0); });
    }
    if (data.accel_x !== undefined) { pushData(chartData.accel, ['accel_x', 'accel_y', 'accel_z']); charts.accel.setData(chartData.accel); autoScroll(charts.accel, chartData.accel); }
    if (data.gyro_x !== undefined) { pushData(chartData.gyro, ['gyro_x', 'gyro_y', 'gyro_z']); charts.gyro.setData(chartData.gyro); autoScroll(charts.gyro, chartData.gyro); }
    if (data.mag_x !== undefined) { pushData(chartData.mag, ['mag_x', 'mag_y', 'mag_z']); charts.mag.setData(chartData.mag); autoScroll(charts.mag, chartData.mag); }
    if (data.pressure_0 !== undefined) { pushData(chartData.pressure, ['pressure_0', 'pressure_1', 'pressure_2']); charts.pressure.setData(chartData.pressure); autoScroll(charts.pressure, chartData.pressure); document.getElementById('pressure-chart-container').style.display = 'block'; } 
    else { document.getElementById('pressure-chart-container').style.display = 'none'; }
}

function autoScroll(u, data) {
    if (!isUserInteracting) {
        var xData = data[0];
        var lastTime = xData[xData.length - 1];
        var windowSize = 10;
        var minX = lastTime - windowSize;
        if (xData[0] > minX) minX = xData[0];
        u.setScale('x', { min: minX, max: lastTime });
    }
}

function updateSensorSelector() {
    var select = document.getElementById('chart-sensor-select');
    if (!select) return;
    select.innerHTML = '<option value="">-- Seleziona sensore --</option>';
    Object.keys(sensors).forEach(function(name) {
        var option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
    });
    var chartsContainer = document.getElementById('charts-container');
    if (chartsContainer) {
        chartsContainer.style.display = Object.keys(sensors).length > 0 ? 'block' : 'none';
    }
}

function resetChartData() {
    isUserInteracting = false;
    if (!chartsInitialized) return;
    chartData = { accel: [[], [], [], []], gyro: [[], [], [], []], mag: [[], [], [], []], pressure: [[], [], [], []] };
    if (charts.accel) charts.accel.setData(chartData.accel);
    if (charts.gyro) charts.gyro.setData(chartData.gyro);
    if (charts.mag) charts.mag.setData(chartData.mag);
    if (charts.pressure) charts.pressure.setData(chartData.pressure);
}

function calibrateKnee() { alert('Funzione calibrazione ginocchio non ancora implementata'); }
