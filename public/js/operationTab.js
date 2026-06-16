/**
 * Operation Tab controller — visualization only
 */

'use strict';

const OperationTab = (() => {
  let totalPcbs        = 0;
  let pcbsCompleted    = 0;
  let productionActive = false;
  let startTime        = null;
  let statsTimer       = null;

  function buildStatusTable() {
    const tbody = document.querySelector('#stationStatusTable tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const stations = [AppState.loaderStationId, ...AppState.pnpStations];
    stations.forEach(sid => {
      const name = sid === AppState.loaderStationId ? 'Loader' : `P&P ${sid}`;
      const tr = document.createElement('tr');
      tr.id = `op-row-${sid}`;
      tr.innerHTML = `
        <td>${name}</td>
        <td id="op-status-${sid}">—</td>
        <td id="op-pcb-${sid}">—</td>
        <td id="op-cycle-${sid}">—</td>
        <td id="op-avg-${sid}">—</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function onProductionStarted({ totalPcbs: t }) {
    totalPcbs = t;
    pcbsCompleted = 0;
    productionActive = true;
    startTime = Date.now();
    startStatsTimer();
  }

  function onProductionStopped() { _deactivate(); }

  function onProductionComplete({ totalPcbs: t, totalTime, throughputPerMin }) {
    _deactivate();
    const fill = document.getElementById('progressFill');
    if (fill) { fill.style.width = '100%'; fill.classList.add('complete'); }
    logEvent(`✓ Complete: ${t} PCBs | ${totalTime.toFixed(1)}s | ${throughputPerMin.toFixed(2)} PCB/min`);
  }

  function onPcbCompleted({ pcbsCompleted: c, totalPcbs: t }) {
    pcbsCompleted = c;
  }

  function onStateChange({ slaveId, statusName }) {
    setText(`op-status-${slaveId}`, statusName);
  }

  function onSnapshot(snap) {
    if (!snap) return;
    snap.stationRows?.forEach(row => {
      const sid = row.slaveId;
      setText(`op-status-${sid}`, row.statusName ?? '—');
      setText(`op-pcb-${sid}`,    row.pcbId > 0 ? row.pcbId : '—');
      setText(`op-cycle-${sid}`,  row.cycleTime    != null ? row.cycleTime.toFixed(1)    : '—');
      setText(`op-avg-${sid}`,    row.avgCycleTime != null ? row.avgCycleTime.toFixed(1) : '—');
    });
    if (snap.productionActive) {
      pcbsCompleted = snap.pcbsCompleted;
      setText('stat-completed', snap.pcbsCompleted);
      setText('stat-remaining', snap.totalPcbs - snap.pcbsCompleted);
    }
  }

  function startStatsTimer() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = setInterval(() => {
      if (!productionActive) { clearInterval(statsTimer); return; }
      const elapsed = (Date.now() - startTime) / 1000;
      const h = Math.floor(elapsed / 3600);
      const m = Math.floor((elapsed % 3600) / 60);
      const s = Math.floor(elapsed % 60);
      setText('stat-totalTime',  `${pad(h)}:${pad(m)}:${pad(s)}`);
      setText('stat-completed',  pcbsCompleted);
      setText('stat-remaining',  totalPcbs - pcbsCompleted);
      const thr = elapsed > 0 ? (pcbsCompleted / elapsed) * 60 : 0;
      setText('stat-throughput', `${thr.toFixed(2)} PCB/min`);
    }, 1000);
  }

  function _deactivate() {
    productionActive = false;
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }
  function pad(n) { return String(n).padStart(2, '0'); }

  return { buildStatusTable, onProductionStarted, onProductionStopped, onProductionComplete, onPcbCompleted, onStateChange, onSnapshot };
})();