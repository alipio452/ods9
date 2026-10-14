/* ============================================================
   AGRO RAIN 3D — Escena Three.js
   Finca agrícola construida 100 % con código: terreno con relieve,
   cultivos por zonas, edificio con canaletas, tuberías, filtro,
   tanque con nivel animado, bomba, sensores, panel solar,
   estación meteorológica, lluvia, partículas de flujo y etiquetas.
   ============================================================ */

window.AGRO = window.AGRO || {};

AGRO.Scene3D = (function () {
  'use strict';

  /* ---------- Constantes de posición ---------- */
  const POS = {
    building:  { x: -14, z: -10 },
    gutter:    { x: -14, z: -12.6, y: 3.35 },
    filter:    { x: -8,  z: -14 },
    tank:      { x: 2,   z: -14 },
    pump:      { x: 6,   z: -12 },
    manifold:  { x: 8.5, z: -8 },
    controller:{ x: 4.5, z: -9.5 },
    solar:     { x: -20, z: 4 },
    meteo:     { x: -22, z: -16 },
    zones: {
      A: { cx: 2,  cz: 8 },
      B: { cx: 14, cz: 8 },
      C: { cx: 26, cz: 8 },
    },
  };

  const ZONE_ROWS = [-1.6, 1.6];   // desplazamiento de filas respecto al centro
  const ZONE_PLANTS_X = [-3.3, -1.1, 1.1, 3.3];
  const LEAF_HEALTHY = new THREE.Color(0x3e8e41);
  const LEAF_DRY = new THREE.Color(0x8a9a3f);

  /* ---------- Variables de módulo ---------- */
  let renderer, scene, camera, controls, container;
  let sunLight, hemiLight, skyColorClear, skyColorRain, fogColor;
  let tankWater, pumpLed, pumpGroup, highlightRing;
  let rainPoints, rainVelocities, cloudGroup;
  let anemometer;
  const pipeFlows = {};      // { capture: {curve, meshes, offset}, distA: ..., riegoA: ... }
  const dripSystems = {};    // por zona: { meshes, emitters: [Vector3], active }
  const sensorLeds = {};     // por zona: material
  const leafMats = {};       // por zona: material
  const fruitMats = {};      // por zona: material
  const plantGroups = [];   // { group, zoneId, phase }
  let camAnim = null;
  let elapsed = 0;
  let rainBlend = 0;         // 0 = despejado, 1 = lluvia (transición suave)
  let currentHighlight = null;

  /* ---------- Geometrías y materiales compartidos ---------- */
  const G = {}; // geometrías reutilizables
  const M = {}; // materiales reutilizables

  function initShared() {
    G.leaf = new THREE.ConeGeometry(0.3, 0.55, 6);
    G.stem = new THREE.CylinderGeometry(0.045, 0.07, 0.7, 6);
    G.fruit = new THREE.SphereGeometry(0.09, 8, 6);
    G.sensorStake = new THREE.CylinderGeometry(0.04, 0.04, 0.5, 6);
    G.sensorHead = new THREE.BoxGeometry(0.2, 0.24, 0.13);
    G.sensorLed = new THREE.SphereGeometry(0.07, 8, 6);
    G.pipeParticle = new THREE.SphereGeometry(0.09, 6, 5);
    G.drip = new THREE.SphereGeometry(0.05, 6, 5);
    G.ring = new THREE.RingGeometry(1.15, 1.5, 40);
    G.trunk = new THREE.CylinderGeometry(0.14, 0.2, 1.4, 7);
    G.canopy = new THREE.SphereGeometry(1.1, 8, 6);
    G.rock = new THREE.DodecahedronGeometry(0.4, 0);

    M.stem = new THREE.MeshStandardMaterial({ color: 0x3e6b34, roughness: 0.9 });
    M.sensorStake = new THREE.MeshStandardMaterial({ color: 0x8d6e63, roughness: 0.8 });
    M.sensorHead = new THREE.MeshStandardMaterial({ color: 0x37474f, roughness: 0.5, metalness: 0.3 });
    M.pipeCapture = new THREE.MeshStandardMaterial({ color: 0x4fc3f7, roughness: 0.45 });
    M.pipeDist = new THREE.MeshStandardMaterial({ color: 0x1e88e5, roughness: 0.45 });
    M.pipeDrip = new THREE.MeshStandardMaterial({ color: 0x66bb6a, roughness: 0.45 });
    M.pipeParticle = new THREE.MeshBasicMaterial({ color: 0xb3e5fc });
    M.dripDrop = new THREE.MeshBasicMaterial({ color: 0x4fc3f7, transparent: true, opacity: 0.9 });
    M.rock = new THREE.MeshStandardMaterial({ color: 0x9aa5a0, roughness: 1, flatShading: true });
    M.trunk = new THREE.MeshStandardMaterial({ color: 0x6d4c41, roughness: 1 });
  }

  /* ---------- Terreno con relieve suave ---------- */
  function buildTerrain() {
    const geo = new THREE.PlaneGeometry(64, 64, 56, 56);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    const flatZones = [
      { x: 14, z: 8, r: 13 },   // cultivos
      { x: -14, z: -10, r: 9 }, // edificio
      { x: 2, z: -14, r: 7 },   // tanque
      { x: -8, z: -14, r: 5 },  // filtro
      { x: 6, z: -12, r: 4 },   // bomba
    ];
    const colors = new Float32Array(pos.count * 3);
    const c1 = new THREE.Color(0x55853f); // verde vivo
    const c2 = new THREE.Color(0x47713a); // verde oscuro
    const tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      let minDist = Infinity;
      for (const f of flatZones) {
        const d = Math.hypot(x - f.x, z - f.z) - f.r;
        if (d < minDist) minDist = d;
      }
      const factor = Math.min(1, Math.max(0, minDist / 9));
      const y = factor * (0.55 * Math.sin(x * 0.14 + 1.3) * Math.cos(z * 0.11) + 0.3 * Math.sin(x * 0.31) * Math.sin(z * 0.27 + 2));
      pos.setY(i, y);
      const mix = 0.5 + 0.5 * Math.sin(x * 0.4 + z * 0.33);
      tmp.copy(c1).lerp(c2, mix * 0.7);
      colors[i * 3] = tmp.r; colors[i * 3 + 1] = tmp.g; colors[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
    const ground = new THREE.Mesh(geo, mat);
    ground.receiveShadow = true;
    scene.add(ground);

    // Parcelas de tierra bajo cada zona de cultivo
    const plotMat = new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 1 });
    for (const key of Object.keys(POS.zones)) {
      const z = POS.zones[key];
      const plot = new THREE.Mesh(new THREE.PlaneGeometry(10.4, 5.4), plotMat);
      plot.rotation.x = -Math.PI / 2;
      plot.position.set(z.cx, 0.06, z.cz);
      plot.receiveShadow = true;
      scene.add(plot);
    }
  }

  /* ---------- Cultivos ---------- */
  function buildCrops() {
    for (const key of Object.keys(POS.zones)) {
      const z = POS.zones[key];
      const leafMat = new THREE.MeshStandardMaterial({ color: 0x3e8e41, roughness: 0.85 });
      const fruitMat = new THREE.MeshStandardMaterial({
        color: [0xe53935, 0x43a047, 0xfb8c00]['ABC'.indexOf(key)],
        roughness: 0.5,
      });
      leafMats[key] = leafMat;
      fruitMats[key] = fruitMat;

      for (const dz of ZONE_ROWS) {
        for (const dx of ZONE_PLANTS_X) {
          const plant = new THREE.Group();
          const stem = new THREE.Mesh(G.stem, M.stem);
          stem.position.y = 0.35;
          stem.castShadow = true;
          plant.add(stem);
          for (let l = 0; l < 3; l++) {
            const leaf = new THREE.Mesh(G.leaf, leafMat);
            const a = (l / 3) * Math.PI * 2;
            leaf.position.set(Math.cos(a) * 0.14, 0.62 + l * 0.12, Math.sin(a) * 0.14);
            leaf.rotation.set(0.7, a, 0.35);
            leaf.castShadow = true;
            plant.add(leaf);
          }
          for (let f = 0; f < 3; f++) {
            const fruit = new THREE.Mesh(G.fruit, fruitMat);
            const a = (f / 3) * Math.PI * 2 + 0.5;
            fruit.position.set(Math.cos(a) * 0.2, 0.55 + (f % 2) * 0.18, Math.sin(a) * 0.2);
            fruit.castShadow = true;
            plant.add(fruit);
          }
          plant.position.set(z.cx + dx, 0.05, z.cz + dz);
          scene.add(plant);
          plantGroups.push({ group: plant, zoneId: key, phase: Math.random() * Math.PI * 2 });
        }
      }
    }
  }

  /* ---------- Edificio rural con techo y canaletas ---------- */
  function buildBuilding() {
    const g = new THREE.Group();
    const { x, z } = POS.building;

    const walls = new THREE.Mesh(
      new THREE.BoxGeometry(7, 3, 5),
      new THREE.MeshStandardMaterial({ color: 0xe8dcc0, roughness: 0.9 })
    );
    walls.position.set(0, 1.5, 0);
    walls.castShadow = walls.receiveShadow = true;
    g.add(walls);

    const roofMat = new THREE.MeshStandardMaterial({ color: 0xb0413e, roughness: 0.7, side: THREE.DoubleSide });
    const roofL = new THREE.Mesh(new THREE.BoxGeometry(7.5, 0.14, 3.1), roofMat);
    roofL.position.set(0, 4.05, -1.32);
    roofL.rotation.x = 0.62;
    roofL.castShadow = true;
    g.add(roofL);
    const roofR = roofL.clone();
    roofR.position.z = 1.32;
    roofR.rotation.x = -0.62;
    g.add(roofR);

    const door = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 1.9, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x5d4037, roughness: 0.8 })
    );
    door.position.set(-1.4, 0.95, 2.53);
    g.add(door);
    const winMat = new THREE.MeshStandardMaterial({ color: 0x90caf9, roughness: 0.2, metalness: 0.4 });
    for (const wx of [0.8, 2.2]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.08), winMat);
      win.position.set(wx, 1.7, 2.53);
      g.add(win);
    }

    // Canaletas a lo largo de los bordes bajos del techo
    const gutterMat = new THREE.MeshStandardMaterial({ color: 0x78909c, roughness: 0.4, metalness: 0.6 });
    for (const gz of [-2.55, 2.55]) {
      const gutter = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 7.4, 8), gutterMat);
      gutter.rotation.z = Math.PI / 2;
      gutter.position.set(0, 3.35, gz);
      g.add(gutter);
    }
    // Bajante: de la canaleta sur hacia el filtro
    const downspout = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 2.4, 8), gutterMat);
    downspout.position.set(0, 2.1, -2.6);
    g.add(downspout);

    g.position.set(x, 0, z);
    scene.add(g);
  }

  /* ---------- Tuberías (curvas + tubos) ---------- */
  function makePipe(points, radius, material) {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(p[0], p[1], p[2])));
    const mesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, radius, 8, false), material);
    mesh.castShadow = true;
    scene.add(mesh);
    return curve;
  }

  function buildPipes() {
    // Captación: canaleta → filtro → tanque
    const captureCurve = makePipe([
      [-14, 3.3, -12.6], [-12.5, 1.7, -13.7], [-8, 1.15, -14],
      [-3, 0.95, -14], [0, 1.0, -14], [2, 1.15, -14],
    ], 0.11, M.pipeCapture);
    pipeFlows.capture = createPipeFlow(captureCurve, 14, 0.22);

    // Distribución: manifold → entrada de cada zona
    for (const key of Object.keys(POS.zones)) {
      const z = POS.zones[key];
      const curve = makePipe([
        [POS.manifold.x, 0.5, POS.manifold.z],
        [z.cx, 0.5, -3],
        [z.cx, 0.45, z.cz - 2.6],
        [z.cx - 4.2, 0.4, z.cz - 1.6],
      ], 0.08, M.pipeDist);
      pipeFlows['dist' + key] = createPipeFlow(curve, 10, 0.3);

      // Riego por goteo: recorre las dos filas de la zona
      const dripCurve = makePipe([
        [z.cx - 4.2, 0.38, z.cz - 1.6], [z.cx + 4.2, 0.38, z.cz - 1.6],
        [z.cx + 4.2, 0.38, z.cz + 1.6], [z.cx - 4.2, 0.38, z.cz + 1.6],
      ], 0.05, M.pipeDrip);
      pipeFlows['riego' + key] = createPipeFlow(dripCurve, 12, 0.35);
    }
  }

  function createPipeFlow(curve, count, speed) {
    const meshes = [];
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(G.pipeParticle, M.pipeParticle);
      m.visible = false;
      scene.add(m);
      meshes.push(m);
    }
    return { curve, meshes, speed, offset: 0, active: false };
  }

  function updatePipeFlow(flow, dt, active) {
    if (active !== flow.active) {
      flow.active = active;
      for (const m of flow.meshes) m.visible = active;
    }
    if (!active) return;
    flow.offset = (flow.offset + dt * flow.speed) % 1;
    for (let i = 0; i < flow.meshes.length; i++) {
      const t = (i / flow.meshes.length + flow.offset) % 1;
      flow.meshes[i].position.copy(flow.curve.getPoint(t));
    }
  }

  /* ---------- Filtro ---------- */
  function buildFilter() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.7, 0.7, 1.8, 14),
      new THREE.MeshStandardMaterial({ color: 0x78909c, roughness: 0.4, metalness: 0.5 })
    );
    body.position.y = 0.9;
    body.castShadow = true;
    g.add(body);
    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.78, 0.78, 0.25, 14),
      new THREE.MeshStandardMaterial({ color: 0x546e7a, roughness: 0.5, metalness: 0.4 })
    );
    cap.position.y = 1.9;
    g.add(cap);
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.85, 0.9, 0.25, 14),
      new THREE.MeshStandardMaterial({ color: 0x455a64, roughness: 0.8 })
    );
    base.position.y = 0.12;
    g.add(base);
    g.position.set(POS.filter.x, 0, POS.filter.z);
    scene.add(g);
  }

  /* ---------- Tanque de almacenamiento ---------- */
  function buildTank() {
    const g = new THREE.Group();
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(2.5, 2.6, 0.35, 20),
      new THREE.MeshStandardMaterial({ color: 0xb0bec5, roughness: 0.9 })
    );
    base.position.y = 0.17;
    base.receiveShadow = true;
    g.add(base);

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(2.2, 2.2, 4.4, 24),
      new THREE.MeshStandardMaterial({ color: 0xeceff1, roughness: 0.25, metalness: 0.1, transparent: true, opacity: 0.42, depthWrite: false })
    );
    body.position.y = 2.55;
    body.castShadow = body.receiveShadow = true;
    body.renderOrder = 2;
    g.add(body);

    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(2.35, 0.7, 24),
      new THREE.MeshStandardMaterial({ color: 0x90a4ae, roughness: 0.5, metalness: 0.3 })
    );
    roof.position.y = 5.05;
    roof.castShadow = true;
    g.add(roof);

    // Agua interior (escala Y según nivel)
    tankWater = new THREE.Mesh(
      new THREE.CylinderGeometry(2.0, 2.0, 4.1, 20),
      new THREE.MeshStandardMaterial({ color: 0x039be5, transparent: true, opacity: 0.9, roughness: 0.15, depthWrite: false })
    );
    tankWater.position.y = 0.35;
    tankWater.renderOrder = 1;
    g.add(tankWater);

    // Franjas del medidor de nivel
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0x1976d2, roughness: 0.6 });
    for (let i = 1; i <= 4; i++) {
      const stripe = new THREE.Mesh(new THREE.TorusGeometry(2.21, 0.035, 6, 32), stripeMat);
      stripe.rotation.x = Math.PI / 2;
      stripe.position.y = 0.35 + (4.1 * i) / 5;
      g.add(stripe);
    }

    g.position.set(POS.tank.x, 0, POS.tank.z);
    scene.add(g);
  }

  /* ---------- Bomba ---------- */
  function buildPump() {
    pumpGroup = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 0.75, 0.85),
      new THREE.MeshStandardMaterial({ color: 0x1565c0, roughness: 0.45, metalness: 0.35 })
    );
    body.position.y = 0.45;
    body.castShadow = true;
    pumpGroup.add(body);
    const motor = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.34, 0.75, 12),
      new THREE.MeshStandardMaterial({ color: 0x0d47a1, roughness: 0.4, metalness: 0.5 })
    );
    motor.rotation.z = Math.PI / 2;
    motor.position.set(0, 1.05, 0);
    motor.castShadow = true;
    pumpGroup.add(motor);
    pumpLed = new THREE.Mesh(
      G.sensorLed,
      new THREE.MeshStandardMaterial({ color: 0x616161, emissive: 0x000000, roughness: 0.3 })
    );
    pumpLed.position.set(0.55, 0.95, 0.45);
    pumpGroup.add(pumpLed);
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.18, 1.1),
      new THREE.MeshStandardMaterial({ color: 0x455a64, roughness: 0.9 })
    );
    base.position.y = 0.09;
    pumpGroup.add(base);

    pumpGroup.position.set(POS.pump.x, 0, POS.pump.z);
    scene.add(pumpGroup);
  }

  /* ---------- Manifold de distribución ---------- */
  function buildManifold() {
    const g = new THREE.Group();
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.65, 0.9),
      new THREE.MeshStandardMaterial({ color: 0x37474f, roughness: 0.5, metalness: 0.3 })
    );
    box.position.y = 0.33;
    box.castShadow = true;
    g.add(box);
    const valveColors = [0xe53935, 0x43a047, 0xfb8c00];
    valveColors.forEach((c, i) => {
      const valve = new THREE.Mesh(
        new THREE.CylinderGeometry(0.11, 0.11, 0.3, 8),
        new THREE.MeshStandardMaterial({ color: c, roughness: 0.5 })
      );
      valve.position.set(-0.25 + i * 0.25, 0.8, 0);
      g.add(valve);
    });
    g.position.set(POS.manifold.x, 0, POS.manifold.z);
    scene.add(g);
  }

  /* ---------- Controlador electrónico ---------- */
  function buildController() {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 1.5, 8),
      new THREE.MeshStandardMaterial({ color: 0x607d8b, roughness: 0.6, metalness: 0.4 })
    );
    pole.position.y = 0.75;
    g.add(pole);
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.75, 0.95, 0.35),
      new THREE.MeshStandardMaterial({ color: 0xf9a825, roughness: 0.55 })
    );
    box.position.y = 1.85;
    box.castShadow = true;
    g.add(box);
    const led = new THREE.Mesh(
      G.sensorLed,
      new THREE.MeshStandardMaterial({ color: 0x4caf50, emissive: 0x1b5e20, roughness: 0.3 })
    );
    led.position.set(0.22, 2.1, 0.19);
    g.add(led);
    g.position.set(POS.controller.x, 0, POS.controller.z);
    scene.add(g);
  }

  /* ---------- Panel solar ---------- */
  function buildSolar() {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.11, 1.6, 8),
      new THREE.MeshStandardMaterial({ color: 0x78909c, roughness: 0.5, metalness: 0.5 })
    );
    pole.position.y = 0.8;
    pole.castShadow = true;
    g.add(pole);
    const panel = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 0.1, 1.6),
      new THREE.MeshStandardMaterial({ color: 0x1a237e, roughness: 0.25, metalness: 0.55 })
    );
    panel.position.y = 1.75;
    panel.rotation.x = -0.45;
    panel.castShadow = true;
    g.add(panel);
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(2.5, 0.06, 1.7),
      new THREE.MeshStandardMaterial({ color: 0xb0bec5, roughness: 0.4, metalness: 0.6 })
    );
    frame.position.y = 1.7;
    frame.rotation.x = -0.45;
    g.add(frame);
    g.position.set(POS.solar.x, 0, POS.solar.z);
    scene.add(g);
  }

  /* ---------- Estación meteorológica ---------- */
  function buildMeteo() {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.08, 4.2, 8),
      new THREE.MeshStandardMaterial({ color: 0x90a4ae, roughness: 0.5, metalness: 0.5 })
    );
    pole.position.y = 2.1;
    pole.castShadow = true;
    g.add(pole);

    // Anemómetro (copas que giran)
    anemometer = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.04, 0.04),
        new THREE.MeshStandardMaterial({ color: 0x607d8b })
      );
      arm.rotation.y = (i / 3) * Math.PI * 2;
      const cup = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0xeceff1, roughness: 0.4 })
      );
      cup.position.set(Math.cos(arm.rotation.y) * 0.25, 0, -Math.sin(arm.rotation.y) * 0.25);
      arm.add(cup);
      anemometer.add(arm);
    }
    anemometer.position.y = 4.1;
    g.add(anemometer);

    // Veleta
    const vane = new THREE.Mesh(
      new THREE.ConeGeometry(0.12, 0.5, 6),
      new THREE.MeshStandardMaterial({ color: 0xe53935, roughness: 0.5 })
    );
    vane.rotation.z = Math.PI / 2;
    vane.position.set(0.35, 3.6, 0);
    g.add(vane);

    // Pluviómetro
    const rainGauge = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.12, 0.4, 10),
      new THREE.MeshStandardMaterial({ color: 0x4fc3f7, roughness: 0.3, transparent: true, opacity: 0.85 })
    );
    rainGauge.position.set(0, 3.2, 0.35);
    g.add(rainGauge);

    g.position.set(POS.meteo.x, 0, POS.meteo.z);
    scene.add(g);
  }

  /* ---------- Sensores de humedad ---------- */
  function buildSensors() {
    for (const key of Object.keys(POS.zones)) {
      const z = POS.zones[key];
      const ledMat = new THREE.MeshStandardMaterial({ color: 0x4caf50, emissive: 0x1b5e20, roughness: 0.3 });
      sensorLeds[key] = ledMat;
      for (const sx of [-1.6, 1.6]) {
        const g = new THREE.Group();
        const stake = new THREE.Mesh(G.sensorStake, M.sensorStake);
        stake.position.y = 0.25;
        g.add(stake);
        const head = new THREE.Mesh(G.sensorHead, M.sensorHead);
        head.position.y = 0.58;
        g.add(head);
        const led = new THREE.Mesh(G.sensorLed, ledMat);
        led.position.y = 0.78;
        g.add(led);
        g.position.set(z.cx + sx, 0.05, z.cz);
        scene.add(g);
      }
    }
  }

  /* ---------- Gotas de riego (pool por zona) ---------- */
  function buildDripSystems() {
    for (const key of Object.keys(POS.zones)) {
      const z = POS.zones[key];
      const emitters = [];
      for (const dz of ZONE_ROWS) {
        for (const dx of ZONE_PLANTS_X) {
          // Emisor visible junto a cada planta
          const em = new THREE.Mesh(
            new THREE.CylinderGeometry(0.05, 0.07, 0.22, 6),
            M.pipeDrip
          );
          em.position.set(z.cx + dx, 0.16, z.cz + dz);
          scene.add(em);
          emitters.push(new THREE.Vector3(z.cx + dx, 0.3, z.cz + dz));
        }
      }
      const meshes = [];
      for (let i = 0; i < 24; i++) {
        const d = new THREE.Mesh(G.drip, M.dripDrop);
        d.visible = false;
        scene.add(d);
        meshes.push(d);
      }
      dripSystems[key] = { meshes, emitters, active: false };
    }
  }

  function updateDripSystem(key, dt, active) {
    const sys = dripSystems[key];
    if (active !== sys.active) {
      sys.active = active;
      for (const m of sys.meshes) m.visible = active;
    }
    if (!active) return;
    for (let i = 0; i < sys.meshes.length; i++) {
      const m = sys.meshes[i];
      const em = sys.emitters[i % sys.emitters.length];
      if (!m.userData.phase) m.userData.phase = Math.random();
      m.userData.phase += dt * 1.6;
      if (m.userData.phase > 1) {
        m.userData.phase = 0;
        m.position.copy(em);
      }
      m.position.y = em.y - m.userData.phase * 0.26;
    }
  }

  /* ---------- Lluvia ---------- */
  function buildRain() {
    const COUNT = 1300;
    const positions = new Float32Array(COUNT * 3);
    rainVelocities = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 70;
      positions[i * 3 + 1] = Math.random() * 22;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 70;
      rainVelocities[i] = 15 + Math.random() * 7;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // Textura circular suave para que las gotas no se vean cuadradas
    const dropCanvas = document.createElement('canvas');
    dropCanvas.width = dropCanvas.height = 32;
    const dctx = dropCanvas.getContext('2d');
    const grad = dctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(200,225,250,0.85)');
    grad.addColorStop(1, 'rgba(200,225,250,0)');
    dctx.fillStyle = grad;
    dctx.fillRect(0, 0, 32, 32);
    const dropTex = new THREE.CanvasTexture(dropCanvas);
    const mat = new THREE.PointsMaterial({
      color: 0xd6ebff, size: 0.32, map: dropTex, transparent: true, opacity: 0.85, depthWrite: false,
    });
    rainPoints = new THREE.Points(geo, mat);
    rainPoints.visible = false;
    rainPoints.frustumCulled = false;
    scene.add(rainPoints);

    // Nube low-poly que aparece con la lluvia
    cloudGroup = new THREE.Group();
    const cloudMat = new THREE.MeshStandardMaterial({ color: 0x78909c, roughness: 1, transparent: true, opacity: 0.95 });
    const puffs = [[0, 0, 0, 3.2], [2.6, 0.4, 0.8, 2.4], [-2.6, 0.3, -0.5, 2.5], [0.8, 0.9, -1, 2.1], [-1, 0.8, 1.2, 2.0]];
    for (const [x, y, z, r] of puffs) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), cloudMat);
      puff.position.set(x, y, z);
      puff.scale.y = 0.62;
      cloudGroup.add(puff);
    }
    cloudGroup.position.set(0, 19, -4);
    cloudGroup.visible = false;
    scene.add(cloudGroup);
  }

  function updateRain(dt) {
    rainPoints.visible = rainBlend > 0.03;
    cloudGroup.visible = rainBlend > 0.03;
    if (!rainPoints.visible) return;
    const pos = rainPoints.geometry.attributes.position;
    for (let i = 0; i < rainVelocities.length; i++) {
      let y = pos.getY(i) - rainVelocities[i] * dt;
      if (y < 0) {
        y = 18 + Math.random() * 5;
        pos.setX(i, (Math.random() - 0.5) * 70);
        pos.setZ(i, (Math.random() - 0.5) * 70);
      }
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    cloudGroup.position.x = Math.sin(elapsed * 0.15) * 3;
  }

  /* ---------- Árboles y rocas decorativas ---------- */
  function buildDecor() {
    const spots = [[-26, -24], [26, -24], [-26, 20], [27, 22]];
    for (const [x, z] of spots) {
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(G.trunk, M.trunk);
      trunk.position.y = 0.7;
      trunk.castShadow = true;
      tree.add(trunk);
      const canopy = new THREE.Mesh(G.canopy, new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.95, flatShading: true }));
      canopy.position.y = 2;
      canopy.castShadow = true;
      tree.add(canopy);
      tree.position.set(x, 0, z);
      tree.scale.setScalar(0.9 + Math.random() * 0.5);
      scene.add(tree);
    }
    const rockSpots = [[-6, 14], [10, -18], [20, 2], [-18, 14]];
    for (const [x, z] of rockSpots) {
      const rock = new THREE.Mesh(G.rock, M.rock);
      rock.position.set(x, 0.15, z);
      rock.scale.setScalar(0.5 + Math.random() * 0.8);
      rock.rotation.set(Math.random(), Math.random(), Math.random());
      rock.castShadow = true;
      scene.add(rock);
    }
  }

  /* ---------- Etiquetas flotantes ---------- */
  function makeLabel(text, x, y, z, scale) {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 112;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(13, 38, 30, 0.78)';
    const r = 26;
    ctx.beginPath();
    ctx.moveTo(r, 4); ctx.lineTo(512 - r, 4); ctx.quadraticCurveTo(508, 4, 508, r);
    ctx.lineTo(508, 112 - r); ctx.quadraticCurveTo(508, 108, 512 - r, 108);
    ctx.lineTo(r, 108); ctx.quadraticCurveTo(4, 108, 4, 112 - r);
    ctx.lineTo(4, r); ctx.quadraticCurveTo(4, 4, r, 4);
    ctx.fill();
    ctx.fillStyle = '#e8f5ee';
    ctx.font = 'bold 44px "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 58);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    sprite.scale.set(4.6 * (scale || 1), 1.0 * (scale || 1), 1);
    sprite.position.set(x, y, z);
    sprite.renderOrder = 10;
    scene.add(sprite);
    return sprite;
  }

  function buildLabels() {
    makeLabel('Edificio + canaletas', POS.building.x, 6.1, POS.building.z, 1.15);
    makeLabel('Filtro', POS.filter.x, 2.9, POS.filter.z, 0.8);
    makeLabel('Tanque de agua', POS.tank.x, 6.2, POS.tank.z, 1.05);
    makeLabel('Bomba', POS.pump.x, 2.1, POS.pump.z, 0.8);
    makeLabel('Controlador', POS.controller.x, 2.9, POS.controller.z, 0.8);
    makeLabel('Panel solar', POS.solar.x, 3.1, POS.solar.z, 0.85);
    makeLabel('Estación meteo', POS.meteo.x, 5.1, POS.meteo.z, 0.85);
    makeLabel('Zona A', POS.zones.A.cx, 2.4, POS.zones.A.cz, 0.85);
    makeLabel('Zona B', POS.zones.B.cx, 2.4, POS.zones.B.cz, 0.85);
    makeLabel('Zona C', POS.zones.C.cx, 2.4, POS.zones.C.cz, 0.85);
  }

  /* ---------- Anillo de resaltado ---------- */
  function buildHighlight() {
    highlightRing = new THREE.Mesh(
      G.ring,
      new THREE.MeshBasicMaterial({ color: 0xffd54f, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
    );
    highlightRing.rotation.x = -Math.PI / 2;
    highlightRing.visible = false;
    scene.add(highlightRing);
  }

  const HIGHLIGHT_SPOTS = {
    overview:  { x: 0,  z: 0,  s: 1 },
    tank:      { x: POS.tank.x, z: POS.tank.z, s: 3.4 },
    pump:      { x: POS.pump.x, z: POS.pump.z, s: 1.4 },
    filter:    { x: POS.filter.x, z: POS.filter.z, s: 1.4 },
    controller:{ x: POS.controller.x, z: POS.controller.z, s: 1.2 },
    solar:     { x: POS.solar.x, z: POS.solar.z, s: 1.8 },
    meteo:     { x: POS.meteo.x, z: POS.meteo.z, s: 1.2 },
    building:  { x: POS.building.x, z: POS.building.z, s: 4.4 },
    crops:     { x: 14, z: 8, s: 7 },
    sensors:   { x: 14, z: 8, s: 5 },
    zoneA:     { x: POS.zones.A.cx, z: POS.zones.A.cz, s: 5.4 },
    zoneB:     { x: POS.zones.B.cx, z: POS.zones.B.cz, s: 5.4 },
    zoneC:     { x: POS.zones.C.cx, z: POS.zones.C.cz, s: 5.4 },
    sensorA:   { x: POS.zones.A.cx, z: POS.zones.A.cz, s: 2.6 },
    sensorB:   { x: POS.zones.B.cx, z: POS.zones.B.cz, s: 2.6 },
    sensorC:   { x: POS.zones.C.cx, z: POS.zones.C.cz, s: 2.6 },
  };

  function highlight(id) {
    const spot = HIGHLIGHT_SPOTS[id];
    if (!spot) { highlightRing.visible = false; return; }
    highlightRing.visible = true;
    highlightRing.position.set(spot.x, 0.12, spot.z);
    highlightRing.scale.setScalar(spot.s);
  }

  /* ---------- Cámara y controles ---------- */
  const CAM_PRESETS = {
    overview: { pos: [38, 25, 42],  tgt: [2, 0, 1] },
    tank:     { pos: [11, 8.5, -3], tgt: [2, 2.2, -14] },
    crops:    { pos: [14, 11, 21],  tgt: [14, 1, 8] },
    sensors:  { pos: [7, 6.5, 15], tgt: [8, 0.8, 8] },
    pump:     { pos: [12.5, 5, -3.5], tgt: [6, 0.9, -12] },
    zoneA:    { pos: [2, 6.5, 15], tgt: [2, 1, 8] },
    zoneB:    { pos: [14, 6.5, 15], tgt: [14, 1, 8] },
    zoneC:    { pos: [26, 6.5, 15], tgt: [26, 1, 8] },
  };

  function focusOn(preset) {
    const p = CAM_PRESETS[preset];
    if (!p) return;
    camAnim = {
      fromPos: camera.position.clone(),
      fromTgt: controls.target.clone(),
      toPos: new THREE.Vector3(p.pos[0], p.pos[1], p.pos[2]),
      toTgt: new THREE.Vector3(p.tgt[0], p.tgt[1], p.tgt[2]),
      t: 0,
    };
  }

  function updateCamera(dt) {
    if (!camAnim) return;
    camAnim.t = Math.min(1, camAnim.t + dt / 1.1);
    const k = camAnim.t < 0.5 ? 4 * camAnim.t ** 3 : 1 - Math.pow(-2 * camAnim.t + 2, 3) / 2; // easeInOutCubic
    camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, k);
    controls.target.lerpVectors(camAnim.fromTgt, camAnim.toTgt, k);
    if (camAnim.t >= 1) camAnim = null;
  }

  /* ---------- Sincronización con el estado de simulación ---------- */
  function syncWithSim(dt) {
    const sim = AGRO.Sim;
    const s = sim.state;

    // Nivel del tanque
    const frac = sim.params.tankCapacity > 0 ? s.tankLevel / sim.params.tankCapacity : 0;
    tankWater.visible = frac > 0.01;
    tankWater.scale.y = Math.max(0.001, frac);
    tankWater.position.y = 0.35 + (4.1 * frac) / 2;

    // Transición de cielo según lluvia
    const target = s.raining ? 1 : 0;
    rainBlend += (target - rainBlend) * Math.min(1, dt * 1.5);
    scene.background.copy(skyColorClear).lerp(skyColorRain, rainBlend);
    scene.fog.color.copy(scene.background);
    sunLight.intensity = 1.15 - rainBlend * 0.55;
    hemiLight.intensity = 0.65 - rainBlend * 0.25;

    // Bomba
    const pumpOn = s.pumpActive;
    pumpLed.material.emissive.setHex(pumpOn ? 0x2e7d32 : 0x000000);
    pumpLed.material.color.setHex(pumpOn ? 0x69f0ae : 0x616161);
    if (pumpOn) {
      pumpGroup.position.x = POS.pump.x + Math.sin(elapsed * 42) * 0.02;
    } else {
      pumpGroup.position.x = POS.pump.x;
    }

    // Flujo de agua por tuberías
    updatePipeFlow(pipeFlows.capture, dt, s.raining && s.tankLevel < sim.params.tankCapacity);
    for (const zone of s.zones) {
      updatePipeFlow(pipeFlows['dist' + zone.id], dt, zone.irrigating);
      updatePipeFlow(pipeFlows['riego' + zone.id], dt, zone.irrigating);
      updateDripSystem(zone.id, dt, zone.irrigating);

      // Color del LED del sensor según humedad
      const led = sensorLeds[zone.id];
      if (zone.irrigating) {
        led.color.setHex(0x29b6f6); led.emissive.setHex(0x01579b);
      } else if (zone.humidity < zone.threshold) {
        led.color.setHex(0xff5252); led.emissive.setHex(0xb71c1c);
      } else if (zone.humidity < zone.target) {
        led.color.setHex(0xffb300); led.emissive.setHex(0xe65100);
      } else {
        led.color.setHex(0x4caf50); led.emissive.setHex(0x1b5e20);
      }

      // Color de hojas según humedad (marchitez simulada)
      const leaf = leafMats[zone.id];
      const health = Math.min(1, zone.humidity / 100);
      leaf.color.copy(LEAF_HEALTHY).lerp(LEAF_DRY, 1 - health);
    }

    // Marchitez: inclinación de plantas
    for (const p of plantGroups) {
      const zone = s.zones.find(z => z.id === p.zoneId);
      const health = zone ? Math.min(1, zone.humidity / 100) : 1;
      const tilt = (1 - health) * 0.22;
      p.group.rotation.z = Math.sin(p.phase) * tilt;
    }

    // Anemómetro gira más rápido con lluvia
    if (anemometer) anemometer.rotation.y += dt * (1 + rainBlend * 6);

    // Pulso del anillo de resaltado
    if (highlightRing.visible) {
      const pulse = 1 + Math.sin(elapsed * 4) * 0.06;
      const base = HIGHLIGHT_SPOTS[currentHighlight] ? HIGHLIGHT_SPOTS[currentHighlight].s : 1;
      highlightRing.scale.setScalar(base * pulse);
      highlightRing.material.opacity = 0.65 + Math.sin(elapsed * 4) * 0.25;
    }
  }

  /* ---------- Inicialización ---------- */
  function init(containerEl) {
    container = containerEl;

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    skyColorClear = new THREE.Color(0xbfe3ff);
    skyColorRain = new THREE.Color(0x8fa8bd);
    scene.background = skyColorClear.clone();
    scene.fog = new THREE.Fog(scene.background.clone(), 70, 150);

    camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 400);
    camera.position.set(38, 25, 42);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 1, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 9;
    controls.maxDistance = 85;
    controls.maxPolarAngle = 1.42;
    controls.minPolarAngle = 0.12;
    controls.addEventListener('start', () => { camAnim = null; });

    // Luces
    hemiLight = new THREE.HemisphereLight(0xdff3ff, 0x4a6b4f, 0.65);
    scene.add(hemiLight);
    sunLight = new THREE.DirectionalLight(0xfff4e0, 1.15);
    sunLight.position.set(28, 42, 18);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.left = -40;
    sunLight.shadow.camera.right = 40;
    sunLight.shadow.camera.top = 40;
    sunLight.shadow.camera.bottom = -40;
    sunLight.shadow.camera.far = 120;
    sunLight.shadow.bias = -0.0004;
    scene.add(sunLight);

    initShared();
    buildTerrain();
    buildCrops();
    buildBuilding();
    buildPipes();
    buildFilter();
    buildTank();
    buildPump();
    buildManifold();
    buildController();
    buildSolar();
    buildMeteo();
    buildSensors();
    buildDripSystems();
    buildRain();
    buildDecor();
    buildLabels();
    buildHighlight();

    window.addEventListener('resize', onResize);
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(onResize).observe(container);
    }
  }

  function onResize() {
    if (!container || !renderer) return;
    const w = container.clientWidth, h = container.clientHeight;
    if (w === 0 || h === 0) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  /* ---------- Bucle de actualización ---------- */
  function update(dt) {
    elapsed += dt;
    controls.update();
    updateCamera(dt);
    updateRain(dt);
    syncWithSim(dt);
    renderer.render(scene, camera);
  }

  return {
    init,
    update,
    focusOn,
    highlight(id) { currentHighlight = id; highlight(id); },
    onResize,
  };
})();
