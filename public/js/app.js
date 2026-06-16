/**
 * Main application controller
 * Manages tab switching, Socket.IO connection, and shared state
 */

'use strict';

// ── Shared application state ──────────────────────────────────────────────────
const AppState = {
  connected: false,
  availableStations: [],
  loaderStationId: 5,
  pnpStations: [],
};

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const socket = io();

socket.on('connect', () => console.log('[Socket] Connected to server'));
socket.on('disconnect', () => console.log('[Socket] Disconnected from server'));

socket.on('connectionState', (data) => {
  AppState.connected = data.connected;
  AppState.availableStations = data.availableStations ?? [];
  AppState.loaderStationId = data.loaderStationId ?? 5;
  AppState.pnpStations = data.pnpStations ?? [];
  updateConnectionBadge(data.connected);
  updateTabAccess(data.connected);
  if (data.connected && typeof SetupTab !== 'undefined') SetupTab.onConnected();
});

socket.on('initProgress', (data) => {
  if (typeof ConnectionTab !== 'undefined') ConnectionTab.onProgress(data);
});

// Production events → Operation tab
socket.on('productionStarted', (d) => OperationTab.onProductionStarted(d));
socket.on('productionStopped', ()  => OperationTab.onProductionStopped());
socket.on('productionComplete', (d)=> OperationTab.onProductionComplete(d));
socket.on('pcbCompleted', (d)      => OperationTab.onPcbCompleted(d));
socket.on('stateChange', (d)       => {
  OperationTab.onStateChange(d);
  MonitoringTab.logEvent(`${d.stationName}: ${PlacementStatus.getName(d.oldStatus)} → ${d.statusName}`);
});
socket.on('snapshot', (d) => OperationTab.onSnapshot(d));
socket.on('returnedToSetup', ()    => {
  setTabEnabled('setup', true);
  setTabEnabled('operation', false);
  switchTab('setup');
});

// Button pressed → enable operation tab, server will auto-start
socket.on('buttonPressed', () => {
  MonitoringTab.logEvent('Physical start button pressed on PCB Loader');
  setTabEnabled('operation', true);
  switchTab('operation');
  // Server auto-starts production after 1 s
});

// ── PlacementStatus mirror (subset for client-side name lookup) ────────────────
const PlacementStatus = {
  IDLE_WAITING_FOR_NEW_PCB: 0,
  LOADING_NEW_PCB: 1,
  LOADING_NEW_PCB_FINISHED: 2,
  COMPONENT_PLACEMENT_STARTED: 3,
  COMPONENT_PLACEMENT_FINISHED: 4,
  WAITING_TO_START_UNLOADING_PCB: 5,
  UNLOADING_POPULATED_PCB: 6,
  UNLOADING_FINISHED: 7,
  ERROR: 99,
  getName(code) {
    return (
      Object.entries(this).find(
        ([k, v]) => typeof v === 'number' && v === code
      )?.[0] ?? String(code)
    );
  },
};

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tabName) {
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
  const panel = document.getElementById(`tab-${tabName}`);
  const btn = document.querySelector(`[data-tab="${tabName}"]`);
  if (panel) panel.classList.add('active');
  if (btn) btn.classList.add('active');

  // Tab-specific init
  if (tabName === 'monitoring' && AppState.connected) MonitoringTab.startPolling();
  else MonitoringTab.stopPolling();
}

function setTabEnabled(tabName, enabled) {
  const btn = document.querySelector(`[data-tab="${tabName}"]`);
  if (btn) btn.disabled = !enabled;
}

function updateTabAccess(connected) {
  ['setup', 'configuration', 'monitoring'].forEach((t) => setTabEnabled(t, connected));
  setTabEnabled('operation', false); // only enabled when all components distributed
}

function updateConnectionBadge(connected) {
  const badge = document.getElementById('connectionBadge');
  badge.textContent = connected ? 'Connected' : 'Disconnected';
  badge.className = `badge ${connected ? 'connected' : 'disconnected'}`;
}

// LED slider label helper (called from HTML)
function updateLedLabel(key, value) {
  const el = document.getElementById(`led-${key}-val`);
  if (el) el.textContent = value;
}

// ── Wire tab buttons ──────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!btn.disabled) switchTab(btn.dataset.tab);
    });
  });

  // Build RFID table rows
  const rfidBody = document.getElementById('rfidTableBody');
  for (let i = 0; i < 4; i++) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>Box ${i + 1}</td>
      <td><input type="text" id="rfid-uid-high-${i}" placeholder="0x00000000" style="width:120px" /></td>
      <td><input type="text" id="rfid-uid-low-${i}"  placeholder="0x00000000" style="width:120px" /></td>
      <td><input type="number" id="rfid-count-${i}" min="0" max="65535" value="0" style="width:80px" /></td>
    `;
    rfidBody.appendChild(tr);
  }
});

// ── HTTP helper ───────────────────────────────────────────────────────────────
async function apiPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function apiGet(url) {
  const res = await fetch(url);
  return res.json();
}