// ==========================================
// CONFIGURAZIONE GLOBALE
// ==========================================
var socket = io({ 
    transports: ['websocket'], 
    reconnection: true, 
    reconnectionDelay: 500 
});

// Stato Dati
var sensors = {};
var map = null;
var mapMarker = null;
var isMapInitialized = false;

// Stato Grafici
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
// INIZIALIZZAZIONE DOM
// ==========================================
document.addEventListener('DOMContentLoaded', function() {
    initSocket();
    
    // Gestione Dropdown Sensore per Grafici
    var sel = document.getElementById('chart-sensor-select');
    if(sel) {
        sel.addEventListener('change', function(e) {
            selectedSensor = e.target.value || null;
            resetChartData();
            
            // Gestione visibilità contenitore grafici
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
// GESTIONE SOCKET E DATI IN INGRESSO
// ==========================================
function initSocket() {
    socket.on('connect', () => {
        var el = document.getElementById('connection-status');
        if(el) { el.className = ''; el.innerHTML = '<span class="dot"></span> Connesso'; }
    });
    
    socket.on('disconnect', () => {
        var el = document.getElementById('connection-status');
        if(el) { el.className = 'disconnected'; el.innerHTML = '<span class="dot"></span> Disconnesso'; }
    });

    // 1. CARICAMENTO DATI INIZIALI (Snapshot)
    fetch('/api/sensors').then(r => r.json()).then(data => {
        if (data.sensors) {
            sensors = data.sensors;
            renderSensorsGrid();
        }
        if (data.profile) updateProfileUI(data.profile);
        if (data.gps) updateMapUI(data.gps);
        if (data.bpm) updateBpmUI(data.bpm);
    }).catch(console.error);

    // 2. EVENTI REAL-TIME (Routing unico per gestire log sporchi)
    socket.on('sensor_update', (data) => processIncomingData(data));
    socket.on('bpm_update', (data) => processIncomingData(data));

    // Eventi specifici puliti (se arrivano dal server già filtrati)
    socket.on('profile_update', (data) => updateProfileUI(data));
    socket.on('gps_update', (data) => updateMapUI(data));
    
    // 3. RESET TOTALE
    socket.on('data_cleared', () => {
        sensors = {};
        
        // Pulisci DOM
        document.getElementById('sensors-grid').innerHTML = '';
        document.getElementById('empty-state').style.display = 'block';
        document.getElementById('selector-container').style.display = 'none';
        document.getElementById('charts-container').style.display = 'none';
        document.getElementById('user-profile-display').style.display = 'none';
        document.getElementById('bpm-display').style.display = 'none';
        document.getElementById('map-section').style.display = 'none';
        
        if(mapMarker && map) { 
            map.removeLayer(mapMarker); 
            mapMarker = null; 
        }
        
        resetChartData();
        chartsInitialized = false;
        selectedSensor = null;
    });
}

// ==========================================
// PARSING DEI DATI (Logica "Sporca" e "Pulita")
// ==========================================
function processIncomingData(data) {
    // 1. Convertiamo TUTTO in stringa per poter usare Regex sul log sporco
    var str = (typeof data === 'object') ? JSON.stringify(data) : String(data);

    // 2. CERCA BPM (Priorità assoluta)
    // Cerca pattern: "bpm": 123 oppure "bpm":123
    var bpmRegex = /"bpm"\s*:\s*(\d+)/;
    var match = str.match(bpmRegex);

    if (match && match[1]) {
        var bpmVal = parseInt(match[1]);
        if (!isNaN(bpmVal) && bpmVal > 0) {
            updateBpmUI(bpmVal);
            // NON ritorniamo qui, perché teoricamente una riga potrebbe avere sia BPM che dati sensore
            // ma solitamente BPM arriva da solo o con COOSPO.
        }
    }

    // 3. ESTRAZIONE JSON (Per Sensori, Profilo, etc.)
    var payload = null;
    
    if (typeof data === 'object' && data.sensor_name) {
        // È già un oggetto pulito
        payload = data;
    } else {
        // È una stringa sporca: cerchiamo il JSON dentro {...}
        var start = str.indexOf('{');
        var end = str.lastIndexOf('}');
        if (start !== -1 && end > start) {
            try {
                payload = JSON.parse(str.substring(start, end + 1));
            } catch(e) {
                // JSON non valido, ignoriamo
            }
        }
    }

    // 4. ROUTING DEL PAYLOAD ESTRATTO
    if (payload && payload.sensor_name) {
        var name = payload.sensor_name;

        // Se è info profilo
        if (name === 'PROFILE_INFO') {
            updateProfileUI(payload);
            return;
        }

        // Se è un dato cardio (già gestito dal regex sopra, o da ignorare nella griglia)
        if (name === 'HRM' || name.toUpperCase().includes('COOSPO') || payload.bpm !== undefined) {
            return; 
        }

        // Se è un sensore vero (accel, gyro, pressure...)
        sensors[name] = payload;
        updateSensorCardUI(name, payload);
        updateChartsUI(name, payload);
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
    var valEl = document.getElementById('bpm-value');
    
    if (!div || !valEl) return;

    val = parseInt(val);
    if (val > 0) {
        // Se arriva il BPM, mostriamo la mappa (dove vive il widget)
        if (mapSection && mapSection.style.display === 'none') {
            mapSection.style.display = 'block';
            if(!isMapInitialized) initMap();
        }

        div.style.display = 'flex';
        valEl.textContent = val;
        
        // Animazione
        var icon = div.querySelector('.heart-icon');
        if (icon) {
            var d = 60/val; 
            if(d<0.3) d=0.3; 
            icon.style.animationDuration = d + 's';
        }
    }
}

function updateMapUI(data) {
    var section = document.getElementById('map-section');
    if(section) section.style.display = 'block';

    if (!isMapInitialized) initMap();

    // Centra mappa se necessario (o rimuovere setView per non seguire sempre)
    if(map) map.setView([data.latitude, data.longitude], 15);

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
    } else {
        mapMarker.setLatLng(latlng);
    }
}

function initMap() {
    if (isMapInitialized) return;
    map = L.map('map').setView([41.9028, 12.4964], 5); // Default Roma
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { 
        attribution: '© OpenStreetMap, © CartoDB',
        maxZoom: 20 
    }).addTo(map);
    isMapInitialized = true;
    setTimeout(() => map.invalidateSize(), 100);
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
    // Filtro per evitare card vuote
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
    
    sel.innerHTML = '<option value="">-- Seleziona sensore --</option>';
    names.forEach(n => {
        var opt = document.createElement('option');
        opt.value = n; opt.textContent = n;
        sel.appendChild(opt);
    });
    
    if (names.length === 0) {
        container.style.display = 'none';
    } else {
        container.style.display = 'block';
        // Auto-selezione intelligente
        if (current && sensors[current]) {
            sel.value = current;
        } else if (!selectedSensor && names.length > 0) {
            sel.value = names[0];
            sel.dispatchEvent(new Event('change'));
        }
    }
}


// ==========================================
// GRAFICI uPLOT
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

    // 1. Accel
    if (data.accel_x !== undefined && charts.accel) {
        push(chartData.accel, [data.accel_x, data.accel_y, data.accel_z]);
        charts.accel.setData(chartData.accel);
        autoScroll(charts.accel, chartData.accel);
    }

    // 2. Gyro
    if (data.gyro_x !== undefined && charts.gyro) {
        push(chartData.gyro, [data.gyro_x, data.gyro_y, data.gyro_z]);
        charts.gyro.setData(chartData.gyro);
        autoScroll(charts.gyro, chartData.gyro);
    }

    // 3. Mag
    if (data.mag_x !== undefined && charts.mag) {
        push(chartData.mag, [data.mag_x, data.mag_y, data.mag_z]);
        charts.mag.setData(chartData.mag);
        autoScroll(charts.mag, chartData.mag);
    }

    // 4. Pressioni
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

// INIZIALIZZAZIONE COMPLETA DI TUTTI I GRAFICI
function initCharts() {
    var accelDiv = document.getElementById('accel-chart');
    var gyroDiv = document.getElementById('gyro-chart');
    var magDiv = document.getElementById('mag-chart');
    var pressureDiv = document.getElementById('pressure-chart');

    // Se mancano i DIV, esci
    if (!accelDiv || !gyroDiv || !magDiv || !pressureDiv) return;
    
    // Pulisci
    accelDiv.innerHTML = ''; gyroDiv.innerHTML = ''; magDiv.innerHTML = ''; pressureDiv.innerHTML = '';

    // Opzioni comuni
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

    // 1. Accel
    var opts1 = commonOpts();
    opts1.series = [{}, {label:'X', stroke:'#ff6384', width:2}, {label:'Y', stroke:'#36a2eb', width:2}, {label:'Z', stroke:'#4bc0c0', width:2}];
    charts.accel = new uPlot(opts1, chartData.accel, accelDiv);
    addInteraction(charts.accel);

    // 2. Gyro
    var opts2 = commonOpts();
    opts2.series = [{}, {label:'X', stroke:'#ff9f40', width:2}, {label:'Y', stroke:'#9966ff', width:2}, {label:'Z', stroke:'#ffcd56', width:2}];
    charts.gyro = new uPlot(opts2, chartData.gyro, gyroDiv);
    addInteraction(charts.gyro);

    // 3. Mag
    var opts3 = commonOpts();
    opts3.series = [{}, {label:'X', stroke:'#c9cbcf', width:2}, {label:'Y', stroke:'#4bc0c0', width:2}, {label:'Z', stroke:'#ff6384', width:2}];
    charts.mag = new uPlot(opts3, chartData.mag, magDiv);
    addInteraction(charts.mag);

    // 4. Pressure
    var opts4 = commonOpts();
    opts4.height = 250;
    opts4.scales.y = { auto: false, range: [0, 1024] };
    opts4.series = [{}, {label:'P0', stroke:'#ff6384', width:3}, {label:'P1', stroke:'#36a2eb', width:3}, {label:'P2', stroke:'#ffce56', width:3}];
    charts.pressure = new uPlot(opts4, chartData.pressure, pressureDiv);
    addInteraction(charts.pressure);
}

// Helpers grafici
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
