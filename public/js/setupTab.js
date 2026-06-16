/**
 * Setup Tab controller — polls & visualises component distribution
 */

'use strict';

const SetupTab = (() => {
  const TOTAL = { transistors: 5, diodes: 4, ics: 3, capacitors: 2 };
  const KEYS  = ['transistors', 'diodes', 'ics', 'capacitors'];

  let pollTimer = null;
  let wasReady  = false;

  function onConnected() {
    buildDistributionTable();
    startPolling();
  }

  function buildDistributionTable() {
    const tbody = document.querySelector('#distributionTable tbody');
    tbody.innerHTML = '';
    AppState.pnpStations.forEach((sid) => {
      const tr = document.createElement('tr');
      tr.id = `dist-row-${sid}`;
      tr.innerHTML = `<td>P&amp;P Station ${sid}</td>` +
        KEYS.map(k => `<td id="dist-${sid}-${k}">0</td>`).join('');
      tbody.appendChild(tr);
    });
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(poll, 500);
    poll();
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function poll() {
    if (!AppState.connected || AppState.pnpStations.length === 0) return;
    try {
      const data = await apiGet('/api/setup/components');
      updateUI(data);
    } catch { /* ignore */ }
  }

  function updateUI(data) {
    const allPlaced    = AppState.pnpStations.map(sid => data[sid] ?? {});
    const totalAssigned = KEYS.map(k => allPlaced.reduce((s, p) => s + (p[k] ?? 0), 0));

    // Distribution table
    AppState.pnpStations.forEach((sid, idx) => {
      const placed = allPlaced[idx];
      KEYS.forEach(k => {
        const cell = document.getElementById(`dist-${sid}-${k}`);
        if (cell) cell.textContent = placed[k] ?? 0;
      });
    });

    // Available counts + status
    const available = {};
    KEYS.forEach((k, i) => { available[k] = TOTAL[k] - totalAssigned[i]; });

    KEYS.forEach(k => {
      const valEl  = document.getElementById(`avail-${k}`);
      const statEl = document.getElementById(`avail-status-${k}`);
      if (!valEl) return;
      valEl.textContent = available[k];
      valEl.className   = available[k] < 0 ? 'avail-neg' : available[k] === 0 ? 'avail-zero' : '';
      if (statEl) {
        if (available[k] < 0) { statEl.textContent = '⚠ Over-assigned'; statEl.style.color = '#e53935'; }
        else if (available[k] === 0) { statEl.textContent = '✓ Assigned';      statEl.style.color = '#43a047'; }
        else                         { statEl.textContent = `${available[k]} remaining`; statEl.style.color = '#ffb300'; }
      }
    });

    // Total positions per station
    AppState.pnpStations.forEach((sid, idx) => {
      const otherSum = KEYS.map((k, ki) => totalAssigned[ki] - (allPlaced[idx][k] ?? 0));
      const stationTotal = KEYS.map((k, ki) => Math.max(0, TOTAL[k] - otherSum[ki]));
      apiPost('/api/setup/total-positions', {
        slaveId: sid,
        transistors: stationTotal[0],
        diodes: stationTotal[1],
        ics: stationTotal[2],
        capacitors: stationTotal[3],
      }).catch(() => {});
    });

    // Ready check
    const allZero   = KEYS.every(k => available[k] === 0);
    const allNonNeg = KEYS.every(k => available[k] >= 0);
    const ready     = allZero && allNonNeg;

    if (ready !== wasReady) {
      wasReady = ready;
      apiPost('/api/setup/start-button', { active: ready }).catch(() => {});
    } else {
      apiPost('/api/setup/start-button', { active: ready }).catch(() => {});
    }
  }

  return { onConnected, startPolling, stopPolling };
})();