// office-scene.js — three.js recreation of the Blender office diorama.
// Usage:
//   import { mountOffice } from './office-scene.js';
//   mountOffice(document.getElementById('app'), { glb: './office.glb', params: './scene.json' });
//
// Everything that defines the look (camera, sun, window lights, world, exposure)
// is read from scene.json, which is written by Blender at export time, so the
// isometric view matches the Blender camera 1:1. A second, perspective view uses
// a 55 mm lens on the same camera axis.

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
    view = 'iso',             // 'iso' = Blender's orthographic camera, 'persp' = real lens
    lens = 55,                // focal length (mm) for the perspective view, 36 mm sensor like Blender
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

  // ---------- cameras: isometric (Blender ortho) + perspective (55 mm) ----------
  const C = P.camera;
  const target = b2t(C.target);
  const isoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, C.clip_start, C.clip_end);
  isoCam.position.copy(b2t(C.location));
  isoCam.up.set(0, 1, 0);           // Blender camera has no roll
  isoCam.lookAt(target);
  isoCam.updateMatrixWorld();
  const homeDir = isoCam.position.clone().sub(target).normalize();
  const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(isoCam.quaternion);
  const ISO_DIST = isoCam.position.distanceTo(target);
  const perspCam = new THREE.PerspectiveCamera(30, 1, 0.05, 400);
  perspCam.up.set(0, 1, 0);
  const SENSOR = 36;
  const halfH = { iso: 0, w: 0 };
  let perspHome = 30;              // distance at which the 55 mm view frames the room
  let mode = view === 'persp' ? 'persp' : 'iso';
  let cam = mode === 'iso' ? isoCam : perspCam;
  const shiftY = C.shift_y * C.ortho_scale, shiftX = C.shift_x * C.ortho_scale;
  const homeTarget = target.clone().addScaledVector(camUp, shiftY)
    .addScaledVector(new THREE.Vector3(1, 0, 0).applyQuaternion(isoCam.quaternion), shiftX);

  function fitCamera() {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    const aspect = w / h;
    const renderAspect = C.res_x / C.res_y;
    // Blender 'AUTO' sensor fit: ortho_scale spans the larger render dimension
    let hw, hh;
    if (renderAspect >= 1) { hw = C.ortho_scale / 2; hh = hw / renderAspect; }
    else { hh = C.ortho_scale / 2; hw = hh * renderAspect; }
    if (aspect > hw / hh) hw = hh * aspect; else hh = hw / aspect;   // keep the framing, extend the other axis
    isoCam.left = -hw + shiftX; isoCam.right = hw + shiftX; isoCam.top = hh + shiftY; isoCam.bottom = -hh + shiftY;
    isoCam.updateProjectionMatrix();
    halfH.iso = hh; halfH.w = hw;
    // 55 mm on a 36 mm sensor, fitted to the wider side like Blender
    const half = Math.atan(SENSOR / 2 / lens);
    const vHalf = aspect >= 1 ? Math.atan(Math.tan(half) / aspect) : half;
    perspCam.fov = THREE.MathUtils.radToDeg(vHalf * 2); perspCam.aspect = aspect; perspCam.updateProjectionMatrix();
    const hHalf = Math.atan(Math.tan(vHalf) * aspect);
    perspHome = Math.max((hw * 1.06) / Math.tan(hHalf), (hh * 1.06) / Math.tan(vHalf));
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

  // ---------- post: AO + tone mapping (rebuilt when the camera changes) ----------
  const toe = P.web?.lookToe ?? (String(P.look).includes('High Contrast') ? 0.87 : 0);
  let composer = null;
  function buildComposer() {
    composer?.dispose();
    composer = new EffectComposer(renderer);
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
    if (toe > 0) {
      composer.addPass(new ShaderPass({
        uniforms: { tDiffuse: { value: null }, uToe: { value: toe } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `uniform sampler2D tDiffuse; uniform float uToe; varying vec2 vUv;
          void main(){ vec4 c = texture2D(tDiffuse, vUv); vec3 x = clamp(c.rgb, 0.0, 1.0);
            vec3 e = 1.0 + uToe * (1.0 - x) * (1.0 - x); gl_FragColor = vec4(pow(x, e), c.a); }`,
      }));
    }
    const w = container.clientWidth || window.innerWidth, h = container.clientHeight || window.innerHeight;
    composer.setSize(w, h);
  }

  // ---------- controls ----------
  let orbit = null;
  if (controls) {
    orbit = new OrbitControls(cam, renderer.domElement);
    orbit.enableDamping = true;
    orbit.minZoom = 0.6; orbit.maxZoom = 6;
    orbit.minDistance = 3; orbit.maxDistance = 90;
    orbit.maxPolarAngle = Math.PI * 0.47;
  }
  const curTarget = () => (orbit ? orbit.target : homeTarget);

  // place a camera on the Blender view axis, `amount` = zoom (iso) or distance (persp)
  function placeCam(c, tgt, dir, amount) {
    if (c.isOrthographicCamera) { c.zoom = amount; c.position.copy(tgt).addScaledVector(dir, ISO_DIST); }
    else c.position.copy(tgt).addScaledVector(dir, amount);
    c.lookAt(tgt); c.updateProjectionMatrix();
    if (orbit) orbit.target.copy(tgt);
  }

  fitCamera();
  // iso keeps Blender's projection (target + lens shift handled by the frustum)
  placeCam(isoCam, target, homeDir, 1);
  placeCam(perspCam, homeTarget, homeDir, perspHome);
  if (mode === 'iso') placeCam(isoCam, target, homeDir, 1);
  if (orbit) { orbit.object = cam; orbit.target.copy(mode === 'iso' ? target : homeTarget); orbit.update(); }
  buildComposer();
  const ro = new ResizeObserver(fitCamera); ro.observe(container);

  // ---- smooth camera moves ----
  let fly = null;
  const amountOf = () => (cam.isOrthographicCamera ? cam.zoom : cam.position.distanceTo(curTarget()));
  function flyTo(tgt, amount, dir = cam.position.clone().sub(curTarget()).normalize(), ms = 900) {
    fly = { t0: performance.now(), ms, fromT: curTarget().clone(), toT: tgt.clone(), fromA: amountOf(), toA: amount,
      fromD: cam.position.clone().sub(curTarget()).normalize(), toD: dir.clone().normalize() };
    if (!autoRender) { stepFly(fly.t0 + ms); }
  }
  function stepFly(now) {
    if (!fly) return;
    const k = Math.min(1, (now - fly.t0) / fly.ms), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const t = fly.fromT.clone().lerp(fly.toT, e);
    const d = fly.fromD.clone().lerp(fly.toD, e).normalize();
    // ease zoom/distance in log space so it feels even
    const a = Math.exp(Math.log(fly.fromA) + (Math.log(fly.toA) - Math.log(fly.fromA)) * e);
    placeCam(cam, t, d, a);
    if (k >= 1) fly = null;
  }
  function focusBox(box, pad = 1.15) {
    const s = box.getSize(new THREE.Vector3()); const span = Math.max(s.x, s.z, s.y) * pad;
    const c = box.getCenter(new THREE.Vector3());
    if (cam.isOrthographicCamera) {
      const viewH = (cam.top - cam.bottom), viewW = (cam.right - cam.left);
      flyTo(c, THREE.MathUtils.clamp(Math.min(viewH, viewW) / Math.max(span, 0.6), 0.6, 6));
    } else {
      const vHalf = THREE.MathUtils.degToRad(perspCam.fov / 2);
      flyTo(c, THREE.MathUtils.clamp((span / 2) / Math.tan(vHalf) * 1.1, 3, 90));
    }
  }
  const toBox = (mn, mx) => new THREE.Box3().setFromPoints([b2t(mn), b2t(mx)]);
  const zones = Object.entries(P.zones || {}).filter(([, z]) => z).map(([name, z]) => ({ name, box: toBox(z.min, z.max) }));

  // ---- isometric <-> 55 mm ----
  function setView(next) {
    if (next === mode) return;
    const tgt = curTarget().clone(), dir = cam.position.clone().sub(tgt).normalize();
    // keep roughly the same framing when switching
    const isoZoom = cam.isOrthographicCamera ? cam.zoom : perspHome / cam.position.distanceTo(tgt);
    mode = next; cam = mode === 'iso' ? isoCam : perspCam;
    fly = null;
    placeCam(cam, tgt, dir, mode === 'iso' ? THREE.MathUtils.clamp(isoZoom, 0.6, 6) : THREE.MathUtils.clamp(perspHome / isoZoom, 3, 90));
    if (orbit) { orbit.object = cam; orbit.update(); }
    buildComposer();
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
    rig.point.forEach(p => (p.light.intensity = p.base * L(1, NIGHT.lamp)));
    if (rig.hemi) rig.hemi.light.intensity = rig.hemi.base * L(1, NIGHT.hemi);
    scene.environmentIntensity = baseEnv * L(1, NIGHT.env);
    scene.background.copy(baseBg).multiplyScalar(L(1, NIGHT.bg));
    renderer.toneMappingExposure = baseExp * Math.pow(2, L(0, NIGHT.exposure));
  }

  let raf = 0;
  const render = () => composer.render();
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
    scene, renderer, controls: orbit, render,
    get camera() { return cam; },
    get view() { return mode; },
    setView,
    zones: ['Overview', ...zones.map(z => z.name)],
    focusZone(name) {
      if (name === 'Overview') return api.resetView(true);
      const z = zones.find(z => z.name === name); if (z) focusBox(z.box);
    },
    setNight(on) { moodTarget = on ? 1 : 0; if (!autoRender) { mood = moodTarget; applyMood(mood); } },
    get night() { return moodTarget === 1; },
    resetView(animated = false) {
      const tgt = mode === 'iso' ? target : homeTarget, amt = mode === 'iso' ? 1 : perspHome;
      if (animated && autoRender) return flyTo(tgt, amt, homeDir);
      fly = null; placeCam(cam, tgt, homeDir, amt); orbit?.update();
    },
    dispose() { cancelAnimationFrame(raf); ro.disconnect(); orbit?.dispose(); composer.dispose(); renderer.dispose(); container.removeChild(renderer.domElement); },
  };
  return api;
}
