/* ============================================================
   AGRO RAIN 3D — Interfaz de control
   Indicadores, panel de zonas, historial, toasts, botones de
   lluvia/modo/cámara y configuración. Conecta el DOM con el
   estado central de AGRO.Sim.
   ============================================================ */

window.AGRO = window.AGRO || {};

AGRO.UI = (function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let els = {};

  const EVENT_ICONS = {
    rain: '🌧️', water: '💧', alert: '⚠️', ok: '✅',
    pump: '⚙️', info: 'ℹ️',
  };

  /* ---------- Inicialización ---------- */
  function init() {
    els = {
      stored: $('ind-stored'),
      capacity: $('ind-capacity'),
      collected: $('ind-collected'),
      consumed: $('ind-consumed'),
      avgHumidity: $('ind-avg-humidity'),
      barStored: $('bar-stored'),
      barAvg: $('bar-avg-humidity'),
      pump: $('ind-pump'),
      sensors: $('ind-sensors'),
      zonesNeed: $('ind-zones-need'),
      eventList: $('event-list'),
      zonesContainer: $('zones-container'),
      btnRain: $('btn-rain'),
      btnRainText: $('btn-rain-text'),
      btnMode: $('btn-mode'),
      btnModeText: $('btn-mode-text'),
      btnReset: $('btn-reset'),
      toastContainer: $('toast-container'),
      impactHarvested: $('impact-harvested'),
      impactConsumed: $('impact-consumed'),
      impactEfficiency: $('impact-efficiency'),
    };

    buildZoneCards();
    bindToolbar();
    bindConfig();
    bindTankQuick();
    renderHistory();
  }

  /* ---------- Tarjetas de zona (generadas desde el estado) ---------- */
  function buildZoneCards() {
    const zones = AGRO.Sim.state.zones;
    els.zonesContainer.innerHTML = '';
    for (const zone of zones) {
      const card = document.createElement('div');
      card.className = 'zone-card';
      card.id = 'zone-card-' + zone.id;
      card.innerHTML =
        '<div class="zone-head">' +
          '<span class="zone-name">' + zone.name + '</span>' +
          '<span class="zone-state ok" id="zone-state-' + zone.id + '">Humedad adecuada</span>' +
        '</div>' +
        '<div class="zone-humidity-row">' +
          '<span>Humedad actual</span>' +
          '<span class="zone-humidity-val" id="zone-hum-' + zone.id + '">--%</span>' +
        '</div>' +
        '<div class="zone-bar">' +
          '<div class="zone-bar-fill" id="zone-bar-' + zone.id + '"></div>' +
          '<div class="zone-bar-target" id="zone-target-' + zone.id + '"></div>' +
        '</div>' +
        '<div class="zone-controls">' +
          '<input type="range" min="0" max="100" value="' + Math.round(zone.humidity) + '" id="zone-slider-' + zone.id + '" aria-label="Humedad manual ' + zone.name + '">' +
          '<button class="btn btn-small" id="zone-focus-' + zone.id + '">Enfocar</button>' +
          '<button class="btn btn-small btn-irrigate" id="zone-irrigate-' + zone.id + '">Regar</button>' +
        '</div>' +
        '<div class="zone-target-line" id="zone-target-line-' + zone.id + '"></div>';
      els.zonesContainer.appendChild(card);

      $('zone-slider-' + zone.id).addEventListener('input', (e) => {
        AGRO.Sim.setZoneHumidity(zone.id, Number(e.target.value));
      });
      $('zone-focus-' + zone.id).addEventListener('click', () => {
        selectZone(zone.id);
      });
      $('zone-irrigate-' + zone.id).addEventListener('click', () => {
        const ok = AGRO.Sim.toggleZoneIrrigation(zone);
        if (!ok && !zone.irrigating) {
          showToast('No se pudo iniciar el riego: revisa la bomba y el tanque.', 'warn');
        }
      });
    }
  }

  function selectZone(zoneId) {
    document.querySelectorAll('.zone-card').forEach(c => c.classList.remove('selected'));
    const card = $('zone-card-' + zoneId);
    if (card) card.classList.add('selected');
    AGRO.Scene3D.focusOn('zone' + zoneId);
    AGRO.Scene3D.highlight('zone' + zoneId);
  }

  /* ---------- Barra de herramientas ---------- */
  function bindToolbar() {
    els.btnRain.addEventListener('click', () => {
      if (AGRO.Sim.state.raining) {
        AGRO.Sim.stopRain();
      } else {
        AGRO.Sim.startRain();
      }
      syncRainButton();
    });

    els.btnMode.addEventListener('click', () => {
      const next = AGRO.Sim.state.mode === 'auto' ? 'manual' : 'auto';
      AGRO.Sim.setMode(next);
      syncModeButton();
    });

    els.btnReset.addEventListener('click', () => {
      AGRO.Sim.reset();
      AGRO.Charts.reset();
      renderHistory();
      syncRainButton();
      syncModeButton();
      syncZoneSliders();
      showToast('Simulación reiniciada.', 'ok');
    });

    document.querySelectorAll('[data-focus]').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-focus');
        AGRO.Scene3D.focusOn(target);
        AGRO.Scene3D.highlight(target);
        document.querySelectorAll('[data-focus]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }

  function syncRainButton() {
    const raining = AGRO.Sim.state.raining;
    els.btnRain.classList.toggle('active', raining);
    els.btnRainText.textContent = raining ? 'Detener lluvia' : 'Iniciar lluvia';
  }

  function syncModeButton() {
    const auto = AGRO.Sim.state.mode === 'auto';
    els.btnModeText.textContent = auto ? 'Modo automático' : 'Modo manual';
    document.body.dataset.mode = AGRO.Sim.state.mode;
    updateIrrigateButtons();
  }

  function updateIrrigateButtons() {
    const manual = AGRO.Sim.state.mode === 'manual';
    for (const zone of AGRO.Sim.state.zones) {
      const btn = $('zone-irrigate-' + zone.id);
      if (!btn) continue;
      btn.disabled = !manual;
      btn.textContent = zone.irrigating ? 'Detener' : 'Regar';
    }
  }

  /* ---------- Configuración ---------- */
  function bindConfig() {
    const bindings = [
      ['cfg-capacity', 'val-capacity', 'tankCapacity', v => v + ' L'],
      ['cfg-rain-rate', 'val-rain-rate', 'rainRate', v => v + ' L/s'],
      ['cfg-threshold', 'val-threshold', 'threshold', v => v + ' %'],
      ['cfg-target', 'val-target', 'target', v => v + ' %'],
      ['cfg-consumption', 'val-consumption', 'consumption', v => v + ' L/s'],
      ['cfg-recovery', 'val-recovery', 'recovery', v => v + ' %/s'],
      ['cfg-evaporation', 'val-evaporation', 'evaporation', v => v.toFixed(2) + ' %/s'],
    ];
    for (const [inputId, labelId, key, fmt] of bindings) {
      const input = $(inputId);
      const label = $(labelId);
      if (!input || !label) continue;
      input.addEventListener('input', () => {
        const v = Number(input.value);
        AGRO.Sim.setParam(key, v);
        label.textContent = fmt(v);
        if (key === 'tankCapacity') {
          els.capacity.textContent = AGRO.Sim.params.tankCapacity;
        }
      });
    }
  }

  function bindTankQuick() {
    $('tank-empty').addEventListener('click', () => AGRO.Sim.setTankLevelFrac(0));
    $('tank-half').addEventListener('click', () => AGRO.Sim.setTankLevelFrac(0.5));
    $('tank-full').addEventListener('click', () => AGRO.Sim.setTankLevelFrac(1));
  }

  /* ---------- Actualización periódica de indicadores ---------- */
  function update() {
    const s = AGRO.Sim.state;
    const p = AGRO.Sim.params;

    // Sincroniza botones con el estado real (p.ej. si cambió fuera del clic)
    syncRainButton();
    syncModeButton();

    els.stored.textContent = Math.round(s.tankLevel);
    els.capacity.textContent = p.tankCapacity;
    els.collected.textContent = Math.round(s.collectedSession) + ' L';
    els.consumed.textContent = Math.round(s.consumedSession) + ' L';
    els.avgHumidity.textContent = Math.round(AGRO.Sim.averageHumidity());

    const frac = p.tankCapacity > 0 ? s.tankLevel / p.tankCapacity : 0;
    els.barStored.style.width = (frac * 100).toFixed(1) + '%';
    els.barAvg.style.width = AGRO.Sim.averageHumidity().toFixed(1) + '%';

    // Bomba
    els.pump.textContent = s.pumpActive ? 'Activada' : 'Inactiva';
    els.pump.classList.toggle('on', s.pumpActive);

    // Zonas que necesitan riego
    const need = AGRO.Sim.zonesNeedingWater();
    els.zonesNeed.textContent = need + (need === 1 ? ' zona' : ' zonas');

    // Tarjetas de zona
    for (const zone of s.zones) {
      const humEl = $('zone-hum-' + zone.id);
      const barEl = $('zone-bar-' + zone.id);
      const stateEl = $('zone-state-' + zone.id);
      const targetEl = $('zone-target-' + zone.id);
      const targetLine = $('zone-target-line-' + zone.id);
      const card = $('zone-card-' + zone.id);
      const slider = $('zone-slider-' + zone.id);
      if (!humEl) continue;

      humEl.textContent = Math.round(zone.humidity) + '%';
      barEl.style.width = zone.humidity.toFixed(1) + '%';
      barEl.style.background = zone.irrigating
        ? 'linear-gradient(90deg,#4fc3f7,#1976d2)'
        : zone.humidity < zone.threshold
          ? 'linear-gradient(90deg,#ff8a80,#e53935)'
          : zone.humidity < zone.target
            ? 'linear-gradient(90deg,#ffd54f,#f57c00)'
            : 'linear-gradient(90deg,#81c784,#43a047)';
      targetEl.style.left = 'calc(' + zone.target + '% - 1px)';

      let stateText, stateClass;
      if (zone.irrigating) { stateText = 'Regando…'; stateClass = 'regando'; }
      else if (zone.humidity < zone.threshold) { stateText = 'Necesita agua'; stateClass = 'dry'; }
      else if (zone.humidity < zone.target) { stateText = 'Humedad moderada'; stateClass = 'warn'; }
      else { stateText = 'Humedad adecuada'; stateClass = 'ok'; }
      stateEl.textContent = stateText;
      stateEl.className = 'zone-state ' + stateClass;
      targetLine.textContent = 'Objetivo: ' + zone.target + ' % · Umbral: ' + zone.threshold + ' %';

      card.classList.toggle('irrigating', zone.irrigating);
      if (document.activeElement !== slider) {
        slider.value = Math.round(zone.humidity);
      }
    }

    updateIrrigateButtons();

    // Impacto ambiental
    els.impactHarvested.textContent = Math.round(s.collectedSession) + ' L';
    els.impactConsumed.textContent = Math.round(s.consumedSession) + ' L';
    const eff = s.collectedSession + s.consumedSession > 0
      ? Math.round((s.collectedSession / (s.collectedSession + s.consumedSession)) * 100)
      : null;
    els.impactEfficiency.textContent = eff === null ? '—' : eff + ' %';
  }

  function syncZoneSliders() {
    for (const zone of AGRO.Sim.state.zones) {
      const slider = $('zone-slider-' + zone.id);
      if (slider) slider.value = Math.round(zone.humidity);
    }
  }

  /* ---------- Historial de eventos ---------- */
  function renderHistory() {
    const events = AGRO.Sim.state.events;
    if (!events.length) {
      els.eventList.innerHTML = '<li class="event-item event-info"><span class="event-time">--:--:--</span> Esperando eventos de la simulación…</li>';
      return;
    }
    els.eventList.innerHTML = events.slice(0, 30).map(ev =>
      '<li class="event-item event-' + ev.type + '">' +
        '<span class="event-time">' + ev.time + '</span>' +
        '<span>' + (EVENT_ICONS[ev.type] || '•') + ' ' + ev.message + '</span>' +
      '</li>'
    ).join('');
  }

  function onSimEvent() {
    renderHistory();
  }

  /* ---------- Toasts ---------- */
  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = 'toast ' + (type || 'info');
    toast.textContent = message;
    els.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('fade');
      setTimeout(() => toast.remove(), 450);
    }, 3800);
  }

  return { init, update, onSimEvent, showToast, syncRainButton, syncModeButton, syncZoneSliders };
})();
