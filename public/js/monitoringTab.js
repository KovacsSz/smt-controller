/**
 * Monitoring Tab controller
 */

'use strict';

const MonitoringTab = (() => {
  let pollTimer = null;

  function buildTables() {
    const allStations = [AppState.loaderStationId, ...AppState.pnpStations];
    ['componentStatusTable', 'inputStatusTable', 'outputStatusTable'].forEach(tableId => {
      const tbody = document.querySelector(`#${tableId} tbody`);
      if (!tbody) return;
      tbody.innerHTML = '';
      allStations.forEach(sid => {
        const name = sid === AppState.loaderStationId ? 'PCB Loader' : `P&P Station ${sid}`;
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${name}</td><td>—</td><td>—</td><td>—</td><td>—</td>`;
        tbody.appendChild(tr);
      });
    });
  }

  function startPolling() {
    if (!AppState.connected) return;
    stopPolling();
    pollTimer = setInterval(poll, 800);
    poll();
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  async function poll() {
    if (!AppState.connected) return;
    try {
      const data = await apiGet('/api/monitoring');
      const allStations = [AppState.loaderStationId, ...AppState.pnpStations];
      allStations.forEach((sid, idx) => {
        const entry = data[sid];
        if (!entry) return;
        const sd = entry.statusData;
        if (sd) setRowCells('componentStatusTable', idx,
          [`${sd.toPlace.transistors}/${sd.available.transistors}`,
           `${sd.toPlace.diodes}/${sd.available.diodes}`,
           `${sd.toPlace.ics}/${sd.available.ics}`,
           `${sd.toPlace.capacitors}/${sd.available.capacitors}`]);
        const ic = entry.inputCoils;
        if (ic) setRowCells('inputStatusTable', idx,
          [bar(ic.slice(0,5)), bar(ic.slice(5,9)), bar(ic.slice(9,12)), bar(ic.slice(12,14))]);
        const oi = entry.outputInputs;
        if (oi) setRowCells('outputStatusTable', idx,
          [bar(oi.slice(0,5)), bar(oi.slice(5,9)), bar(oi.slice(9,12)), bar(oi.slice(12,14))]);
      });
    } catch { /* ignore */ }
  }

  function setRowCells(tableId, rowIdx, vals) {
    const rows = document.querySelectorAll(`#${tableId} tbody tr`);
    if (!rows[rowIdx]) return;
    const cells = rows[rowIdx].querySelectorAll('td');
    vals.forEach((v, i) => { if (cells[i + 1]) cells[i + 1].textContent = v; });
  }

  function bar(arr) { return arr.map(v => v ? '✓' : '○').join(''); }

  return { buildTables, startPolling, stopPolling };
})();