/**
 * Main application controller — visualization only
 */

'use strict';

// ── Shared state ──────────────────────────────────────────────────────────────
const AppState = {
  connected:         false,
  availableStations: [],
  loaderStationId:   5,
  pnpStations:       [],
  systemState:       'idle',
  productionActive:  false,
};

// ── PlacementStatus (client mirror) ──────────────────────────────────────────
const PlacementStatus = {
  IDLE_WAITING_FOR_NEW_PCB:       0,
  LOADING_NEW_PCB:                1,
  LOADING_NEW_PCB_FINISHED:       2,
  COMPONENT_PLACEMENT_STARTED:    3,
  COMPONENT_PLACEMENT_FINISHED:   4,
  WAITING_TO_START_UNLOADING_PCB: 5,
  UNLOADING_POPULATED_PCB:        6,
  UNLOADING_FINISHED:             7,
  ERROR:                          99,
  getName(code) {
    return Object.entries(this).find(([k, v]) => typeof v === 'number' && v === code)?.[0]
      ?? String(code);
  },
};

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const socket = io();

socket.on('connect',    () => logEvent('Connected to server'));
socket.on('disconnect', () => {
  logEvent('Connection to server lost — reconnecting...');
  updateConnectionBadge(false);
  updateSystemBadge('idle');
});

socket.on('connectionState', (data) => {
  AppState.connected         = data.connected;
  AppState.availableStations = data.availableStations ?? [];
  AppState.loaderStationId   = data.loaderStationId ?? 5;
  AppState.pnpStations       = data.pnpStations ?? [];
  updateConnectionBadge(data.connected);
  if (data.connected) {
    buildPipeline();
    SetupTab.onConnected();
    OperationTab.buildStatusTable();
    MonitoringTab.buildTables();
    logEvent(`Connected — Loader ID ${data.loaderStationId}, P&P stations: [${data.pnpStations}]`);
  } else {
    clearPipeline();
    logEvent('Disconnected from stations');
  }
});

socket.on('systemState', (data) => {
  AppState.systemState = data.state;
  updateSystemBadge(data.state, data);
  updateBanner(data.state, data);
  updateDashboardCards(data.state);
});

socket.on('initProgress', (data) => {
  if (data.pct != null) updateInitProgress(data.pct);
  if (data.message)     logInit(data.message);
});

socket.on('totalPcbsUpdated', ({ totalPcbs }) => {
  const el = document.getElementById('totalPcbsInput');
  if (el) el.value = totalPcbs;
});

// Production events
socket.on('productionStarted',  (d) => {
  AppState.productionActive = true;
  OperationTab.onProductionStarted(d);
  updateDashboardCards('production');
  logEvent(`Production started — ${d.totalPcbs} PCBs`);
});
socket.on('productionStopped',  () => {
  AppState.productionActive = false;
  OperationTab.onProductionStopped();
  logEvent('Production stopped by operator');
});
socket.on('productionComplete', (d) => {
  AppState.productionActive = false;
  OperationTab.onProductionComplete(d);
  updateBanner('complete', d);
  logEvent(`Production complete — ${d.totalPcbs} PCBs in ${d.totalTime.toFixed(1)}s`);
});
socket.on('pcbCompleted',  (d)  => {
  OperationTab.onPcbCompleted(d);
  logEvent(`PCB ${d.pcbId} completed at ${d.stationName} (${d.cycleTime.toFixed(1)}s)`);
});
socket.on('stateChange',   (d)  => {
  OperationTab.onStateChange(d);
  updatePipelineStation(d.slaveId, d.newStatus, d.statusName, null);
  logEvent(`${d.stationName}: ${PlacementStatus.getName(d.oldStatus)} → ${d.statusName}`);
});
socket.on('snapshot',      (d)  => {
  OperationTab.onSnapshot(d);
  updateKPIs(d);
  if (d?.stationRows) {
    d.stationRows.forEach(r => updatePipelineStation(r.slaveId, r.status, r.statusName, r.pcbId));
  }
});
socket.on('buttonPressed', () => {
  logEvent('Physical START button pressed — production starting...');
  updateBanner('starting', {});
});
socket.on('setupComplete',     () => logEvent('Setup complete — awaiting start button'));
socket.on('returnedToSetup',   () => {
  AppState.productionActive = false;
  logEvent('All stations returned to setup page');
});

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById(`tab-${name}`);
  const btn   = document.querySelector(`[data-tab="${name}"]`);
  if (panel) panel.classList.add('active');
  if (btn)   btn.classList.add('active');
  if (name === 'monitoring' && AppState.connected) MonitoringTab.startPolling();
  else MonitoringTab.stopPolling();
}

// ── Connection badge ──────────────────────────────────────────────────────────
function updateConnectionBadge(connected) {
  const badge = document.getElementById('connectionBadge');
  const text  = document.getElementById('connBadgeText');
  badge.className = `conn-badge ${connected ? 'connected' : 'disconnected'}`;
  text.textContent = connected ? 'Connected' : 'Disconnected';
}

// ── System state badge ────────────────────────────────────────────────────────
function updateSystemBadge(state, extra = {}) {
  const badge = document.getElementById('systemBadge');
  const text  = document.getElementById('systemBadgeText');
  const map = {
    idle:          ['badge-idle',         'Idle'],
    detecting:     ['badge-detecting',    'Detecting...'],
    initializing:  ['badge-initializing', 'Initializing'],
    setup:         ['badge-setup',        extra.waitingForButton ? 'Awaiting Button' : 'Setup'],
    production:    ['badge-production',   'Production'],
    error:         ['badge-error',        'Error'],
  };
  const [cls, label] = map[state] ?? ['badge-idle', state];
  badge.className = `sys-badge ${cls}`;
  text.textContent = label;
}

// ── Status banner ─────────────────────────────────────────────────────────────
function updateBanner(state, data = {}) {
  const banner = document.getElementById('statusBanner');
  const icon   = document.getElementById('bannerIcon');
  const title  = document.getElementById('bannerTitle');
  const sub    = document.getElementById('bannerSub');

  const configs = {
    idle:         { cls: 'banner-searching',    ico: '⟳', ttl: 'Searching for PCB Loader...',          sub: 'Scanning available serial ports for Slave ID 5' },
    detecting:    { cls: 'banner-searching',    ico: '⟳', ttl: 'Detecting PCB Loader...',              sub: 'Trying all serial ports' },
    initializing: { cls: 'banner-initializing', ico: '⚡', ttl: 'Initializing Stations',               sub: 'Resetting stations and loading setup page' },
    setup:        { cls: data.waitingForButton ? 'banner-waiting' : 'banner-setup',
                                                ico: data.waitingForButton ? '🔘' : '⚙',
                                                ttl: data.waitingForButton ? 'Waiting for Physical Start Button' : 'Setup Phase — Configure Component Distribution',
                                                sub: data.waitingForButton
                                                  ? 'Press the START button on the PCB Loader to begin production'
                                                  : 'Set component counts on each station display (total must equal 0 remaining)' },
    starting:     { cls: 'banner-production',   ico: '▶', ttl: 'Starting Production...',              sub: 'Activating all stations' },
    production:   { cls: 'banner-production',   ico: '▶', ttl: 'Production Running',                  sub: `${data.pcbsCompleted ?? 0} / ${data.totalPcbs ?? '?'} PCBs completed` },
    complete:     { cls: 'banner-complete',      ico: '✓', ttl: 'Production Complete!',                sub: data.totalPcbs ? `${data.totalPcbs} PCBs in ${data.totalTime?.toFixed(1) ?? '?'}s` : '' },
    error:        { cls: 'banner-error',         ico: '✗', ttl: 'System Error',                        sub: data.message ?? 'Check console for details' },
  };

  const cfg = configs[state] ?? configs.idle;
  banner.className = `status-banner ${cfg.cls}`;
  icon.textContent  = cfg.ico;
  title.textContent = cfg.ttl;
  sub.textContent   = cfg.sub;
}

// ── Dashboard cards visibility ────────────────────────────────────────────────
function updateDashboardCards(state) {
  const showProgress = ['production', 'complete'].includes(state);
  const showTarget   = ['setup', 'production'].includes(state);
  const showStop     = state === 'production';

  setDisplay('progressCard',  showProgress);
  setDisplay('pcbTargetCard', showTarget);
  setDisplay('stopCard',      showStop);
}

// ── Pipeline ──────────────────────────────────────────────────────────────────
function buildPipeline() {
  const container = document.getElementById('pipeline');
  container.innerHTML = '';
  const stations = [AppState.loaderStationId, ...AppState.pnpStations];
  stations.forEach((sid, idx) => {
    const name = sid === AppState.loaderStationId ? 'PCB Loader' : `P&P ${sid}`;
    const div = document.createElement('div');
    div.className = 'pipeline-station st-idle';
    div.id = `pipe-${sid}`;
    div.innerHTML = `
      <div class="station-name">${name}</div>
      <div class="station-status-dot"></div>
      <div class="station-status-text">Idle</div>
      <div class="station-pcb"></div>
    `;
    container.appendChild(div);
  });
}

function clearPipeline() {
  const container = document.getElementById('pipeline');
  container.innerHTML = '<div class="pipeline-placeholder">Waiting for connection...</div>';
}

function updatePipelineStation(slaveId, statusCode, statusName, pcbId) {
  const el = document.getElementById(`pipe-${slaveId}`);
  if (!el) return;
  const textEl = el.querySelector('.station-status-text');
  const pcbEl  = el.querySelector('.station-pcb');
  if (textEl) textEl.textContent = statusName ?? 'Unknown';
  if (pcbEl)  pcbEl.textContent  = pcbId > 0 ? `PCB #${pcbId}` : '';

  // Determine CSS class
  const cls = stationCssClass(statusCode);
  el.className = `pipeline-station ${cls}`;
}

function stationCssClass(code) {
  if (code === 0)            return 'st-idle';
  if (code === 1 || code === 2) return 'st-loading';
  if (code >= 3 && code <= 5)   return 'st-working';
  if (code === 6 || code === 7) return 'st-unloading';
  if (code === 99)              return 'st-error';
  return 'st-idle';
}

// ── KPI Updates ───────────────────────────────────────────────────────────────
function updateKPIs(snap) {
  if (!snap) return;
  setText('kpi-completed',  snap.productionActive || snap.pcbsCompleted > 0 ? snap.pcbsCompleted : '—');
  setText('kpi-remaining',  snap.productionActive ? (snap.totalPcbs - snap.pcbsCompleted) : '—');
  setText('kpi-throughput', snap.throughputPerMin > 0 ? snap.throughputPerMin.toFixed(2) : '—');

  if (snap.productionActive && snap.elapsedSeconds > 0) {
    const t = snap.elapsedSeconds;
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    setText('kpi-elapsed', `${pad(h)}:${pad(m)}:${pad(s)}`);
  } else {
    setText('kpi-elapsed', '—');
  }

  setText('kpi-stations', AppState.availableStations.length || '—');

  // Progress bar
  if (snap.productionActive && snap.totalPcbs > 0) {
    const pct = Math.round((snap.pcbsCompleted / snap.totalPcbs) * 100);
    const fill = document.getElementById('progressFill');
    if (fill) fill.style.width = `${pct}%`;
    setText('progressLabel', `${snap.pcbsCompleted} / ${snap.totalPcbs} PCBs`);
  }
}

// ── Init progress (setup tab) ─────────────────────────────────────────────────
function updateInitProgress(pct) {
  const fill = document.getElementById('initProgressFill');
  if (fill) fill.style.width = `${pct}%`;
}

function logInit(msg) {
  const box = document.getElementById('initLog');
  if (!box) return;
  box.textContent += msg + '\n';
  box.scrollTop = box.scrollHeight;
}

// ── Event Log ─────────────────────────────────────────────────────────────────
function logEvent(msg) {
  const box = document.getElementById('eventLog');
  if (!box) return;
  const now = new Date();
  const ts  = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(v => String(v).padStart(2, '0')).join(':');
  box.textContent += `[${ts}] ${msg}\n`;
  box.scrollTop = box.scrollHeight;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function setDisplay(id, show) {
  const el = document.getElementById(id);
  if (el) el.style.display = show ? '' : 'none';
}
function pad(n) { return String(n).padStart(2, '0'); }

function updateLedLabel(key, value) {
  const el = document.getElementById(`led-${key}-val`);
  if (el) el.textContent = value;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
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

// ── Wire tab buttons & controls ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => { if (!btn.disabled) switchTab(btn.dataset.tab); });
  });

  // Stop production
  document.getElementById('stopProductionBtn')?.addEventListener('click', async () => {
    if (!confirm('Stop production now?')) return;
    await apiPost('/api/operation/stop', {});
  });

  // Set total PCBs
  document.getElementById('setTotalBtn')?.addEventListener('click', async () => {
    const val = parseInt(document.getElementById('totalPcbsInput')?.value);
    if (!val || val < 1) { alert('Enter a valid number'); return; }
    await apiPost('/api/operation/set-total', { totalPcbs: val });
    logEvent(`Production target set to ${val} PCBs`);
  });

  // RFID table
  const rfidBody = document.getElementById('rfidTableBody');
  if (rfidBody) {
    for (let i = 0; i < 4; i++) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>Box ${i + 1}</td>
        <td><input type="text" id="rfid-uid-high-${i}" placeholder="0x00000000" style="width:110px;background:#0d1117;border:1px solid #3949ab;border-radius:4px;color:#fff;padding:0.25rem 0.4rem" /></td>
        <td><input type="text" id="rfid-uid-low-${i}"  placeholder="0x00000000" style="width:110px;background:#0d1117;border:1px solid #3949ab;border-radius:4px;color:#fff;padding:0.25rem 0.4rem" /></td>
        <td><input type="number" id="rfid-count-${i}" min="0" max="65535" value="0" style="width:80px;background:#0d1117;border:1px solid #3949ab;border-radius:4px;color:#fff;padding:0.25rem 0.4rem" /></td>
      `;
      rfidBody.appendChild(tr);
    }
  }

  // Initial banner
  updateBanner('idle');
});