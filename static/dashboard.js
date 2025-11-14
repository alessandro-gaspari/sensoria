// sensoria-upplot-100hz.js
// Versione completa: socket + UI ottimizzata + uPlot realtime 100Hz (4 grafici)
// Richiede: socket.io client e uPlot (CSS+JS) caricati nella pagina

(function () {
    'use strict';

    // CONFIG
    const TICK_MS = 10;               // 100 Hz
    const STATUS_BLINK_MS = 50;
    const MAX_DATA_POINTS = 100;      // punti per grafico (configurabile)
    const CHART_HEIGHT = 140;
    const CHART_WIDTH = 480;

    // Socket (manteniamo le tue opzioni originali)
    var socket = io({
        reconnection: true,
        reconnectionDelay: 100,
        reconnectionDelayMax: 1000,
        reconnectionAttempts: 5,
        transports: ['websocket'],
        upgrade: false
    });

    // Stato globale
    var sensors = {};           // snapshot ultima per sensore
    var pendingUpdates = {};    // buffer inbound { sensorName: data }
    var domCache = {};          // cache DOM per card (key = 'card-'+sensorName)
    var isConnected = false;
    var frameCount = 0;
    var lastFrameTime = Date.now();
    var currentFps = 0;

    // Chart objects (uPlot instances)
    var uCharts = {
        accel: null,
        gyro: null,
        mag: null,
        pressure: null
    };

    // Buffers per sensor: chartBuffers[sensorName] = { ts:[], accel:{x:[],y:[],z:[]}, ... }
    var chartBuffers = {};

    // UI state
    var selectedSensor = null;
    var chartsInitialized = false;

    // DOM ready init
    document.addEventListener('DOMContentLoaded', function () {
        initializeSocketListeners();
        ensureBaseDOM();
        fetchInitialData();
        startBatchLoop();
        startFpsCounter();
        bindSensorSelector();
    });

    // --------------------
    // SOCKET LISTENERS
    // --------------------
    socket.on('connect', function () {
        isConnected = true;
        updateConnectionStatus(true);
    });
    socket.on('disconnect', function () {
        isConnected = false;
        updateConnectionStatus(false);
    });
    socket.on('connection_response', function (data) {
        if (data && data.sensors) {
            sensors = data.sensors;
            renderSensors();
        }
    });
    socket.on('sensor_update', function (data) {
        if (!data || !data.sensor_name) return;
        // data format expected: { sensor_name: '...', timestamp: 123, accel_x:..., ... }
        frameCount++;
        pendingUpdates[data.sensor_name] = data;
    });
    socket.on('sensor_data', function (data) {
        // support alternative event name
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
        if (selectedSensor === name) selectedSensor = null;
        updateConnectionStatus(isConnected);
    });
    socket.on('data_cleared', function () {
        sensors = {};
        pendingUpdates = {};
        domCache = {};
        chartBuffers = {};
        selectedSensor = null;
        renderSensors();
    });

    // --------------------
    // FETCH INITIAL
    // --------------------
    function fetchInitialData() {
        fetch('/api/sensors')
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data && data.sensors) {
                    sensors = data.sensors;
                    renderSensors();
                }
            })
            .catch(function () { /* silent */ });
    }

    // --------------------
    // BATCH LOOP (100Hz)
    // --------------------
    function startBatchLoop() {
        setInterval(function () {
            // nothing pending -> skip
            if (!hasPending()) return;

            // apply each pending snapshot
            for (var name in pendingUpdates) {
                var snapshot = pendingUpdates[name];
                // update global snapshot
                sensors[name] = snapshot;

                // ensure DOM card exists
                ensureCardExists(name, snapshot);

                // ensure chart buffer exists
                ensureChartBuffer(name);

                // push sample into buffer (timestamp + values)
                pushSampleBuffers(name, snapshot);
            }

            // clear buffer (new object to avoid property deletes)
            pendingUpdates = {};

            // update DOM (differenziale)
            batchUpdateDOM();

            // update charts for selectedSensor
            if (chartsInitialized && selectedSensor) {
                updateAllChartsFor(selectedSensor);
            }
        }, TICK_MS);
    }

    function hasPending() {
        for (var k in pendingUpdates) return true;
        return false;
    }

    // --------------------
    // DOM: ensure base elements and sensor cards
    // --------------------
    function ensureBaseDOM() {
        // sensors grid
        if (!document.getElementById('sensors-grid')) {
            var g = document.createElement('div');
            g.id = 'sensors-grid';
            g.style.display = 'grid';
            g.style.gridTemplateColumns = 'repeat(auto-fill, minmax(220px, 1fr))';
            g.style.gap = '10px';
            g.style.padding = '8px';
            document.body.appendChild(g);
        }

        // empty-state
        if (!document.getElementById('empty-state')) {
            var e = document.createElement('div');
            e.id = 'empty-state';
            e.textContent = 'Nessun sensore connesso';
            e.className = 'visible';
            e.style.padding = '12px';
            document.body.appendChild(e);
        }

        // charts container
        if (!document.getElementById('charts-container')) {
            var cc = document.createElement('div');
            cc.id = 'charts-container';
            cc.style.display = 'none';
            cc.style.position = 'fixed';
            cc.style.right = '10px';
            cc.style.bottom = '10px';
            cc.style.width = (CHART_WIDTH + 20) + 'px';
            cc.style.maxWidth = (CHART_WIDTH + 20) + 'px';
            cc.style.background = 'rgba(0,0,0,0.6)';
            cc.style.padding = '8px';
            cc.style.borderRadius = '8px';
            document.body.appendChild(cc);

            // selector
            var sel = document.createElement('select');
            sel.id = 'chart-sensor-select';
            sel.style.width = '100%';
            sel.style.marginBottom = '6px';
            cc.appendChild(sel);

            // charts canvas placeholders
            var c1 = document.createElement('div'); c1.id = 'accel-wrap'; c1.style.height = CHART_HEIGHT + 'px'; c1.style.marginBottom = '6px';
            var canvasA = document.createElement('div'); canvasA.id = 'accel-chart'; c1.appendChild(canvasA);
            cc.appendChild(c1);

            var c2 = document.createElement('div'); c2.id = 'gyro-wrap'; c2.style.height = CHART_HEIGHT + 'px'; c2.style.marginBottom = '6px';
            var canvasG = document.createElement('div'); canvasG.id = 'gyro-chart'; c2.appendChild(canvasG);
            cc.appendChild(c2);

            var c3 = document.createElement('div'); c3.id = 'mag-wrap'; c3.style.height = CHART_HEIGHT + 'px'; c3.style.marginBottom = '6px';
            var canvasM = document.createElement('div'); canvasM.id = 'mag-chart'; c3.appendChild(canvasM);
            cc.appendChild(c3);

            var c4 = document.createElement('div'); c4.id = 'pressure-wrap'; c4.style.height = CHART_HEIGHT + 'px';
            var canvasP = document.createElement('div'); canvasP.id = 'pressure-chart'; c4.appendChild(canvasP);
            cc.appendChild(c4);
        }
    }

    function renderSensors() {
        var grid = document.getElementById('sensors-grid');
        var emptyState = document.getElementById('empty-state');
        if (!grid || !emptyState) return;

        grid.innerHTML = '';
        domCache = {};
        pendingUpdates = {}; // clear pending

        var keys = Object.keys(sensors);
        if (keys.length === 0) {
            grid.style.display = 'none';
            emptyState.classList.add('visible');
            var cc = document.getElementById('charts-container'); if (cc) cc.style.display = 'none';
            return;
        }

        keys.forEach(function (name) {
            createSensorCard(name, sensors[name]);
            ensureChartBuffer(name);
        });

        grid.style.display = 'grid';
        emptyState.classList.remove('visible');
        updateConnectionStatus(isConnected);
        updateSensorSelector();
    }

    function createSensorCard(sensorName, data) {
        var grid = document.getElementById('sensors-grid');
        if (!grid) return;

        var card = document.createElement('div');
        card.className = 'sensor-col connected';
        card.setAttribute('data-sensor', sensorName);
        card.style.padding = '8px';
        card.style.borderRadius = '8px';
        card.style.background = '#fff';
        card.style.cursor = 'pointer';
        card.style.userSelect = 'none';
        card.style.boxShadow = '0 1px 3px rgba(0,0,0,0.08)';
        card.addEventListener('click', function () {
            selectedSensor = sensorName;
            highlightSelectedCard(sensorName);
            // on first selection, init charts
            if (!chartsInitialized) {
                initCharts();
                chartsInitialized = true;
            }
            updateSensorSelector(); // keep selection in dropdown synced
        });

        // header
        var header = document.createElement('div');
        header.className = 'sensor-header';
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.style.marginBottom = '6px';

        var title = document.createElement('div');
        title.textContent = getSensorEmoji(sensorName) + ' ' + sensorName;
        title.style.fontWeight = '600';

        var status = document.createElement('div');
        status.className = 'status-indicator';
        status.style.width = '10px';
        status.style.height = '10px';
        status.style.borderRadius = '50%';
        status.style.background = '#ddd';

        header.appendChild(title);
        header.appendChild(status);
        card.appendChild(header);

        // fields container
        var fields = document.createElement('div');
        fields.className = 'sensor-fields';

        // detect keys and build rows
        var keys = [];
        for (var k in data) {
            if (k === 'timestamp' || k === 'sensor_name') continue;
            keys.push(k);
        }
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
            fields.appendChild(row);
        });

        card.appendChild(fields);

        var ts = document.createElement('span');
        ts.className = 'sensor-timestamp';
        ts.textContent = '--:--:--';
        ts.style.display = 'block';
        ts.style.marginTop = '6px';
        ts.style.fontSize = '12px';
        ts.style.color = '#666';
        card.appendChild(ts);

        grid.appendChild(card);
        // cache DOM
        cacheDomForCard(sensorName, card);
    }

    function ensureCardExists(sensorName, snapshot) {
        var cacheKey = 'card-' + sensorName;
        if (domCache[cacheKey]) return;
        var existing = document.querySelector('[data-sensor="' + sensorName + '"]');
        if (!existing) {
            createSensorCard(sensorName, snapshot || {});
        } else {
            cacheDomForCard(sensorName, existing);
        }
    }

    function cacheDomForCard(sensorName, card) {
        var cacheKey = 'card-' + sensorName;
        var valueElements = {};
        card.querySelectorAll('.sensor-data-row').forEach(function (row) {
            var label = row.querySelector('.sensor-data-label');
            var value = row.querySelector('.sensor-value');
            if (label && value) {
                // normalize label key (remove colon)
                var key = label.textContent.replace(':', '').trim();
                valueElements[key] = value;
            }
        });
        domCache[cacheKey] = {
            card: card,
            content: card.querySelector('.sensor-fields'),
            timestamp: card.querySelector('.sensor-timestamp'),
            status: card.querySelector('.status-indicator'),
            valueElements: valueElements,
            lastData: {}
        };
    }

    function removeSensorDom(sensorName) {
        var card = document.querySelector('[data-sensor="' + sensorName + '"]');
        if (card) card.remove();
        var cacheKey = 'card-' + sensorName;
        if (domCache[cacheKey]) delete domCache[cacheKey];
        if (chartBuffers[sensorName]) delete chartBuffers[sensorName];
        updateSensorSelector();
    }

    // apply all pending updates to DOM (differential)
    function batchUpdateDOM() {
        for (var cacheKey in domCache) {
            // nothing here - we update per-sensor below
        }
        // iterate sensors currently updated (we pushed samples earlier)
        for (var sensorName in sensors) {
            var snapshot = sensors[sensorName];
            updateSensorCardDynamic(sensorName, snapshot);
        }
    }

    function updateSensorCardDynamic(sensorName, data) {
        var cacheKey = 'card-' + sensorName;
        var cached = domCache[cacheKey];
        if (!cached) return;

        var valueElements = cached.valueElements;
        var lastData = cached.lastData;

        for (var key in data) {
            if (key === 'timestamp' || key === 'sensor_name') continue;
            var newValue = Math.round(data[key]);
            if (lastData[key] !== newValue) {
                lastData[key] = newValue;
                var element = valueElements[key];
                if (element) {
                    element.textContent = newValue;
                    if (key.indexOf('pressure_') === 0) {
                        var colorClass = 'low';
                        if (newValue > 5000) colorClass = 'high';
                        else if (newValue > 1000) colorClass = 'medium';
                        element.className = 'sensor-value ' + colorClass;
                    }
                }
            }
        }

        if (cached.timestamp && data.timestamp) {
            var date = new Date(data.timestamp);
            var timeStr = pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds());
            if (cached.timestamp.textContent !== timeStr) cached.timestamp.textContent = timeStr;
        }

        if (cached.status) {
            cached.status.style.background = '#2ecc71';
            if (cached.status._timeout) clearTimeout(cached.status._timeout);
            cached.status._timeout = setTimeout(function (s) { return function () { s.style.background = '#ddd'; }; }(cached.status), STATUS_BLINK_MS);
        }
    }

    // --------------------
    // Chart buffers and push
    // --------------------
    function ensureChartBuffer(sensorName) {
        if (chartBuffers[sensorName]) return;
        chartBuffers[sensorName] = {
            ts: [],
            accel: { x: [], y: [], z: [] },
            gyro: { x: [], y: [], z: [] },
            mag: { x: [], y: [], z: [] },
            pressure: { s0: [], s1: [], s2: [], s3: [], s4: [], s5: [], s6: [], s7: [] }
        };
    }

    function pushSampleBuffers(sensorName, snapshot) {
        var buf = chartBuffers[sensorName];
        if (!buf) return;

        var t = (snapshot.timestamp !== undefined) ? Number(snapshot.timestamp) : Date.now();

        // push ts as number (uPlot expects x axis numeric)
        buf.ts.push(t);
        if (buf.ts.length > MAX_DATA_POINTS) buf.ts.shift();

        // accel
        if (snapshot.accel_x !== undefined) {
            buf.accel.x.push(Number(snapshot.accel_x));
            buf.accel.y.push(Number(snapshot.accel_y));
            buf.accel.z.push(Number(snapshot.accel_z));
            if (buf.accel.x.length > MAX_DATA_POINTS) { buf.accel.x.shift(); buf.accel.y.shift(); buf.accel.z.shift(); }
        } else {
            // keep arrays in sync by pushing NaN so uPlot stretches correctly
            buf.accel.x.push(NaN); buf.accel.y.push(NaN); buf.accel.z.push(NaN);
            if (buf.accel.x.length > MAX_DATA_POINTS) { buf.accel.x.shift(); buf.accel.y.shift(); buf.accel.z.shift(); }
        }

        // gyro
        if (snapshot.gyro_x !== undefined) {
            buf.gyro.x.push(Number(snapshot.gyro_x));
            buf.gyro.y.push(Number(snapshot.gyro_y));
            buf.gyro.z.push(Number(snapshot.gyro_z));
            if (buf.gyro.x.length > MAX_DATA_POINTS) { buf.gyro.x.shift(); buf.gyro.y.shift(); buf.gyro.z.shift(); }
        } else {
            buf.gyro.x.push(NaN); buf.gyro.y.push(NaN); buf.gyro.z.push(NaN);
            if (buf.gyro.x.length > MAX_DATA_POINTS) { buf.gyro.x.shift(); buf.gyro.y.shift(); buf.gyro.z.shift(); }
        }

        // mag
        if (snapshot.mag_x !== undefined) {
            buf.mag.x.push(Number(snapshot.mag_x));
            buf.mag.y.push(Number(snapshot.mag_y));
            buf.mag.z.push(Number(snapshot.mag_z));
            if (buf.mag.x.length > MAX_DATA_POINTS) { buf.mag.x.shift(); buf.mag.y.shift(); buf.mag.z.shift(); }
        } else {
            buf.mag.x.push(NaN); buf.mag.y.push(NaN); buf.mag.z.push(NaN);
            if (buf.mag.x.length > MAX_DATA_POINTS) { buf.mag.x.shift(); buf.mag.y.shift(); buf.mag.z.shift(); }
        }

        // pressure S0..S7
        var hasPressure = false;
        for (var i = 0; i <= 7; i++) {
            var key = 'pressure_' + i;
            if (snapshot[key] !== undefined) {
                hasPressure = true;
                chartBuffers[sensorName].pressure['s' + i].push(Number(snapshot[key]));
            } else {
                chartBuffers[sensorName].pressure['s' + i].push(NaN);
            }
            if (chartBuffers[sensorName].pressure['s' + i].length > MAX_DATA_POINTS) {
                chartBuffers[sensorName].pressure['s' + i].shift();
            }
        }
    }

    // --------------------
    // CHARTS: init uPlot instances
    // --------------------
    function initCharts() {
        // require uPlot loaded
        if (typeof uPlot === 'undefined') {
            console.error('uPlot non trovato. Importa uPlot prima di questo script.');
            return;
        }

        // common opts helper
        function baseOpts(title) {
            return {
                id: title,
                width: CHART_WIDTH,
                height: CHART_HEIGHT,
                plugins: [],
                scales: {
                    x: { time: false, auto: true },
                    y: { auto: true }
                },
                series: [] // filled per chart
            };
        }

        // ACCEL (3 series)
        var accelOpts = {
            ...baseOpts('accel'),
            series: [
                { label: 't' }, // x axis placeholder
                { label: 'X', stroke: '#ff6384', width: 1.5 },
                { label: 'Y', stroke: '#36a2eb', width: 1.5 },
                { label: 'Z', stroke: '#4bc0c0', width: 1.5 }
            ],
            axes: [
                { show: false }, // x axis hidden
                { show: true }
            ]
        };
        var accelTarget = document.getElementById('accel-chart');
        uCharts.accel = new uPlot(accelOpts, [ [/* timestamps */], [], [], [] ], accelTarget);

        // GYRO
        var gyroOpts = {
            ...baseOpts('gyro'),
            series: [
                { label: 't' },
                { label: 'X', stroke: '#ff9f40', width: 1.5 },
                { label: 'Y', stroke: '#9966ff', width: 1.5 },
                { label: 'Z', stroke: '#ffcd56', width: 1.5 }
            ],
            axes: [{ show: false }, { show: true }]
        };
        var gyroTarget = document.getElementById('gyro-chart');
        uCharts.gyro = new uPlot(gyroOpts, [ [], [], [], [] ], gyroTarget);

        // MAG
        var magOpts = {
            ...baseOpts('mag'),
            series: [
                { label: 't' },
                { label: 'X', stroke: '#c9cbcf', width: 1.5 },
                { label: 'Y', stroke: '#4bc0c0', width: 1.5 },
                { label: 'Z', stroke: '#ff6384', width: 1.5 }
            ],
            axes: [{ show: false }, { show: true }]
        };
        var magTarget = document.getElementById('mag-chart');
        uCharts.mag = new uPlot(magOpts, [ [], [], [], [] ], magTarget);

        // PRESSURE (8 series)
        var pressureSeries = [ { label: 't' } ];
        var pressureColors = ['#ff6384','#36a2eb','#ffce56','#4bc0c0','#9966ff','#ff9f40','#c9cbcf','#e7e9ed'];
        for (var i = 0; i < 8; i++) pressureSeries.push({ label: 'S' + i, stroke: pressureColors[i], width: 1 });
        var pressOpts = {
            ...baseOpts('pressure'),
            series: pressureSeries,
            axes: [{ show: false }, { show: true }]
        };
        var pressTarget = document.getElementById('pressure-chart');
        // data arrays: timestamps + 8 series
        var emptySeries = [ [] ];
        for (var i = 0; i < 8; i++) emptySeries.push([]);
        uCharts.pressure = new uPlot(pressOpts, emptySeries, pressTarget);

        chartsInitialized = true;
    }

    // --------------------
    // CHARTS: update drawings for selected sensor
    // --------------------
    function updateAllChartsFor(sensorName) {
        var buf = chartBuffers[sensorName];
        if (!buf) {
            // clear charts
            clearCharts();
            return;
        }

        // build base x as numeric timestamps / or synthetic 0..n-1 if timestamps not meaningful
        var x = buf.ts.length ? buf.ts.slice() : syntheticX(buf.accel.x.length);

        // accel
        if (uCharts.accel) {
            var aX = buf.accel.x.slice();
            var aY = buf.accel.y.slice();
            var aZ = buf.accel.z.slice();
            // ensure same lengths
            syncLengths([x, aX, aY, aZ]);
            uCharts.accel.setData([x, aX, aY, aZ]);
        }

        // gyro
        if (uCharts.gyro) {
            var gX = buf.gyro.x.slice();
            var gY = buf.gyro.y.slice();
            var gZ = buf.gyro.z.slice();
            syncLengths([x, gX, gY, gZ]);
            uCharts.gyro.setData([x, gX, gY, gZ]);
        }

        // mag
        if (uCharts.mag) {
            var mX = buf.mag.x.slice();
            var mY = buf.mag.y.slice();
            var mZ = buf.mag.z.slice();
            syncLengths([x, mX, mY, mZ]);
            uCharts.mag.setData([x, mX, mY, mZ]);
        }

        // pressure
        if (uCharts.pressure) {
            var pSeries = [x];
            for (var i = 0; i <= 7; i++) {
                pSeries.push(buf.pressure['s' + i].slice());
            }
            // sync all lengths
            syncLengths(pSeries);
            uCharts.pressure.setData(pSeries);
            // show or hide pressure container based on presence
            var pressureContainer = document.getElementById('pressure-wrap');
            if (pressureContainer) {
                var hasAny = false;
                for (var i = 0; i <= 7; i++) {
                    if (buf.pressure['s' + i].some(function (v) { return !isNaN(v); })) { hasAny = true; break; }
                }
                pressureContainer.style.display = hasAny ? 'block' : 'none';
            }
        }
    }

    function clearCharts() {
        if (!chartsInitialized) return;
        var empty = [ [] ];
        empty.length = 1 + 3; // timestamps + 3 series
        empty.fill([]);
        try {
            if (uCharts.accel) uCharts.accel.setData([[], [], [], []]);
            if (uCharts.gyro) uCharts.gyro.setData([[], [], [], []]);
            if (uCharts.mag) uCharts.mag.setData([[], [], [], []]);
            if (uCharts.pressure) {
                var arr = [ [] ];
                for (var i = 0; i < 8; i++) arr.push([]);
                uCharts.pressure.setData(arr);
            }
        } catch (e) { /* ignore timing */ }
    }

    // helper: ensure all arrays same length by prepending NaN on shorter ones (uPlot expects same length)
    function syncLengths(arrays) {
        var max = 0;
        arrays.forEach(function (a) { if (a.length > max) max = a.length; });
        for (var i = 0; i < arrays.length; i++) {
            while (arrays[i].length < max) arrays[i].unshift(NaN);
        }
    }

    function syntheticX(n) {
        var r = new Array(n);
        for (var i = 0; i < n; i++) r[i] = i;
        return r;
    }

    // --------------------
    // SENSOR SELECT UI
    // --------------------
    function bindSensorSelector() {
        var sel = document.getElementById('chart-sensor-select');
        if (sel) {
            sel.addEventListener('change', function (e) {
                selectedSensor = e.target.value || null;
                if (selectedSensor && !chartsInitialized) {
                    initCharts();
                }
                // when select changes we immediately update charts
                if (selectedSensor && chartsInitialized) updateAllChartsFor(selectedSensor);
            });
        }
    }

    function updateSensorSelector() {
        var sel = document.getElementById('chart-sensor-select');
        var cc = document.getElementById('charts-container');
        if (!sel || !cc) return;
        sel.innerHTML = '';
        var opt0 = document.createElement('option');
        opt0.value = '';
        opt0.textContent = '-- Seleziona sensore --';
        sel.appendChild(opt0);

        var first = null;
        Object.keys(sensors).forEach(function (name) {
            var opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name;
            sel.appendChild(opt);
            if (!first) first = name;
        });

        if (!selectedSensor && first) {
            // auto-select first available sensor
            selectedSensor = first;
            sel.value = first;
        } else if (selectedSensor) {
            sel.value = selectedSensor;
        }

        // show/hide charts container
        cc.style.display = (Object.keys(sensors).length > 0) ? 'block' : 'none';
    }

    // --------------------
    // Utility: highlight selected card
    // --------------------
    function highlightSelectedCard(name) {
        for (var k in domCache) {
            var c = domCache[k].card;
            if (c) c.style.border = 'none';
        }
        var cacheKey = 'card-' + name;
        if (domCache[cacheKey] && domCache[cacheKey].card) {
            domCache[cacheKey].card.style.border = '2px solid #3498db';
        }
    }

    // --------------------
    // FPS counter
    // --------------------
    function startFpsCounter() {
        setInterval(function () {
            var now = Date.now();
            var elapsed = (now - lastFrameTime) / 1000;
            currentFps = Math.round(frameCount / elapsed) || 0;
            frameCount = 0;
            lastFrameTime = now;
            var fpsEl = document.getElementById('fps-counter');
            if (fpsEl) fpsEl.textContent = currentFps + ' Hz';
        }, 1000);
    }

    // --------------------
    // Helpers
    // --------------------
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function getSensorEmoji(name) {
        var n = (name || '').toLowerCase();
        if (n.indexOf('ginocchio') !== -1 || n.indexOf('knee') !== -1) return '🦿';
        if (n.indexOf('piede') !== -1 || n.indexOf('foot') !== -1 || n.indexOf('calzino') !== -1) return '🧦';
        if (n.indexOf('braccio') !== -1) return '🦾';
        return '📱';
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

    // --------------------
    // reset chart data (clear buffers and chart visuals)
    // --------------------
    function resetChartData() {
        chartBuffers = {};
        if (chartsInitialized) clearCharts();
    }

    // --------------------
    // start/stop helpers (exposed)
    // --------------------
    window.sensoria = window.sensoria || {};
    window.sensoria.resetChartData = resetChartData;
    window.sensoria.clearAllData = function () {
        if (!confirm('Pulire tutti i dati?')) return;
        fetch('/api/clear', { method: 'POST' }).then(function () {
            sensors = {};
            pendingUpdates = {};
            domCache = {};
            chartBuffers = {};
            selectedSensor = null;
            renderSensors();
            resetChartData();
        });
    };

    // --------------------
    // Export internal for debugging
    // --------------------
    window._sensoria_internal = {
        sensors: sensors,
        chartBuffers: chartBuffers,
        uCharts: uCharts
    };

    // ---- end IIFE
})();