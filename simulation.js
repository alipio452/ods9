/* ============================================================
   AGRO RAIN 3D — Núcleo de simulación
   Estado central único: tanque, lluvia, bomba, zonas, eventos.
   Sin dependencias de Three.js ni del DOM.
   ============================================================ */

window.AGRO = window.AGRO || {};

AGRO.Sim = (function () {
  'use strict';

  /* ---------- Parámetros configurables ---------- */
  const params = {
    tankCapacity: 5000,   // litros
    rainRate: 14,         // L/s recolectados durante la lluvia
    threshold: 30,        // % humedad mínima antes de solicitar riego
    target: 70,           // % humedad objetivo al regar
    consumption: 8,       // L/s consumidos por zona mientras riega
    recovery: 5,          // %/s de recuperación de humedad al regar
    evaporation: 0.35,    // %/s de pérdida natural de humedad
  };

  /* ---------- Estado central ---------- */
  const INITIAL_ZONE_HUMIDITY = { A: 22, B: 55, C: 38 };

  const state = {
    time: 0,
    raining: false,
    tankLevel: 1200,
    collectedSession: 0,
    consumedSession: 0,
    pumpActive: false,
    mode: 'auto', // 'auto' | 'manual'
    zones: [],
    events: [],
    history: [],
    lastCollectionMark: 0,
    lowWaterNotified: false,
    emptyNotified: false,
    fullNotified: false,
    historyTimer: 0,
  };

  /* ---------- Utilidades ---------- */
  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  function nowLabel() {
    return new Date().toLocaleTimeString('es-ES', { hour12: false });
  }

  function addEvent(type, message) {
    state.events.unshift({ type, message, time: nowLabel() });
    if (state.events.length > 60) state.events.length = 60;
    if (typeof AGRO.UI !== 'undefined' && AGRO.UI.onSimEvent) {
      AGRO.UI.onSimEvent(type, message);
    }
  }

  /* ---------- Inicialización / reinicio ---------- */
  function reset() {
    state.time = 0;
    state.raining = false;
    state.tankLevel = Math.round(params.tankCapacity * 0.24);
    state.collectedSession = 0;
    state.consumedSession = 0;
    state.pumpActive = false;
    state.mode = 'auto';
    state.events = [];
    state.history = [];
    state.lastCollectionMark = 0;
    state.lowWaterNotified = false;
    state.emptyNotified = false;
    state.fullNotified = false;
    state.historyTimer = 0;
    state.zones = [
      makeZone('A', 'Zona A · Tomates', INITIAL_ZONE_HUMIDITY.A, 0xe53935),
      makeZone('B', 'Zona B · Maíz',     INITIAL_ZONE_HUMIDITY.B, 0x43a047),
      makeZone('C', 'Zona C · Pimientos', INITIAL_ZONE_HUMIDITY.C, 0xfb8c00),
    ];
    pushHistory();
    addEvent('info', 'Simulación reiniciada. Sistema listo.');
  }

  function makeZone(id, name, humidity, color) {
    return {
      id, name, color,
      humidity,
      target: params.target,
      threshold: params.threshold,
      irrigating: false,
      needsWater: humidity < params.threshold,
    };
  }

  /* ---------- Lluvia y captación ---------- */
  function startRain() {
    if (state.raining) return;
    state.raining = true;
    addEvent('rain', 'Comenzó la lluvia sobre la finca.');
  }

  function stopRain() {
    if (!state.raining) return;
    state.raining = false;
    addEvent('rain', 'La lluvia se detuvo.');
  }

  function updateRain(dt) {
    if (!state.raining) return;
    const space = params.tankCapacity - state.tankLevel;
    if (space <= 0) {
      if (!state.fullNotified) {
        state.fullNotified = true;
        addEvent('alert', 'Tanque lleno: la capacidad máxima ha sido alcanzada.');
      }
      return; // el excedente se desborda, no se recolecta
    }
    const collected = Math.min(params.rainRate * dt, space);
    state.tankLevel += collected;
    state.collectedSession += collected;

    // Evento periódico cada 250 L recolectados
    if (state.collectedSession - state.lastCollectionMark >= 250) {
      state.lastCollectionMark = state.collectedSession;
      addEvent('water', 'Se recolectaron ' + Math.round(state.collectedSession) + ' L de agua de lluvia en la sesión.');
    }
    if (state.tankLevel < params.tankCapacity * 0.98) {
      state.fullNotified = false;
    }
  }

  /* ---------- Riego ---------- */
  function startIrrigation(zone, source) {
    if (zone.irrigating) return false;
    if (state.pumpActive) {
      // En modo automático es normal: la zona simplemente espera su turno.
      if (source !== 'automático') {
        const other = state.zones.find(z => z.irrigating);
        addEvent('alert', 'Bomba ocupada: ' + (other ? other.name : 'otra zona') + ' está regando ahora mismo.');
      }
      return false;
    }
    if (state.tankLevel <= 0) {
      if (!state.emptyNotified) {
        state.emptyNotified = true;
        addEvent('alert', 'Tanque vacío: no es posible regar ' + zone.name + '.');
      }
      return false;
    }
    zone.irrigating = true;
    state.pumpActive = true;
    addEvent('pump', 'Bomba activada — regando ' + zone.name + ' (' + source + ').');
    return true;
  }

  function stopIrrigation(zone, reason) {
    if (!zone.irrigating) return;
    zone.irrigating = false;
    if (!state.zones.some(z => z.irrigating)) {
      state.pumpActive = false;
    }
    if (reason === 'target') {
      addEvent('ok', zone.name + ' alcanzó su humedad objetivo (' + Math.round(zone.humidity) + ' %).');
    } else if (reason === 'empty') {
      addEvent('alert', 'Sin agua en el tanque: riego de ' + zone.name + ' detenido.');
    } else if (reason === 'manual') {
      addEvent('info', 'Riego de ' + zone.name + ' detenido manualmente.');
    }
  }

  function toggleZoneIrrigation(zone) {
    if (state.mode !== 'manual') return false;
    if (zone.irrigating) {
      stopIrrigation(zone, 'manual');
      return true;
    }
    return startIrrigation(zone, 'manual');
  }

  function updateZone(zone, dt) {
    // Sincroniza umbrales configurables
    zone.threshold = params.threshold;
    zone.target = params.target;

    if (zone.irrigating) {
      if (state.tankLevel <= 0) {
        stopIrrigation(zone, 'empty');
      } else {
        const used = Math.min(params.consumption * dt, state.tankLevel);
        state.tankLevel -= used;
        state.consumedSession += used;
        zone.humidity = clamp(zone.humidity + params.recovery * dt, 0, 100);
        if (zone.humidity >= zone.target) {
          stopIrrigation(zone, 'target');
        }
      }
    } else {
      zone.humidity = clamp(zone.humidity - params.evaporation * dt, 0, 100);
    }

    const wasLow = zone.needsWater;
    zone.needsWater = zone.humidity < zone.threshold;
    if (zone.needsWater && !wasLow) {
      addEvent('alert', 'El sensor de ' + zone.name + ' detectó humedad baja (' + Math.round(zone.humidity) + ' %).');
    }
  }

  /* ---------- Bucle principal de simulación ---------- */
  function update(dt) {
    state.time += dt;

    updateRain(dt);

    // Modo automático: el controlador decide
    if (state.mode === 'auto') {
      for (const zone of state.zones) {
        if (zone.needsWater && !zone.irrigating) {
          startIrrigation(zone, 'automático');
        }
      }
    }

    for (const zone of state.zones) updateZone(zone, dt);

    // Alerta de poca agua (una sola vez por ciclo)
    if (state.tankLevel < params.tankCapacity * 0.2 && !state.lowWaterNotified) {
      state.lowWaterNotified = true;
      addEvent('alert', 'El tanque tiene poca agua (' + Math.round(state.tankLevel) + ' L).');
    } else if (state.tankLevel > params.tankCapacity * 0.3) {
      state.lowWaterNotified = false;
    }

    // Reactiva la alerta de tanque vacío cuando vuelve a haber agua
    if (state.tankLevel > 0) {
      state.emptyNotified = false;
    }

    // Historial para gráficas (1 muestra/segundo)
    state.historyTimer += dt;
    if (state.historyTimer >= 1) {
      state.historyTimer = 0;
      pushHistory();
    }
  }

  function pushHistory() {
    state.history.push({
      t: nowLabel(),
      tank: Math.round(state.tankLevel),
      collected: Math.round(state.collectedSession),
      consumed: Math.round(state.consumedSession),
      A: Math.round(state.zones[0] ? state.zones[0].humidity : 0),
      B: Math.round(state.zones[1] ? state.zones[1].humidity : 0),
      C: Math.round(state.zones[2] ? state.zones[2].humidity : 0),
    });
    if (state.history.length > 90) state.history.shift();
  }

  /* ---------- API pública ---------- */
  reset();

  return {
    params,
    state,
    update,
    reset,
    startRain,
    stopRain,
    toggleZoneIrrigation,
    setZoneHumidity(zoneId, value) {
      const zone = state.zones.find(z => z.id === zoneId);
      if (!zone) return;
      zone.humidity = clamp(Number(value) || 0, 0, 100);
      zone.needsWater = zone.humidity < zone.threshold;
    },
    setMode(mode) {
      if (mode !== 'auto' && mode !== 'manual') return;
      if (state.mode === mode) return;
      state.mode = mode;
      if (mode === 'manual') {
        // En manual, ningún riego queda activo sin decisión del usuario
        for (const zone of state.zones) {
          if (zone.irrigating) stopIrrigation(zone, 'manual');
        }
        addEvent('info', 'Modo manual activado: el sistema ya no decide por sí solo.');
      } else {
        addEvent('info', 'Modo automático activado: el controlador gestiona el riego.');
      }
    },
    setParam(key, value) {
      if (!(key in params)) return;
      params[key] = Number(value);
      if (key === 'tankCapacity') {
        state.tankLevel = clamp(state.tankLevel, 0, params.tankCapacity);
        state.fullNotified = state.tankLevel >= params.tankCapacity;
      }
    },
    setTankLevelFrac(frac) {
      state.tankLevel = clamp(params.tankCapacity * frac, 0, params.tankCapacity);
      state.lowWaterNotified = state.tankLevel < params.tankCapacity * 0.2;
      state.fullNotified = state.tankLevel >= params.tankCapacity;
      addEvent('info', 'Depósito ajustado a ' + Math.round(state.tankLevel) + ' L (' + Math.round(frac * 100) + ' %).');
    },
    /* Instantánea de solo lectura para AgroBot AI (datos simulados, sin referencias al estado) */
    snapshot() {
      return {
        tankLevel: Math.round(state.tankLevel),
        tankCapacity: params.tankCapacity,
        raining: state.raining,
        mode: state.mode,
        pumpActive: state.pumpActive,
        rainRate: params.rainRate,
        threshold: params.threshold,
        target: params.target,
        consumption: params.consumption,
        collectedSession: Math.round(state.collectedSession),
        consumedSession: Math.round(state.consumedSession),
        zones: state.zones.map(z => ({
          id: z.id,
          humidity: Math.round(z.humidity * 10) / 10,
          irrigating: z.irrigating,
          needsWater: z.needsWater,
        })),
      };
    },
    averageHumidity() {
      if (!state.zones.length) return 0;
      return state.zones.reduce((acc, z) => acc + z.humidity, 0) / state.zones.length;
    },
    zonesNeedingWater() {
      return state.zones.filter(z => z.needsWater).length;
    },
  };
})();
