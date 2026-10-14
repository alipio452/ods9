/* ============================================================
   AGRO RAIN 3D — Punto de entrada
   Inicializa la simulación, la escena 3D, las gráficas y la
   interfaz, y ejecuta el bucle principal con requestAnimationFrame.
   ============================================================ */

(function () {
  'use strict';

  function setLoaderProgress(pct, text) {
    const bar = document.getElementById('loader-bar');
    const txt = document.getElementById('loader-text');
    if (bar) bar.style.width = pct + '%';
    if (txt && text) txt.textContent = text;
  }

  function hideLoader() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.classList.add('hidden');
  }

  function showError(message) {
    const overlay = document.getElementById('loading-overlay');
    if (!overlay) return;
    overlay.classList.add('error');
    const txt = document.getElementById('loader-text');
    if (txt) txt.textContent = 'Error al iniciar: ' + message;
  }

  function start() {
    try {
      setLoaderProgress(45, 'Construyendo la finca en 3D…');

      const container = document.getElementById('scene-container');
      if (!container) throw new Error('No se encontró el contenedor de la escena.');

      if (typeof THREE === 'undefined') throw new Error('Three.js no se cargó (revisa tu conexión a internet).');
      if (THREE.OrbitControls === undefined) throw new Error('OrbitControls no se cargó.');

      AGRO.Scene3D.init(container);
      setLoaderProgress(70, 'Preparando gráficas y paneles…');

      AGRO.Charts.init();
      AGRO.UI.init();

      AGRO.UI.syncRainButton();
      AGRO.UI.syncModeButton();

      // AgroBot AI: módulo aislado; un fallo aquí nunca debe romper la escena 3D
      try { if (AGRO.Bot) AGRO.Bot.init(); } catch (botErr) { console.warn('[AgroBot AI]', botErr); }

      setLoaderProgress(100, 'Listo');
      setTimeout(hideLoader, 250);

      // Bucle principal: un solo requestAnimationFrame
      let last = performance.now();
      let chartTimer = 0;
      function loop(now) {
        requestAnimationFrame(loop);
        let dt = (now - last) / 1000;
        last = now;
        if (dt > 0.1) dt = 0.1; // evitar saltos tras pestañas inactivas
        if (dt <= 0) return;

        AGRO.Sim.update(dt);
        AGRO.Scene3D.update(dt);

        chartTimer += dt;
        if (chartTimer >= 1) {
          chartTimer = 0;
          AGRO.Charts.update();
        }
      }
      requestAnimationFrame(loop);

      // Actualización de indicadores 4 veces por segundo
      setInterval(() => AGRO.UI.update(), 250);

    } catch (err) {
      console.error('[AGRO RAIN 3D]', err);
      showError(err.message || String(err));
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
