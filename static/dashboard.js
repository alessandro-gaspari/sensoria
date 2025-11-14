// sensoria-optimized.js
// Versione ottimizzata per 100 Hz (batching ogni 10 ms, cache DOM completa, update differenziale)

var socket = io({
    reconnection: true,
    reconnectionDelay: 100,
    reconnectionDelayMax: 1000,
    reconnectionAttempts: 5,
    transports: ['websocket'],
    upgrade: false,
});

// Stato applicazione
var sensors = {};            // dati sensori correnti (ultima snapshot ricevuta)
var pendingUpdates = {};     // buffer di update in attesa di essere applicati (key = sensorName)
var domCache = {};           // cache degli elementi DOM per sensore (key = sensorName)
var isConnected = false;

// Statistiche
var frameCount = 0;
var currentFps = 0;
var lastFpsTime = Date.now();

// Scheduler: batch apply a 10ms => 100 Hz
var BATCH_INTERVAL_MS = 10;

// --- Init on DOM ready
document.addEventListener('DOMContentLoaded', function() {
    initializeSocketListeners();
    fetchInitialData();
    startFpsCounter();
    startBatchLoop();
});

// --- Batch loop 100Hz
function startBatchLoop() {
    setInterval(function() {
        // se non ci sono pending, skip veloce
        if (!hasPending()) return;

        // Applica tutti gli aggiornamenti differenziali
        // Usiamo for..in per evitare Object.keys() costose
        for (var sensorName in pendingUpdates) {
            // copia reference (evitiamo mutate esterne)
            var data = pendingUpdates[sensorName];
            applyUpdate(sensorName, data);
        }

        // svuota il buffer (nuova object per evitare costose clear di proprietà)
        pendingUpdates = {};
    }, BATCH_INTERVAL_MS);
}

function hasPending() {
    // check veloce senza creare array
    for (var k in pendingUpdates) return true;
    return false;
}

// --- Applica update differenziale e minimale sul DOM
function applyUpdate(sensorName, data) {
    // mantieni copia nel sensors (ultima snapshot)
    sensors[sensorName] = data;

    // assicurati che la card esista e sia in cache, altrimenti creala al volo
    if (!domCache[sensorName]) {
        var card = document.querySelector('[data-sensor="' + sensorName + '"]');
        if (!card) {
            // se non esiste la creiamo immediatamente (sincrono)
            createSensorCardDynamic(sensorName, data);
            // query again
            card = document.querySelector('[data-sensor="' + sensorName + '"]');
            if (!card) return; // qualcosa è andato storto
        }
        cacheDomForCard(sensorName, card);
    }

    var cache = domCache[sensorName];
    var last = cache.lastValues;

    // Aggiorna solo i campi che sono cambiati
    // Le righe hanno dataset.key = key: possiamo iterare sulle proprietà di "data"
    for (var key in data) {
        if (key === 'timestamp' || key === 'sensor_name') continue;
        // round rapido: |0 per int, ma manteniamo Math.round per sicurezza in caso di float large
        var newVal = Math.round(data[key]);

        // confronto con last cache (undefined ok)
        if (last[key] !== newVal) {
            last[key] = newVal;
            var el = cache.fields[key];
            if (el) {
                // solo update textContent (no innerHTML)
                el.textContent = newVal;

                // logica di classe per pressure_*
                if (key.indexOf('pressure_') === 0) {
                    // class toggling minimale: solo rimuoviamo e aggiungiamo se necessario
                    var cls = (newVal > 5000) ? 'high' : (newVal > 1000 ? 'medium' : 'low');
                    // per essere super performanti, scriviamo la classe completa
                    // lasciamo 'sensor-value' come base (className meno costoso che classList for many ops)
                    el.className = 'sensor-value ' + cls;
                }
            }
        }
    }

    // timestamp update (solo se diverso)
    if (data.timestamp && cache.timestamp) {
        var t = new Date(data.timestamp);
        // formato hh:mm:ss
        var timeStr = pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds());
        if (cache.timestamp.textContent !== timeStr) {
            cache.timestamp.textContent = timeStr;
        }
    }

    // status indicator: attiva e poi disattiva in breve
    if (cache.status) {
        if (!cache.status.classList.contains('active')) {
            cache.status.classList.add('active');
        }
        if (cache.status._timeout) clearTimeout(cache.status._timeout);
        cache.status._timeout = setTimeout(function(st) {
            return function() { st.classList.remove('active'); };
        }(cache.status), 50);
    }
}

// --- Cache DOM per una card sensor (estraiamo elementi utili e mapping fields)
function cacheDomForCard(sensorName, card) {
    var cacheObj = {
        card: card,
        fields: {},        // map key -> element (span.sensor-value)
        timestamp: card.querySelector('.sensor-timestamp'),
        status: card.querySelector('.status-indicator'),
        lastValues: {}     // ultimo valore noto (per confronto)
    };

    // ogni .sensor-data-row deve avere data-key impostato alla chiave (creato nella create)
    card.querySelectorAll('.sensor-data-row').forEach(function(row) {
        var k = row.dataset.key;
        if (!k) return;
        var v = row.querySelector('.sensor-value');
        if (v) cacheObj.fields[k] = v;
    });

    domCache[sensorName] = cacheObj;
}

// --- Creazione dinamica della card (DOM building performante)
function createSensorCardDynamic(sensorName, data) {
    var grid = document.getElementById('sensors-grid');
    if (!grid) return;

    var emoji = getSensorEmoji(sensorName);

    // container
    var wrapper = document.createElement('div');
    wrapper.className = 'sensor-col connected';
    wrapper.setAttribute('data-sensor', sensorName);

    // header
    var header = document.createElement('div');
    header.className = 'sensor-header';

    var title = document.createElement('div');
    title.textContent = emoji + ' ' + sensorName;

    var status = document.createElement('div');
    status.className = 'status-indicator active';

    header.appendChild(title);
    header.appendChild(status);
    wrapper.appendChild(header);

    // fields container
    var fieldsContainer = document.createElement('div');
    fieldsContainer.className = 'sensor-fields';

    // raccogliamo keys per IMU / pressure
    var imuKeys = [], pressureKeys = [], otherKeys = [];
    for (var k in data) {
        if (k === 'timestamp' || k === 'sensor_name') continue;
        if (k.indexOf('accel_') === 0 || k.indexOf('gyro_') === 0 || k.indexOf('mag_') === 0) imuKeys.push(k);
        else if (k.indexOf('pressure_') === 0) pressureKeys.push(k);
        else otherKeys.push(k);
    }

    // helper per creare righe
    function makeSection(titleText, keysArray, addLowClassForPressure) {
        if (keysArray.length === 0) return;
        var section = document.createElement('div');
        section.className = 'sensor-data-section';

        var st = document.createElement('div');
        st.className = 'sensor-data-section-title';
        st.textContent = titleText;
        section.appendChild(st);

        for (var i = 0; i < keysArray.length; i++) {
            var key = keysArray[i];
            var row = document.createElement('div');
            row.className = 'sensor-data-row';
            row.dataset.key = key;

            var label = document.createElement('span');
            label.className = 'sensor-data-label';
            label.textContent = key + ':';

            var value = document.createElement('span');
            value.className = 'sensor-value' + (addLowClassForPressure ? ' low' : '');
            value.textContent = '0';

            row.appendChild(label);
            row.appendChild(value);
            section.appendChild(row);
        }

        fieldsContainer.appendChild(section);
    }

    makeSection('📊 IMU Data', imuKeys, false);
    makeSection('⬇️ Pressione (S0-S7)', pressureKeys.sort(), true);
    if (otherKeys.length) makeSection('Dati', otherKeys, false);

    wrapper.appendChild(fieldsContainer);

    // timestamp
    var ts = document.createElement('span');
    ts.className = 'sensor-timestamp';
    ts.textContent = '--:--:--';
    wrapper.appendChild(ts);

    // append in documentFragment per performance
    grid.appendChild(wrapper);

    // aggiorna empty state
    var emptyState = document.getElementById('empty-state');
    if (emptyState) {
        emptyState.classList.remove('visible');
        grid.style.display = 'grid';
    }

    // cache DOM immediatamente per risparmi in next update
    cacheDomForCard(sensorName, wrapper);
}

// --- Socket listeners (minimo overhead)
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
        if (data && data.sensors) {
            // Sovrascriviamo sensors con la snapshot iniziale
            sensors = data.sensors;
            renderSensors(); // costruisce tutte le card e cache DOM
        }
    });

    socket.on('sensor_update', function(data) {
        // dati arrivano a ritmo elevato: minimizziamo lavoro qui
        if (!data || !data.sensor_name) return;
        frameCount++;

        var sensorName = data.sensor_name;
        // Mettiamo nel buffer l'ultima snapshot ricevuta per il sensore
        pendingUpdates[sensorName] = data;
        // Nota: non facciamo render sincrono qui
    });

    socket.on('sensor_disconnected', function(data) {
        if (!data || !data.sensor_name) return;
        var name = data.sensor_name;
        delete sensors[name];
        delete pendingUpdates[name];

        // rimuovi DOM e cache
        var card = document.querySelector('[data-sensor="' + name + '"]');
        if (card) card.remove();
        if (domCache[name]) delete domCache[name];

        renderSensors(); // ricrea lo stato visuale (senz'altro rapido se pochi sensori)
    });

    socket.on('data_cleared', function() {
        sensors = {};
        pendingUpdates = {};
        domCache = {};
        renderSensors();
    });
}

// --- Render initial sensors (ricrea tutto: usata su init o clear)
function renderSensors() {
    var grid = document.getElementById('sensors-grid');
    var emptyState = document.getElementById('empty-state');
    if (!grid || !emptyState) return;

    // svuota DOM
    grid.innerHTML = '';
    domCache = {};      // reset cache
    pendingUpdates = {}; // puliamo buffer per non applicare snapshot vecchie

    var sensorNamesExist = false;
    for (var name in sensors) {
        sensorNamesExist = true;
        createSensorCardDynamic(name, sensors[name]);
    }

    if (!sensorNamesExist) {
        grid.style.display = 'none';
        emptyState.classList.add('visible');
    } else {
        grid.style.display = 'grid';
        emptyState.classList.remove('visible');
    }

    updateConnectionStatus(isConnected);
}

// --- Fetch iniziale
function fetchInitialData() {
    fetch('/api/sensors')
        .then(function(response) { return response.json(); })
        .then(function(data) {
            sensors = data.sensors || {};
            renderSensors();
        })
        .catch(function() {
            // ignore fetch errors silently (puoi loggare se vuoi)
        });
}

// --- Connection status UI
function updateConnectionStatus(connected) {
    var statusEl = document.getElementById('connection-status');
    var countEl = document.getElementById('sensor-count');
    if (statusEl) {
        statusEl.innerHTML = connected ? '<span class="dot"></span> Connesso' : '<span class="dot"></span> Disconnesso';
    }
    if (countEl) {
        // calcolo count veloce
        var c = 0;
        for (var k in sensors) c++;
        countEl.textContent = c + ' Sensor' + (c !== 1 ? 'i' : 'e');
    }
}

// --- Utility: emoji
function getSensorEmoji(name) {
    var n = (name || '').toLowerCase();
    if (n.indexOf('ginocchio') !== -1 || n.indexOf('knee') !== -1) return '🦿';
    if (n.indexOf('piede') !== -1 || n.indexOf('foot') !== -1 || n.indexOf('calzino') !== -1) return '🧦';
    if (n.indexOf('braccio') !== -1) return '🦾';
    return '📱';
}

// --- Utility: pad 2 digits
function pad2(n) {
    return (n < 10 ? '0' : '') + n;
}

// --- FPS counter (mostra update rate delle update ricevute)
function startFpsCounter() {
    setInterval(function() {
        var now = Date.now();
        var elapsed = (now - lastFpsTime) / 1000;
        currentFps = Math.round(frameCount / elapsed) || 0;
        frameCount = 0;
        lastFpsTime = now;

        var fpsEl = document.getElementById('fps-counter');
        if (fpsEl) fpsEl.textContent = currentFps + ' Hz';
    }, 1000);
}

// --- Clear all data (UI action)
function clearAllData() {
    if (!confirm('Pulire dati?')) return;
    fetch('/api/clear', { method: 'POST' })
        .then(function() {
            sensors = {};
            pendingUpdates = {};
            domCache = {};
            renderSensors();
        });
}