/**
 * SMT Pick and Place Machine Controller
 * Express + Socket.IO backend server
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

let modbusHandler     = null;
let stationManager    = null;
let availableStations = [];
let loaderStationId   = PCB_LOADER_SLAVE_ID;
let pnpStations       = [];
let pendingTotalPcbs  = 10;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('[Socket] Client connected:', socket.id);

  // Send current state immediately on join
  socket.emit('connectionState', {
    connected:         modbusHandler?.connected ?? false,
    availableStations,
    loaderStationId,
    pnpStations,
  });

  if (stationManager) {
    socket.emit('snapshot', stationManager.getSnapshot());
  }

  socket.on('disconnect', () => {
    console.log('[Socket] Client disconnected:', socket.id);
  });
});

/** Broadcast to all connected clients */
function broadcast(event, data) {
  io.emit(event, data);
}

/**
 * Manager emit callback — routes StationManager events to clients.
 * Also handles the physical-button → auto-start flow.
 */
function managerEmit(event) {
  // Forward every event to the browser under its type name
  io.emit(event.type, event);

  // Physical button pressed → wait 1 s then start production
  if (event.type === 'buttonPressed' && stationManager) {
    setTimeout(async () => {
      try {
        for (const sid of availableStations) {
          await modbusHandler.setActivePage(sid, PageID.PICK_AND_PLACE_ANIMATION);
        }
        await stationManager.startProduction(pendingTotalPcbs);
      } catch (err) {
        console.error('[Server] Failed to auto-start production:', err.message);
      }
    }, 1000);
  }
}

// ─── REST API ─────────────────────────────────────────────────────────────────

// ── List serial ports ─────────────────────────────────────────────────────────
app.get('/api/ports', async (_req, res) => {
  try {
    const ports = await SerialPort.list();
    res.json(ports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Connect & Initialise ──────────────────────────────────────────────────────
app.post('/api/connect', async (req, res) => {
  const { port } = req.body;
  if (!port) return res.status(400).json({ error: 'port is required' });

  // Tunable timeouts
  const RESET_POLL_INTERVAL_MS  = 500;    // how often to poll "reset complete?"
  const RESET_TOTAL_TIMEOUT_MS  = 30000;  // max wait for reset to finish
  const UI_WAIT_PER_STATION_MS  = 20000;  // max wait for UI to load after reset
  const UI_POLL_INTERVAL_MS     = 500;    // how often to poll IS_UI_LOADED

  function log(message, pct = null) {
    const payload = { message };
    if (pct !== null) payload.pct = pct;
    broadcast('initProgress', payload);
    console.log(`[Init] ${message}`);
  }

  try {
    // Disconnect any existing session
    if (modbusHandler) {
      modbusHandler.disconnect();
      modbusHandler = null;
    }

    // ── PHASE 0: Open serial port ─────────────────────────────────────────────
    log(`Connecting to ${port}...`, 0);

    modbusHandler = new ModbusHandler(port, {
      timeoutMs:    1000,
      retries:      2,
      retryDelayMs: 200,
    });

    if (!(await modbusHandler.connect())) {
      throw new Error(`Failed to open serial port ${port}`);
    }
    log('✓ Serial port opened', 2);

    // Short settling delay after opening the port
    await sleep(200);

    // ── Detect PCB Loader (required) ──────────────────────────────────────────
    log(`Detecting PCB Loader (Slave ID ${PCB_LOADER_SLAVE_ID})...`, 5);

    let loaderFound = false;
    for (let attempt = 0; attempt < 5; attempt++) {
      loaderFound = await modbusHandler.pingStation(PCB_LOADER_SLAVE_ID);
      if (loaderFound) break;
      log(`  PCB Loader not responding, retry ${attempt + 1}/5...`);
      await sleep(500);
    }
    if (!loaderFound) {
      throw new Error(
        `PCB Loader Station (ID ${PCB_LOADER_SLAVE_ID}) not found — ` +
        `is it powered and connected to ${port}?`
      );
    }
    log(`✓ PCB Loader detected (ID ${PCB_LOADER_SLAVE_ID})`, 10);

    // ── Detect P&P stations ───────────────────────────────────────────────────
    log('Detecting Pick and Place stations...', 12);
    const foundPnp = [];
    for (const sid of SLAVE_IDS) {
      const found = await modbusHandler.pingStation(sid);
      if (found) {
        foundPnp.push(sid);
        log(`  ✓ P&P Station ${sid} detected`);
      } else {
        log(`  – P&P Station ${sid} not found (skipped)`);
      }
      await sleep(100);
    }

    if (foundPnp.length === 0) {
      throw new Error('No Pick and Place stations detected');
    }
    log(`✓ ${foundPnp.length} P&P station(s) found: [${foundPnp}]`, 18);

    const allStations = [PCB_LOADER_SLAVE_ID, ...foundPnp];

    // ── PHASE 1: Send soft reset to ALL stations ──────────────────────────────
    log('\nPhase 1 — Sending soft reset to all stations...', 20);

    for (const sid of allStations) {
      const name = sid === PCB_LOADER_SLAVE_ID
        ? 'PCB Loader'
        : `Pick & Place ${sid}`;
      const ok = await modbusHandler.softReset(sid);
      if (!ok) throw new Error(`Failed to send soft reset to ${name}`);
      log(`  ↺ Reset sent → ${name}`);
      await sleep(50);
    }

    // ── PHASE 2: Wait for ALL stations to complete reset ──────────────────────
    log('\nPhase 2 — Waiting for all stations to complete reset...');

    const pending    = new Set(allStations);
    const confirmed  = new Set();
    const resetStart = Date.now();

    while (pending.size > 0) {
      if (Date.now() - resetStart > RESET_TOTAL_TIMEOUT_MS) {
        const names = [...pending].map((s) =>
          s === PCB_LOADER_SLAVE_ID ? 'PCB Loader' : `Pick & Place ${s}`
        );
        throw new Error(
          `Reset timeout (${RESET_TOTAL_TIMEOUT_MS / 1000}s) for: ${names.join(', ')}`
        );
      }

      for (const sid of [...pending]) {
        const done = await modbusHandler.checkSoftResetComplete(sid);
        if (done) {
          const name = sid === PCB_LOADER_SLAVE_ID
            ? 'PCB Loader'
            : `Pick & Place ${sid}`;
          log(`  ✓ ${name}: reset complete`);
          pending.delete(sid);
          confirmed.add(sid);
          const pct = 20 + Math.round((confirmed.size / allStations.length) * 30);
          broadcast('initProgress', { pct });
        }
      }

      if (pending.size > 0) await sleep(RESET_POLL_INTERVAL_MS);
    }

    // ── PHASE 3: Wait for UI to load on every station ─────────────────────────
    //
    // After reset the embedded UI takes time to boot.
    // Poll IS_UI_LOADED until true (or timeout).
    //
    log('\nPhase 3 — Waiting for UIs to load on all stations...');
    broadcast('initProgress', { pct: 55 });

    for (let i = 0; i < allStations.length; i++) {
      const sid  = allStations[i];
      const name = sid === PCB_LOADER_SLAVE_ID
        ? 'PCB Loader'
        : `Pick & Place ${sid}`;

      log(`  ⏳ Waiting for ${name} UI...`);

      const uiLoaded = await modbusHandler.checkUiLoaded(
        sid,
        UI_WAIT_PER_STATION_MS,
        UI_POLL_INTERVAL_MS
      );

      if (!uiLoaded) {
        throw new Error(
          `${name} UI did not load within ${UI_WAIT_PER_STATION_MS / 1000}s. ` +
          'Check the station display.'
        );
      }

      log(`  ✓ ${name}: UI loaded`);
      const pct = 55 + Math.round(((i + 1) / allStations.length) * 20);
      broadcast('initProgress', { pct });
    }

    // ── PHASE 4: Verify station IDs and set setup page ────────────────────────
    log('\nPhase 4 — Verifying station IDs and setting setup page...');
    broadcast('initProgress', { pct: 78 });

    for (let i = 0; i < allStations.length; i++) {
      const sid  = allStations[i];
      const name = sid === PCB_LOADER_SLAVE_ID
        ? 'PCB Loader'
        : `Pick & Place ${sid}`;

      const stationId = await modbusHandler.getStationId(sid);
      if (stationId === null) {
        throw new Error(`${name}: could not read station ID register`);
      }
      if (stationId !== sid) {
        throw new Error(
          `${name} ID mismatch: expected ${sid}, got ${stationId}. ` +
          'Check station configuration.'
        );
      }

      const pageOk = await modbusHandler.setActivePage(
        sid, PageID.PLACEMENT_PARAMETERS_SETUP
      );
      if (!pageOk) {
        throw new Error(`Failed to set setup page for ${name}`);
      }

      log(`  ✓ ${name}: ID ${stationId} verified, setup page set`);
      const pct = 78 + Math.round(((i + 1) / allStations.length) * 20);
      broadcast('initProgress', { pct });
    }

    // ── Done ──────────────────────────────────────────────────────────────────
    broadcast('initProgress', {
      pct: 100,
      message: '✓ ALL STATIONS INITIALIZED SUCCESSFULLY',
    });
    log(`  - PCB Loader  : Slave ID ${PCB_LOADER_SLAVE_ID}`);
    log(`  - Pick & Place: Slave IDs [${foundPnp}]`);

    // Save application state
    availableStations = allStations;
    loaderStationId   = PCB_LOADER_SLAVE_ID;
    pnpStations       = foundPnp;

    // Create station manager
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
    });

    return res.json({
      success: true,
      availableStations,
      loaderStationId,
      pnpStations,
    });

  } catch (err) {
    console.error('[Server] Connect error:', err.message);
    broadcast('initProgress', { message: `✗ ERROR: ${err.message}` });

    if (modbusHandler) {
      modbusHandler.disconnect();
      modbusHandler = null;
    }
    availableStations = [];
    pnpStations       = [];

    return res.status(500).json({ error: err.message });
  }
});

// ── Disconnect ────────────────────────────────────────────────────────────────
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

  broadcast('connectionState', {
    connected:         false,
    availableStations: [],
    pnpStations:       [],
  });

  res.json({ success: true });
});

// ── Setup: read component distribution from stations ──────────────────────────
app.get('/api/setup/components', async (_req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  try {
    const result = {};
    for (const sid of pnpStations) {
      const components = await modbusHandler.getComponentsToPlace(sid);
      result[sid] = components
        ? {
            transistors: components[0],
            diodes:      components[1],
            ics:         components[2],
            capacitors:  components[3],
          }
        : { transistors: 0, diodes: 0, ics: 0, capacitors: 0 };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Setup: write total positions to a station ─────────────────────────────────
app.post('/api/setup/total-positions', async (req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  const { slaveId, transistors, diodes, ics, capacitors } = req.body;
  try {
    const ok = await modbusHandler.setTotalPositions(
      slaveId, transistors, diodes, ics, capacitors
    );
    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Setup: activate / deactivate physical start button ────────────────────────
app.post('/api/setup/start-button', async (req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  const { active } = req.body;
  try {
    const ok = await modbusHandler.setStartButtonActive(loaderStationId, active);

    if (stationManager) {
      if (active) {
        // Only call onSetupComplete the first time (it is idempotent internally,
        // but we avoid even the extra async work on every poll tick)
        await stationManager.onSetupComplete();
      } else {
        // Distribution changed — stop monitoring
        stationManager.onSetupIncomplete();
      }
    }

    res.json({ success: ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Operation: start production ───────────────────────────────────────────────
app.post('/api/operation/start', async (req, res) => {
  if (!modbusHandler || !stationManager) {
    return res.status(400).json({ error: 'Not connected' });
  }
  const { totalPcbs } = req.body;
  pendingTotalPcbs = totalPcbs ?? 10;
  try {
    for (const sid of availableStations) {
      await modbusHandler.setActivePage(sid, PageID.PICK_AND_PLACE_ANIMATION);
    }
    await stationManager.startProduction(pendingTotalPcbs);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Operation: stop production ────────────────────────────────────────────────
app.post('/api/operation/stop', async (_req, res) => {
  if (!stationManager) return res.status(400).json({ error: 'Not connected' });
  try {
    await stationManager.stopProduction();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Operation: get snapshot ───────────────────────────────────────────────────
app.get('/api/operation/snapshot', (_req, res) => {
  if (!stationManager) return res.status(400).json({ error: 'Not connected' });
  res.json(stationManager.getSnapshot());
});

// ── Configuration: read from first P&P station ───────────────────────────────
app.get('/api/configuration', async (_req, res) => {
  if (!modbusHandler || pnpStations.length === 0) {
    return res.status(400).json({ error: 'No P&P stations connected' });
  }
  const slaveId = pnpStations[0];
  try {
    const timing = await modbusHandler.readHoldingRegisters(
      slaveId,
      HoldingRegisterAddresses.TRANSISTOR_PLACEMENT_DURATION_MS,
      5
    );
    const led = await modbusHandler.readHoldingRegisters(
      slaveId,
      HoldingRegisterAddresses.BRIGHTNESS_RED_LED,
      6
    );
    const rfid = await modbusHandler.readHoldingRegisters(
      slaveId,
      HoldingRegisterAddresses.RFID_BOX_UID_START,
      12
    );
    const vol = await modbusHandler.readHoldingRegisters(
      slaveId,
      HoldingRegisterAddresses.SPEAKER_VOLUME,
      1
    );

    res.json({
      timing: timing
        ? {
            transistor: timing[0],
            diode:      timing[1],
            ic:         timing[2],
            capacitor:  timing[3],
            transport:  timing[4],
          }
        : null,
      led: led
        ? {
            red:             led[0],
            yellow:          led[1],
            green:           led[2],
            rgb:             led[3],
            thresholdYellow: led[4],
            thresholdRed:    led[5],
          }
        : null,
      rfid: rfid
        ? Array.from({ length: 4 }, (_, i) => ({
            uidHigh: rfid[i * 2],
            uidLow:  rfid[i * 2 + 1],
            count:   rfid[8 + i],
          }))
        : null,
      volume: vol ? vol[0] : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Configuration: write to all stations ──────────────────────────────────────
app.post('/api/configuration', async (req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  const { timing, led, rfid, volume } = req.body;
  try {
    for (const sid of availableStations) {
      if (timing) {
        await modbusHandler.setTimingConfig(
          sid,
          timing.transistor,
          timing.diode,
          timing.ic,
          timing.capacitor,
          timing.transport
        );
      }
      if (led) {
        await modbusHandler.setLedConfig(
          sid,
          led.red,
          led.yellow,
          led.green,
          led.rgb,
          led.thresholdYellow,
          led.thresholdRed
        );
      }
      if (rfid) {
        const rfidValues = [];
        for (const box of rfid) rfidValues.push(box.uidHigh, box.uidLow);
        for (const box of rfid) rfidValues.push(box.count);
        await modbusHandler.writeHoldingRegisters(
          sid,
          HoldingRegisterAddresses.RFID_BOX_UID_START,
          rfidValues
        );
      }
      if (volume != null) {
        await modbusHandler.setSpeakerVolume(sid, volume);
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Configuration: soft reset all stations ────────────────────────────────────
app.post('/api/configuration/soft-reset', async (_req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  try {
    for (const sid of availableStations) {
      if (!(await modbusHandler.softReset(sid))) {
        throw new Error(`Failed to reset Station ${sid}`);
      }
    }

    await sleep(2000);

    const timeout = 10000;
    const start   = Date.now();
    let allReset  = false;

    while (!allReset && Date.now() - start < timeout) {
      allReset = true;
      for (const sid of availableStations) {
        if (!(await modbusHandler.checkSoftResetComplete(sid))) {
          allReset = false;
          break;
        }
      }
      if (!allReset) await sleep(200);
    }

    if (!allReset) {
      throw new Error('Reset timeout — check station status manually');
    }

    for (const sid of availableStations) {
      await modbusHandler.setActivePage(sid, PageID.PLACEMENT_PARAMETERS_SETUP);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Monitoring: all station status ────────────────────────────────────────────
app.get('/api/monitoring', async (_req, res) => {
  if (!modbusHandler) return res.status(400).json({ error: 'Not connected' });
  try {
    const allStations = [loaderStationId, ...pnpStations];
    const result = {};
    for (const sid of allStations) {
      const statusData   = await modbusHandler.getAllStatus(sid);
      const inputCoils   = await modbusHandler.readCoils(
        sid, CoilAddresses.INPUT_TRANSISTOR_1_IS_POPULATED, 14
      );
      const outputInputs = await modbusHandler.readDiscreteInputs(
        sid, DiscreteInputAddresses.OUTPUT_TRANSISTOR_1_IS_POPULATED, 14
      );
      result[sid] = { statusData, inputCoils, outputInputs };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START SERVER ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
server.listen(PORT, () => {
  console.log(
    `[Server] SMT Pick & Place Controller running at http://localhost:${PORT}`
  );
});