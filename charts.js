/* ============================================================
   AGRO RAIN 3D — Gráficas con Chart.js
   Humedad por zona, nivel del tanque y balance recolectado vs
   consumido. Se actualizan en caliente sin recrear gráficas.
   ============================================================ */

window.AGRO = window.AGRO || {};

AGRO.Charts = (function () {
  'use strict';

  let humidityChart, tankChart, flowChart;

  const ZONE_COLORS = { A: '#e53935', B: '#43a047', C: '#fb8c00' };

  function baseOptions(yMax, yTitle) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { enabled: true },
      },
      scales: {
        x: {
          ticks: { maxTicksLimit: 8, font: { size: 10 } },
          grid: { color: 'rgba(0,0,0,0.05)' },
        },
        y: {
          min: 0,
          max: yMax,
          title: { display: !!yTitle, text: yTitle, font: { size: 10 } },
          ticks: { font: { size: 10 } },
          grid: { color: 'rgba(0,0,0,0.07)' },
        },
      },
    };
  }

  function init() {
    if (typeof Chart === 'undefined') return;

    const ctxH = document.getElementById('chart-humidity');
    const ctxT = document.getElementById('chart-tank');
    const ctxF = document.getElementById('chart-flow');
    if (!ctxH || !ctxT || !ctxF) return;

    humidityChart = new Chart(ctxH, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          { label: 'Zona A', data: [], borderColor: ZONE_COLORS.A, backgroundColor: ZONE_COLORS.A + '22', tension: 0.35, borderWidth: 2, pointRadius: 0 },
          { label: 'Zona B', data: [], borderColor: ZONE_COLORS.B, backgroundColor: ZONE_COLORS.B + '22', tension: 0.35, borderWidth: 2, pointRadius: 0 },
          { label: 'Zona C', data: [], borderColor: ZONE_COLORS.C, backgroundColor: ZONE_COLORS.C + '22', tension: 0.35, borderWidth: 2, pointRadius: 0 },
        ],
      },
      options: baseOptions(100, '% humedad'),
    });

    tankChart = new Chart(ctxT, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          label: 'Agua almacenada (L)',
          data: [],
          borderColor: '#1976d2',
          backgroundColor: 'rgba(25, 118, 210, 0.15)',
          fill: true,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: 0,
        }],
      },
      options: baseOptions(AGRO.Sim.params.tankCapacity, 'litros'),
    });

    flowChart = new Chart(ctxF, {
      type: 'bar',
      data: {
        labels: ['Total sesión'],
        datasets: [
          { label: 'Recolectada', data: [0], backgroundColor: '#29b6f6', borderRadius: 5 },
          { label: 'Consumida', data: [0], backgroundColor: '#66bb6a', borderRadius: 5 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 300 },
        plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } } },
        scales: {
          x: { grid: { display: false } },
          y: {
            min: 0,
            title: { display: true, text: 'litros', font: { size: 10 } },
            ticks: { font: { size: 10 } },
            grid: { color: 'rgba(0,0,0,0.07)' },
          },
        },
      },
    });
  }

  function update() {
    if (!humidityChart || !AGRO.Sim) return;
    const history = AGRO.Sim.state.history;
    if (!history.length) return;

    const labels = history.map(h => h.t);

    humidityChart.data.labels = labels;
    humidityChart.data.datasets[0].data = history.map(h => h.A);
    humidityChart.data.datasets[1].data = history.map(h => h.B);
    humidityChart.data.datasets[2].data = history.map(h => h.C);
    humidityChart.update();

    tankChart.data.labels = labels;
    tankChart.data.datasets[0].data = history.map(h => h.tank);
    tankChart.options.scales.y.max = AGRO.Sim.params.tankCapacity;
    tankChart.update();

    const last = history[history.length - 1];
    flowChart.data.datasets[0].data = [last.collected];
    flowChart.data.datasets[1].data = [last.consumed];
    flowChart.update();
  }

  function reset() {
    if (!humidityChart) return;
    for (const chart of [humidityChart, tankChart]) {
      chart.data.labels = [];
      for (const ds of chart.data.datasets) ds.data = [];
      chart.update();
    }
    flowChart.data.datasets[0].data = [0];
    flowChart.data.datasets[1].data = [0];
    flowChart.update();
  }

  return { init, update, reset };
})();
