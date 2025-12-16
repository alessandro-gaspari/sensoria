// ==========================================
// CONFIGURAZIONE GLOBALE
// ==========================================
var socket = io({ 
    transports: ['websocket'], 
    reconnection: true, 
    reconnectionDelay: 500 
});

var sensors = {};

// --- MAPPA & REPLAY ---
var map = null;
var mapMarker = null;
var routePath = null;           // Linea verde
var routeHistory = [];          // Storico punti
var isMapInitialized = false;
var isReplayMode = false;       

const SENSORIA_GREEN = '#97c93e'; 

// --- INTERPOLAZIONE MARKER ---
var currentMapPos = null; 
var targetMapPos = null;  
var animationStartTime = null;
var startMapPos = null;   
var animationFrameId = null;
const ANIMATION_DURATION = 1000; 

// --- GRAFICI ---
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

    socket.on('sensor_update', (data) => processIncomingData(data));
    socket.on('bpm_update', (val) => updateBpmUI(val));
    socket.on('profile_update', (data) => updateProfileUI(data));
    socket.on('gps_update', (data) => updateMapUI(data));

    socket.on('data_cleared', () => { resetAll(); });
}

function resetAll() {
    sensors = {};
    routeHistory = []; 
    
    document.getElementById('sensors-grid').innerHTML = '';
    var empty = document.getElementById('empty-state');
    if(empty) empty.style.display = 'block';
    
    document.getElementById('charts-container').style.display = 'none';
    document.getElementById('user-profile-display').style.display = 'none';
    document.getElementById('bpm-display').style.display = 'none';
    
    // Reset Mappa
    if(routePath) routePath.setLatLngs([]); 
    if(mapMarker) mapMarker.setOpacity(0); 
    
    // Reset Replay
    isReplayMode = false;
    var slider = document.getElementById('replay-slider');
    if(slider) { slider.value = 0; slider.max = 0; }
    
    var replayDiv = document.getElementById('replay-overlay');
    if(replayDiv) replayDiv.style.display = 'none';
    
    resetChartData();
    chartsInitialized = false;
    selectedSensor = null;
}

// ==========================================
// PARSING DATI
// ==========================================
function processIncomingData(data) {
    var str = (typeof data === 'object') ? JSON.stringify(data) : String(data);
    var bpmMatch = str.match(/"bpm"\s*:\s*(\d+)/);
    if (bpmMatch && bpmMatch[1]) {
        var val = parseInt(bpmMatch[1]);
        if (!isNaN(val) && val > 0) { updateBpmUI(val); return; }
    }

    var payload = null;
    if (typeof data === 'object') {
        payload = data.data || data;
    } else {
        var jsonStart = str.indexOf('{');
        var jsonEnd = str.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd > jsonStart) {
            try { payload = JSON.parse(str.substring(jsonStart, jsonEnd + 1)); } catch (e) {}
        }
    }

    if (payload && payload.sensor_name) {
        var name = payload.sensor_name;
        if (name.includes("COOSPO") || name === "HRM") return; 
        if (name === 'PROFILE_INFO') { updateProfileUI(payload); return; }

        sensors[name] = payload;
        var empty = document.getElementById('empty-state');
        if (empty) empty.style.display = 'none';

        updateSensorCardUI(name, payload);
        updateChartsUI(name, payload);
    }
}

// ==========================================
// MAPPA, PERCORSO & REPLAY (OVERLAY FIX)
// ==========================================

function ensureMapInitialized(lat, lng) {
    if (isMapInitialized) return;

    var section = document.getElementById('map-section');
    if(section) section.style.display = 'block';

    // Assicuriamoci che il container #map abbia position: relative per ospitare l'overlay
    var mapContainer = document.getElementById('map');
    if(mapContainer) {
        mapContainer.style.position = 'relative'; // Cruciale per l'overlay
    }

    map = L.map('map', { attributionControl: false, zoomControl: false }).setView([lat, lng], 19);
    L.control.zoom({ position: 'topleft' }).addTo(map);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 20 }).addTo(map);

    // Marker
    var pulseIcon = L.divIcon({
        className: 'custom-div-icon', 
        html: "<div class='pulsating-marker'></div>", 
        iconSize: [24, 24], 
        iconAnchor: [12, 12] 
    });
    mapMarker = L.marker([lat, lng], {icon: pulseIcon}).addTo(map);

    // Percorso Verde
    routePath = L.polyline([], {
        color: SENSORIA_GREEN,
        weight: 6,           // Leggermente più spesso
        opacity: 0.9,
        lineJoin: 'round',
        lineCap: 'round'
    }).addTo(map);

    // Creiamo i controlli OVERLAY (sopra la mappa)
    createReplayOverlay();

    isMapInitialized = true;
    setTimeout(() => map.invalidateSize(), 100);
}

function updateMapUI(data) {
    ensureMapInitialized(data.latitude, data.longitude);
    document.getElementById('map-section').style.display = 'block';
    
    var timestamp = data.timestamp ? new Date(data.timestamp).getTime() : Date.now();
    var newPoint = { lat: data.latitude, lng: data.longitude, t: timestamp };
    routeHistory.push(newPoint);

    // Aggiorna slider e percorso SE siamo in Live Mode
    if (!isReplayMode) {
        // Aggiungi alla linea (anche se statico, il punto viene aggiunto)
        if(routePath) {
            routePath.addLatLng([data.latitude, data.longitude]);
        }
        
        updateReplaySliderUI(); // Allunga la barra

        // Mostra overlay replay se abbiamo dati
        var overlay = document.getElementById('replay-overlay');
        if(overlay && routeHistory.length > 1) {
            overlay.style.display = 'flex';
        }

        // Animazione Marker
        if(!currentMapPos) currentMapPos = { lat: data.latitude, lng: data.longitude };
        targetMapPos = { lat: data.latitude, lng: data.longitude };
        startMapPos = { ...currentMapPos };
        animationStartTime = performance.now();
        
        if (!animationFrameId) animateMarkerLoop();

        var accEl = document.getElementById('gps-accuracy');
        if(accEl) accEl.textContent = Math.round(data.accuracy);
        
        mapMarker.setOpacity(1);
    }
}

function animateMarkerLoop() {
    if (!startMapPos || !targetMapPos || !mapMarker || isReplayMode) {
        animationFrameId = null;
        return;
    }
    var now = performance.now();
    var elapsed = now - animationStartTime;
    var progress = elapsed / ANIMATION_DURATION;
    if (progress > 1) progress = 1;

    var lat = startMapPos.lat + (targetMapPos.lat - startMapPos.lat) * progress;
    var lng = startMapPos.lng + (targetMapPos.lng - startMapPos.lng) * progress;

    currentMapPos = { lat: lat, lng: lng };
    mapMarker.setLatLng([lat, lng]);

    if (progress < 1) animationFrameId = requestAnimationFrame(animateMarkerLoop);
    else animationFrameId = null;
}

// --- REPLAY OVERLAY SYSTEM ---

function createReplayOverlay() {
    // Inseriamo l'overlay DENTRO il div #map, ma con z-index alto
    var mapContainer = document.getElementById('map');
    if(!mapContainer || document.getElementById('replay-overlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'replay-overlay';
    
    // STILE OVERLAY: Fluttua sopra la mappa in basso
    overlay.style.cssText = `
        position: absolute;
        bottom: 20px;
        left: 20px;
        right: 20px;
        z-index: 9999; /* Sopra a Leaflet */
        background: rgba(20, 20, 20, 0.9);
        backdrop-filter: blur(5px);
        padding: 10px 15px;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        display: none; /* Nascondi finché non ci sono dati */
        align-items: center;
        gap: 15px;
        box-shadow: 0 4px 15px rgba(0,0,0,0.5);
    `;
    
    overlay.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:flex-start;">
            <span style="color:#888; font-size:10px; font-weight:bold; letter-spacing:1px;">TIMELINE</span>
            <span id="replay-current-time" style="color:#fff; font-family:monospace; font-size:14px; font-weight:bold;">00:00</span>
        </div>
        
        <input type="range" id="replay-slider" min="0" max="0" value="0" 
               style="flex-grow:1; cursor:pointer; accent-color:${SENSORIA_GREEN}; height:4px; border-radius:2px;">
        
        <button id="btn-go-live" style="
            background: rgba(151, 201, 62, 0.2);
            color: ${SENSORIA_GREEN};
            border: 1px solid ${SENSORIA_GREEN};
            padding: 5px 12px;
            border-radius: 6px;
            font-size: 11px;
            font-weight: bold;
            cursor: pointer;
            transition: all 0.2s;
            text-transform: uppercase;
        ">LIVE</button>
    `;

    mapContainer.appendChild(overlay);
    
    // LOGICA EVENTI
    var slider = document.getElementById('replay-slider');
    var btnLive = document.getElementById('btn-go-live');

    // 1. Tasto LIVE: Torna subito alla fine
    btnLive.addEventListener('click', function() {
        goBackToLive();
    });

    // 2. Slider Input: Mentre trascini -> Replay
    slider.addEventListener('input', function(e) {
        enterReplayMode(parseInt(e.target.value));
    });

    // 3. Slider Change: Se rilasci alla fine -> Live
    slider.addEventListener('change', function(e) {
        if (parseInt(e.target.value) >= routeHistory.length - 1) {
            goBackToLive();
        }
    });
}

function enterReplayMode(index) {
    isReplayMode = true;
    cancelAnimationFrame(animationFrameId); // Stop animazione live
    
    // Aggiorna stile bottone LIVE (spento)
    var btn = document.getElementById('btn-go-live');
    if(btn) {
        btn.style.background = 'transparent';
        btn.style.color = '#666';
        btn.style.border = '1px solid #444';
    }

    if (index >= 0 && index < routeHistory.length) {
        var pt = routeHistory[index];
        mapMarker.setLatLng([pt.lat, pt.lng]);
        
        // Opzionale: Centra mappa sul punto replay
        // map.panTo([pt.lat, pt.lng]); 
        
        document.getElementById('replay-current-time').textContent = formatReplayTime(index);
    }
}

function goBackToLive() {
    isReplayMode = false;
    
    // Riaccendi bottone LIVE
    var btn = document.getElementById('btn-go-live');
    if(btn) {
        btn.style.background = 'rgba(151, 201, 62, 0.2)';
        btn.style.color = SENSORIA_GREEN;
        btn.style.border = `1px solid ${SENSORIA_GREEN}`;
    }

    // Porta slider alla fine
    var slider = document.getElementById('replay-slider');
    if(slider && routeHistory.length > 0) {
        slider.value = routeHistory.length - 1;
        document.getElementById('replay-current-time').textContent = formatReplayTime(routeHistory.length - 1);
    }

    // Riaggancia marker all'ultimo target noto
    if(targetMapPos) {
        mapMarker.setLatLng([targetMapPos.lat, targetMapPos.lng]);
    }
}

function updateReplaySliderUI() {
    var slider = document.getElementById('replay-slider');
    if (slider) {
        var len = routeHistory.length;
        if(len > 0) slider.max = len - 1;
        
        if (!isReplayMode) {
            slider.value = len - 1;
            document.getElementById('replay-current-time').textContent = formatReplayTime(len - 1);
        }
    }
}

function formatReplayTime(index) {
    if(routeHistory.length === 0) return "00:00";
    var startT = routeHistory[0].t;
    var currT = routeHistory[index].t;
    var diffSec = Math.floor((currT - startT) / 1000);
    if(diffSec < 0) diffSec = 0;
    
    var m = Math.floor(diffSec / 60).toString().padStart(2, '0');
    var s = (diffSec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
}

// ==========================================
// FUNZIONI STANDARD (SENSORI & GRAFICI)
// ==========================================
function renderSensorsGrid() { /* ... (invariato) ... */ } 
// Per brevità, le funzioni di render card sono identiche alla versione precedente 
// che avevi confermato funzionare per "tutti i dati".
// Le riporto qui per completezza del copia-incolla:

function createSensorCard(name, data) {
    var hasAccel = data.accel_x !== undefined;
    var hasGyro = data.gyro_x !== undefined;
    var hasMag = data.mag_x !== undefined;
    var hasPressure = data.pressure_0 !== undefined;

    if (!hasAccel && !hasGyro && !hasMag && !hasPressure) return;

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

    var html = `<div class="sensor-header"><span>${emoji} ${name}</span><div class="status-indicator active"></div></div>`;
    
    if (hasAccel) {
        html += `<div class="sensor-data-section"><div class="sensor-data-section-title">Accelerometro</div>
                 <div class="sensor-data-row"><span class="sensor-data-label">AX</span> <span class="sensor-value" data-key="accel_x">0</span></div>
                 <div class="sensor-data-row"><span class="sensor-data-label">AY</span> <span class="sensor-value" data-key="accel_y">0</span></div>
                 <div class="sensor-data-row"><span class="sensor-data-label">AZ</span> <span class="sensor-value" data-key="accel_z">0</span></div></div>`;
    }
    if (hasGyro) {
        html += `<div class="sensor-data-section"><div class="sensor-data-section-title">Giroscopio</div>
                 <div class="sensor-data-row"><span class="sensor-data-label">GX</span> <span class="sensor-value" data-key="gyro_x">0</span></div>
                 <div class="sensor-data-row"><span class="sensor-data-label">GY</span> <span class="sensor-value" data-key="gyro_y">0</span></div>
                 <div class="sensor-data-row"><span class="sensor-data-label">GZ</span> <span class="sensor-value" data-key="gyro_z">0</span></div></div>`;
    }
    if (hasMag) {
        html += `<div class="sensor-data-section"><div class="sensor-data-section-title">Magnetometro</div>
                 <div class="sensor-data-row"><span class="sensor-data-label">MX</span> <span class="sensor-value" data-key="mag_x">0</span></div>
                 <div class="sensor-data-row"><span class="sensor-data-label">MY</span> <span class="sensor-value" data-key="mag_y">0</span></div>
                 <div class="sensor-data-row"><span class="sensor-data-label">MZ</span> <span class="sensor-value" data-key="mag_z">0</span></div></div>`;
    }
    if (hasPressure) {
         html += `<div class="sensor-data-section" style="border:none;"><div class="sensor-data-section-title">Pressioni</div>
                  <div class="sensor-data-row"><span class="sensor-data-label">P0</span> <span class="sensor-value" style="color:#ffce56;" data-key="pressure_0">0</span></div>
                  <div class="sensor-data-row"><span class="sensor-data-label">P1</span> <span class="sensor-value" style="color:#ffce56;" data-key="pressure_1">0</span></div></div>`;
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
    sel.innerHTML = '<option value="">-- Seleziona sensore --</option>';
    names.forEach(n => { var opt = document.createElement('option'); opt.value = n; opt.textContent = n; sel.appendChild(opt); });
    
    if (names.length === 0) { container.style.display = 'none'; return; }
    container.style.display = 'block';
    if (current && sensors[current]) sel.value = current;
    else if (!selectedSensor && names.length > 0) { sel.value = names[0]; var event = new Event('change'); sel.dispatchEvent(event); }
}

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
    val = parseInt(val);
    if (val > 0) {
        if(div) {
            div.style.display = 'flex';
            document.getElementById('bpm-value').textContent = val;
            var icon = div.querySelector('.heart-icon');
            if (icon) { var d = 60/val; if(d<0.3) d=0.3; icon.style.animationDuration = d+'s'; }
        }
    }
}

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
        var minX = lastTime - 10;
        if (xData[0] > minX) minX = xData[0];
        u.setScale('x', { min: minX, max: lastTime });
    }
}

function resetChartData() {
    isUserInteracting = false;
    chartData = { accel: [[],[],[],[]], gyro: [[],[],[],[]], mag: [[],[],[],[]], pressure: [[],[],[],[]] };
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
        axes: [ { stroke: '#97c93e', grid: { stroke: '#333' }, values: (u, vals) => vals.map(v => new Date(v*1000).toLocaleTimeString()) }, { stroke: '#97c93e', grid: { stroke: '#333' }, size: 50 } ],
        plugins: [wheelZoomPlugin()]
    });

    var opts1 = commonOpts(); opts1.series = [{}, {label:'X', stroke:'#ff6384', width:2}, {label:'Y', stroke:'#36a2eb', width:2}, {label:'Z', stroke:'#4bc0c0', width:2}];
    charts.accel = new uPlot(opts1, chartData.accel, accelDiv); addInteraction(charts.accel);

    var opts2 = commonOpts(); opts2.series = [{}, {label:'X', stroke:'#ff9f40', width:2}, {label:'Y', stroke:'#9966ff', width:2}, {label:'Z', stroke:'#ffcd56', width:2}];
    charts.gyro = new uPlot(opts2, chartData.gyro, gyroDiv); addInteraction(charts.gyro);

    var opts3 = commonOpts(); opts3.series = [{}, {label:'X', stroke:'#c9cbcf', width:2}, {label:'Y', stroke:'#4bc0c0', width:2}, {label:'Z', stroke:'#ff6384', width:2}];
    charts.mag = new uPlot(opts3, chartData.mag, magDiv); addInteraction(charts.mag);

    var opts4 = commonOpts(); opts4.height = 250; opts4.scales.y = { auto: false, range: [0, 1024] };
    opts4.series = [{}, {label:'P0', stroke:'#ff6384', width:3}, {label:'P1', stroke:'#36a2eb', width:3}, {label:'P2', stroke:'#ffce56', width:3}];
    charts.pressure = new uPlot(opts4, chartData.pressure, pressureDiv); addInteraction(charts.pressure);
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
                u.over.addEventListener("dblclick", () => { isUserInteracting = false; });
            }
        }
    };
}
function addInteraction(u) { u.over.addEventListener('mousedown', () => isUserInteracting = true); u.over.addEventListener('wheel', () => isUserInteracting = true); }
function clearAllData() { if(confirm('Pulire tutto?')) fetch('/api/clear', {method:'POST'}); }
