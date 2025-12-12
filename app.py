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

// ==========================================
// SOCKET.IO
// ==========================================
function initSocket() {
    socket.on('connect', () => {
        var el = document.getElementById('connection-status');
        if(el) el.innerHTML = '<span class="dot"></span> Connesso';
    });
    
    socket.on('disconnect', () => {
        var el = document.getElementById('connection-status');
        if(el) el.innerHTML = '<span class="dot"></span> Disconnesso';
    });

    // SENSORI
    socket.on('sensor_update', (data) => processIncomingData(data));

    // BPM
    socket.on('bpm_update', (data) => {
        let val = null;
        if (typeof data === 'number') val = data;
        else if (typeof data === 'object') {
            if (data.bpm !== undefined) val = data.bpm;
            else if (data.heart_rate !== undefined) val = data.heart_rate;
        }
        if (val !== null && !isNaN(val) && val > 0) {
            updateBpmUI(val);
        }
    });

    // PROFILO
    socket.on('profile_update', (data) => updateProfileUI(data));

    // GPS
    socket.on('gps_update', (data) => updateMapUI(data));

    // RESET
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
// PARSING SENSORI
// ==========================================
function processIncomingData(data) {
    var payload = (typeof data === 'object') ? data.data || data : null;

    if (!payload || !payload.sensor_name) return;

    var name = payload.sensor_name;

    if (name === 'PROFILE_INFO') {
        updateProfileUI(payload);
        return;
    }

    // Ignora COOSPO se non serve
    if (name.includes("COOSPO") || name === "HRM") return;

    sensors[name] = payload;
    updateSensorCardUI(name, payload);
    updateChartsUI(name, payload);
}

// ==========================================
// UI: SENSORI
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

    keys.forEach(name => createSensorCard(name, sensors[name]));
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

    if (data.pressure_0 !== undefined) {
        html += `<div class="sensor-data-section" style="border:none;">
                    <div class="sensor-data-section-title">Pressioni</div>
                    <div class="sensor-data-row"><span class="sensor-data-label">P0</span> <span class="sensor-value" data-key="pressure_0">0</span></div>
                    <div class="sensor-data-row"><span class="sensor-data-label">P1</span> <span class="sensor-value" data-key="pressure_1">0</span></div>
                    <div class="sensor-data-row"><span class="sensor-data-label">P2</span> <span class="sensor-value" data-key="pressure_2">0</span></div>
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

// ==========================================
// UI: MAPPA
// ==========================================
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
// GRAFICI (uPlot)
// ==========================================
function updateChartsUI(sensorName, data) {
    if (selectedSensor !== sensorName || !chartsInitialized) return;

    var timestamp = Date.now() / 1000;
    
    const push = (arr, vals) => {
        arr[0].push(timestamp);
        vals.forEach((v, i) => arr[i+1].push(v || 0));
        if(arr[0].length > 1000) arr.forEach(s => s.shift());
    };

    if (data.accel_x !== undefined && charts.accel) push(chartData.accel, [data.accel_x, data.accel_y, data.accel_z]), charts.accel.setData(chartData.accel), autoScroll(charts.accel, chartData.accel);
    if (data.gyro_x !== undefined && charts.gyro) push(chartData.gyro, [data.gyro_x, data.gyro_y, data.gyro_z]), charts.gyro.setData(chartData.gyro), autoScroll(charts.gyro, chartData.gyro);
    if (data.mag_x !== undefined && charts.mag) push(chartData.mag, [data.mag_x, data.mag_y, data.mag_z]), charts.mag.setData(chartData.mag), autoScroll(charts.mag, chartData.mag);
    if (data.pressure_0 !== undefined && charts.pressure) push(chartData.pressure, [data.pressure_0, data.pressure_1, data.pressure_2]), charts.pressure.setData(chartData.pressure), document.getElementById('pressure-chart-container').style.display='block';
    else document.getElementById('pressure-chart-container').style.display='none';
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
    chartData = { accel: [[],[],[],[]], gyro: [[],[],[],[]], mag: [[],[],[],[]], pressure: [[],[],[],[]] };
    if(!chartsInitialized) return;
    Object.values(charts).forEach(c => { if(c) c.setData(chartData[c === charts.accel ? 'accel' : c === charts.gyro ? 'gyro' : c === charts.mag ? 'mag' : 'pressure']); });
}

function initCharts() {
    var divs = { accel: document.getElementById('accel-chart'), gyro: document.getElementById('gyro-chart'), mag: document.getElementById('mag-chart'), pressure: document.getElementById('pressure-chart') };
    if(Object.values(divs).some(d => !d)) return;

    Object.values(divs).forEach(d => d.innerHTML = '');

    const commonOpts = () => ({
        width: divs.accel.offsetWidth, height: 200,
        cursor: { show: true, drag: { x: true, y: false } },
        scales: { x: { time: true }, y: { auto: true } },
        axes: [
            { stroke: '#97c93e', grid: { stroke: '#333' }, values: (u, vals) => vals.map(v => new Date(v*1000).toLocaleTimeString()) },
            { stroke: '#97c93e', grid: { stroke: '#333' }, size: 50 }
        ],
        plugins: [wheelZoomPlugin()]
    });

    var opts = commonOpts();
    opts.series = [{}, {label:'X', stroke:'#ff6384', width:2}, {label:'Y', stroke:'#36a2eb', width:2}, {label:'Z', stroke:'#4bc0c0', width:2}];
    charts.accel = new uPlot(opts, chartData.accel, divs.accel); addInteraction(charts.accel);

    opts = commonOpts();
    opts.series = [{}, {label:'X', stroke:'#ff9f40', width:2}, {label:'Y', stroke:'#9966ff', width:2}, {label:'Z', stroke:'#ffcd56', width:2}];
    charts.gyro = new uPlot(opts, chartData.gyro, divs.gyro); addInteraction(charts.gyro);

    opts = commonOpts();
    opts.series = [{}, {label:'X', stroke:'#c9cbcf', width:2}, {label:'Y', stroke:'#4bc0c0', width:2}, {label:'Z', stroke:'#ff6384', width:2}];
    charts.mag = new uPlot(opts, chartData.mag, divs.mag); addInteraction(charts.mag);

    opts = commonOpts();
    opts.height = 250; opts.scales.y = { auto: false, range: [0, 1024] };
    opts.series = [{}, {label:'P0', stroke:'#ff6384', width:3}, {label:'P1', stroke:'#36a2eb', width:3}, {label:'P2', stroke:'#ffce56', width:3}];
    charts.pressure = new uPlot(opts, chartData.pressure, divs.pressure); addInteraction(charts.pressure);
}

function wheelZoomPlugin() {
    return { hooks: { init: (u) => {
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
        u.over.addEventListener("dblclick", () => { isUserInteracting = false; });
    }}};
}

function addInteraction(u) {
    u.over.addEventListener('mousedown', () => isUserInteracting = true);
    u.over.addEventListener('wheel', () => isUserInteracting = true);
}

function clearAllData() { if(confirm('Pulire tutto?')) fetch('/api/clear', {method:'POST'}); }