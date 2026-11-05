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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
    lampClicks = true,        // click a desk lamp to switch it on / off
    onLamp = null,            // (index, isOn) => void
    blindClicks = true,       // click a window to roll its blind up / down
    onBlind = null,           // (index, isUp) => void
    purifierClicks = true,    // click the air purifier to start / stop it turning
    onPurifier = null,        // (index, isTurning) => void
    chairClicks = true,       // click a chair to slide it out from its desk / table and back
    onChair = null,           // (index, isOut) => void
    laptopClicks = true,      // click a laptop to close / open its lid
    onLaptop = null,          // (index, isOpen) => void
    drawerClicks = true,      // click a desk-pedestal drawer to open / close it
    onDrawer = null,          // (index, isOpen) => void
    doorClicks = true,        // click the meeting-room glass door to open / close it
    onDoor = null,            // (isOpen) => void
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

  // ---- desk lamps: click a lamp to switch its light on / off ----
  const lamps = rig.point.map(p => {
    const [x, y, z] = p.L.location;   // light sits inside the shade; box covers shade + base
    return { p, box: toBox([x - 0.1, y - 0.1, z - 0.17], [x + 0.1, y + 0.1, z + 0.08]) };
  });
  function setLamp(p, on) { p.on = on; p.light.intensity = on ? p.base * (1 + (NIGHT.lamp - 1) * mood) : 0; }
  lamps.forEach((l, i) => (l.click = () => { setLamp(l.p, !l.p.on); onLamp?.(i, l.p.on); }));

  // ---- window blinds: click a window to roll its blind up into the cassette / back down ----
  // Each window is <wall>_blind<n> (fabric), _bar<n> (bottom bar), _cass<n> (cassette) and _glass<n>;
  // the back wall's windows are one InstancedMesh, so every instance is its own blind.
  const blinds = [];
  {
    root.updateMatrixWorld(true);
    const meshes = []; root.traverse(o => o.isMesh && meshes.push(o));
    const m4 = new THREE.Matrix4();
    const part = (mesh, i) => {
      if (!mesh) return null;
      const inst = mesh.isInstancedMesh, p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
      if (inst) mesh.getMatrixAt(i, m4); else m4.copy(mesh.matrix);
      m4.decompose(p, q, s);
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const world = inst ? m4.clone().premultiply(mesh.matrixWorld) : mesh.matrixWorld;
      return { p, q, s, p0: p.clone(), s0: s.clone(), geo: mesh.geometry.boundingBox,
        box: mesh.geometry.boundingBox.clone().applyMatrix4(world),
        apply() { if (inst) { mesh.setMatrixAt(i, m4.compose(p, q, s)); mesh.instanceMatrix.needsUpdate = true; } else { mesh.position.copy(p); mesh.scale.copy(s); } } };
    };
    for (const mesh of meshes) {
      const m = mesh.name.match(/^(.*)_blind(\d+)$/); if (!m) continue;
      const find = kind => meshes.find(o => o.name.startsWith(`${m[1]}_${kind}${m[2]}`));
      const bar = find('bar'), cass = find('cass'), glass = find('glass');
      for (let i = 0; i < (mesh.isInstancedMesh ? mesh.count : 1); i++) {
        const b = { fabric: part(mesh, i), bar: part(bar, i), u: 0, anim: null };
        b.box = [b.bar, part(cass, i), part(glass, i)].reduce((box, x) => (x ? box.union(x.box) : box), b.fabric.box.clone()).expandByScalar(0.02);
        b.click = () => { const up = b.anim ? b.anim.to < 0.5 : b.u < 0.5; setBlind(b, up); onBlind?.(blinds.indexOf(b), up); };
        blinds.push(b);
      }
    }
  }
  const ROLLED = 0.03;   // fabric left showing under the cassette when fully up
  function poseBlind(b) {
    const f = b.fabric, k = 1 - b.u * (1 - ROLLED);
    const lift = (f.geo.max.y - f.geo.min.y) * f.s0.y * (1 - k);   // how far the bottom edge has risen
    f.s.y = f.s0.y * k; f.p.y = f.p0.y + f.geo.max.y * f.s0.y * (1 - k); f.apply();   // top edge stays put
    if (b.bar) { b.bar.p.y = b.bar.p0.y + lift; b.bar.apply(); }
  }
  function setBlind(b, up) {
    const to = up ? 1 : 0;
    b.anim = { t0: performance.now(), from: b.u, to, ms: Math.max(250, 1200 * Math.abs(to - b.u)) };
    if (!autoRender) { b.u = to; b.anim = null; poseBlind(b); }
  }
  function stepBlinds(now) {
    for (const b of blinds) {
      if (!b.anim) continue;
      const k = Math.min(1, (now - b.anim.t0) / b.anim.ms), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      b.u = b.anim.from + (b.anim.to - b.anim.from) * e; poseBlind(b);
      if (k >= 1) b.anim = null;
    }
  }

  // ---- air purifier: click to start a slow continuous turn about its upright axis, click again to stop ----
  // Its parts sit on the purifier's local Y axis, so a pivot at its origin turns it in place;
  // the floor plate (Cube012) and foot (Circle) stay put.
  const purifiers = [];
  root.traverse(o => o.name === 'Air_Purifier' && purifiers.push(o));
  const spins = purifiers.map((ap, i) => {
    const pivot = new THREE.Group();
    for (const c of [...ap.children]) if (!/^(Circle|Cube012)$/.test(c.name)) pivot.add(c);
    ap.add(pivot);
    const s = { pivot, box: new THREE.Box3().setFromObject(ap).expandByScalar(0.02), on: false, speed: 0 };
    s.click = () => { s.on = !s.on; onPurifier?.(i, s.on); };
    return s;
  });
  const SPIN = (Math.PI * 2) / 12;   // rad/s: one turn every 12 s
  let lastSpin = 0;
  function stepSpins(now) {
    const dt = lastSpin ? Math.min(0.1, (now - lastSpin) / 1000) : 0; lastSpin = now;
    for (const s of spins) {
      s.speed += ((s.on ? SPIN : 0) - s.speed) * Math.min(1, dt * 3);   // ease up to speed, ease down to a stop
      if (!s.on && s.speed < 1e-3) s.speed = 0;
      s.pivot.rotation.y = (s.pivot.rotation.y + s.speed * dt) % (Math.PI * 2);
    }
  }

  // ---- shared by chairs, laptops and the door ----
  // Instanced furniture: each part is its own InstancedMesh holding one instance per copy of the model.
  // Instanced nodes sit at the origin, unrotated, so a part's instance matrix is its world matrix.
  const instanced = []; root.traverse(o => o.isInstancedMesh && instanced.push(o));
  instanced.forEach(m => m.geometry.boundingBox || m.geometry.computeBoundingBox());
  const m4 = new THREE.Matrix4(), v3 = new THREE.Vector3();
  const worldAt = (m, k, out = new THREE.Matrix4()) => { m.getMatrixAt(k, out); return out.premultiply(m.matrixWorld); };
  const centreAt = (m, k) => m.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(worldAt(m, k, m4));
  // Split every InstancedMesh with `seed`'s count among seed's instances: a mesh joins when each of its
  // instances lies within `radius` (horizontally) of a different seed instance. -> one part list per copy.
  function instanceSets(seed, radius) {
    const N = seed.count, at = [...Array(N)].map((_, k) => centreAt(seed, k)), sets = at.map(() => []);
    for (const m of instanced) {
      if (m.count !== N) continue;
      const owner = [];
      for (let k = 0; k < N; k++) {
        const c = centreAt(m, k); let best = -1, bd = radius;
        at.forEach((a, j) => { const d = Math.hypot(a.x - c.x, a.z - c.z); if (d < bd) { bd = d; best = j; } });
        owner.push(best);
      }
      if (owner.includes(-1) || new Set(owner).size !== N) continue;   // belongs to some other model
      owner.forEach((j, k) => sets[j].push({ mesh: m, k, m0: worldAt(m, k) }));
    }
    return sets;
  }
  const partsBox = parts => parts.reduce((b, p) => b.union(p.mesh.geometry.boundingBox.clone().applyMatrix4(p.m0)), new THREE.Box3());
  const partsPoints = parts => {   // every 3rd vertex, in world space
    const pts = [];
    for (const p of parts) {
      const a = p.mesh.geometry.attributes.position;
      for (let i = 0; i < a.count; i += 3) pts.push(new THREE.Vector3().fromBufferAttribute(a, i).applyMatrix4(p.m0));
    }
    return pts;
  };
  const mean = arr => arr.reduce((s, q) => s.add(q), new THREE.Vector3()).divideScalar(arr.length);
  function setPart(p, mat) {
    p.mesh.instanceMatrix.array.set(mat.elements, p.k * 16);
    p.mesh.instanceMatrix.needsUpdate = true;
    p.mesh.boundingSphere = null;   // re-fit for frustum culling
  }
  // exact hit test against an object's own parts (instanced parts or plain meshes), so a click on
  // whatever sits beside it doesn't count
  const probe = new THREE.Mesh(); probe.matrixAutoUpdate = false;
  function partsHit(parts, meshes, r) {
    let t = Infinity;
    for (const p of parts) {
      probe.geometry = p.mesh.geometry; probe.material = p.mesh.material; worldAt(p.mesh, p.k, probe.matrixWorld);
      const h = r.intersectObject(probe, false)[0]; if (h && h.distance < t) t = h.distance;
    }
    for (const h of r.intersectObjects(meshes, false)) if (h.distance < t) t = h.distance;
    return t < Infinity ? t : null;
  }
  // The export packs flat colours into palette textures, each mesh's UVs pinned on its colour's texel:
  // new geometry borrows the UV of the mesh whose material it uses.
  function paletteUV(geo, from) {
    const uv = from.geometry.attributes.uv;
    if (uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(geo.attributes.position.count).fill([uv.getX(0), uv.getY(0)]).flat(), 2));
    return geo;
  }
  // click-to-toggle with an eased 0 -> 1 run; each item has u, anim and pose()
  const easeIO = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const isOn = it => (it.anim ? it.anim.to === 1 : it.u === 1);
  function toggleTo(it, on, ms) {
    const to = on ? 1 : 0;
    it.anim = { t0: performance.now(), from: it.u, to, ms: Math.max(200, ms * Math.abs(to - it.u)) };
    if (!autoRender) { it.u = to; it.anim = null; it.pose(); }
  }
  function stepToggles(list, now) {
    for (const it of list) {
      if (!it.anim) continue;
      const k = Math.min(1, (now - it.anim.t0) / it.anim.ms);
      it.u = it.anim.from + (it.anim.to - it.anim.from) * easeIO(k); it.pose();
      if (k >= 1) it.anim = null;
    }
  }

  // ---- chairs: click a chair to slide it out from its desk / table, click again to push it back in ----
  // A seed part names each chair model. The top of the backrest leans away from the desk, so
  // base -> backrest top is the way the chair slides out.
  const CHAIR_SEEDS = ['Cylinder105', 'Plane030'];   // mesh-back desk chair: base hub; meeting chair: shell
  const PULL = 0.35;                                 // metres a chair slides out
  const chairs = [];
  {
    let room = null; root.traverse(o => o.name === 'Floor' && (room = new THREE.Box3().setFromObject(o)));
    for (const seedName of CHAIR_SEEDS) {
      const seed = instanced.find(m => m.name === seedName); if (!seed) continue;
      for (const parts of instanceSets(seed, 0.45)) {
        const box = partsBox(parts), pts = partsPoints(parts);
        const top = mean(pts.filter(q => q.y > box.max.y - 0.08)), base = mean(pts.filter(q => q.y < box.min.y + 0.12));
        const dir = new THREE.Vector3(top.x - base.x, 0, top.z - base.z).normalize();
        // don't slide through the room's outer walls
        let pull = PULL;
        if (room) for (const ax of ['x', 'z']) {
          if (dir[ax] > 1e-3) pull = Math.min(pull, (room.max[ax] - 0.03 - box.max[ax]) / dir[ax]);
          if (dir[ax] < -1e-3) pull = Math.min(pull, (room.min[ax] + 0.03 - box.min[ax]) / dir[ax]);
        }
        const offset = dir.multiplyScalar(Math.max(0, pull));
        const ch = { parts, offset, u: 0, anim: null, box: box.clone().union(box.clone().translate(offset)) };
        ch.pose = () => { for (const p of parts) setPart(p, m4.copy(p.m0).setPosition(v3.setFromMatrixPosition(p.m0).addScaledVector(offset, ch.u))); };
        ch.click = () => { const out = !isOn(ch); toggleTo(ch, out, 700); onChair?.(chairs.indexOf(ch), out); };
        ch.hit = r => partsHit(parts, [], r);
        chairs.push(ch);
      }
    }
  }

  // ---- laptops: click a laptop to fold its lid shut, click again to open it ----
  // The lid of each laptop model is one multi-part node (named here by its first part); the rest of the
  // laptop is whatever instanced parts sit on the same spot. Shut, the lid lies screen-down on the
  // keyboard deck with its back flush over the base's back edge. The whole motion is one rigid turn about
  // a single fixed hinge line, solved so that it lands exactly there: nothing slides or lifts on the way.
  const LAPTOP_LIDS = ['Cube078', 'Cube026'];   // desk laptops, meeting-table laptops
  const laptops = [];
  for (const lidName of LAPTOP_LIDS) {
    const first = instanced.find(m => m.name === lidName); if (!first) continue;
    const lidMeshes = first.parent === root ? [first] : first.parent.children.filter(c => c.isInstancedMesh);
    for (const parts of instanceSets(first, 0.25)) {
      const lid = parts.filter(p => lidMeshes.includes(p.mesh)), body = parts.filter(p => !lidMeshes.includes(p.mesh));
      const lp = partsPoints(lid), bp = partsPoints(body);
      // box centres, not vertex means: the meshes' vertices are bunched unevenly along the lid
      const mid = arr => new THREE.Box3().setFromPoints(arr).getCenter(new THREE.Vector3());
      const lo = Math.min(...lp.map(q => q.y)), hi = Math.max(...lp.map(q => q.y));
      const bottom = lp.filter(q => q.y < lo + 0.004);
      const toKeys = mid(bp).sub(mid(bottom)).setY(0).normalize();         // across the keyboard, level
      const axis = new THREE.Vector3().crossVectors(toKeys, new THREE.Vector3(0, 1, 0));   // along the hinge
      const up = mid(lp.filter(q => q.y > hi - 0.01)).sub(mid(bottom));
      up.addScaledVector(axis, -up.dot(axis)).normalize();
      const shut = new THREE.Quaternion().setFromUnitVectors(up, toKeys); // open -> shut, about the hinge line
      // Fold forward about the screen's bottom edge (where a real hinge line runs), so the back of the lid
      // rises over the base instead of dipping into it; then sit the screen face on the deck.
      const edgeS = Math.max(...bottom.map(q => q.dot(toKeys)));
      const edge = mid(bottom); edge.addScaledVector(toKeys, edgeS - edge.dot(toKeys)); edge.y = lo;
      const deck = Math.max(...bp.map(q => q.y));
      const shutLow = Math.min(...lp.map(q => q.clone().sub(edge).applyQuaternion(shut).y)) + edge.y;
      const rise = deck + 0.0008 - shutLow;
      // turn-about-edge then rise == one turn about a fixed point P: (R - I)(P - edge) = -rise·up,
      // solved in the plane square to the hinge (basis toKeys, up)
      const Rk = toKeys.clone().applyQuaternion(shut), Ry = new THREE.Vector3(0, 1, 0).applyQuaternion(shut);
      const a11 = Rk.dot(toKeys) - 1, a12 = Ry.dot(toKeys), a21 = Rk.y, a22 = Ry.y - 1, det = a11 * a22 - a12 * a21;
      const ds = (a12 * rise) / det, dy = (-a11 * rise) / det;            // Cramer's rule for rhs (0, -rise)
      const hinge = edge.clone().addScaledVector(toKeys, ds); hinge.y += dy;
      const lt = { parts, u: 0, anim: null, box: partsBox(parts).expandByScalar(0.01) };
      const q = new THREE.Quaternion(), pivot = new THREE.Matrix4(), turn = new THREE.Matrix4(), back = new THREE.Matrix4().makeTranslation(-hinge.x, -hinge.y, -hinge.z);
      lt.pose = () => {
        q.identity().slerp(shut, lt.u);
        pivot.makeTranslation(hinge.x, hinge.y, hinge.z).multiply(turn.makeRotationFromQuaternion(q)).multiply(back);
        for (const p of lid) setPart(p, m4.multiplyMatrices(pivot, p.m0));
      };
      lt.click = () => { const shutNow = !isOn(lt); toggleTo(lt, shutNow, 900); onLaptop?.(laptops.indexOf(lt), !shutNow); };
      lt.hit = r => partsHit(parts, [], r);
      laptops.push(lt);
    }
  }

  // ---- desk pedestals: click a drawer to slide it out, click again to close it ----
  // Each storage unit at the end of a desk pair is one instanced model with a pedestal at both ends
  // (its depth runs along the model's local x), each pedestal a small top drawer with a fingerprint
  // lock over a deep bottom drawer. The export merged both ends into each mesh, so the drawer meshes
  // are split at the unit's middle into a -x and a +x half; every drawer then moves on its own.
  const DRAWER_TOP = ['Plane044', 'Plane039', 'Plane039_1'];   // top drawer tray, lock reader, lock bezel
  const DRAWER_LOW = ['Plane037'];                             // bottom drawer front (Plane040 above it is the case's shelf)
  const DRAWER_OUT = 0.38;                                     // metres a drawer slides out
  const drawers = [];
  {
    const byName = n => instanced.find(m => m.name === n);
    const halves = new Map();   // mesh -> [-x half, +x half]
    const split = mesh => {
      const g = mesh.geometry, pos = g.attributes.position, idx = g.index, mid = (g.boundingBox.min.x + g.boundingBox.max.x) / 2;
      const lists = [[], []];
      for (let i = 0; i < (idx ? idx.count : pos.count); i += 3) {
        const t = [0, 1, 2].map(j => (idx ? idx.getX(i + j) : i + j));
        lists[(pos.getX(t[0]) + pos.getX(t[1]) + pos.getX(t[2])) / 3 < mid ? 0 : 1].push(...t);
      }
      const out = lists.map((list, s) => {
        const h = new THREE.InstancedMesh(g.clone().setIndex(list), mesh.material, mesh.count);
        h.name = `${mesh.name}_${s ? 'px' : 'nx'}`; h.castShadow = mesh.castShadow; h.receiveShadow = mesh.receiveShadow;
        h.instanceMatrix.array.set(mesh.instanceMatrix.array); h.geometry.computeBoundingBox();
        mesh.parent.add(h); return h;
      });
      mesh.removeFromParent(); halves.set(mesh, out);
      return out;
    };
    const top = DRAWER_TOP.map(byName), low = DRAWER_LOW.map(byName);
    if (top[0] && low[0] && [...top, ...low].every(m => m && m.count === top[0].count)) {
      // the bottom drawers are only fronts in the model: give each a tray behind it, in the front's
      // own local space (front faces at x = ±1, unit centre at x = 0), so it travels with it
      const fb = low[0].geometry.boundingBox, T = 0.025;
      const tray = s => {
        const x0 = s * 0.06, x1 = s * (fb.max.x - 0.04), cx = (x0 + x1) / 2, d = Math.abs(x1 - x0);
        const y0 = fb.min.y + 0.05, y1 = fb.max.y - 0.16, w = (fb.max.z - fb.min.z) - 0.06;
        const panel = (sx, sy, sz, x, y, z) => new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z);
        const geo = mergeGeometries([
          panel(d, T, w, cx, y0, 0),                                      // floor
          panel(d, y1 - y0, T, cx, (y0 + y1) / 2, -w / 2), panel(d, y1 - y0, T, cx, (y0 + y1) / 2, w / 2),   // sides
          panel(T, y1 - y0, w, x0, (y0 + y1) / 2, 0),                     // back
        ]);
        const m = new THREE.InstancedMesh(paletteUV(geo, top[0]), top[0].material, low[0].count);
        m.instanceMatrix.array.set(low[0].instanceMatrix.array); m.castShadow = m.receiveShadow = true;
        m.geometry.computeBoundingBox(); root.add(m); return m;
      };
      const topH = top.map(split), lowH = low.map(split), trays = [tray(-1), tray(1)];
      const q = new THREE.Quaternion();
      for (let k = 0; k < top[0].count; k++) {
        worldAt(top[0], k, m4).decompose(v3, q, new THREE.Vector3());
        for (const s of [0, 1]) {
          const out = new THREE.Vector3(s ? 1 : -1, 0, 0).applyQuaternion(q).setY(0).normalize().multiplyScalar(DRAWER_OUT);
          for (const meshes of [topH.map(h => h[s]), [...lowH.map(h => h[s]), trays[s]]]) {
            const parts = meshes.map(mesh => ({ mesh, k, m0: worldAt(mesh, k) }));
            const box = partsBox(parts);
            const dr = { parts, u: 0, anim: null, box: box.clone().union(box.clone().translate(out)) };
            dr.pose = () => { for (const p of parts) setPart(p, m4.copy(p.m0).setPosition(v3.setFromMatrixPosition(p.m0).addScaledVector(out, dr.u))); };
            dr.click = () => { const open = !isOn(dr); toggleTo(dr, open, 600); onDrawer?.(drawers.indexOf(dr), open); };
            dr.hit = r => partsHit(parts, [], r);
            drawers.push(dr);
          }
        }
      }
    }
  }

  // ---- meeting-room glass door: fills the opening in the front partition, click to swing it open / shut ----
  // Sized from the scene: between the two posts either side of the glass header, floor to header.
  const doors = [];
  {
    let header = null, posts = null, rail = null, band = null;
    root.traverse(o => {
      if (o.name === 'GDoorHeader') header = o; if (o.name === 'GPostF0') posts = o;
      if (o.name === 'GRailBotF') rail = o; if (o.name === 'GBandF') band = o;
    });
    if (header && posts) {
      const hb = new THREE.Box3().setFromObject(header), z = (hb.min.z + hb.max.z) / 2;
      const pb = [...Array(posts.count)].map((_, k) => posts.geometry.boundingBox.clone().applyMatrix4(worldAt(posts, k)));
      const near = (x, side) => pb.filter(b => b.min.z < z && b.max.z > z).sort((a, b) => Math.abs(a[side].x - x) - Math.abs(b[side].x - x))[0];
      const x0 = near(hb.min.x, 'max').max.x + 0.008, x1 = near(hb.max.x, 'min').min.x - 0.008;   // 8 mm reveals
      const W = x1 - x0, H = hb.min.y - 0.01, T = 0.012;
      const door = new THREE.Group();
      door.position.set(x1, 0, z);                      // hinged on the corner-post side
      const add = (geo, from, x, y, zz = 0) => {
        const m = new THREE.Mesh(paletteUV(geo, from), from.material); m.position.set(x, y, zz);
        m.castShadow = !from.material.transparent; m.receiveShadow = true; door.add(m); return m;
      };
      const glass = header, metal = rail ?? posts;
      add(new THREE.BoxGeometry(W, H - 0.06, T), glass, -W / 2, 0.06 + (H - 0.06) / 2);    // glass leaf
      add(new THREE.BoxGeometry(W, 0.06, 0.034), metal, -W / 2, 0.03 + 0.004);             // bottom shoe, like the partition's rail
      add(new THREE.BoxGeometry(W, 0.03, 0.026), metal, -W / 2, H - 0.015);                // top rail
      if (band) add(new THREE.BoxGeometry(W, 0.12, T + 0.004), band, -W / 2, 1.2);         // manifestation band, as on the panes
      for (const s of [1, -1]) {                                                              // pull handle, both faces
        add(new THREE.CylinderGeometry(0.011, 0.011, 0.9, 16), metal, -W + 0.09, 1.05, s * 0.055);
        for (const y of [0.68, 1.42]) add(new THREE.CylinderGeometry(0.007, 0.007, 0.05, 12).rotateX(Math.PI / 2), metal, -W + 0.09, y, s * 0.031);
      }
      root.add(door);
      door.updateMatrixWorld(true);
      const meshes = door.children;
      // swings into the meeting room towards its side glass, stopping 5° short so the room-side handle clears it
      const OPEN = THREE.MathUtils.degToRad(85);
      const d = { u: 0, anim: null, door, box: new THREE.Box3().setFromObject(door).union(new THREE.Box3(new THREE.Vector3(x1 - 0.2, 0, z - W - 0.1), new THREE.Vector3(x1 + 0.1, H, z))) };
      d.pose = () => { door.rotation.y = -OPEN * d.u; };
      d.click = () => { const open = !isOn(d); toggleTo(d, open, 1100); onDoor?.(open); };
      d.hit = r => partsHit([], meshes, r);
      doors.push(d);
    }
  }

  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), hitPt = new THREE.Vector3();
  const clickables = [...(lampClicks ? lamps : []), ...(blindClicks ? blinds : []), ...(purifierClicks ? spins : []), ...(chairClicks ? chairs : []), ...(laptopClicks ? laptops : []), ...(drawerClicks ? drawers : []), ...(doorClicks ? doors : [])];
  function pickAt(x, y) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    let best = null, bestT = Infinity;
    for (const l of clickables) if (ray.ray.intersectBox(l.box, hitPt)) {
      const t = l.hit ? l.hit(ray) : hitPt.distanceTo(ray.ray.origin);
      if (t != null && t < bestT) { bestT = t; best = l; }
    }
    return best;
  }
  if (clickables.length) {
    const el = renderer.domElement; let down = null;
    el.addEventListener('pointermove', e => { if (!down) el.style.cursor = pickAt(e.clientX, e.clientY) ? 'pointer' : ''; });
    el.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', e => {
      if (!down) return; const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
      if (moved > 6) return;                               // that was an orbit drag, not a click
      pickAt(e.clientX, e.clientY)?.click();
    });
  }

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
    rig.point.forEach(p => (p.light.intensity = p.on ? p.base * L(1, NIGHT.lamp) : 0));
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
      stepBlinds(now);
      stepSpins(now);
      stepToggles(chairs, now); stepToggles(laptops, now); stepToggles(drawers, now); stepToggles(doors, now);
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
    lamps: { count: lamps.length, isOn: i => lamps[i]?.p.on, toggle(i) { const l = lamps[i]; if (l) setLamp(l.p, !l.p.on); return l?.p.on; }, setAll(on) { lamps.forEach(l => setLamp(l.p, on)); } },
    blinds: { count: blinds.length, isUp: i => (blinds[i]?.anim ? blinds[i].anim.to === 1 : blinds[i]?.u === 1), set(i, up) { if (blinds[i]) setBlind(blinds[i], up); }, toggle(i) { blinds[i]?.click(); }, setAll(up) { blinds.forEach(b => setBlind(b, up)); } },
    purifiers: { count: spins.length, isTurning: i => !!spins[i]?.on, set(i, on) { if (spins[i]) spins[i].on = on; }, toggle(i) { spins[i]?.click(); } },
    chairs: { count: chairs.length, isOut: i => !!chairs[i] && isOn(chairs[i]), set(i, out) { if (chairs[i]) toggleTo(chairs[i], out, 700); }, toggle(i) { chairs[i]?.click(); }, setAll(out) { chairs.forEach(c => toggleTo(c, out, 700)); } },
    laptops: { count: laptops.length, isOpen: i => !!laptops[i] && !isOn(laptops[i]), set(i, open) { if (laptops[i]) toggleTo(laptops[i], !open, 900); }, toggle(i) { laptops[i]?.click(); }, setAll(open) { laptops.forEach(l => toggleTo(l, !open, 900)); } },
    drawers: { count: drawers.length, isOpen: i => !!drawers[i] && isOn(drawers[i]), set(i, open) { if (drawers[i]) toggleTo(drawers[i], open, 600); }, toggle(i) { drawers[i]?.click(); }, setAll(open) { drawers.forEach(d => toggleTo(d, open, 600)); } },
    door: { exists: doors.length > 0, get isOpen() { return !!doors[0] && isOn(doors[0]); }, set(open) { if (doors[0]) toggleTo(doors[0], open, 1100); }, toggle() { doors[0]?.click(); } },
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
