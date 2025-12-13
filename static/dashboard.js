// ==========================================
// CONFIGURAZIONE GLOBALE
// ==========================================
var socket = io({ 
    transports: ['websocket'], 
    reconnection: true, 
    reconnectionDelay: 500 
});

var sensors = {};

// Mappa
var map = null;
var mapMarker = null;
var isMapInitialized = false;

// Grafici (uPlot)
var charts = { accel: null, gyro: null, mag: null, pressure: null };
var uPlots = []; // Array per il sync
var chartData = { 
    accel: [[],[],[],[]], 
    gyro: [[],[],[],[]], 
    mag: [[],[],[],[]], 
    pressure: [[],[],[],[]] 
};
var selectedSensor = null;
var chartsInitialized = false;

// Stato Interazione Utente (True = Pausa autoscroll, False = Live)
var isUserInteracting = false; 

// ==========================================
// INIZIALIZZAZIONE
// ==========================================
document.addEventListener('DOMContentLoaded', function() {
    initSocket();
    
    // Gestione Menu a tendina sensori
    var sel = document.getElementById('chart-sensor-select');
    if(sel) {
    sel.addEventListener('change', function(e) {
                selectedSensor = e.target.value || null;
                resetChartData();
                
                var container = document.getElementById('charts-container');
                if (selectedSensor) {
                    container.style.display = 'block'; // PRIMA
                    
                    if(!chartsInitialized) {
                        // Timeout tattico per il rendering
                        setTimeout(() => initCharts(), 10); 
                    } else {
                        // Se esistono già, forza il resize perché erano nascosti
                        var w = container.offsetWidth - 40;
                        uPlots.forEach(u => u.setSize({width: w, height: u.height}));
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

    // DATI SENSORI (Accel, Gyro, Mag, Press)
    socket.on('sensor_update', (data) => processIncomingData(data));
    
    // DATI BPM (Numero secco)
    socket.on('bpm_update', (val) => updateBpmUI(val));

    // DATI PROFILO E GPS
    socket.on('profile_update', (data) => updateProfileUI(data));
    socket.on('gps_update', (data) => updateMapUI(data));

    // PULIZIA (Nuova Sessione)
    socket.on('data_cleared', () => {
        sensors = {};
        document.getElementById('sensors-grid').innerHTML = '';
        
        // Reset UI
        showEmptyState(true);
        
        if(mapMarker) { map.removeLayer(mapMarker); mapMarker = null; }
        
        // Reset Grafici
        resetChartData(true); // true = cancella dati
        chartsInitialized = false;
        selectedSensor = null;
        
        // Pulisce DOM grafici
        ['accel-chart', 'gyro-chart', 'mag-chart', 'pressure-chart'].forEach(id => {
            var el = document.getElementById(id);
            if(el) el.innerHTML = '';
        });
    });
}

function showEmptyState(show) {
    var empty = document.getElementById('empty-state');
    var chartsCont = document.getElementById('charts-container');
    var mapSec = document.getElementById('map-section');
    var bpm = document.getElementById('bpm-display');

    if (show) {
        if(empty) empty.style.display = 'block';
        if(chartsCont) chartsCont.style.display = 'none';
        if(mapSec) mapSec.style.display = 'none'; // Nasconde mappa se reset
        if(bpm) bpm.style.display = 'none';
    } else {
        if(empty) empty.style.display = 'none';
    }
}

// ==========================================
// PARSING DATI
// ==========================================
function processIncomingData(data) {
    var payload = null;

    // 1. Tenta di estrarre il payload pulito
    if (typeof data === 'object') {
        payload = data.data || data;
    } else {
        // Fallback per stringhe sporche (se mai arrivassero ancora)
        try {
            var str = String(data);
            var s = str.indexOf('{');
            var e = str.lastIndexOf('}');
            if (s !== -1 && e !== -1) {
                payload = JSON.parse(str.substring(s, e + 1));
            }
        } catch (ex) {}
    }

    if (payload && payload.sensor_name) {
        // FIX: Appena arriva UN dato valido, nascondiamo "In attesa..."
        showEmptyState(false);

        var name = payload.sensor_name;
        
        // Aggiorna Logica
        if (name === 'PROFILE_INFO') { updateProfileUI(payload); return; }
        if (name === 'GPS' || name.includes('GPS')) { updateMapUI(payload); return; } // Caso GPS extra

        // È un sensore vero
        sensors[name] = payload;
        updateSensorCardUI(name, payload);
        
        // Se non abbiamo selezionato nulla, seleziona il primo automaticamente
        if (!selectedSensor) {
            selectedSensor = name;
            var sel = document.getElementById('chart-sensor-select');
            if(sel) {
                sel.value = name;
                // Forza evento change per mostrare i grafici
                sel.dispatchEvent(new Event('change')); 
            }
            var cCont = document.getElementById('charts-container');
            if (selectedSensor && cCont.style.display === 'none') {
                cCont.style.display = 'block';
            }
        }
        if (selectedSensor && !chartsInitialized) {
             // Piccolo timeout per dare tempo al browser di applicare display:block
             setTimeout(() => initCharts(), 10); 
        } else {
             updateChartsUI(name, payload);
        }
    }
}

// ==========================================
// UI: GRIGLIA SENSORI
// ==========================================
function updateSensorCardUI(name, data) {
    var grid = document.getElementById('sensors-grid');
    var card = document.querySelector(`[data-sensor="${name}"]`);
    
    // Se non esiste, crea la card
    if (!card) {
        if (data.accel_x === undefined && data.pressure_0 === undefined) return;
        
        card = document.createElement('div');
        card.className = 'sensor-card sensor-col connected'; 
        card.setAttribute('data-sensor', name);
        
        var emoji = '📱';
        var n = name.toLowerCase();
        if(n.includes('knee') || n.includes('ginocchio')) emoji = '🦿';
        if(n.includes('foot') || n.includes('sock') || n.includes('calzino')) emoji = '🧦';

        var html = `<div class="sensor-header">
                        <span>${emoji} ${name}</span>
                        <div class="status-indicator active"></div>
                    </div>`;
        
        // Sezioni dati (Accel, Gyro, Mag, Pressure)
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
        card.innerHTML = html;
        grid.appendChild(card);
        updateSelector();
    }

    // Aggiorna valori
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
    
    // Ricostruisci opzioni mantenedo selezione
    sel.innerHTML = '<option value="">-- Seleziona sensore --</option>';
    names.forEach(n => {
        var opt = document.createElement('option');
        opt.value = n; opt.textContent = n;
        if(n === current) opt.selected = true;
        sel.appendChild(opt);
    });
    
    if (names.length > 0) container.style.display = 'block';
}

// ==========================================
// UI: PROFILO, BPM, MAPPA
// ==========================================
function updateProfileUI(data) {
    var div = document.getElementById('user-profile-display');
    if (!data.name || !div) return;
    div.style.display = 'flex';
    document.getElementById('profile-name').textContent = data.name.toUpperCase();
    document.getElementById('profile-avatar').textContent = "👤";
    var gender = data.gender === 'M' ? '♂' : (data.gender === 'F' ? '♀' : '');
    document.getElementById('profile-details').textContent = `${data.age} anni | ${data.weight} kg | ${gender}`;
}

function updateBpmUI(val) {
    var div = document.getElementById('bpm-display');
    var mapSection = document.getElementById('map-section');
    
    val = parseInt(val);
    if (val > 0) {
        // Assicura visibilità
        if (mapSection && mapSection.style.display === 'none') {
            mapSection.style.display = 'block';
            if(!isMapInitialized) initMap();
        }
        if(div) {
            div.style.display = 'flex';
            var valEl = document.getElementById('bpm-value');
            if(valEl) valEl.textContent = val;
            
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
    
    // FIX: attributionControl: false per togliere la scritta
    map = L.map('map', { attributionControl: false }).setView([41.9028, 12.4964], 5);
    
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { 
        maxZoom: 20 
    }).addTo(map);
    
    isMapInitialized = true;
    setTimeout(() => map.invalidateSize(), 100);
}

function updateMapUI(data) {
    var section = document.getElementById('map-section');
    if(section) section.style.display = 'block';

    if (!isMapInitialized) {
        map = L.map('map', { attributionControl: false }).setView([data.latitude, data.longitude], 15);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 20 }).addTo(map);
        isMapInitialized = true;
        setTimeout(() => map.invalidateSize(), 100);
    }

    var latlng = [data.latitude, data.longitude];
    var accEl = document.getElementById('gps-accuracy');
    if(accEl) accEl.textContent = Math.round(data.accuracy);

    // FIX: MARKER PULSANTE VERDE
    if (!mapMarker) {
        var pulseIcon = L.divIcon({
            className: 'custom-div-icon', 
            html: "<div class='pulsating-marker'></div>", // Definito nel CSS
            iconSize: [24, 24], 
            iconAnchor: [12, 12] 
        });
        mapMarker = L.marker(latlng, {icon: pulseIcon}).addTo(map);
        map.panTo(latlng);
    } else {
        mapMarker.setLatLng(latlng);
    }
}

// ==========================================
// GRAFICI (uPlot) - SYNC & LOCK
// ==========================================
// Funzione Helper Opzioni Comuni
function getCommonOpts(title, seriesLabels, seriesColors, height) {
    // CALCOLA LARGHEZZA REALE O FALLBACK A 800px SE NASCOSTO
    var containerWidth = document.getElementById('charts-container').offsetWidth || 800; 
    
    return {
        title: title,
        width: containerWidth - 40, // Margine di sicurezza
        height: height || 200,
        // ... (resto delle opzioni cursore/scale identiche a prima) ...
        cursor: {
            drag: { x: true, y: false, uni: 50 },
            sync: { key: "mooviti_sync" }, 
            focus: { prox: 30 }
        },
        scales: {
            x: { time: true, auto: false },
            y: { auto: true }
        },
        series: [
            {},
            { label: seriesLabels[0], stroke: seriesColors[0], width: 2 },
            { label: seriesLabels[1], stroke: seriesColors[1], width: 2 },
            { label: seriesLabels[2], stroke: seriesColors[2], width: 2 }
        ],
        axes: [
            { stroke: '#97c93e', grid: { stroke: '#333' }, space: 100 },
            { stroke: '#97c93e', grid: { stroke: '#333' }, size: 60 }
        ],
        plugins: [
            // ... (copia qui il plugin init/wheel che ti ho dato prima) ...
             {
                hooks: {
                    init: u => {
                        u.over.addEventListener("dblclick", () => {
                            isUserInteracting = false;
                            var xData = u.data[0];
                            if (xData && xData.length > 0) {
                                var last = xData[xData.length - 1];
                                uPlot.sync("mooviti_sync").setScale('x', { min: last - 10, max: last });
                            }
                        });
                        u.over.addEventListener("wheel", e => {
                            e.preventDefault();
                            isUserInteracting = true;
                            var { left, width } = u.cursor;
                            var { min, max } = u.scales.x;
                            var range = max - min;
                            var oxRange = (e.clientX - u.bbox.left) / u.bbox.width * range; 
                            var factor = e.deltaY < 0 ? 0.9 : 1.1;
                            var newRange = range * factor;
                            if (newRange < 0.5) newRange = 0.5;
                            var newMin = min + oxRange - (oxRange / range) * newRange;
                            var newMax = newMin + newRange;
                            
                            var xData = u.data[0];
                            if (xData && xData.length > 0) {
                                var dataMin = xData[0];
                                var dataMax = xData[xData.length - 1];
                                if (newMin < dataMin) newMin = dataMin;
                                if (newMax > dataMax) newMax = dataMax;
                                if ((newMax - newMin) > (dataMax - dataMin)) {
                                    newMin = dataMin; newMax = dataMax;
                                }
                            }
                            uPlot.sync("mooviti_sync").setScale('x', { min: newMin, max: newMax });
                        });
                        u.over.addEventListener("mousedown", () => isUserInteracting = true);
                    }
                }
            }
        ]
    };
}

function initCharts() {
    var divA = document.getElementById('accel-chart');
    var divG = document.getElementById('gyro-chart');
    var divM = document.getElementById('mag-chart');
    var divP = document.getElementById('pressure-chart');
    
    // IMPORTANTE: Se il container è nascosto, non possiamo inizializzare correttamente le dimensioni.
    // Ma se siamo qui, assumiamo che charts-container sia già 'block'.
    
    if(!divA || chartsInitialized) return;
    
    divA.innerHTML = ""; divG.innerHTML = ""; divM.innerHTML = ""; divP.innerHTML = "";
    uPlots = [];

    charts.accel = new uPlot(getCommonOpts("ACCELEROMETRO", ['AX','AY','AZ'], ['#ff6384','#36a2eb','#4bc0c0']), chartData.accel, divA);
    charts.gyro  = new uPlot(getCommonOpts("GIROSCOPIO",    ['GX','GY','GZ'], ['#ff9f40','#9966ff','#ffcd56']), chartData.gyro,  divG);
    charts.mag   = new uPlot(getCommonOpts("MAGNETOMETRO",  ['MX','MY','MZ'], ['#c9cbcf','#4bc0c0','#ff6384']), chartData.mag,   divM);

    var pOpts = getCommonOpts("PRESSIONI", ['P0','P1','P2'], ['#ff6384','#36a2eb','#ffce56'], 250);
    pOpts.scales.y = { auto: false, range: [0, 1024] };
    charts.pressure = new uPlot(pOpts, chartData.pressure, divP);

    uPlots.push(charts.accel, charts.gyro, charts.mag, charts.pressure);
    chartsInitialized = true;
    
    // FIX FINALE: Aggiungi un resize observer per adattare i grafici se la finestra cambia
    window.addEventListener("resize", () => {
        var w = document.getElementById('charts-container').offsetWidth - 40;
        uPlots.forEach(u => u.setSize({ width: w, height: u.height }));
    });
}

function updateChartsUI(sensorName, data) {
    if (selectedSensor !== sensorName || !chartsInitialized) return;

    var now = Date.now() / 1000;
    
    // Funzione push
    const push = (arr, vals) => {
        arr[0].push(now);
        vals.forEach((v, i) => arr[i+1].push(v || 0));
        // NOTA: Non rimuoviamo mai dati (maxDataPoints = infinito) per richiesta utente
    };

    if (data.accel_x !== undefined && charts.accel) {
        push(chartData.accel, [data.accel_x, data.accel_y, data.accel_z]);
        charts.accel.setData(chartData.accel);
    }
    if (data.gyro_x !== undefined && charts.gyro) {
        push(chartData.gyro, [data.gyro_x, data.gyro_y, data.gyro_z]);
        charts.gyro.setData(chartData.gyro);
    }
    if (data.mag_x !== undefined && charts.mag) {
        push(chartData.mag, [data.mag_x, data.mag_y, data.mag_z]);
        charts.mag.setData(chartData.mag);
    }
    
    // Pressioni
    if (data.pressure_0 !== undefined && charts.pressure) {
        push(chartData.pressure, [data.pressure_0, data.pressure_1, data.pressure_2]);
        charts.pressure.setData(chartData.pressure);
        document.getElementById('pressure-chart-container').style.display = 'block';
    } else {
        document.getElementById('pressure-chart-container').style.display = 'none';
    }

    // AUTO-SCROLL
    if (!isUserInteracting) {
        var windowSize = 10; 
        var minX = now - windowSize;
        
        // Muovi tutti i grafici insieme
        uPlot.sync("mooviti_sync").setScale('x', { min: minX, max: now });
    }
}

function resetChartData(clearAll = false) {
    isUserInteracting = false;
    if (clearAll) {
        chartData = { 
            accel: [[],[],[],[]], gyro: [[],[],[],[]], mag: [[],[],[],[]], pressure: [[],[],[],[]] 
        };
    }
    
    if(!chartsInitialized) return;
    if(charts.accel) charts.accel.setData(chartData.accel);
    if(charts.gyro) charts.gyro.setData(chartData.gyro);
    if(charts.mag) charts.mag.setData(chartData.mag);
    if(charts.pressure) charts.pressure.setData(chartData.pressure);
}

function clearAllData() { if(confirm('Pulire tutto?')) fetch('/api/clear', {method:'POST'}); }
