// ==========================================
// CONFIGURAZIONE GLOBALE
// ==========================================
var socket = io({ 
    transports: ['websocket'], 
    reconnection: true, 
    reconnectionDelay: 500 
});

var sensors = {};
var map = null;
var mapMarker = null;
var isMapInitialized = false;

var charts = { accel: null, gyro: null, mag: null, pressure: null };
var chartData = { 
    accel: [[],[],[],[]], 
    gyro: [[],[],[],[]], 
    mag: [[],[],[],[]], 
    pressure: [[],[],[],[]] 
};
var selectedSensor = null;
var chartsInitialized = false;
var isUserInteracting = false; 
var MIN_ZOOM_RANGE = 0.5;

// ==========================================
// INIZIALIZZAZIONE
// ==========================================
document.addEventListener('DOMContentLoaded', function() {
    initSocket();
    
    var sel = document.getElementById('chart-sensor-select');
    if(sel) {
        sel.addEventListener('change', function(e) {
            selectedSensor = e.target.value || null;
            resetChartData();
            var container = document.getElementById('charts-container');
            if (selectedSensor) {
                container.style.display = 'block';
                if(!chartsInitialized) {
                    initCharts();
                    chartsInitialized = true;
                }
            } else {
                container.style.display = 'none';
            }
        });
    }
});

function initSocket() {
    socket.on('connect', () => {
        var el = document.getElementById('connection-status');
        if(el) { el.className = ''; el.innerHTML = '<span class="dot"></span> Connesso'; }
    });
    
    socket.on('disconnect', () => {
        var el = document.getElementById('connection-status');
        if(el) { el.className = 'disconnected'; el.innerHTML = '<span class="dot"></span> Disconnesso'; }
    });

    // ASCOLTO UNICO: Gestisce sia log sporchi (BPM) che dati puliti (Sensori)
    socket.on('sensor_update', (data) => processIncomingData(data));
    socket.on('bpm_update', (data) => processIncomingData(data));

    socket.on('profile_update', (data) => updateProfileUI(data));
    socket.on('gps_update', (data) => updateMapUI(data));

    socket.on('data_cleared', () => {
        sensors = {};
        document.getElementById('sensors-grid').innerHTML = '';
        var empty = document.getElementById('empty-state');
        if(empty) empty.style.display = 'block';
        
        var selCont = document.getElementById('selector-container');
        if(selCont) selCont.style.display = 'none';
        
        var chartsCont = document.getElementById('charts-container');
        if(chartsCont) chartsCont.style.display = 'none';
        
        var profile = document.getElementById('user-profile-display');
        if(profile) profile.style.display = 'none';
        
        var bpm = document.getElementById('bpm-display');
        if(bpm) bpm.style.display = 'none';
        
        if(mapMarker) { map.removeLayer(mapMarker); mapMarker = null; }
        var mapSec = document.getElementById('map-section');
        if(mapSec) mapSec.style.display = 'none';
        
        resetChartData();
        chartsInitialized = false;
        selectedSensor = null;
    });
}

// ==========================================
// PARSING DEI DATI (ROBUSTO)
// ==========================================
function processIncomingData(data) {
    // 1. GESTIONE BPM DA LOG SPORCO (*** Telemetry line...)
    // Convertiamo sempre a stringa per cercare "bpm": 123 col regex, anche se è un oggetto.
    // Questo è sicuro e non rompe nulla.
    var str = (typeof data === 'object') ? JSON.stringify(data) : String(data);
    var bpmMatch = str.match(/"bpm"\s*:\s*(\d+)/);
    
    if (bpmMatch && bpmMatch[1]) {
        var val = parseInt(bpmMatch[1]);
        if (!isNaN(val) && val > 0) {
            updateBpmUI(val);
            // Se abbiamo trovato il BPM, non facciamo nient'altro con questo pacchetto
            // per evitare di sporcare i grafici o creare card sensori false.
            return;
        }
    }

    // 2. GESTIONE SENSORI (Dati puliti)
    // Se siamo qui, NON è un pacchetto BPM. Proviamo a trattarlo come sensore normale.
    var payload = null;

    if (typeof data === 'object') {
        // Se è già un oggetto (WS diretto o JSON pulito dal server)
        payload = data.data || data;
    } else {
        // Se è una stringa (log sporco), proviamo a estrarre il JSON pulito
        var jsonStart = str.indexOf('{');
        var jsonEnd = str.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd > jsonStart) {
            try {
                payload = JSON.parse(str.substring(jsonStart, jsonEnd + 1));
            } catch (e) {}
        }
    }

    // Se abbiamo estratto un payload valido e ha un nome, aggiorniamo UI
    if (payload && payload.sensor_name) {
        var name = payload.sensor_name;
        
        // Ignoriamo sensori che si chiamano "COOSPO" o simili se non siamo riusciti a estrarre il BPM sopra
        if (name.includes("COOSPO") || name === "HRM") return;

        // Se è profilo
        if (name === 'PROFILE_INFO') {
            updateProfileUI(payload);
            return;
        }

        // Altrimenti è sensore vero (Ginocchio, Calzino...)
        sensors[name] = payload;
        updateSensorCardUI(name, payload);
        updateChartsUI(name, payload);
    }
}


// ==========================================
// UI: GRIGLIA SENSORI
// ==========================================
function renderSensorsGrid() {
    var grid = document.getElementById('sensors-grid');
    grid.innerHTML = '';
    
    var keys = Object.keys(sensors);
    var empty = document.getElementById('empty-state');
    
    if (keys.length === 0) {
        if(empty) empty.style.display = 'block';
        return;
    }
    if(empty) empty.style.display = 'none';

    keys.forEach(name => {
        createSensorCard(name, sensors[name]);
    });
    updateSelector();
}

function createSensorCard(name, data) {
    if (data.accel_x === undefined && data.pressure_0 === undefined) return;

    var grid = document.getElementById('sensors-grid');
    var existing = document.querySelector(`[data-sensor="${name}"]`);
    if(existing) return; 

    var div = document.createElement('div');
    div.className = 'sensor-card sensor-col connected'; 
    div.setAttribute('data-sensor', name);
    
    var emoji = '📱';
    var n = name.toLowerCase();
    if(n.includes('knee') || n.includes('ginocchio')) emoji = '🦿';
    if(n.includes('foot') || n.includes('sock') || n.includes('calzino')) emoji = '🧦';

    var html = `<div class="sensor-header">
                    <span>${emoji} ${name}</span>
                    <div class="status-indicator active"></div>
                </div>`;
    
    if (data.accel_x !== undefined) {
        html += `<div class="sensor-data-section">
                    <div class="sensor-data-section-title">Accelerometro</div>
                    <div class="sensor-data-row"><span class="sensor-data-label">AX</span> <span class="sensor-value" data-key="accel_x">0</span></div>
                    <div class="sensor-data-row"><span class="sensor-data-label">AY</span> <span class="sensor-value" data-key="accel_y">0</span></div>
                    <div class="sensor-data-row"><span class="sensor-data-label">AZ</span> <span class="sensor-value" data-key="accel_z">0</span></div>
                 </div>`;
    }

    if (data.gyro_x !== undefined) {
        html += `<div class="sensor-data-section">
                    <div class="sensor-data-section-title">Giroscopio</div>
                    <div class="sensor-data-row"><span class="sensor-data-label">GX</span> <span class="sensor-value" data-key="gyro_x">0</span></div>
                    <div class="sensor-data-row"><span class="sensor-data-label">GY</span> <span class="sensor-value" data-key="gyro_y">0</span></div>
                    <div class="sensor-data-row"><span class="sensor-data-label">GZ</span> <span class="sensor-value" data-key="gyro_z">0</span></div>
                 </div>`;
    }

    if (data.mag_x !== undefined) {
        html += `<div class="sensor-data-section">
                    <div class="sensor-data-section-title">Magnetometro</div>
                    <div class="sensor-data-row"><span class="sensor-data-label">MX</span> <span class="sensor-value" data-key="mag_x">0</span></div>
                    <div class="sensor-data-row"><span class="sensor-data-label">MY</span> <span class="sensor-value" data-key="mag_y">0</span></div>
                    <div class="sensor-data-row"><span class="sensor-data-label">MZ</span> <span class="sensor-value" data-key="mag_z">0</span></div>
                 </div>`;
    }

    if (data.pressure_0 !== undefined) {
         html += `<div class="sensor-data-section" style="border:none;">
                    <div class="sensor-data-section-title">Pressioni</div>
                    <div class="sensor-data-row"><span class="sensor-data-label">P0</span> <span class="sensor-value" style="color:#ffce56;" data-key="pressure_0">0</span></div>
                    <div class="sensor-data-row"><span class="sensor-data-label">P1</span> <span class="sensor-value" style="color:#ffce56;" data-key="pressure_1">0</span></div>
                    <div class="sensor-data-row"><span class="sensor-data-label">P2</span> <span class="sensor-value" style="color:#ffce56;" data-key="pressure_2">0</span></div>
                 </div>`;
    }

    div.innerHTML = html;
    grid.appendChild(div);
}

function updateSensorCardUI(name, data) {
    var card = document.querySelector(`[data-sensor="${name}"]`);
    if (!card) { createSensorCard(name, data); updateSelector(); return; }
    
    Object.keys(data).forEach(k => {
        var el = card.querySelector(`[data-key="${k}"]`);
        if (el) el.textContent = Math.round(data[k]);
    });
}

function updateSelector() {
    var sel = document.getElementById('chart-sensor-select');
    var container = document.getElementById('selector-container');
    if (!sel || !container) return;
    
    var current = sel.value; 
    var names = Object.keys(sensors);
    var savedSelection = current;
    
    sel.innerHTML = '<option value="">-- Seleziona sensore --</option>';
    names.forEach(n => {
        var opt = document.createElement('option');
        opt.value = n; opt.textContent = n;
        sel.appendChild(opt);
    });
    
    if (names.length === 0) {
        container.style.display = 'none';
        return;
    }

    container.style.display = 'block';

    if (savedSelection && sensors[savedSelection]) {
        sel.value = savedSelection;
    } else if (!selectedSensor && names.length > 0) {
        sel.value = names[0];
        var event = new Event('change');
        sel.dispatchEvent(event);
    }
}

// ==========================================
// UI: PROFILO, BPM, MAPPA
// ==========================================
function updateProfileUI(data) {
    var div = document.getElementById('user-profile-display');
    if (!data.name || !div) return;
    div.style.display = 'flex';
    document.getElementById('profile-name').textContent = data.name.toUpperCase();
    document.getElementById('profile-avatar').textContent = data.avatar || "👤";
    var gender = data.gender === 'M' ? '♂' : (data.gender === 'F' ? '♀' : '');
    document.getElementById('profile-details').textContent = `${data.age} anni | ${data.weight} kg | ${gender}`;
}

function updateBpmUI(val) {
    var div = document.getElementById('bpm-display');
    var mapSection = document.getElementById('map-section');
    
    val = parseInt(val);

    if (val > 0) {
        if (mapSection && mapSection.style.display === 'none') {
            mapSection.style.display = 'block';
            if(!isMapInitialized) initMap();
        }
        
        if(div) {
            div.style.display = 'flex';
            document.getElementById('bpm-value').textContent = val;
            var icon = div.querySelector('.heart-icon');
            if (icon) {
                var d = 60/val; 
                if(d<0.3) d=0.3; 
                icon.style.animationDuration = d+'s';
            }
        }
    }
}

function initMap() {
    if (isMapInitialized) return;
    map = L.map('map').setView([41.9028, 12.4964], 5);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { 
        attribution: '© OpenStreetMap, © CartoDB',
        maxZoom: 20 
    }).addTo(map);
    isMapInitialized = true;
    setTimeout(() => map.invalidateSize(), 100);
}

function updateMapUI(data) {
    var section = document.getElementById('map-section');
    if(section) section.style.display = 'block';

    if (!isMapInitialized) {
        map = L.map('map').setView([data.latitude, data.longitude], 15);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '© OpenStreetMap, © CartoDB',
            maxZoom: 20
        }).addTo(map);
        isMapInitialized = true;
        setTimeout(() => map.invalidateSize(), 100);
    }

    var latlng = [data.latitude, data.longitude];
    var accEl = document.getElementById('gps-accuracy');
    if(accEl) accEl.textContent = Math.round(data.accuracy);

    if (!mapMarker) {
        var greenIcon = new L.Icon({
            iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
            shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
            iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
        });
        mapMarker = L.marker(latlng, {icon: greenIcon}).addTo(map);
        map.panTo(latlng);
    } else {
        mapMarker.setLatLng(latlng);
    }
}

// ==========================================
// LOGICA GRAFICI (uPlot)
// ==========================================
function updateChartsUI(sensorName, data) {
    if (selectedSensor !== sensorName || !chartsInitialized) return;

    var timestamp = Date.now() / 1000;
    
    var cCont = document.getElementById('charts-container');
    if(cCont && cCont.style.display === 'none') cCont.style.display = 'block';

    const push = (arr, vals) => {
        arr[0].push(timestamp);
        vals.forEach((v, i) => arr[i+1].push(v || 0));
        if(arr[0].length > 1000) arr.forEach(s => s.shift());
    };

    if (data.accel_x !== undefined && charts.accel) {
        push(chartData.accel, [data.accel_x, data.accel_y, data.accel_z]);
        charts.accel.setData(chartData.accel);
        autoScroll(charts.accel, chartData.accel);
    }

    if (data.gyro_x !== undefined && charts.gyro) {
        push(chartData.gyro, [data.gyro_x, data.gyro_y, data.gyro_z]);
        charts.gyro.setData(chartData.gyro);
        autoScroll(charts.gyro, chartData.gyro);
    }

    if (data.mag_x !== undefined && charts.mag) {
        push(chartData.mag, [data.mag_x, data.mag_y, data.mag_z]);
        charts.mag.setData(chartData.mag);
        autoScroll(charts.mag, chartData.mag);
    }

    if (data.pressure_0 !== undefined && charts.pressure) {
        push(chartData.pressure, [data.pressure_0, data.pressure_1, data.pressure_2]);
        charts.pressure.setData(chartData.pressure);
        autoScroll(charts.pressure, chartData.pressure);
        document.getElementById('pressure-chart-container').style.display = 'block';
    } else {
        document.getElementById('pressure-chart-container').style.display = 'none';
    }
}

function autoScroll(u, data) {
    if (!isUserInteracting) {
        var xData = data[0];
        if (xData.length < 2) return;
        var lastTime = xData[xData.length - 1];
        var windowSize = 10; 
        var minX = lastTime - windowSize;
        if (xData[0] > minX) minX = xData[0];
        
        u.setScale('x', { min: minX, max: lastTime });
    }
}

function resetChartData() {
    isUserInteracting = false;
    chartData = { 
        accel: [[],[],[],[]], 
        gyro: [[],[],[],[]], 
        mag: [[],[],[],[]], 
        pressure: [[],[],[],[]] 
    };
    
    if(!chartsInitialized) return;
    if(charts.accel) charts.accel.setData(chartData.accel);
    if(charts.gyro) charts.gyro.setData(chartData.gyro);
    if(charts.mag) charts.mag.setData(chartData.mag);
    if(charts.pressure) charts.pressure.setData(chartData.pressure);
}

function initCharts() {
    var accelDiv = document.getElementById('accel-chart');
    var gyroDiv = document.getElementById('gyro-chart');
    var magDiv = document.getElementById('mag-chart');
    var pressureDiv = document.getElementById('pressure-chart');

    if (!accelDiv || !gyroDiv || !magDiv || !pressureDiv) return;
    
    accelDiv.innerHTML = ''; gyroDiv.innerHTML = ''; magDiv.innerHTML = ''; pressureDiv.innerHTML = '';

    var commonOpts = () => ({
        width: accelDiv.offsetWidth, height: 200,
        cursor: { show: true, drag: { x: true, y: false } },
        scales: { x: { time: true }, y: { auto: true } },
        axes: [
            { stroke: '#97c93e', grid: { stroke: '#333' }, values: (u, vals) => vals.map(v => new Date(v*1000).toLocaleTimeString()) },
            { stroke: '#97c93e', grid: { stroke: '#333' }, size: 50 }
        ],
        plugins: [wheelZoomPlugin()]
    });

    var opts1 = commonOpts();
    opts1.series = [{}, {label:'X', stroke:'#ff6384', width:2}, {label:'Y', stroke:'#36a2eb', width:2}, {label:'Z', stroke:'#4bc0c0', width:2}];
    charts.accel = new uPlot(opts1, chartData.accel, accelDiv);
    addInteraction(charts.accel);

    var opts2 = commonOpts();
    opts2.series = [{}, {label:'X', stroke:'#ff9f40', width:2}, {label:'Y', stroke:'#9966ff', width:2}, {label:'Z', stroke:'#ffcd56', width:2}];
    charts.gyro = new uPlot(opts2, chartData.gyro, gyroDiv);
    addInteraction(charts.gyro);

    var opts3 = commonOpts();
    opts3.series = [{}, {label:'X', stroke:'#c9cbcf', width:2}, {label:'Y', stroke:'#4bc0c0', width:2}, {label:'Z', stroke:'#ff6384', width:2}];
    charts.mag = new uPlot(opts3, chartData.mag, magDiv);
    addInteraction(charts.mag);

    var opts4 = commonOpts();
    opts4.height = 250;
    opts4.scales.y = { auto: false, range: [0, 1024] };
    opts4.series = [{}, {label:'P0', stroke:'#ff6384', width:3}, {label:'P1', stroke:'#36a2eb', width:3}, {label:'P2', stroke:'#ffce56', width:3}];
    charts.pressure = new uPlot(opts4, chartData.pressure, pressureDiv);
    addInteraction(charts.pressure);
}

function wheelZoomPlugin() {
    return {
        hooks: {
            init: (u) => {
                u.over.addEventListener("wheel", e => {
                    e.preventDefault();
                    var {min, max} = u.scales.x;
                    var range = max - min;
                    var factor = e.deltaY < 0 ? 0.9 : 1.1;
                    var newRange = range * factor;
                    if(newRange < MIN_ZOOM_RANGE) newRange = MIN_ZOOM_RANGE;
                    var center = min + range/2;
                    u.setScale('x', {min: center - newRange/2, max: center + newRange/2});
                });
                u.over.addEventListener("dblclick", () => {
                    isUserInteracting = false; 
                });
            }
        }
    };
}

function addInteraction(u) {
    u.over.addEventListener('mousedown', () => isUserInteracting = true);
    u.over.addEventListener('wheel', () => isUserInteracting = true);
}

function clearAllData() { if(confirm('Pulire tutto?')) fetch('/api/clear', {method:'POST'}); }
