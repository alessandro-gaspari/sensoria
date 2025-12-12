// ==========================================
// CONFIGURAZIONE GLOBALE
// ==========================================
var socket = io({ 
    transports: ['websocket'], 
    reconnection: true, 
    reconnectionDelay: 500 
});

// Stato Dati
var sensors = {};           // Solo sensori veri (IMU/Pressione)
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
var isUserInteracting = false; // Per bloccare autoscroll se l'utente zooma

// Costanti
var MIN_ZOOM_RANGE = 0.5;

// ==========================================
// INIZIALIZZAZIONE
// ==========================================
document.addEventListener('DOMContentLoaded', function() {
    initSocket();
    
    // Gestione Dropdown Sensore per Grafici
    var sel = document.getElementById('chart-sensor-select');
    if(sel) {
        sel.addEventListener('change', function(e) {
            selectedSensor = e.target.value;
            // Se è la prima volta che selezioniamo, inizializza i canvas uPlot
            if(!chartsInitialized && selectedSensor) {
                initCharts();
                chartsInitialized = true;
            }
            // Quando cambi sensore, resetta le linee del grafico
            resetChartData();
        });
    }
});

function initSocket() {
    // Gestione connessione UI
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
        if (data.profile && Object.keys(data.profile).length > 0) updateProfileUI(data.profile);
        if (data.gps && Object.keys(data.gps).length > 0) updateMapUI(data.gps);
        if (data.bpm) updateBpmUI(data.bpm);
    }).catch(console.error);

    // 2. EVENTI REAL-TIME
    socket.on('sensor_update', (data) => {
        sensors[data.sensor_name] = data.data;
        updateSensorCardUI(data.sensor_name, data.data);
        updateChartsUI(data.sensor_name, data.data);
    });

    socket.on('profile_update', (data) => updateProfileUI(data));
    socket.on('gps_update', (data) => updateMapUI(data));
    socket.on('bpm_update', (bpm) => updateBpmUI(bpm));

    // 3. RESET TOTALE (Nuova Sessione)
    socket.on('data_cleared', () => {
        console.log("🧹 Dati puliti dal server");
        sensors = {};
        
        // Pulisci Griglia Sensori
        document.getElementById('sensors-grid').innerHTML = '';
        document.getElementById('empty-state').style.display = 'block';
        document.getElementById('charts-container').style.display = 'none';
        
        // Pulisci Header
        document.getElementById('user-profile-display').style.display = 'none';
        document.getElementById('bpm-display').style.display = 'none';
        
        // Pulisci Mappa
        if(mapMarker) { map.removeLayer(mapMarker); mapMarker = null; }
        document.getElementById('map-section').style.display = 'none';
        
        // Pulisci Grafici
        resetChartData();
        updateSelector();
    });
}


// ==========================================
// LOGICA UI: GRIGLIA SENSORI
// ==========================================
function renderSensorsGrid() {
    var grid = document.getElementById('sensors-grid');
    grid.innerHTML = ''; // Pulisci tutto
    
    var keys = Object.keys(sensors);
    if (keys.length === 0) {
        document.getElementById('empty-state').style.display = 'block';
        return;
    }
    document.getElementById('empty-state').style.display = 'none';

    keys.forEach(name => {
        createSensorCard(name, sensors[name]);
    });
    updateSelector();
}

function createSensorCard(name, data) {
    // FILTRO BASE: Deve avere almeno un dato utile
    if (data.accel_x === undefined && data.pressure_0 === undefined) return;

    var grid = document.getElementById('sensors-grid');
    var div = document.createElement('div');
    div.className = 'sensor-card';
    div.setAttribute('data-sensor', name);
    div.style.cssText = "background:#1a1a1a; padding:15px; border-radius:12px; border:1px solid #333; min-width: 280px;";
    
    var emoji = '📱';
    var n = name.toLowerCase();
    if(n.includes('leg') || n.includes('knee') || n.includes('ginocchio')) emoji = '🦿';
    if(n.includes('foot') || n.includes('sock') || n.includes('calzino') || n.includes('piede')) emoji = '🧦';
    if(n.includes('arm')) emoji = '🦾';

    var html = `<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                    <h3 style="color:#97c93e; margin:0; font-size:16px;">${emoji} ${name}</h3>
                    <div class="status-indicator active"></div>
                </div>`;
    
    // --- ACCELEROMETRO ---
    if (data.accel_x !== undefined) {
        html += `<div style="margin-bottom:8px;">
                    <div style="color:#97c93e; font-size:11px; font-weight:bold; margin-bottom:4px;">ACCELEROMETRO</div>
                    <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; font-size:13px;">
                        <div style="color:#888;">AX <b style="color:#fff; display:block;" data-key="accel_x">0</b></div>
                        <div style="color:#888;">AY <b style="color:#fff; display:block;" data-key="accel_y">0</b></div>
                        <div style="color:#888;">AZ <b style="color:#fff; display:block;" data-key="accel_z">0</b></div>
                    </div>
                 </div>`;
    }

    // --- GIROSCOPIO (Solo se presente) ---
    if (data.gyro_x !== undefined) {
        html += `<div style="margin-bottom:8px; border-top:1px solid #333; padding-top:8px;">
                    <div style="color:#97c93e; font-size:11px; font-weight:bold; margin-bottom:4px;">GIROSCOPIO</div>
                    <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; font-size:13px;">
                        <div style="color:#888;">GX <b style="color:#fff; display:block;" data-key="gyro_x">0</b></div>
                        <div style="color:#888;">GY <b style="color:#fff; display:block;" data-key="gyro_y">0</b></div>
                        <div style="color:#888;">GZ <b style="color:#fff; display:block;" data-key="gyro_z">0</b></div>
                    </div>
                 </div>`;
    }

    // --- MAGNETOMETRO (Solo se presente) ---
    if (data.mag_x !== undefined) {
        html += `<div style="margin-bottom:8px; border-top:1px solid #333; padding-top:8px;">
                    <div style="color:#97c93e; font-size:11px; font-weight:bold; margin-bottom:4px;">MAGNETOMETRO</div>
                    <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; font-size:13px;">
                        <div style="color:#888;">MX <b style="color:#fff; display:block;" data-key="mag_x">0</b></div>
                        <div style="color:#888;">MY <b style="color:#fff; display:block;" data-key="mag_y">0</b></div>
                        <div style="color:#888;">MZ <b style="color:#fff; display:block;" data-key="mag_z">0</b></div>
                    </div>
                 </div>`;
    }

    // --- PRESSIONI (Solo se presente) ---
    if (data.pressure_0 !== undefined) {
         html += `<div style="border-top:1px solid #333; padding-top:8px;">
                    <div style="color:#97c93e; font-size:11px; font-weight:bold; margin-bottom:4px;">PRESSIONI</div>
                    <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; font-size:13px;">
                        <div style="color:#888;">P0 <b style="color:#ffce56; display:block;" data-key="pressure_0">0</b></div>
                        <div style="color:#888;">P1 <b style="color:#ffce56; display:block;" data-key="pressure_1">0</b></div>
                        <div style="color:#888;">P2 <b style="color:#ffce56; display:block;" data-key="pressure_2">0</b></div>
                    </div>
                 </div>`;
    }

    div.innerHTML = html;
    grid.appendChild(div);
}

function updateSensorCardUI(name, data) {
    var card = document.querySelector(`[data-sensor="${name}"]`);
    if (!card) {
        // Se la card non esiste ancora, creala
        createSensorCard(name, data);
        updateSelector();
        return;
    }
    
    // Aggiorna solo i valori numerici
    Object.keys(data).forEach(k => {
        var el = card.querySelector(`[data-key="${k}"]`);
        if (el) {
            el.textContent = Math.round(data[k]);
            // Effetto flash visivo opzionale potrebbe andare qui
        }
    });
}

function updateSelector() {
    var sel = document.getElementById('chart-sensor-select');
    var current = sel.value; 
    
    sel.innerHTML = '<option value="">-- Seleziona sensore --</option>';
    
    var sensorNames = Object.keys(sensors);
    sensorNames.forEach(name => {
        var opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
    });
    
    // VISIBILITA' DEL MENU A TENDINA
    var selectorContainer = document.getElementById('selector-container');
    if (sensorNames.length > 0) {
        selectorContainer.style.display = 'block'; // Mostra il menu se ci sono sensori
    } else {
        selectorContainer.style.display = 'none';
    }

    // LOGICA AUTO-SELEZIONE (Se vuoi che parta in automatico)
    if (current && sensors[current]) {
        sel.value = current;
    } else if (sensorNames.length > 0) {
        sel.value = sensorNames[0];
        selectedSensor = sensorNames[0];
        if(!chartsInitialized) {
            initCharts();
            chartsInitialized = true;
        }
    }

    // VISIBILITA' DEI GRAFICI
    var chartsContainer = document.getElementById('charts-container');
    if (selectedSensor && sensors[selectedSensor]) {
        chartsContainer.style.display = 'block';
    } else {
        chartsContainer.style.display = 'none';
    }
}



// ==========================================
// LOGICA UI: HEADER (Profilo, BPM) & MAPPA
// ==========================================

function updateProfileUI(data) {
    var div = document.getElementById('user-profile-display');
    if (!data.name) return;
    
    div.style.display = 'flex'; // Mostra il box
    document.getElementById('profile-name').textContent = data.name.toUpperCase();
    document.getElementById('profile-avatar').textContent = data.avatar || "👤";
    
    var gender = data.gender === 'M' ? '♂' : (data.gender === 'F' ? '♀' : '');
    document.getElementById('profile-details').textContent = `${data.age} anni | ${data.weight} kg | ${gender}`;
}

function updateBpmUI(val) {
    var div = document.getElementById('bpm-display');
    if (val > 0) {
        div.style.display = 'flex';
        document.getElementById('bpm-value').textContent = val;
        
        // Regola velocità animazione cuore
        var icon = div.querySelector('.heart-icon');
        if (icon) {
            var duration = 60 / val; // bpm -> secondi per battito
            if(duration < 0.3) duration = 0.3; // Cap velocità massima
            icon.style.animationDuration = duration + 's';
        }
    }
}

function updateMapUI(data) {
    var section = document.getElementById('map-section');
    section.style.display = 'block';

    // Inizializza Mappa se prima volta
    if (!isMapInitialized) {
        map = L.map('map').setView([data.latitude, data.longitude], 15);
        
        // CartoDB Dark Matter (Mappa scura elegante)
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '© OpenStreetMap, © CartoDB',
            maxZoom: 20
        }).addTo(map);
        
        isMapInitialized = true;
        
        // Hack per refresh size quando diventa visibile
        setTimeout(() => map.invalidateSize(), 100);
    }

    var latlng = [data.latitude, data.longitude];
    document.getElementById('gps-accuracy').textContent = Math.round(data.accuracy);

    if (!mapMarker) {
        // Crea Marker Verde
        var greenIcon = new L.Icon({
            iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
            shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/0.7.7/images/marker-shadow.png',
            iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41]
        });
        mapMarker = L.marker(latlng, {icon: greenIcon}).addTo(map);
        map.panTo(latlng);
    } else {
        // Aggiorna posizione
        mapMarker.setLatLng(latlng);
        // map.panTo(latlng); // Decommenta se vuoi inseguire sempre la posizione
    }
}


// ==========================================
// LOGICA GRAFICI (uPlot)
// ==========================================

function updateChartsUI(sensorName, data) {
    // Aggiorna solo se è il sensore selezionato dal menu a tendina
    if (selectedSensor !== sensorName || !chartsInitialized) return;

    var timestamp = Date.now() / 1000;
    
    // Mostra container se nascosto
    document.getElementById('charts-container').style.display = 'block';

    // 1. ACCELEROMETRO
    if (data.accel_x !== undefined) {
        pushData(chartData.accel, timestamp, [data.accel_x, data.accel_y, data.accel_z]);
        charts.accel.setData(chartData.accel);
        autoScroll(charts.accel, chartData.accel);
    }
    // 2. GIROSCOPIO
    if (data.gyro_x !== undefined) {
        pushData(chartData.gyro, timestamp, [data.gyro_x, data.gyro_y, data.gyro_z]);
        charts.gyro.setData(chartData.gyro);
        autoScroll(charts.gyro, chartData.gyro);
    }
    // 3. MAGNETOMETRO
    if (data.mag_x !== undefined) {
        pushData(chartData.mag, timestamp, [data.mag_x, data.mag_y, data.mag_z]);
        charts.mag.setData(chartData.mag);
        autoScroll(charts.mag, chartData.mag);
    }
    // 4. PRESSIONI
    if (data.pressure_0 !== undefined) {
        pushData(chartData.pressure, timestamp, [data.pressure_0, data.pressure_1, data.pressure_2]);
        charts.pressure.setData(chartData.pressure);
        autoScroll(charts.pressure, chartData.pressure);
        document.getElementById('pressure-chart-container').style.display = 'block';
    } else {
        document.getElementById('pressure-chart-container').style.display = 'none';
    }
}

// Helper per aggiungere dati agli array uPlot
function pushData(target, time, values) {
    target[0].push(time);
    values.forEach((v, i) => target[i+1].push(v));
    
    // Limita memoria (es. max 5000 punti)
    if(target[0].length > 5000) {
        target.forEach(series => series.shift());
    }
}

function autoScroll(u, data) {
    if (!isUserInteracting) {
        var xData = data[0];
        if (xData.length < 2) return;
        var lastTime = xData[xData.length - 1];
        var windowSize = 10; // Finestra di 10 secondi
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

// --- CONFIGURAZIONE uPLOT ---
function initCharts() {
    var accelDiv = document.getElementById('accel-chart');
    var gyroDiv = document.getElementById('gyro-chart');
    var magDiv = document.getElementById('mag-chart');
    var pressureDiv = document.getElementById('pressure-chart');

    if (!accelDiv || !gyroDiv || !magDiv || !pressureDiv) return;
    
    // Pulisci precedenti
    accelDiv.innerHTML = ''; gyroDiv.innerHTML = ''; magDiv.innerHTML = ''; pressureDiv.innerHTML = '';

    var commonOpts = (title, color) => ({
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
    
    console.log("📈 Grafici Inizializzati");
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
                    isUserInteracting = false; // Reset zoom per riprendere tracking
                });
            }
        }
    };
}

function addInteraction(u) {
    u.over.addEventListener('mousedown', () => isUserInteracting = true);
    u.over.addEventListener('wheel', () => isUserInteracting = true);
}

function calibrateKnee() { alert('Funzione non disponibile'); }
function clearAllData() { if(confirm('Pulire tutto?')) fetch('/api/clear', {method:'POST'}); }
