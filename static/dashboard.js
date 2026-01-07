// ==========================================
// dashboard.js (Sensoria Dashboard) - NUOVO LAYOUT
// ==========================================

console.log("dashboard.js loaded - VERSION 2026-01-07 NEW LAYOUT");

// ==========================================
// Socket
// ==========================================
var socket = io({
    transports: ["websocket"],
    reconnection: true,
    reconnectionDelay: 500
});

// ==========================================
// UI colors
// ==========================================
const SENSORIA_GREEN = "#97c93e";
const PURPLE_COLOR = "#c77dff";
const RED_COLOR = "#ff6b6b";
const YELLOW_COLOR = "#ffd93d";
const GREEN_COLOR = "#6bcf7f";

// ==========================================
// SENSORI / DATI
// ==========================================
var sensors = {};

// Timeline
var sessionStartTimeMs = null;
var sessionEndTimeMs = null;
var isReplayMode = false;

// GPS
var gpsSamples = [];
var lastSpeedKmh = 0;
var lastDistanceM = 0;

// Pressure (calzini)
var leftSockSamples = [];
var rightSockSamples = [];

// Accelerometro per Bongiorno Index
var leftAccelSamples = [];  // { t, ax, ay, az }
var rightAccelSamples = []; // { t, ax, ay, az }

// Angoli (placeholder per ora)
var kneeAngle = 0;
var tibiaAngle = 0;

// Bongiorno Index
var bongiornoIndexSX = 0;
var bongiornoIndexDX = 0;

// ==========================================
// MAPPA
// ==========================================
var map = null;
var mapMarker = null;
var isMapInitialized = false;
var fullRoute = null;
var progressRoute = null;

// ==========================================
// GRAFICI (uPlot)
// ==========================================
var pressureChartLeft = null;
var pressureChartRight = null;
var rawChartLeft = null;
var rawChartRight = null;

var pressureDataLeft = [[], [], [], []];
var pressureDataRight = [[], [], [], []];
var rawDataLeft = [[], [], [], []];
var rawDataRight = [[], [], [], []];

var currentTab = "left";

// ==========================================
// INIZIALIZZAZIONE
// ==========================================
document.addEventListener("DOMContentLoaded", function () {
    console.log("DOM loaded, initializing dashboard...");
    
    initSocket();
    initMap();
    initPressureCharts();
    initRawCharts();
    initTabs();
    initReplayControls();
    
    // Load activity button
    const loadBtn = document.getElementById("load-activity-btn");
    if (loadBtn) {
        loadBtn.addEventListener("click", loadPastActivity);
    }
    
    console.log("Dashboard initialization complete ✓");
});

// ==========================================
// SOCKET
// ==========================================
function initSocket() {
    socket.on("connect", () => {
        console.log("Socket connected");
        updateConnectionStatus(true);
    });

    socket.on("disconnect", () => {
        console.log("Socket disconnected");
        updateConnectionStatus(false);
    });

    socket.on("sensor_update", (data) => {
        processIncomingData(data);
    });

    socket.on("gps_update", (data) => {
        onGpsUpdate(data);
    });

    socket.on("pressure_update", (data) => {
        onPressureUpdate(data);
    });

    socket.on("data_cleared", () => {
        console.log("Data cleared, session ended");
        if (sessionStartTimeMs != null) {
            sessionEndTimeMs = Date.now();
            showReplayOverlay();
        }
    });
}

function updateConnectionStatus(connected) {
    const el = document.getElementById("connection-status");
    if (!el) return;
    
    if (connected) {
        el.className = "";
        el.innerHTML = '<div class="status-dot"></div><span>Connesso</span>';
    } else {
        el.className = "disconnected";
        const dot = el.querySelector('.status-dot');
        if (dot) {
            dot.style.background = "#ff4136";
            dot.style.boxShadow = "0 0 10px #ff4136";
        }
        const span = el.querySelector('span');
        if (span) span.textContent = "Disconnesso";
    }
}

// ==========================================
// PROCESS INCOMING DATA
// ==========================================
function processIncomingData(data) {
    if (!data || !data.device_id) return;

    const tMs = data.timestamp || Date.now();
    ensureSessionStart(tMs);

    sensors[data.device_id] = data;

    // Identifica piede sinistro/destro in base al device_id
    const isLeft = data.device_id.toLowerCase().includes("left") || 
                   data.device_id.toLowerCase().includes("sx") ||
                   data.device_id.toLowerCase().includes("sinistro");
    const isRight = data.device_id.toLowerCase().includes("right") || 
                    data.device_id.toLowerCase().includes("dx") ||
                    data.device_id.toLowerCase().includes("destro");

    // Accelerometro per Bongiorno Index
    if (data.accelerometer) {
        const { x, y, z } = data.accelerometer;
        const sample = { t: tMs, ax: x, ay: y, az: z };
        
        if (isLeft) {
            leftAccelSamples.push(sample);
            if (leftAccelSamples.length > 1000) leftAccelSamples.shift();
            updateBongiornoIndex("left");
            updateRawCharts();
        } else if (isRight) {
            rightAccelSamples.push(sample);
            if (rightAccelSamples.length > 1000) rightAccelSamples.shift();
            updateBongiornoIndex("right");
            updateRawCharts();
        }
    }

    // Pressure data
    if (data.pressure || data.sensors) {
        const pressureData = data.pressure || data.sensors || {};
        onPressureUpdate({
            timestamp: tMs,
            device_id: data.device_id,
            foot: isLeft ? "left" : "right",
            sensor1: pressureData.s1 || pressureData.sensor1 || 0,
            sensor2: pressureData.s2 || pressureData.sensor2 || 0,
            sensor3: pressureData.s3 || pressureData.sensor3 || 0
        });
    }

    // Aggiorna UI
    updateDashboardUI();
}

// ==========================================
// GPS UPDATE
// ==========================================
function onGpsUpdate(data) {
    if (!data) return;

    const tMs = data.timestamp || Date.now();
    ensureSessionStart(tMs);

    const sample = {
        t: tMs,
        lat: data.latitude,
        lng: data.longitude,
        acc: data.accuracy || 999,
        speedKmh: data.speed || 0,
        cumDistM: data.distance || 0
    };

    gpsSamples.push(sample);
    
    lastSpeedKmh = sample.speedKmh;
    lastDistanceM = sample.cumDistM;

    // Aggiorna mappa
    updateMapPosition(sample.lat, sample.lng);
    
    // Aggiorna UI
    updateDashboardUI();
}

// ==========================================
// PRESSURE UPDATE
// ==========================================
function onPressureUpdate(data) {
    if (!data) return;

    const tMs = data.timestamp || Date.now();
    ensureSessionStart(tMs);

    const isLeft = data.foot === "left" || 
                   data.device_id?.toLowerCase().includes("left") ||
                   data.device_id?.toLowerCase().includes("sx");

    const sample = {
        t: tMs,
        s1: data.sensor1 || 0,
        s2: data.sensor2 || 0,
        s3: data.sensor3 || 0
    };

    if (isLeft) {
        leftSockSamples.push(sample);
        if (leftSockSamples.length > 1000) leftSockSamples.shift();
        updatePressureChart("left");
    } else {
        rightSockSamples.push(sample);
        if (rightSockSamples.length > 1000) rightSockSamples.shift();
        updatePressureChart("right");
    }
}

// ==========================================
// BONGIORNO INDEX CALCULATION
// ==========================================
function updateBongiornoIndex(side) {
    const samples = side === "left" ? leftAccelSamples : rightAccelSamples;
    
    if (samples.length === 0) return;

    // Prendi gli ultimi N campioni durante la fase di spinta
    // Per semplicità calcola la media degli ultimi 50 campioni
    const N = Math.min(50, samples.length);
    const recent = samples.slice(-N);

    let sumBI = 0;
    let count = 0;

    for (const s of recent) {
        const { ax, ay, az } = s;
        const mag = Math.sqrt(ax * ax + ay * ay + az * az);
        
        if (mag > 0.1) { // Evita divisione per zero
            // Formula: BI = |az| / sqrt(ax² + ay² + az²) * 100
            const bi = (Math.abs(az) / mag) * 100;
            sumBI += bi;
            count++;
        }
    }

    const avgBI = count > 0 ? sumBI / count : 0;

    if (side === "left") {
        bongiornoIndexSX = avgBI;
        const el = document.getElementById("bongiorno-sx-value");
        if (el) el.textContent = avgBI.toFixed(1);
    } else {
        bongiornoIndexDX = avgBI;
        const el = document.getElementById("bongiorno-dx-value");
        if (el) el.textContent = avgBI.toFixed(1);
    }
}

// ==========================================
// MAPPA
// ==========================================
function initMap() {
    const mapEl = document.getElementById("map");
    if (!mapEl) {
        console.warn("Map element not found");
        return;
    }

    try {
        map = L.map("map", {
            zoomControl: true,
            attributionControl: false
        }).setView([45.4408, 12.3155], 13); // Mestre default

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19
        }).addTo(map);

        isMapInitialized = true;
        console.log("Map initialized ✓");
    } catch (error) {
        console.error("Error initializing map:", error);
    }
}

function updateMapPosition(lat, lng) {
    if (!isMapInitialized || !map) return;

    if (!mapMarker) {
        mapMarker = L.circleMarker([lat, lng], {
            radius: 8,
            fillColor: SENSORIA_GREEN,
            color: "#fff",
            weight: 2,
            opacity: 1,
            fillOpacity: 0.8
        }).addTo(map);

        map.setView([lat, lng], 15);
    } else {
        mapMarker.setLatLng([lat, lng]);
    }

    // Aggiorna tracciato
    if (!fullRoute) {
        fullRoute = L.polyline([[lat, lng]], {
            color: SENSORIA_GREEN,
            weight: 4,
            opacity: 0.7
        }).addTo(map);
    } else {
        fullRoute.addLatLng([lat, lng]);
    }
}

// ==========================================
// PRESSURE CHARTS
// ==========================================
function initPressureCharts() {
    const opts = {
        width: 300,
        height: 150,
        scales: { x: { time: false } },
        axes: [
            {},
            {
                stroke: RED_COLOR,
                grid: { show: false }
            }
        ],
        series: [
            {},
            { stroke: RED_COLOR, width: 2, label: "S1" },
            { stroke: "#ff9999", width: 2, label: "S2" },
            { stroke: "#ffcccc", width: 2, label: "S3" }
        ],
        legend: { show: false }
    };

    const leftEl = document.getElementById("pressure-left-chart");
    const rightEl = document.getElementById("pressure-right-chart");

    try {
        if (leftEl) {
            pressureChartLeft = new uPlot(opts, pressureDataLeft, leftEl);
            console.log("Left pressure chart initialized ✓");
        }

        if (rightEl) {
            pressureChartRight = new uPlot(opts, pressureDataRight, rightEl);
            console.log("Right pressure chart initialized ✓");
        }
    } catch (error) {
        console.error("Error initializing pressure charts:", error);
    }
}

function updatePressureChart(side) {
    const samples = side === "left" ? leftSockSamples : rightSockSamples;
    const chart = side === "left" ? pressureChartLeft : pressureChartRight;
    const data = side === "left" ? pressureDataLeft : pressureDataRight;

    if (!chart || samples.length === 0) return;

    try {
        // Popola data
        data[0] = samples.map((s, i) => i);
        data[1] = samples.map(s => s.s1);
        data[2] = samples.map(s => s.s2);
        data[3] = samples.map(s => s.s3);

        chart.setData(data);
    } catch (error) {
        console.error(`Error updating ${side} pressure chart:`, error);
    }
}

// ==========================================
// RAW CHARTS (DATI RAW)
// ==========================================
function initRawCharts() {
    const opts = {
        width: 1000,
        height: 180,
        scales: { x: { time: false } },
        axes: [
            {},
            {
                stroke: RED_COLOR,
                grid: { show: true, stroke: "#333" }
            }
        ],
        series: [
            {},
            { stroke: RED_COLOR, width: 2, label: "Acc X" },
            { stroke: YELLOW_COLOR, width: 2, label: "Acc Y" },
            { stroke: GREEN_COLOR, width: 2, label: "Acc Z" }
        ],
        legend: { show: true }
    };

    const leftEl = document.getElementById("raw-chart-left");
    const rightEl = document.getElementById("raw-chart-right");

    try {
        if (leftEl) {
            rawChartLeft = new uPlot(opts, rawDataLeft, leftEl);
            console.log("Left raw chart initialized ✓");
        }

        if (rightEl) {
            rawChartRight = new uPlot(opts, rawDataRight, rightEl);
            console.log("Right raw chart initialized ✓");
        }
    } catch (error) {
        console.error("Error initializing raw charts:", error);
    }
}

function updateRawCharts() {
    // Left
    if (rawChartLeft && leftAccelSamples.length > 0) {
        try {
            rawDataLeft[0] = leftAccelSamples.map((s, i) => i);
            rawDataLeft[1] = leftAccelSamples.map(s => s.ax);
            rawDataLeft[2] = leftAccelSamples.map(s => s.ay);
            rawDataLeft[3] = leftAccelSamples.map(s => s.az);
            rawChartLeft.setData(rawDataLeft);
        } catch (error) {
            console.error("Error updating left raw chart:", error);
        }
    }

    // Right
    if (rawChartRight && rightAccelSamples.length > 0) {
        try {
            rawDataRight[0] = rightAccelSamples.map((s, i) => i);
            rawDataRight[1] = rightAccelSamples.map(s => s.ax);
            rawDataRight[2] = rightAccelSamples.map(s => s.ay);
            rawDataRight[3] = rightAccelSamples.map(s => s.az);
            rawChartRight.setData(rawDataRight);
        } catch (error) {
            console.error("Error updating right raw chart:", error);
        }
    }
}

// ==========================================
// TABS
// ==========================================
function initTabs() {
    const buttons = document.querySelectorAll(".tab-btn");
    buttons.forEach(btn => {
        btn.addEventListener("click", () => {
            const tab = btn.dataset.tab;
            switchTab(tab);
        });
    });
}

function switchTab(tab) {
    currentTab = tab;

    // Update button states
    document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.tab === tab);
    });

    // Show/hide charts
    const leftChart = document.getElementById("raw-chart-left");
    const rightChart = document.getElementById("raw-chart-right");

    if (leftChart) leftChart.style.display = tab === "left" ? "block" : "none";
    if (rightChart) rightChart.style.display = tab === "right" ? "block" : "none";

    updateRawCharts();
}

// ==========================================
// DASHBOARD UI UPDATE
// ==========================================
function updateDashboardUI() {
    // Aggiorna angoli (placeholder)
    // TODO: In futuro calcolare da dati IMU
    const kneeEl = document.getElementById("knee-angle-value");
    const tibiaEl = document.getElementById("tibia-angle-value");
    
    if (kneeEl) kneeEl.textContent = kneeAngle.toFixed(0);
    if (tibiaEl) tibiaEl.textContent = tibiaAngle.toFixed(0);
}

// ==========================================
// REPLAY CONTROLS
// ==========================================
function initReplayControls() {
    const playBtn = document.getElementById("replay-play-btn");
    const slider = document.getElementById("replay-slider");

    if (playBtn) {
        playBtn.addEventListener("click", toggleReplay);
    }

    if (slider) {
        slider.addEventListener("click", onReplaySliderClick);
    }
}

var isReplayPlaying = false;
var replayIntervalId = null;
var currentReplayTimeMs = 0;

function toggleReplay() {
    isReplayPlaying = !isReplayPlaying;
    const btn = document.getElementById("replay-play-btn");

    if (isReplayPlaying) {
        btn.textContent = "⏸ Pause";
        startReplayPlayback();
    } else {
        btn.textContent = "▶ Play";
        stopReplayPlayback();
    }
}

function startReplayPlayback() {
    if (!sessionStartTimeMs || !sessionEndTimeMs) return;

    replayIntervalId = setInterval(() => {
        currentReplayTimeMs += 100;
        
        if (currentReplayTimeMs > (sessionEndTimeMs - sessionStartTimeMs)) {
            currentReplayTimeMs = sessionEndTimeMs - sessionStartTimeMs;
            stopReplayPlayback();
        }

        updateReplayUI();
    }, 100);
}

function stopReplayPlayback() {
    if (replayIntervalId) {
        clearInterval(replayIntervalId);
        replayIntervalId = null;
    }
    isReplayPlaying = false;
    const btn = document.getElementById("replay-play-btn");
    if (btn) btn.textContent = "▶ Play";
}

function updateReplayUI() {
    if (!sessionStartTimeMs || !sessionEndTimeMs) return;

    const duration = sessionEndTimeMs - sessionStartTimeMs;
    const progress = (currentReplayTimeMs / duration) * 100;

    const progressEl = document.getElementById("replay-progress");
    if (progressEl) progressEl.style.width = progress + "%";

    const sec = Math.floor(currentReplayTimeMs / 1000);
    const min = Math.floor(sec / 60);
    const secRem = sec % 60;
    
    const timeEl = document.getElementById("replay-time-display");
    if (timeEl) timeEl.textContent = `${pad(min)}:${pad(secRem)}`;
}

function onReplaySliderClick(e) {
    if (!sessionStartTimeMs || !sessionEndTimeMs) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = x / rect.width;

    const duration = sessionEndTimeMs - sessionStartTimeMs;
    currentReplayTimeMs = duration * percent;

    updateReplayUI();
}

function showReplayOverlay() {
    const overlay = document.getElementById("replay-overlay");
    if (overlay) overlay.style.display = "block";
}

function pad(n) {
    return n < 10 ? "0" + n : n;
}

// ==========================================
// LOAD PAST ACTIVITY
// ==========================================
function loadPastActivity() {
    const filename = prompt("Inserisci il nome del file JSON (es: activity_123.json):");
    if (!filename) return;

    console.log("Loading past activity:", filename);
    socket.emit("load_past_activity", { filename });
}

// ==========================================
// UTILS
// ==========================================
function ensureSessionStart(tMs) {
    if (sessionStartTimeMs == null) {
        sessionStartTimeMs = tMs;
        console.log("Session started at:", new Date(tMs).toISOString());
    }
}

function getNowMs() {
    return Date.now();
}

console.log("Dashboard module loaded ✓");
