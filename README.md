# 3D Space

An interactive 3D office, built in Blender and rendered in the browser with three.js.

- Toggle the camera between the Blender isometric view and a 55 mm perspective lens.
- Jump between areas (Overview, Meeting room, Workstations, Reception).
- Switch between day and night lighting.
- Click a desk lamp to switch it on / off, a window to roll its blind up / down, a chair to slide it out from its desk, a laptop to close its lid, a desk-pedestal drawer to open it, the meeting-room glass door to open it, or the air purifier to set it turning (click again to undo each).

## Run locally

The page loads `office.glb` with `fetch`, so it needs a web server (opening the file directly won't work):

```bash
npx serve .
```

## Use on your own page

```html
<script type="importmap">
{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/" } }
</script>
<div id="app" style="position:fixed;inset:0"></div>
<script type="module">
  import { mountOffice } from './office-scene.js';
  const view = await mountOffice(document.getElementById('app'), { glb: './office.glb', params: './scene.json' });
  // view.setView('persp'); view.focusZone('Meeting room'); view.setNight(true); view.resetView(true);
</script>
```

## Files

| File | Purpose |
|---|---|
| `office.glb` | The scene geometry and textures (meshopt-compressed, WebP textures) |
| `scene.json` | Camera, lights, exposure and clickable objects, exported from Blender |
| `office-scene.js` | three.js viewer module (`mountOffice`) |
| `index.html` | Demo page with the full UI |
