/**
 * Operation Tab controller
 */

'use strict';

const OperationTab = (() => {
  let totalPcbs = 0;
  let pcbsCompleted = 0;
  let productionActive = false;
  let startTime = null;
  let statsTimer = null;

  // ── DOM ───────────────────────────────────────────────────────────────────
  const totalInput    = () => document.getElementById('totalPcbsInput');
  const stopBtn       = () => document.getElementById('stopProductionBtn');
  const progressLabel = () => document.getElementById('progressLabel');
  const progressBar   = () => document.getElementById('productionProgress');
  const tableBody     = () => document.querySelector('#stationStatusTable tbody');

  // ── Wire buttons ──────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    stopBtn().addEventListener('click', stopProduction);
  });

  // ── Called when all components are distributed ────────────────────────────
  function onSetupComplete() {
    buildStatusTable();
  }

  function buildStatusTable() {
    const tbody = tableBody();
    tbody.innerHTML = '';
    const stations = [AppState.loaderStationId, ...AppState.pnpStations];
    stations.forEach((sid) => {
      const name = sid === AppState.loaderStationId ? 'Loader' : `P&P ${sid}`;
      const tr = document.createElement('tr');
      tr.id = `op-row-${sid}`;
      tr.innerHTML = `
        <td>${name}</td>
        <td id="op-status-${sid}">-</td>
        <td id="op-pcb-${sid}">-</td>
        <td id="op-comp-${sid}">-</td>
        <td id="op-cycle-${sid}">-</td>
        <td id="op-avg-${sid}">-</td>
      `;
      tbody.appendChild(tr);
    });
  }

  // ── Server events ─────────────────────────────────────────────────────────
  function onProductionStarted({ totalPcbs: t }) {
    totalPcbs = t;
    pcbsCompleted = 0;
    productionActive = true;
    startTime = Date.now();
    totalInput().disabled = true;
    stopBtn().disabled = false;
    progressLabel().textContent = `0 / ${totalPcbs} PCBs completed`;
    progressBar().value = 0;
    startStatsTimer();
  }

  function onProductionStopped() {
    _deactivate();
  }

  function onProductionComplete({ totalPcbs: t, totalTime, throughputPerMin }) {
    _deactivate();
    alert(
      `All ${t} PCBs completed!\n` +
      `Total time: ${totalTime.toFixed(1)} s\n` +
      `Throughput: ${throughputPerMin.toFixed(2)} PCB/min`
    );
  }

  function onPcbCompleted({ pcbsCompleted: c, totalPcbs: t }) {
    pcbsCompleted = c;
    updateProgress(c, t);
  }

  function onStateChange({ slaveId, statusName, oldStatus, newStatus }) {
    const el = document.getElementById(`op-status-${slaveId}`);
    if (el) el.textContent = statusName;
  }

  function onSnapshot(snapshot) {
    if (!snapshot) return;
    snapshot.stationRows?.forEach((row) => {
      const sid = row.slaveId;
      setText(`op-status-${sid}`, row.statusName ?? '-');
      setText(`op-pcb-${sid}`,    row.pcbId > 0 ? row.pcbId : '-');
      setText(`op-cycle-${sid}`,  row.cycleTime != null ? row.cycleTime.toFixed(1) : '-');
      setText(`op-avg-${sid}`,    row.avgCycleTime != null ? row.avgCycleTime.toFixed(1) : '-');
    });

    if (snapshot.productionActive) {
      pcbsCompleted = snapshot.pcbsCompleted;
      updateProgress(snapshot.pcbsCompleted, snapshot.totalPcbs);
    }
  }

  // ── Stop production ───────────────────────────────────────────────────────
  async function stopProduction() {
    if (!confirm('Are you sure you want to stop production?')) return;
    await apiPost('/api/operation/stop', {});
  }

  // ── Stats timer ───────────────────────────────────────────────────────────
  function startStatsTimer() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = setInterval(() => {
      if (!productionActive) { clearInterval(statsTimer); return; }
      const elapsed = (Date.now() - startTime) / 1000;
      setText('stat-completed',  String(pcbsCompleted));
      setText('stat-remaining',  String(totalPcbs - pcbsCompleted));
      const h = Math.floor(elapsed / 3600);
      const m = Math.floor((elapsed % 3600) / 60);
      const s = Math.floor(elapsed % 60);
      setText('stat-totalTime',
        `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`);
      const thr = elapsed > 0 ? (pcbsCompleted / elapsed) * 60 : 0;
      setText('stat-throughput', `${thr.toFixed(2)} PCB/min`);
    }, 1000);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function _deactivate() {
    productionActive = false;
    totalInput().disabled = false;
    stopBtn().disabled = true;
    if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  }

  function updateProgress(completed, total) {
    progressBar().value = total > 0 ? Math.round((completed / total) * 100) : 0;
    progressLabel().textContent = `${completed} / ${total} PCBs completed`;
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  return {
    onSetupComplete,
    onProductionStarted,
    onProductionStopped,
    onProductionComplete,
    onPcbCompleted,
    onStateChange,
    onSnapshot,
  };
})();