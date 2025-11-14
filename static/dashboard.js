// sensoria-100hz-graph.js
// Versione completa: batch 100Hz, socket, UI ottimizzato e grafico realtime (100Hz)

(function () {
    'use strict';

    // =========================
    // CONFIG
    // =========================
    const TICK_MS = 10; // 100 Hz
    const STATUS_BLINK_MS = 50;
    const CHART_SAMPLERATE_MS = 10; // 100Hz, allineato a TICK_MS
    const CHART_HISTORY_SECONDS = 5; // quanti secondi mostrare sul grafico
    const MAX_POINTS = Math.ceil(CHART_HISTORY_SECONDS * 1000 / CHART_SAMPLERATE_MS);

    // Lista sensori di default (se vuoi la prendi dalla connessione iniziale)
    // Puoi lasciare vuoto e verranno creati quando arrivano dati
    var sensorIds = []; // popoleremo da /api o socket

    // =========================
    // STATO E CACHE
    // =========================
    var sensors = {};          // ultima snapshot per sensore { sensorName: data }
    var pendingUpdates = {};   // buffer aggiornamenti in arrivo { sensorName: data }
    var domCache = {};         // cache DOM per sensore { sensorName: {fields,timestamp,status,lastValues,card} }
    var isConnected = false;
    var frameCount = 0;
    var lastFpsTime = Date.now();
    var currentFps = 0;

    // Chart data per sensor (circular buffer)
    var chartBuffers = {}; // sensorName -> {buffer: Float32Array, head: int, length: int}
    var selectedSensor = null;

    // Canvas / drawing
    var canvas, canvasCtx, canvasW, canvasH, devicePixelRatio = window.devicePixelRatio || 1;

    // =========================
    // SOCKET.IO
    // =========================
    var socket = io({
        reconnection: true,
        reconnectionDelay: 100,
        reconnectionDelayMax: 1000,
        transports: ['websocket'],
        upgrade: false
    });

    socket.on('connect', function () {
        isConnected = true;
        updateConnectionStatus(true);
    });
    socket.on('disconnect', function () {
        isConnected = false;
        updateConnectionStatus(false);
    });

    // supporta due formati: "connection_response" con snapshot o "sensor_update"/"sensor_data"
    socket.on('connection_response', function (data) {
        if (data && data.sensors) {
            sensors = data.sensors;
            sensorIds = Object.keys(sensors);
            renderSensors(); // build UI initial
        }
    });

    socket.on('sensor_data', function (data) {
        // expected: { sensor_name: '...', ...fields... } or batch object
        if (!data) return;
        // If server sends an object of many sensors, handle gracefully
        if (data.sensors && typeof data.sensors === 'object') {
            for (var n in data.sensors) {
                pendingUpdates[n] = data.sensors[n];
            }
        } else if (data.sensor_name) {
            pendingUpdates[data.sensor_name] = data;
        }
        frameCount++;
    });

    socket.on('sensor_update', function (data) {
        if (!data) return;
        if (data.sensor_name) {
            pendingUpdates[data.sensor_name] = data;
            frameCount++;
        }
    });

    socket.on('sensor_disconnected', function (data) {
        if (!data || !data.sensor_name) return;
        var name = data.sensor_name;
        delete sensors[name];
        delete pendingUpdates[name];
        removeSensorDom(name);
        // if removed sensor was selected for chart, switch to another
        if (selectedSensor === name) {
            selectedSensor = sensorIds.length ? sensorIds[0] : null;
        }
        updateConnectionStatus(isConnected);
    });

    socket.on('data_cleared', function () {
        sensors = {};
        pendingUpdates = {};
        domCache = {};
        chartBuffers = {};
        sensorIds = [];
        selectedSensor = null;
        renderSensors(); // clear UI
    });

    // =========================
    // INIT
    // =========================
    document.addEventListener('DOMContentLoaded', function () {
        ensureBaseDOM();
        fetchInitialData();
        startBatchLoop();
        startFpsCounter();
        initChartCanvas(); // prepara canvas - crea se non presente
        startChartLoop();
    });

    // =========================
    // FETCH INIZIALE
    // =========================
    function fetchInitialData() {
        fetch('/api/sensors')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data && data.sensors) {
                    sensors = data.sensors;
                    sensorIds = Object.keys(sensors);
                    renderSensors();
                }
            })
            .catch(function () {
                // ignore
            });
    }

    // =========================
    // BATCH LOOP 100Hz (UI updates + chart buffer push)
    // =========================
    function startBatchLoop() {
        setInterval(function () {
            if (!hasPending()) return;

            // per ogni sensore in pending, applichiamo
            for (var name in pendingUpdates) {
                var snapshot = pendingUpdates[name];

                // aggiorniamo stato globale
                sensors[name] = snapshot;

                // se non esiste nella lista sensori -> nuovo sensore
                if (sensorIds.indexOf(name) === -1) {
                    sensorIds.push(name);
                }

                // appendiamo al buffer grafico il valore da tracciare (scegliamo la prima numeric property utile)
                ensureChartBufferFor(name);
                pushSampleToChart(name, selectPrimaryValue(snapshot));

                // aggiorniamo la UI (differenziale)
                applyUpdateToDom(name, snapshot);
            }

            // svuotiamo il buffer
            pendingUpdates = {};
        }, TICK_MS);
    }

    function hasPending() {
        for (var k in pendingUpdates) return true;
        return false;
    }

    // =========================
    // DOM: assicurati che elementi base esistano
    // =========================
    function ensureBaseDOM() {
        // sensors-grid
        if (!document.getElementById('sensors-grid')) {
            var g = document.createElement('div');
            g.id = 'sensors-grid';
            // default minimal styles if not present (l'utente può sovrascrivere nel CSS)
            g.style.display = 'grid';
            g.style.gridTemplateColumns = 'repeat(auto-fill, minmax(220px, 1fr))';
            g.style.gap = '10px';
            document.body.appendChild(g);
        }
        if (!document.getElementById('empty-state')) {
            var e = document.createElement('div');
            e.id = 'empty-state';
            e.textContent = 'Nessun sensore connesso';
            e.className = 'visible';
            document.body.appendChild(e);
        }
        // fps-counter
        if (!document.getElementById('fps-counter')) {
            var f = document.createElement('div');
            f.id = 'fps-counter';
            f.style.position = 'fixed';
            f.style.right = '10px';
            f.style.top = '10px';
            f.style.background = 'rgba(0,0,0,0.5)';
            f.style.color = '#fff';
            f.style.padding = '4px 8px';
            f.style.borderRadius = '6px';
            document.body.appendChild(f);
        }
        // connection-status
        if (!document.getElementById('connection-status')) {
            var s = document.createElement('div');
            s.id = 'connection-status';
            s.style.position = 'fixed';
            s.style.left = '10px';
            s.style.top = '10px';
            s.style.background = 'rgba(0,0,0,0.5)';
            s.style.color = '#fff';
            s.style.padding = '4px 8px';
            s.style.borderRadius = '6px';
            document.body.appendChild(s);
        }
        // sensor-count
        if (!document.getElementById('sensor-count')) {
            var c = document.createElement('div');
            c.id = 'sensor-count';
            c.style.position = 'fixed';
            c.style.left = '10px';
            c.style.top = '44px';
            c.style.background = 'rgba(0,0,0,0.25)';
            c.style.color = '#fff';
            c.style.padding = '4px 8px';
            c.style.borderRadius = '6px';
            document.body.appendChild(c);
        }
        // canvas for chart
        if (!document.getElementById('realtime-chart')) {
            var canvasEl = document.createElement('canvas');
            canvasEl.id = 'realtime-chart';
            canvasEl.style.position = 'fixed';
            canvasEl.style.right = '10px';
            canvasEl.style.bottom = '10px';
            canvasEl.style.width = '480px';
            canvasEl.style.height = '160px';
            canvasEl.style.border = '1px solid rgba(0,0,0,0.2)';
            canvasEl.style.background = '#0b1220';
            document.body.appendChild(canvasEl);
        }
    }

    // =========================
    // Render (crea tutte le card sensori)
    // =========================
    function renderSensors() {
        var grid = document.getElementById('sensors-grid');
        var emptyState = document.getElementById('empty-state');
        if (!grid || !emptyState) return;

        grid.innerHTML = '';
        domCache = {};
        chartBuffers = {};
        selectedSensor = null;

        var any = false;
        for (var name in sensors) {
            any = true;
            createSensorCard(name, sensors[name]);
        }

        if (!any) {
            grid.style.display = 'none';
            emptyState.classList.add('visible');
        } else {
            grid.style.display = 'grid';
            emptyState.classList.remove('visible');
        }

        updateConnectionStatus(isConnected);
    }

    function createSensorCard(name, data) {
        var grid = document.getElementById('sensors-grid');
        if (!grid) return;

        var wrapper = document.createElement('div');
        wrapper.className = 'sensor-col connected';
        wrapper.setAttribute('data-sensor', name);
        wrapper.style.padding = '8px';
        wrapper.style.borderRadius = '8px';
        wrapper.style.background = '#fff';
        wrapper.style.boxShadow = '0 1px 3px rgba(0,0,0,0.08)';
        wrapper.style.fontFamily = 'sans-serif';

        // header
        var header = document.createElement('div');
        header.className = 'sensor-header';
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.style.marginBottom = '6px';

        var title = document.createElement('div');
        title.textContent = getSensorEmoji(name) + ' ' + name;
        title.style.fontWeight = '600';

        var status = document.createElement('div');
        status.className = 'status-indicator active';
        status.style.width = '10px';
        status.style.height = '10px';
        status.style.borderRadius = '50%';
        status.style.background = '#2ecc71';

        header.appendChild(title);
        header.appendChild(status);
        wrapper.appendChild(header);

        // fields
        var fieldsContainer = document.createElement('div');
        fieldsContainer.className = 'sensor-fields';

        // determiniamo keys
        var keys = [];
        for (var k in data) {
            if (k === 'timestamp' || k === 'sensor_name') continue;
            keys.push(k);
        }
        // sort for stability
        keys.sort();

        keys.forEach(function (key) {
            var row = document.createElement('div');
            row.className = 'sensor-data-row';
            row.dataset.key = key;
            row.style.display = 'flex';
            row.style.justifyContent = 'space-between';
            row.style.padding = '2px 0';
            row.style.fontSize = '13px';

            var label = document.createElement('span');
            label.className = 'sensor-data-label';
            label.textContent = key + ':';

            var value = document.createElement('span');
            value.className = 'sensor-value';
            value.textContent = '0';

            row.appendChild(label);
            row.appendChild(value);
            fieldsContainer.appendChild(row);
        });

        wrapper.appendChild(fieldsContainer);

        // timestamp
        var ts = document.createElement('span');
        ts.className = 'sensor-timestamp';
        ts.textContent = '--:--:--';
        ts.style.display = 'block';
        ts.style.marginTop = '6px';
        ts.style.fontSize = '12px';
        ts.style.color = '#666';
        wrapper.appendChild(ts);

        // click to select for chart
        wrapper.style.cursor = 'pointer';
        wrapper.addEventListener('click', function () {
            selectedSensor = name;
            // visual feedback
            highlightSelectedCard(name);
        });

        grid.appendChild(wrapper);

        // cache immediately
        cacheDomForCard(name, wrapper);

        // ensure chart buffer
        ensureChartBufferFor(name);

        // if no sensor selected, select first
        if (!selectedSensor) selectedSensor = name;

        // update connection status count
        updateConnectionStatus(isConnected);
    }

    function cacheDomForCard(sensorName, card) {
        var cacheObj = {
            card: card,
            fields: {},
            timestamp: card.querySelector('.sensor-timestamp'),
            status: card.querySelector('.status-indicator'),
            lastValues: {}
        };

        card.querySelectorAll('.sensor-data-row').forEach(function (row) {
            var k = row.dataset.key;
            if (!k) return;
            var v = row.querySelector('.sensor-value');
            if (v) cacheObj.fields[k] = v;
        });

        domCache[sensorName] = cacheObj;
    }

    function removeSensorDom(sensorName) {
        var card = document.querySelector('[data-sensor="' + sensorName + '"]');
        if (card) card.remove();
        if (domCache[sensorName]) delete domCache[sensorName];
        if (chartBuffers[sensorName]) delete chartBuffers[sensorName];
        var idx = sensorIds.indexOf(sensorName);
        if (idx !== -1) sensorIds.splice(idx, 1);
    }

    // =========================
    // APPLY UPDATE (differenziale, minimale)
    // =========================
    function applyUpdateToDom(sensorName, data) {
        // create card if not present
        if (!domCache[sensorName]) {
            var card = document.querySelector('[data-sensor="' + sensorName + '"]');
            if (!card) {
                createSensorCard(sensorName, data);
                // ensure cache
                card = document.querySelector('[data-sensor="' + sensorName + '"]');
                if (!card) return;
            } else {
                cacheDomForCard(sensorName, card);
            }
        }

        var cache = domCache[sensorName];
        var last = cache.lastValues;

        for (var key in data) {
            if (key === 'timestamp' || key === 'sensor_name') continue;
            var newVal = Math.round(data[key]);
            if (last[key] !== newVal) {
                last[key] = newVal;
                var el = cache.fields[key];
                if (el) el.textContent = newVal;
                // pressure style
                if (key.indexOf('pressure_') === 0 && el) {
                    var cls = (newVal > 5000) ? 'high' : (newVal > 1000 ? 'medium' : 'low');
                    el.className = 'sensor-value ' + cls;
                }
            }
        }

        if (data.timestamp && cache.timestamp) {
            var d = new Date(data.timestamp);
            var ts = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
            if (cache.timestamp.textContent !== ts) cache.timestamp.textContent = ts;
        }

        if (cache.status) {
            cache.status.style.background = '#2ecc71';
            if (cache.status._timeout) clearTimeout(cache.status._timeout);
            cache.status._timeout = setTimeout(function (s) {
                return function () { s.style.background = '#ddd'; };
            }(cache.status), STATUS_BLINK_MS);
        }
    }

    // =========================
    // CONNECTION UI
    // =========================
    function updateConnectionStatus(connected) {
        var statusEl = document.getElementById('connection-status');
        var countEl = document.getElementById('sensor-count');
        if (statusEl) {
            statusEl.innerHTML = connected ? '<span class="dot" style="color:#2ecc71">●</span> Connesso' : '<span class="dot" style="color:#e74c3c">●</span> Disconnesso';
        }
        if (countEl) {
            var c = 0;
            for (var k in sensors) c++;
            countEl.textContent = c + ' Sensor' + (c !== 1 ? 'i' : 'e');
        }
    }

    // =========================
    // FPS counter (aggiornamenti ricevuti)
    // =========================
    function startFpsCounter() {
        setInterval(function () {
            var now = Date.now();
            var elapsed = (now - lastFpsTime) / 1000;
            currentFps = Math.round(frameCount / elapsed) || 0;
            frameCount = 0;
            lastFpsTime = now;
            var el = document.getElementById('fps-counter');
            if (el) el.textContent = currentFps + ' Hz';
        }, 1000);
    }

    // =========================
    // Chart: inizializzazione e loop (100Hz)
    // =========================
    function initChartCanvas() {
        canvas = document.getElementById('realtime-chart');
        if (!canvas) return;
        canvasCtx = canvas.getContext('2d');

        resizeCanvasToDisplaySize();
        window.addEventListener('resize', resizeCanvasToDisplaySize);
    }

    function resizeCanvasToDisplaySize() {
        if (!canvas) return;
        // match CSS size to pixel size for crisp lines
        var rect = canvas.getBoundingClientRect();
        canvasW = Math.max(100, Math.floor(rect.width));
        canvasH = Math.max(40, Math.floor(rect.height));
        canvas.width = Math.floor(canvasW * devicePixelRatio);
        canvas.height = Math.floor(canvasH * devicePixelRatio);
        canvas.style.width = canvasW + 'px';
        canvas.style.height = canvasH + 'px';
        canvasCtx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    }

    function startChartLoop() {
        setInterval(function () {
            // disegna il grafico per selectedSensor
            if (!canvas || !canvasCtx) return;
            if (!selectedSensor) {
                drawEmptyChart();
                return;
            }
            drawChartFor(selectedSensor);
        }, CHART_SAMPLERATE_MS);
    }

    function drawEmptyChart() {
        canvasCtx.clearRect(0, 0, canvasW, canvasH);
        canvasCtx.fillStyle = '#07101a';
        canvasCtx.fillRect(0, 0, canvasW, canvasH);
        canvasCtx.fillStyle = '#7f8c8d';
        canvasCtx.font = '12px sans-serif';
        canvasCtx.fillText('Nessun sensore selezionato', 10, 20);
    }

    function drawChartFor(sensorName) {
        var bufObj = chartBuffers[sensorName];
        if (!bufObj) {
            drawEmptyChart();
            return;
        }
        var buffer = bufObj.buffer;
        var len = bufObj.length;
        var head = bufObj.head;

        // background
        canvasCtx.clearRect(0, 0, canvasW, canvasH);
        canvasCtx.fillStyle = '#07101a';
        canvasCtx.fillRect(0, 0, canvasW, canvasH);

        // axis grid simple
        canvasCtx.strokeStyle = 'rgba(255,255,255,0.06)';
        canvasCtx.lineWidth = 1;
        canvasCtx.beginPath();
        for (var g = 1; g <= 3; g++) {
            var y = (canvasH / 4) * g;
            canvasCtx.moveTo(0, y);
            canvasCtx.lineTo(canvasW, y);
        }
        canvasCtx.stroke();

        // compute min/max from actual buffer range for autoscale
        if (len <= 1) {
            // nothing to plot
            canvasCtx.fillStyle = '#9ba7b0';
            canvasCtx.font = '12px sans-serif';
            canvasCtx.fillText('Attesa dati...', 10, 20);
            return;
        }
        var min = Number.POSITIVE_INFINITY;
        var max = Number.NEGATIVE_INFINITY;
        for (var i = 0; i < len; i++) {
            var idx = (head - len + i + buffer.length) % buffer.length;
            var v = buffer[idx];
            if (v < min) min = v;
            if (v > max) max = v;
        }
        if (min === max) { min -= 0.5; max += 0.5; }

        // path draw
        canvasCtx.lineWidth = 1.5;
        canvasCtx.strokeStyle = '#4cd137'; // non impostiamo palette comunque, ma è ok qui
        canvasCtx.beginPath();

        for (var i = 0; i < len; i++) {
            var idx = (head - len + i + buffer.length) % buffer.length;
            var v = buffer[idx];
            var t = i / (MAX_POINTS - 1); // normalized time 0..1
            var x = Math.round(t * (canvasW - 10)) + 5;
            // map v to canvasY
            var y = canvasH - 8 - ((v - min) / (max - min)) * (canvasH - 16);
            if (i === 0) canvasCtx.moveTo(x, y); else canvasCtx.lineTo(x, y);
        }
        canvasCtx.stroke();

        // draw current value
        var latestIdx = (head - 1 + buffer.length) % buffer.length;
        var latestVal = buffer[latestIdx];
        canvasCtx.fillStyle = '#ffffff';
        canvasCtx.font = '12px sans-serif';
        canvasCtx.fillText(sensorName + ' : ' + Number(latestVal).toFixed(2), 8, 14);

        // draw min/max
        canvasCtx.fillStyle = '#9ba7b0';
        canvasCtx.font = '10px sans-serif';
        canvasCtx.fillText('min: ' + Number(min).toFixed(2), canvasW - 120, canvasH - 26);
        canvasCtx.fillText('max: ' + Number(max).toFixed(2), canvasW - 120, canvasH - 12);
    }

    // =========================
    // Chart buffer helpers
    // =========================
    function ensureChartBufferFor(sensorName) {
        if (chartBuffers[sensorName]) return;
        var buf = new Float32Array(MAX_POINTS);
        chartBuffers[sensorName] = { buffer: buf, head: 0, length: 0 };
    }

    function pushSampleToChart(sensorName, value) {
        if (typeof value !== 'number' || isNaN(value)) return;
        ensureChartBufferFor(sensorName);
        var cb = chartBuffers[sensorName];
        cb.buffer[cb.head] = value;
        cb.head = (cb.head + 1) % cb.buffer.length;
        if (cb.length < cb.buffer.length) cb.length++;
    }

    // Select primary numeric field from snapshot (prefer accel_, gyro_, pressure_ otherwise first numeric)
    function selectPrimaryValue(snapshot) {
        if (!snapshot) return 0;
        var order = ['accel_x', 'accel_y', 'accel_z', 'gyro_x', 'gyro_y', 'gyro_z'];
        for (var i = 0; i < order.length; i++) {
            if (snapshot[order[i]] !== undefined && !isNaN(snapshot[order[i]])) return Number(snapshot[order[i]]);
        }
        // pressure first if present
        for (var k in snapshot) {
            if (k.indexOf('pressure_') === 0 && !isNaN(snapshot[k])) return Number(snapshot[k]);
        }
        // fallback: first numeric prop
        for (var k2 in snapshot) {
            if (k2 === 'sensor_name' || k2 === 'timestamp') continue;
            var v = snapshot[k2];
            if (typeof v === 'number' || (!isNaN(v) && String(v).trim() !== '')) return Number(v);
        }
        return 0;
    }

    // =========================
    // util
    // =========================
    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    function getSensorEmoji(name) {
        var n = (name || '').toLowerCase();
        if (n.indexOf('ginocchio') !== -1 || n.indexOf('knee') !== -1) return '🦿';
        if (n.indexOf('piede') !== -1 || n.indexOf('foot') !== -1 || n.indexOf('calzino') !== -1) return '🧦';
        if (n.indexOf('braccio') !== -1) return '🦾';
        return '📱';
    }

    function highlightSelectedCard(name) {
        // rimetti tutto normale e evidenzia selezionato
        for (var k in domCache) {
            var c = domCache[k].card;
            if (c) c.style.border = 'none';
        }
        var cache = domCache[name];
        if (cache && cache.card) {
            cache.card.style.border = '2px solid #3498db';
        }
    }

    // =========================
    // helper: pick first numeric property (if you want to send specific field, modify selectPrimaryValue)
    // =========================

    // =========================
    // Public utility: clear all data (esposto globalmente se vuoi chiamarlo)
    // =========================
    window.sensoria = window.sensoria || {};
    window.sensoria.clearAllData = function () {
        if (!confirm('Pulire dati?')) return;
        fetch('/api/clear', { method: 'POST' }).then(function () {
            sensors = {};
            pendingUpdates = {};
            domCache = {};
            chartBuffers = {};
            sensorIds = [];
            selectedSensor = null;
            renderSensors();
        });
    };

    // =========================
    // END
    // =========================

})();