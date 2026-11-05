// office-scene.js — three.js recreation of the Blender office diorama.
// Usage:
//   import { mountOffice } from './office-scene.js';
//   mountOffice(document.getElementById('app'), { glb: './office.glb', params: './scene.json' });
//
// Everything that defines the look (camera, sun, window lights, world, exposure)
// is read from scene.json, which is written by Blender at export time, so the
// web view matches the Blender camera 1:1.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// Blender (Z-up, right-handed) -> three/glTF (Y-up)
const b2t = ([x, y, z]) => new THREE.Vector3(x, z, -y);

export async function mountOffice(container, opts = {}) {
  const {
    glb = './office.glb',
    params = './scene.json',
    controls = true,          // orbit / zoom / pan
    ao = true,                // ground-truth ambient occlusion pass
    reflections = true,       // faint glossy-floor reflection under the diorama
    shadowMapSize = 4096,
    pixelRatio = Math.min(window.devicePixelRatio, 2),
    onProgress = null,
    autoRender = true,        // set false to render on demand via view.render()
    interactive = true,       // hover / click picking, camera focus, lamps, day-night
    onHover = null,           // (item | null, clientX, clientY) => void
    onSelect = null,          // (item | null) => void
    accent = 0xE58A3A,        // highlight colour
  } = opts;

  const P = typeof params === 'string' ? await (await fetch(params)).json() : params;

  // ---------- renderer ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(pixelRatio);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;           // Blender "AgX"
  renderer.toneMappingExposure = Math.pow(2, P.exposure ?? 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';

  const scene = new THREE.Scene();
  const worldLin = new THREE.Color().setRGB(...P.world.color, THREE.LinearSRGBColorSpace).multiplyScalar(P.world.strength);
  scene.background = worldLin.clone();

  // Uniform world -> image based light (same as Blender's flat world colour)
  {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 16, 8),
      new THREE.MeshBasicMaterial({ color: worldLin, side: THREE.BackSide })));
    scene.environment = pmrem.fromScene(envScene, 0).texture;
    scene.environmentIntensity = P.web?.envBoost ?? 1.0;
    pmrem.dispose();
  }

  // ---------- camera (Blender ortho camera, incl. lens shift) ----------
  const C = P.camera;
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, C.clip_start, C.clip_end);
  cam.position.copy(b2t(C.location));
  // Blender cameras here have no roll, so world-up gives the identical orientation
  // (and keeps OrbitControls' orbit axis vertical)
  cam.up.set(0, 1, 0);
  const target = b2t(C.target);
  cam.lookAt(target);
  scene.add(cam);

  function fitCamera() {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    const aspect = w / h;
    const renderAspect = C.res_x / C.res_y;
    // Blender 'AUTO' sensor fit: ortho_scale spans the larger render dimension
    let halfW, halfH;
    if (renderAspect >= 1) { halfW = C.ortho_scale / 2; halfH = halfW / renderAspect; }
    else { halfH = C.ortho_scale / 2; halfW = halfH * renderAspect; }
    // keep the Blender framing fully visible, extend the other axis
    if (aspect > halfW / halfH) halfW = halfH * aspect; else halfH = halfW / aspect;
    const sx = C.shift_x * C.ortho_scale, sy = C.shift_y * C.ortho_scale;
    cam.left = -halfW + sx; cam.right = halfW + sx; cam.top = halfH + sy; cam.bottom = -halfH + sy;
    cam.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
    composer?.setSize(w, h);
  }

  // ---------- lights ----------
  RectAreaLightUniformsLib.init();
  const rig = { sun: [], area: [], point: [], hemi: null };   // base values, for day / night
  for (const L of P.lights) {
    const color = new THREE.Color().setRGB(...L.color, THREE.LinearSRGBColorSpace);
    if (L.type === 'SUN') {
      const sun = new THREE.DirectionalLight(color, L.strength * (P.web?.sunBoost ?? 1));
      const dir = b2t(L.direction).normalize();            // direction light travels
      const c = b2t(P.bounds.center);
      sun.position.copy(c).addScaledVector(dir, -40);
      sun.target.position.copy(c);
      sun.castShadow = true;
      sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
      const r = P.bounds.radius * 1.15;
      Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 90 });
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.03;
      sun.shadow.radius = 2 + L.angle_deg;                  // soft edge ~ Blender sun angle
      scene.add(sun, sun.target);
      rig.sun.push({ light: sun, base: sun.intensity });
    } else if (L.type === 'AREA') {
      // Blender power (W) -> radiance for RectAreaLight
      const area = L.size_x * L.size_y;
      const radiance = L.power / (Math.PI * area) * (P.web?.areaBoost ?? 1);
      const rl = new THREE.RectAreaLight(color, radiance, L.size_x, L.size_y);
      rl.position.copy(b2t(L.location));
      rl.lookAt(rl.position.clone().add(b2t(L.direction)));
      scene.add(rl);
      rig.area.push({ light: rl, base: rl.intensity, window: /win/i.test(L.name), color: rl.color.clone() });
    } else if (L.type === 'POINT' || L.type === 'SPOT') {
      // Blender point power (W) -> luminous intensity (W/sr) for three's physical lights
      const I = L.power / (4 * Math.PI) * (P.web?.pointBoost ?? 1);
      const pl = L.type === 'SPOT'
        ? new THREE.SpotLight(color, I, 0, THREE.MathUtils.degToRad(L.spot_size_deg) / 2, L.blend ?? 0.15, 2)
        : new THREE.PointLight(color, I, 0, 2);
      pl.position.copy(b2t(L.location));
      if (L.type === 'SPOT') { pl.target.position.copy(pl.position.clone().add(b2t(L.direction))); scene.add(pl.target); }
      scene.add(pl);
      rig.point.push({ light: pl, base: pl.intensity, on: true, L });
    }
  }
  // stand-in for Blender's bounced light (Eevee fast GI)
  if (P.web?.bounce) {
    const hemi = new THREE.HemisphereLight(
      new THREE.Color().setRGB(...P.web.bounce.sky, THREE.LinearSRGBColorSpace),
      new THREE.Color().setRGB(...P.web.bounce.ground, THREE.LinearSRGBColorSpace),
      P.web.bounce.intensity);
    scene.add(hemi);
    rig.hemi = { light: hemi, base: hemi.intensity };
  }

  // ---------- ground (dark glossy floor the diorama stands on) ----------
  const gy = P.ground.z;
  const useRefl = reflections && P.ground.roughness < 0.4;   // rough floor in Blender -> no mirror
  const groundMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(...P.ground.color, THREE.LinearSRGBColorSpace),
    roughness: P.ground.roughness, metalness: 0,
    transparent: useRefl, opacity: useRefl ? 0.9 : 1,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), groundMat);
  ground.rotation.x = -Math.PI / 2; ground.position.y = gy; ground.receiveShadow = true;
  scene.add(ground);
  if (useRefl) {
    const refl = new Reflector(new THREE.PlaneGeometry(400, 400), {
      textureWidth: 1024 * pixelRatio, textureHeight: 1024 * pixelRatio, color: 0x7a7a7a,
    });
    refl.rotation.x = -Math.PI / 2; refl.position.y = gy - 0.002;
    scene.add(refl);
  }

  // ---------- model ----------
  const draco = new DRACOLoader().setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  const loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  const gltf = await new Promise((res, rej) => loader.load(glb, res,
    e => onProgress && e.total && onProgress(e.loaded / e.total), rej));
  const root = gltf.scene;
  root.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      // thin glass (picture frames, drinking glasses, bottles): Blender sees straight through it,
      // three's transmission would render it milky, so use a clear alpha-blended glass instead
      if ((m.transmission ?? 0) > 0) {
        m.transmission = 0; m.transparent = true; m.opacity = 0.16; m.roughness = Math.min(m.roughness, 0.05);
        m.color?.setRGB(0.92, 0.95, 1.0); m.envMapIntensity = 2.0;
      }
      if ('anisotropy' in m) m.anisotropy = 0;   // no tangents in the export -> streaky highlights
      if (m.metalness > 0.5) m.envMapIntensity = P.web?.metalEnvBoost ?? 2.5;   // stand-in for Eevee reflections
      if (m.map) m.map.anisotropy = renderer.capabilities.getMaxAnisotropy();
      if (m.transparent) m.depthWrite = false;
    }
    const see = mats.some(m => m.transparent);
    o.castShadow = !see;      // glass lets the sun through, like in Blender
    o.receiveShadow = true;
  });
  scene.add(root);

  // ---------- post: AO + tone mapping ----------
  var composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, cam));
  if (ao) {
    const gtao = new GTAOPass(scene, cam, 1, 1);
    gtao.updateGtaoMaterial({ radius: 0.35, distanceExponent: 1.5, thickness: 1.0, scale: 1.0, samples: 16 });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, rings: 2, samples: 16 });
    gtao.blendIntensity = P.web?.aoIntensity ?? 0.9;
    composer.addPass(gtao);
  }
  composer.addPass(new OutputPass());
  // Blender's "AgX - High Contrast" look: three only ships base AgX, so add the
  // look's deeper toe on top (darks pushed down, highlights untouched).
  const toe = P.web?.lookToe ?? (String(P.look).includes('High Contrast') ? 0.87 : 0);
  if (toe > 0) {
    composer.addPass(new ShaderPass({
      uniforms: { tDiffuse: { value: null }, uToe: { value: toe } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse; uniform float uToe; varying vec2 vUv;
        void main(){ vec4 c = texture2D(tDiffuse, vUv); vec3 x = clamp(c.rgb, 0.0, 1.0);
          vec3 e = 1.0 + uToe * (1.0 - x) * (1.0 - x); gl_FragColor = vec4(pow(x, e), c.a); }`,
    }));
  }

  // ---------- controls ----------
  let orbit = null;
  if (controls) {
    orbit = new OrbitControls(cam, renderer.domElement);
    orbit.target.copy(target);
    orbit.enableDamping = true;
    orbit.minZoom = 0.6; orbit.maxZoom = 6;
    orbit.maxPolarAngle = Math.PI * 0.47;
    orbit.update();
  }

  fitCamera();
  const ro = new ResizeObserver(fitCamera); ro.observe(container);

  // ================= interaction =================
  const LABELS = {
    CHAIR: 'Ergonomic mesh chair', MCHAIR: 'Conference chair', PAIR: 'Bench desk · 2 seats', DESK: 'Desk with drawers',
    MONITOR: 'MacBook Pro 14″', MTABLE: 'Meeting table', PLANT: 'Ficus in concrete pot', PLANTB: 'Potted plant',
    MONST: 'Monstera', SNAKE: 'Snake plant', KIT8: 'Leafy floor plant', DESKPL: 'Small snake plant', COOLER: 'Water cooler',
    CAB: 'Sideboard', PRINTER: 'Printer', TALL: 'Air purifier', TV: '60″ wall TV', CLOCK: 'Wall clock', POSTER: 'Framed poster',
    ART: 'Abstract print', KIT1: 'Desk accessories', KIT2: 'Desk accessories', KIT3: 'Desk accessories', LAPTOP: 'Laptop',
    GLASS: 'Water glass', NOTE: 'Notebook', BOTTLE: 'Glass bottle', BINDER: 'Binder', BOOKS: 'Book stack', SUCC: 'Succulent',
    TRAY: 'Letter tray', LAMP: 'Desk lamp',
  };
  const toBox = (mn, mx) => new THREE.Box3().setFromPoints([b2t(mn), b2t(mx)]);
  const zones = Object.entries(P.zones || {}).filter(([, z]) => z).map(([name, z]) => ({ name, box: toBox(z.min, z.max) }));
  const zoneOf = c => (zones.find(z => z.name !== 'Overview' && z.box.containsPoint(c)) || { name: 'Open office' }).name;
  const items = (P.items || []).map((it, i) => {
    const box = toBox(it.min, it.max); const c = box.getCenter(new THREE.Vector3());
    const size = [it.max[0] - it.min[0], it.max[1] - it.min[1], it.max[2] - it.min[2]];
    return { id: i, key: it.key, label: LABELS[it.key] || it.key, box, center: c, zone: zoneOf(c),
      dims: { w: Math.round(Math.max(size[0], size[1]) * 100), d: Math.round(Math.min(size[0], size[1]) * 100), h: Math.round(size[2] * 100) } };
  });
  rig.point.forEach((p, i) => {          // desk lamps are clickable switches
    const [x, y, z] = p.L.location;
    const box = toBox([x - 0.09, y - 0.09, z - 0.16], [x + 0.09, y + 0.09, z + 0.07]); const c = box.getCenter(new THREE.Vector3());
    items.push({ id: items.length, key: 'LAMP', label: 'Desk lamp', box, center: c, zone: zoneOf(c), lamp: i, dims: { w: 15, d: 15, h: 22 } });
  });
  const vol = b => { const s = b.getSize(new THREE.Vector3()); return s.x * s.y * s.z; };

  // highlight overlay (drawn after post-processing so AO never touches it)
  const overlay = new THREE.Scene();
  const mkHi = (op) => {
    const g = new THREE.Group();
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: op, depthTest: false, toneMapped: false }));
    const fill = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: op * 0.12, depthTest: false, depthWrite: false, toneMapped: false }));
    g.add(edges, fill); g.visible = false; overlay.add(g); return g;
  };
  const hoverHi = mkHi(0.55), selHi = mkHi(1.0);
  const place = (g, it) => {
    if (!it) { g.visible = false; return; }
    const s = it.box.getSize(new THREE.Vector3()).addScalar(0.04);
    g.position.copy(it.center); g.scale.copy(s); g.visible = true;
  };

  const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2(); const tmp = new THREE.Vector3();
  function pick(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    const hits = [];
    for (const it of items) if (ray.ray.intersectBox(it.box, tmp)) hits.push({ it, t: tmp.distanceTo(ray.ray.origin) });
    if (!hits.length) return null;
    const t0 = Math.min(...hits.map(h => h.t));
    // among boxes the ray enters first, prefer the most specific (smallest) one
    return hits.filter(h => h.t < t0 + 0.7).sort((a, b) => vol(a.it.box) - vol(b.it.box))[0].it;
  }

  // ---- smooth camera focus ----
  const home = { target: target.clone(), pos: b2t(C.location), zoom: 1 };
  let fly = null;
  function flyTo(tgt, zoom, ms = 900) {
    const dir = cam.position.clone().sub(orbit ? orbit.target : target).normalize();
    fly = { t0: performance.now(), ms, fromT: (orbit ? orbit.target : target).clone(), toT: tgt.clone(),
      fromZ: cam.zoom, toZ: THREE.MathUtils.clamp(zoom, 0.6, 6), dir, dist: 40 };
  }
  function focusBox(box, pad = 1.6) {
    const s = box.getSize(new THREE.Vector3()); const span = Math.max(s.x, s.y, s.z) * pad;
    const viewH = cam.top - cam.bottom, viewW = cam.right - cam.left;
    flyTo(box.getCenter(new THREE.Vector3()), Math.min(viewH, viewW) / Math.max(span, 0.6));
  }
  function stepFly(now) {
    if (!fly) return;
    const k = Math.min(1, (now - fly.t0) / fly.ms), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const t = fly.fromT.clone().lerp(fly.toT, e);
    cam.zoom = fly.fromZ + (fly.toZ - fly.fromZ) * e; cam.updateProjectionMatrix();
    cam.position.copy(t).addScaledVector(fly.dir, fly.dist); cam.lookAt(t);
    if (orbit) orbit.target.copy(t);
    if (k >= 1) fly = null;
  }

  // ---- day / night ----
  const NIGHT = { sun: 0, window: 0.18, area: 0.2, env: 0.18, hemi: 0.18, lamp: 1.0, bg: 0.35, exposure: 0.1 };
  let mood = 0, moodTarget = 0;   // 0 = day, 1 = night
  const nightWin = new THREE.Color(0.35, 0.45, 0.9);
  const baseEnv = scene.environmentIntensity, baseBg = scene.background.clone(), baseExp = renderer.toneMappingExposure;
  function applyMood(m) {
    const L = (a, b) => a + (b - a) * m;
    rig.sun.forEach(s => (s.light.intensity = s.base * L(1, NIGHT.sun)));
    rig.area.forEach(a => {
      a.light.intensity = a.base * L(1, a.window ? NIGHT.window : NIGHT.area);
      if (a.window) a.light.color.copy(a.color).lerp(nightWin, m);
    });
    rig.point.forEach(p => (p.light.intensity = p.on ? p.base * L(1, NIGHT.lamp) : 0));
    if (rig.hemi) rig.hemi.light.intensity = rig.hemi.base * L(1, NIGHT.hemi);
    scene.environmentIntensity = baseEnv * L(1, NIGHT.env);
    scene.background.copy(baseBg).multiplyScalar(L(1, NIGHT.bg));
    renderer.toneMappingExposure = baseExp * Math.pow(2, L(0, NIGHT.exposure));
  }

  // ---- pointer handling ----
  let hovered = null, selected = null, down = null;
  const el = renderer.domElement;
  if (interactive) {
    el.style.touchAction = 'none';
    el.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse' && down) return;
      const it = pick(e.clientX, e.clientY);
      if (it !== hovered) { hovered = it; place(hoverHi, it && it !== selected ? it : null); }
      el.style.cursor = it ? 'pointer' : '';
      onHover?.(it, e.clientX, e.clientY);
    });
    el.addEventListener('pointerleave', () => { hovered = null; place(hoverHi, null); onHover?.(null); });
    el.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', e => {
      if (!down) return; const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
      if (moved > 6) return;                                   // that was an orbit drag
      const it = pick(e.clientX, e.clientY);
      if (it && it.key === 'LAMP' && selected === it) { api.toggleLamp(it.lamp); onSelect?.(it); return; }
      api.select(it);
    });
  }

  let raf = 0;
  const render = () => {
    composer.render();
    if (hoverHi.visible || selHi.visible) {
      renderer.autoClear = false; renderer.clearDepth(); renderer.render(overlay, cam); renderer.autoClear = true;
    }
  };
  if (autoRender) {
    const tick = now => {
      raf = requestAnimationFrame(tick);
      stepFly(now);
      if (Math.abs(mood - moodTarget) > 1e-3) { mood += (moodTarget - mood) * 0.08; applyMood(mood); }
      if (!fly) orbit?.update();
      render();
    };
    raf = requestAnimationFrame(tick);
  }

  const api = {
    scene, camera: cam, renderer, controls: orbit, render, items, zones: ['Overview', ...zones.map(z => z.name)],
    select(it) {
      selected = it || null; place(selHi, selected); place(hoverHi, null);
      if (selected) focusBox(selected.box, selected.key === 'PAIR' || selected.key === 'MTABLE' ? 1.3 : 2.4);
      onSelect?.(selected);
    },
    focusZone(name) {
      api.select(null);
      if (name === 'Overview') return api.resetView(true);
      const z = zones.find(z => z.name === name); if (z) focusBox(z.box, 1.15);
    },
    setNight(on) { moodTarget = on ? 1 : 0; if (!autoRender) { mood = moodTarget; applyMood(mood); } },
    get night() { return moodTarget === 1; },
    toggleLamp(i) { const p = rig.point[i]; if (!p) return; p.on = !p.on; applyMood(mood); return p.on; },
    lampOn(i) { return rig.point[i]?.on; },
    resetView(animated = false) {
      selected = null; place(selHi, null);
      if (animated && autoRender) { cam.position.copy(cam.position); flyTo(home.target, 1); fly.dir = home.pos.clone().sub(home.target).normalize(); return; }
      cam.position.copy(home.pos); cam.zoom = 1; cam.lookAt(home.target); orbit?.target.copy(home.target); cam.updateProjectionMatrix();
    },
    dispose() { cancelAnimationFrame(raf); ro.disconnect(); orbit?.dispose(); composer.dispose(); renderer.dispose(); container.removeChild(renderer.domElement); },
  };
  return api;
}
