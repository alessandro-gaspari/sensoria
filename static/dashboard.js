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

var maxDataPoints = 0;
var selectedSensor = null;
var chartsInitialized = false;

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

    socket.on('data_cleared', function() {
        sensors = {};
        domCache = {};
        pendingUpdates = {};
        renderSensors();
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

function fetchInitialData() {
    fetch('/api/sensors')
        .then(function(response) { return response.json(); })
        .then(function(data) {
            sensors = data.sensors || {};
            renderSensors();
        });
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

function wheelZoomPlugin(opts) {
    var factor = opts.factor || 0.75;

    function init(u, opts, data) {
        var over = u.over;
        var rect, xVal;
        var isDragging = false;
        var dragStartX = null;
        var dragStartScale = null;

        // Gestione ZOOM con rotella (già presente e corretta)
        over.addEventListener("wheel", function(e) {
            e.preventDefault();
            rect = over.getBoundingClientRect();
            xVal = u.posToVal(e.clientX - rect.left, 'x');
            var left = u.scales.x.min;
            var right = u.scales.x.max;
            var range = right - left;
            var pct = xVal == null ? 0.5 : (xVal - left) / range;
            var nRange = e.deltaY < 0 ? range * factor : range / factor;
            var nLeft = xVal - pct * nRange;
            var nRight = nLeft + nRange;
            u.batch(function() {
                u.setScale('x', { min: nLeft, max: nRight });
            });
        });

        // Gestione PAN con trascinamento
        over.addEventListener("mousedown", function(e) {
            // Se non è il tasto sinistro, ignora
            if (e.button !== 0) return;
            
            e.preventDefault();
            isDragging = true;
            dragStartX = e.clientX;
            dragStartScale = {
                min: u.scales.x.min,
                max: u.scales.x.max
            };
            over.style.cursor = "grabbing";
        });

        over.addEventListener("mousemove", function(e) {
            if (!isDragging) return;
            
            e.preventDefault();
            var currentX = e.clientX;
            var dx = dragStartX - currentX;
            
            var scaleX = u.scales.x;
            var plotWidth = u.bbox.width;
            var scaleRange = dragStartScale.max - dragStartScale.min;
            
            // Calcola quanto spostare in base ai pixel trascinati
            var shift = (dx / plotWidth) * scaleRange;
            
            u.setScale("x", {
                min: dragStartScale.min + shift,
                max: dragStartScale.max + shift
            });
        });

        document.addEventListener("mouseup", function(e) {
            if (isDragging) {
                isDragging = false;
                dragStartX = null;
                dragStartScale = null;
                over.style.cursor = "default";
            }
        });
    }

    return {
        hooks: {
            init: init
        }
    };
}



function getBaseOpts(width, height) {
    return {
        width: width,
        height: height,
        cursor: { show: true, drag: { x: true, y: false } },
        legend: { show: true, live: true },
        scales: { x: { time: true }, y: { auto: true } },
        select: {show: false,  
        },
        axes: [
            { stroke: '#97c93e', grid: { stroke: '#333', width: 1 },
                values: function(u, ticks) {
                    return ticks.map(function(v) {
                        var d = new Date(v * 1000);
                        return d.toLocaleTimeString('it-IT', { hour12: false });
                    });
                }
            },
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

    if (!accelDiv || !gyroDiv || !magDiv || !pressureDiv) {
        console.error('Canvas non trovati');
        return;
    }

    // Mostra il container PRIMA di inizializzare
    document.getElementById('pressure-chart-container').style.display = 'block';

    // Forza dimensioni minime
    pressureDiv.style.minWidth = '400px';
    pressureDiv.style.minHeight = '250px';

    // Accelerometro
    var accelOpts = getBaseOpts(accelDiv.offsetWidth, 200);
    accelOpts.series = [
        { show: false },
        { label: 'X', stroke: '#ff6384', width: 2 },
        { label: 'Y', stroke: '#36a2eb', width: 2 },
        { label: 'Z', stroke: '#4bc0c0', width: 2 }
    ];
    charts.accel = new uPlot(accelOpts, chartData.accel, accelDiv);
    addInteractionListeners(charts.accel);

    // Giroscopio
    var gyroOpts = getBaseOpts(gyroDiv.offsetWidth, 200);
    gyroOpts.series = [
        { show: false },
        { label: 'X', stroke: '#ff9f40', width: 2 },
        { label: 'Y', stroke: '#9966ff', width: 2 },
        { label: 'Z', stroke: '#ffcd56', width: 2 }
    ];
    charts.gyro = new uPlot(gyroOpts, chartData.gyro, gyroDiv);
    addInteractionListeners(charts.gyro);

    // Magnetometro
    var magOpts = getBaseOpts(magDiv.offsetWidth, 200);
    magOpts.series = [
        { show: false },
        { label: 'X', stroke: '#c9cbcf', width: 2 },
        { label: 'Y', stroke: '#4bc0c0', width: 2 },
        { label: 'Z', stroke: '#ff6384', width: 2 }
    ];
    charts.mag = new uPlot(magOpts, chartData.mag, magDiv);
    addInteractionListeners(charts.mag);

    // PRESSIONI - forza width esplicito
    console.log('Pressure div width:', pressureDiv.offsetWidth);
    
    var pressureOpts = {
        width: Math.max(pressureDiv.offsetWidth, 400),  // Minimo 400px
        height: 250,
        cursor: { show: true, drag: { x: true, y: false } },
        select: { show: false, 
        },
        legend: { show: true, live: true },
        scales: {
            x: { time: true },
            y: { auto: false, range: [0, 1024] }
        },
        axes: [
            { 
                stroke: '#97c93e', 
                grid: { stroke: '#333', width: 1 },
                values: function(u, ticks) {
                    return ticks.map(function(v) {
                        var d = new Date(v * 1000);
                        return d.toLocaleTimeString('it-IT', { hour12: false });
                    });
                }
            },
            { 
                stroke: '#97c93e', 
                grid: { stroke: '#333', width: 1 },
                size: 50
            }
        ],
        series: [
            {},  // Asse X (time) - IMPORTANTE: oggetto vuoto, non { show: false }
            { label: 'S0', stroke: '#ff6384', width: 3 },
            { label: 'S1', stroke: '#36a2eb', width: 3 },
            { label: 'S2', stroke: '#ffce56', width: 3 }
        ],
        plugins: [wheelZoomPlugin({ factor: 0.75 })]
    };

    // Inizializza con 2 punti minimi
    var now = Date.now() / 1000;
    var initData = [
        [now - 1, now],
        [512, 512],
        [512, 512],
        [512, 512]
    ];

    charts.pressure = new uPlot(pressureOpts, initData, pressureDiv);
    addInteractionListeners(charts.pressure);

    console.log('✅ Grafici inizializzati');
    console.log('📊 Pressure SVG:', document.querySelector('#pressure-chart svg'));
    
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
                        if (isOff) {
                            marker.style.backgroundColor = 'transparent';
                            marker.style.borderColor = '#666';
                            marker.style.color = '#666';
                        } else {
                            marker.style.backgroundColor = seriesConfig.stroke;
                            marker.style.borderColor = seriesConfig.stroke;
                            marker.style.color = seriesConfig.stroke;
                        }
                    }
                });
            }
            updateColors();
            var observer = new MutationObserver(updateColors);
            observer.observe(legend, { 
                attributes: true, 
                subtree: true, 
                attributeFilter: ['class'] 
            });
        });
    }, 300);
}

// Variabile globale per tracciare se l'utente sta interagendo col grafico
var isUserInteracting = false;

// Aggiungi questi listener al canvas del grafico (o al container)
function addInteractionListeners(u) {
    var over = u.over;
    over.addEventListener('mousedown', function() { isUserInteracting = true; });
    over.addEventListener('wheel', function() { isUserInteracting = true; });
    // Se vuoi riprendere l'auto-scroll con doppio click:
    over.addEventListener('dblclick', function() { isUserInteracting = false; }); 
}


function updateCharts(sensorName, data) {
    if (selectedSensor !== sensorName || !chartsInitialized) return;

    var timestamp = Date.now() / 1000;

    // Accelerometro
    if (data.accel_x !== undefined) {
        chartData.accel[0].push(timestamp);
        chartData.accel[1].push(data.accel_x);
        chartData.accel[2].push(data.accel_y);
        chartData.accel[3].push(data.accel_z);
        //if (chartData.accel[0].length > maxDataPoints) {
        //    for (var i = 0; i <= 3; i++) chartData.accel[i].shift();
        //}
        charts.accel.setData(chartData.accel);
        if (!isUserInteracting) {
            var windowSize = 10; // Mostra ultimi 10 secondi
            var minX = timestamp - windowSize;
            var maxX = timestamp;
            
            // Se abbiamo meno di 10s di dati, mostra dall'inizio
            if (chartData.accel[0][0] > minX) {
                minX = chartData.accel[0][0];
            }
            
            charts.accel.setScale('x', { min: minX, max: maxX });
        }    
        
    }

    // Giroscopio
    if (data.gyro_x !== undefined) {
        chartData.gyro[0].push(timestamp);
        chartData.gyro[1].push(data.gyro_x);
        chartData.gyro[2].push(data.gyro_y);
        chartData.gyro[3].push(data.gyro_z);
        //if (chartData.gyro[0].length > maxDataPoints) {
        //    for (var i = 0; i <= 3; i++) chartData.gyro[i].shift();
        //}
        charts.gyro.setData(chartData.gyro);
        if (!isUserInteracting) {
            var windowSize = 10; // Mostra ultimi 10 secondi
            var minX = timestamp - windowSize;
            var maxX = timestamp;
            
            // Se abbiamo meno di 10s di dati, mostra dall'inizio
            if (chartData.accel[0][0] > minX) {
                minX = chartData.accel[0][0];
            }
            
            charts.accel.setScale('x', { min: minX, max: maxX });
        }
    }

    // Magnetometro
    if (data.mag_x !== undefined) {
        chartData.mag[0].push(timestamp);
        chartData.mag[1].push(data.mag_x);
        chartData.mag[2].push(data.mag_y);
        chartData.mag[3].push(data.mag_z);
        //if (chartData.mag[0].length > maxDataPoints) {
        //    for (var i = 0; i <= 3; i++) chartData.mag[i].shift();
        //}
        charts.mag.setData(chartData.mag);
        if (!isUserInteracting) {
            var windowSize = 10; // Mostra ultimi 10 secondi
            var minX = timestamp - windowSize;
            var maxX = timestamp;
            
            // Se abbiamo meno di 10s di dati, mostra dall'inizio
            if (chartData.accel[0][0] > minX) {
                minX = chartData.accel[0][0];
            }
            
            charts.accel.setScale('x', { min: minX, max: maxX });
        }
    }

    // PRESSIONI
    if (data.pressure_0 !== undefined) {
        chartData.pressure[0].push(timestamp);
        chartData.pressure[1].push(data.pressure_0 || 0);
        chartData.pressure[2].push(data.pressure_1 || 0);
        chartData.pressure[3].push(data.pressure_2 || 0);
        //if (chartData.pressure[0].length > maxDataPoints) {
        //    for (var i = 0; i <= 3; i++) chartData.pressure[i].shift();
        //}
        charts.pressure.setData(chartData.pressure);
        if (!isUserInteracting) {
            var windowSize = 10; // Mostra ultimi 10 secondi
            var minX = timestamp - windowSize;
            var maxX = timestamp;
            
            // Se abbiamo meno di 10s di dati, mostra dall'inizio
            if (chartData.accel[0][0] > minX) {
                minX = chartData.accel[0][0];
            }
            
            charts.accel.setScale('x', { min: minX, max: maxX });
        }
        document.getElementById('pressure-chart-container').style.display = 'block';
    } else {
        document.getElementById('pressure-chart-container').style.display = 'none';
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
    if (!chartsInitialized) return;
    chartData = {
        accel: [[], [], [], []],
        gyro: [[], [], [], []],
        mag: [[], [], [], []],
        pressure: [[], [], [], []]
    };
    if (charts.accel) charts.accel.setData(chartData.accel);
    if (charts.gyro) charts.gyro.setData(chartData.gyro);
    if (charts.mag) charts.mag.setData(chartData.mag);
    if (charts.pressure) charts.pressure.setData(chartData.pressure);
}

function calibrateKnee() {
    alert('Funzione calibrazione ginocchio non ancora implementata');
}
