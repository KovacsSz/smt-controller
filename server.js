/**
 * SMT Pick and Place Machine Controller
 * Express + Socket.IO backend server
 * Auto-connects when PCB Loader (Slave ID 5) is detected
 */

'use strict';

const express    = require('express');
const http       = require('http');
const { Server: SocketIOServer } = require('socket.io');
const cors       = require('cors');
const path       = require('path');
const { SerialPort } = require('serialport');

const ModbusHandler  = require('./src/modbusHandler');
const StationManager = require('./src/stationManager');
const {
  PCB_LOADER_SLAVE_ID,
  SLAVE_IDS,
  PageID,
  HoldingRegisterAddresses,
  CoilAddresses,
  DiscreteInputAddresses,
} = require('./src/modbusDefinitions');

// ─── APP SETUP ────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new SocketIOServer(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── APPLICATION STATE ────────────────────────────────────────────────────────

let modbusHandler       = null;
let stationManager      = null;
let availableStations   = [];
let loaderStationId     = PCB_LOADER_SLAVE_ID;
let pnpStations         = [];
let pendingTotalPcbs    = 10;

// Auto-detection state
let autoDetectTimer     = null;
let autoDetectRunning   = false;
let systemState         = 'idle'; // idle | detecting | initializing | setup | production | error

const RESET_POLL_INTERVAL_MS  = 500;
const RESET_TOTAL_TIMEOUT_MS  = 30000;
const UI_WAIT_PER_STATION_MS  = 20000;
const UI_POLL_INTERVAL_MS     = 500;
const AUTO_DETECT_INTERVAL_MS = 3000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── BROADCAST HELPERS ────────────────────────────────────────────────────────

function broadcast(event, data) {
  io.emit(event, data);
}

function setSystemState(state, extra = {}) {
  systemState = state;
  broadcast('systemState', { state, ...extra });
  console.log(`[System] State → ${state}`, extra);
}

function logInit(message, pct = null) {
  const payload = { message };
  if (pct !== null) payload.pct = pct;
  broadcast('initProgress', payload);
  console.log(`[Init] ${message}`);
}

// ─── MANAGER EMIT ─────────────────────────────────────────────────────────────

function managerEmit(event) {
  io.emit(event.type, event);

  if (event.type === 'buttonPressed' && stationManager) {
    console.log('[Server] Physical button pressed – auto-starting production in 1s');
    setTimeout(async () => {
      try {
        for (const sid of availableStations) {
          await modbusHandler.setActivePage(sid, PageID.PICK_AND_PLACE_ANIMATION);
        }
        await stationManager.startProduction(pendingTotalPcbs);
        setSystemState('production');
      } catch (err) {
        console.error('[Server] Failed to auto-start production:', err.message);
        setSystemState('error', { message: err.message });
      }
    }, 1000);
  }

  if (event.type === 'productionComplete' || event.type === 'returnedToSetup') {
    setSystemState('setup');
  }

  if (event.type === 'productionStopped') {
    setSystemState('setup');
  }

  if (event.type === 'setupComplete') {
    setSystemState('setup', { waitingForButton: true });
  }
}

// ─── AUTO-DETECT & INITIALIZE ────────────────────────────────────────────────

async function tryDetectAndInitialize() {
  if (autoDetectRunning) return;
  if (modbusHandler && modbusHandler.connected) return;

  autoDetectRunning = true;

  try {
    // Get all available serial ports
    const ports = await SerialPort.list();
    if (ports.length === 0) {
      autoDetectRunning = false;
      return;
    }

    setSystemState('detecting');
    logInit('Auto-detecting PCB Loader on available ports...');

    let detectedPort  = null;
    let tempHandler   = null;

    // Try each port
    for (const portInfo of ports) {
      const portPath = portInfo.path;
      logInit(`  Trying ${portPath}...`);

      const handler = new ModbusHandler(portPath, {
        timeoutMs:    500,
        retries:      1,
        retryDelayMs: 100,
      });

      try {
        const opened = await handler.connect();
        if (!opened) {
          handler.disconnect();
          continue;
        }

        const found = await handler.pingStation(PCB_LOADER_SLAVE_ID);
        if (found) {
          detectedPort = portPath;
          tempHandler  = handler;
          logInit(`  ✓ PCB Loader found on ${portPath}`);
          break;
        } else {
          handler.disconnect();
        }
      } catch {
        try { handler.disconnect(); } catch { /* ignore */ }
      }

      await sleep(100);
    }

    if (!detectedPort || !tempHandler) {
      setSystemState('idle');
      autoDetectRunning = false;
      return;
    }

    // PCB Loader detected — run full initialization
    await runInitialization(detectedPort, tempHandler);

  } catch (err) {
    console.error('[AutoDetect] Error:', err.message);
    setSystemState('error', { message: err.message });
    if (modbusHandler) {
      modbusHandler.disconnect();
      modbusHandler = null;
    }
    autoDetectRunning = false;
  }
}

async function runInitialization(port, existingHandler) {
  setSystemState('initializing');

  try {
    // Reuse the handler that already found the loader, but recreate with proper timeouts
    existingHandler.disconnect();
    await sleep(200);

    modbusHandler = new ModbusHandler(port, {
      timeoutMs:    1000,
      retries:      2,
      retryDelayMs: 200,
    });

    if (!(await modbusHandler.connect())) {
      throw new Error(`Failed to open serial port ${port}`);
    }

    logInit(`✓ Serial port ${port} opened`, 2);
    await sleep(200);

    // ── Verify PCB Loader ────────────────────────────────────────────────────
    logInit(`Verifying PCB Loader (Slave ID ${PCB_LOADER_SLAVE_ID})...`, 5);
    let loaderFound = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      loaderFound = await modbusHandler.pingStation(PCB_LOADER_SLAVE_ID);
      if (loaderFound) break;
      await sleep(500);
    }
    if (!loaderFound) {
      throw new Error(`PCB Loader (ID ${PCB_LOADER_SLAVE_ID}) not responding`);
    }
    logInit(`✓ PCB Loader confirmed (ID ${PCB_LOADER_SLAVE_ID})`, 10);

    // ── Detect P&P stations ──────────────────────────────────────────────────
    logInit('Detecting Pick and Place stations...', 12);
    const foundPnp = [];
    for (const sid of SLAVE_IDS) {
      const found = await modbusHandler.pingStation(sid);
      if (found) {
        foundPnp.push(sid);
        logInit(`  ✓ P&P Station ${sid} detected`);
      } else {
        logInit(`  – P&P Station ${sid} not found`);
      }
      await sleep(100);
    }

    if (foundPnp.length === 0) {
      throw new Error('No Pick and Place stations detected');
    }
    logInit(`✓ ${foundPnp.length} P&P station(s) found: [${foundPnp}]`, 18);

    const allStations = [PCB_LOADER_SLAVE_ID, ...foundPnp];

    // ── Soft reset ALL stations ──────────────────────────────────────────────
    logInit('\nPhase 1 — Resetting all stations...', 20);

    for (const sid of allStations) {
      const name = sid === PCB_LOADER_SLAVE_ID ? 'PCB Loader' : `P&P ${sid}`;
      const ok   = await modbusHandler.softReset(sid);
      if (!ok) throw new Error(`Failed to reset ${name}`);
      logInit(`  ↺ Reset sent → ${name}`);
      await sleep(50);
    }

    // ── Wait for reset complete ───────────────────────────────────────────────
    logInit('\nPhase 2 — Waiting for stations to complete reset...');

    const pending    = new Set(allStations);
    const confirmed  = new Set();
    const resetStart = Date.now();

    while (pending.size > 0) {
      if (Date.now() - resetStart > RESET_TOTAL_TIMEOUT_MS) {
        throw new Error(`Reset timeout for stations: [${[...pending]}]`);
      }
      for (const sid of [...pending]) {
        const done = await modbusHandler.checkSoftResetComplete(sid);
        if (done) {
          const name = sid === PCB_LOADER_SLAVE_ID ? 'PCB Loader' : `P&P ${sid}`;
          logInit(`  ✓ ${name}: reset complete`);
          pending.delete(sid);
          confirmed.add(sid);
          const pct = 20 + Math.round((confirmed.size / allStations.length) * 30);
          broadcast('initProgress', { pct });
        }
      }
      if (pending.size > 0) await sleep(RESET_POLL_INTERVAL_MS);
    }

    // ── Wait for UIs to load ──────────────────────────────────────────────────
    logInit('\nPhase 3 — Waiting for station UIs to load...');
    broadcast('initProgress', { pct: 55 });

    for (let i = 0; i < allStations.length; i++) {
      const sid  = allStations[i];
      const name = sid === PCB_LOADER_SLAVE_ID ? 'PCB Loader' : `P&P ${sid}`;
      logInit(`  ⏳ Waiting for ${name} UI...`);

      const loaded = await modbusHandler.checkUiLoaded(
        sid, UI_WAIT_PER_STATION_MS, UI_POLL_INTERVAL_MS
      );
      if (!loaded) {
        throw new Error(`${name} UI did not load within ${UI_WAIT_PER_STATION_MS / 1000}s`);
      }
      logInit(`  ✓ ${name}: UI loaded`);
      broadcast('initProgress', { pct: 55 + Math.round(((i + 1) / allStations.length) * 20) });
    }

    // ── Verify IDs & set setup page ───────────────────────────────────────────
    logInit('\nPhase 4 — Verifying station IDs and setting setup page...');
    broadcast('initProgress', { pct: 78 });

    for (let i = 0; i < allStations.length; i++) {
      const sid  = allStations[i];
      const name = sid === PCB_LOADER_SLAVE_ID ? 'PCB Loader' : `P&P ${sid}`;

      const stationId = await modbusHandler.getStationId(sid);
      if (stationId === null) throw new Error(`${name}: cannot read station ID`);
      if (stationId !== sid)  throw new Error(`${name} ID mismatch: expected ${sid}, got ${stationId}`);

      const ok = await modbusHandler.setActivePage(sid, PageID.PLACEMENT_PARAMETERS_SETUP);
      if (!ok) throw new Error(`Failed to set setup page for ${name}`);

      logInit(`  ✓ ${name}: verified, setup page set`);
      broadcast('initProgress', { pct: 78 + Math.round(((i + 1) / allStations.length) * 20) });
    }

    // ── Done ──────────────────────────────────────────────────────────────────
    broadcast('initProgress', { pct: 100, message: '✓ ALL STATIONS INITIALIZED' });

    availableStations = allStations;
    loaderStationId   = PCB_LOADER_SLAVE_ID;
    pnpStations       = foundPnp;

    stationManager = new StationManager(
      modbusHandler,
      loaderStationId,
      pnpStations,
      managerEmit
    );

    broadcast('connectionState', {
      connected: true,
      availableStations,
      loaderStationId,
      pnpStations,
      port,
    });

    // Immediately begin setup monitoring
    await stationManager.onSetupComplete();
    setSystemState('setup', { waitingForButton: false });

    autoDetectRunning = false;

  } catch (err) {
    console.error('[Init] Error:', err.message);
    logInit(`✗ ERROR: ${err.message}`);
    setSystemState('error', { message: err.message });

    if (modbusHandler) {
      modbusHandler.disconnect();
      modbusHandler = null;
    }
    availableStations = [];
    pnpStations       = [];

    broadcast('connectionState', {
      connected:         false,
      availableStations: [],
      pnpStations:       [],
    });

    autoDetectRunning = false;
  }
}

// ─── START AUTO-DETECT LOOP ───────────────────────────────────────────────────

function startAutoDetect() {
  if (autoDetectTimer) clearInterval(autoDetectTimer);
  autoDetectTimer = setInterval(() => {
    if (!modbusHandler || !modbusHandler.connected) {
      tryDetectAndInitialize();
    }
  }, AUTO_DETECT_INTERVAL_MS);

  // Run immediately on start
  tryDetectAndInitialize();
}

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('[Socket] Client connected:', socket.id);

  socket.emit('connectionState', {
    connected:         modbusHandler?.connected ?? false,
    availableStations,
    loaderStationId,
    pnpStations,
  });

  socket.emit('systemState', { state: systemState });

  if (stationManager) {
    socket.emit('snapshot', stationManager.getSnapshot());
  }

  socket.on('disconnect', () => {
    console.log('[Socket] Client disconnected:', socket.id);
  });
});

// ─── REST API ─────────────────────────────────────────────────────────────────

// List serial ports
app.get('/api/ports', async (_req, res) => {
  try {
    const ports = await SerialPort.list();
    res.json(ports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual disconnect (for admin use)
app.post('/api/disconnect', (_req, res) => {
  if (stationManager) {
    stationManager._stopPolling();
    stationManager = null;
  }
  if (modbusHandler) {
    modbusHandler.disconnect();
    modbusHandler = null;
  }
  availableStations = [];
  pnpStations       = [];
  setSystemState('idle');

  broadcast('connectionState', {
    connected: false, availableStations: [], pnpStations: [],
  });

  res.json({ success: true });
});

// Setup: read component distribution
app.get('/api/setup/components', async (_req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  try {
    const result = {};
    for (const sid of pnpStations) {
      const components = await modbusHandler.getComponentsToPlace(sid);
      result[sid] = components
        ? { transistors: components[0], diodes: components[1], ics: components[2], capacitors: components[3] }
        : { transistors: 0, diodes: 0, ics: 0, capacitors: 0 };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Setup: write total positions
app.post('/api/setup/total-positions', async (req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  const { slaveId, transistors, diodes, ics, capacitors } = req.body;
  try {
    const ok = await modbusHandler.setTotalPositions(slaveId, transistors, diodes, ics, capacitors);
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Setup: activate/deactivate physical start button
app.post('/api/setup/start-button', async (req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  const { active } = req.body;
  try {
    const ok = await modbusHandler.setStartButtonActive(loaderStationId, active);
    if (stationManager) {
      if (active) {
        await stationManager.onSetupComplete();
        setSystemState('setup', { waitingForButton: true });
      } else {
        stationManager.onSetupIncomplete();
        setSystemState('setup', { waitingForButton: false });
      }
    }
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Operation: set total PCBs
app.post('/api/operation/set-total', (req, res) => {
  const { totalPcbs } = req.body;
  if (totalPcbs && totalPcbs > 0) {
    pendingTotalPcbs = parseInt(totalPcbs);
    broadcast('totalPcbsUpdated', { totalPcbs: pendingTotalPcbs });
    res.json({ success: true, totalPcbs: pendingTotalPcbs });
  } else {
    res.status(400).json({ error: 'Invalid totalPcbs' });
  }
});

// Operation: stop production
app.post('/api/operation/stop', async (_req, res) => {
  if (!stationManager) return res.status(400).json({ error: 'Not connected' });
  try {
    await stationManager.stopProduction();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Operation: snapshot
app.get('/api/operation/snapshot', (_req, res) => {
  if (!stationManager) return res.status(400).json({ error: 'Not connected' });
  res.json(stationManager.getSnapshot());
});

// Configuration: read
app.get('/api/configuration', async (_req, res) => {
  if (!modbusHandler || pnpStations.length === 0) {
    return res.status(400).json({ error: 'No P&P stations connected' });
  }
  const slaveId = pnpStations[0];
  try {
    const timing = await modbusHandler.readHoldingRegisters(slaveId, HoldingRegisterAddresses.TRANSISTOR_PLACEMENT_DURATION_MS, 5);
    const led    = await modbusHandler.readHoldingRegisters(slaveId, HoldingRegisterAddresses.BRIGHTNESS_RED_LED, 6);
    const rfid   = await modbusHandler.readHoldingRegisters(slaveId, HoldingRegisterAddresses.RFID_BOX_UID_START, 12);
    const vol    = await modbusHandler.readHoldingRegisters(slaveId, HoldingRegisterAddresses.SPEAKER_VOLUME, 1);

    res.json({
      timing: timing ? { transistor: timing[0], diode: timing[1], ic: timing[2], capacitor: timing[3], transport: timing[4] } : null,
      led:    led    ? { red: led[0], yellow: led[1], green: led[2], rgb: led[3], thresholdYellow: led[4], thresholdRed: led[5] } : null,
      rfid:   rfid   ? Array.from({ length: 4 }, (_, i) => ({ uidHigh: rfid[i * 2], uidLow: rfid[i * 2 + 1], count: rfid[8 + i] })) : null,
      volume: vol    ? vol[0] : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Configuration: write
app.post('/api/configuration', async (req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  const { timing, led, rfid, volume } = req.body;
  try {
    for (const sid of availableStations) {
      if (timing) await modbusHandler.setTimingConfig(sid, timing.transistor, timing.diode, timing.ic, timing.capacitor, timing.transport);
      if (led)    await modbusHandler.setLedConfig(sid, led.red, led.yellow, led.green, led.rgb, led.thresholdYellow, led.thresholdRed);
      if (rfid) {
        const vals = [];
        rfid.forEach(b => vals.push(b.uidHigh, b.uidLow));
        rfid.forEach(b => vals.push(b.count));
        await modbusHandler.writeHoldingRegisters(sid, HoldingRegisterAddresses.RFID_BOX_UID_START, vals);
      }
      if (volume != null) await modbusHandler.setSpeakerVolume(sid, volume);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Configuration: soft reset
app.post('/api/configuration/soft-reset', async (_req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  try {
    for (const sid of availableStations) {
      if (!(await modbusHandler.softReset(sid))) throw new Error(`Failed to reset Station ${sid}`);
    }
    await sleep(2000);
    const start = Date.now();
    let allReset = false;
    while (!allReset && Date.now() - start < 10000) {
      allReset = true;
      for (const sid of availableStations) {
        if (!(await modbusHandler.checkSoftResetComplete(sid))) { allReset = false; break; }
      }
      if (!allReset) await sleep(200);
    }
    if (!allReset) throw new Error('Reset timeout');
    for (const sid of availableStations) {
      await modbusHandler.setActivePage(sid, PageID.PLACEMENT_PARAMETERS_SETUP);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Monitoring
app.get('/api/monitoring', async (_req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  try {
    const result = {};
    for (const sid of [loaderStationId, ...pnpStations]) {
      const statusData   = await modbusHandler.getAllStatus(sid);
      const inputCoils   = await modbusHandler.readCoils(sid, CoilAddresses.INPUT_TRANSISTOR_1_IS_POPULATED, 14);
      const outputInputs = await modbusHandler.readDiscreteInputs(sid, DiscreteInputAddresses.OUTPUT_TRANSISTOR_1_IS_POPULATED, 14);
      result[sid] = { statusData, inputCoils, outputInputs };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
server.listen(PORT, () => {
  console.log(`[Server] SMT Pick & Place Controller running at http://localhost:${PORT}`);
  startAutoDetect();
});