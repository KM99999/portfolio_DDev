// =====================================================================
//  3D BACKGROUND
//  An ambient three.js scene sitting behind every section, in three parts:
//
//    1. Chains  - short runs of connected bars (4-8 per chain), scattered
//                 sparsely across the upper part of the view. Each chain
//                 tumbles as one linked piece, never as loose sticks.
//    2. Grid    - a wavy wireframe mesh across the bottom, receding toward
//                 a horizon, which is what gives the page its sense of depth.
//    3. Dust    - a light scatter of points tying the two together.
//
//  Everything reacts to pointer movement (parallax + tilt), clicks (a
//  travelling shockwave) and scroll position, and keeps rendering while a
//  project modal is open so the scene stays alive behind the overlay.
//
//  Colours come from the CSS custom properties in styles.css, so the scene
//  re-tints itself whenever the light/dark toggle flips.
//  Tweak the feel with CONFIG below.
// =====================================================================

import * as THREE from 'three';

const CONFIG = {
  // --- chains of connected bars, kept sparse and high ---
  chains:         16,        // how many linked runs
  chainNodes: [5, 9],        // nodes per chain -> 4 to 8 connected bars
  barLen:     [4, 9],        // length of one bar in a chain
  topBand:    [2, 42],       // y range the chains live in (upper part of view)

  // --- wireframe mesh across the bottom ---
  grid: {
    width: 200, cols: 42,    // side to side
    zNear: 26, zFar: -95, rows: 30,   // toward the horizon
    y: -30,                  // height: sits below the content
    waveAmp: 3.6, waveSpeed: 0.5,
  },

  dust:          900,        // ambient points
  spread: { x: 78, y: 48, zNear: 22, zFar: -38 },

  cameraZ:        62,
  parallax:        9,        // how far the camera drifts with the pointer
  tilt:         0.20,        // how far the scene leans toward the pointer
  drift:        0.16,        // idle translation speed
  tumble:       0.10,        // idle chain rotation speed
  scrollTurn:   0.25,        // radians of rotation across the whole page
  pulseDuration: 1.15,       // seconds for a click shockwave to travel out
  pulseReach:      70,       // world units the shockwave ring travels
};

const canvas = document.getElementById('bg-canvas');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function supportsWebGL() {
  try {
    return !!document.createElement('canvas').getContext('webgl2')
        || !!document.createElement('canvas').getContext('webgl');
  } catch { return false; }
}

// Read an accent colour out of the stylesheet so the scene follows the theme.
function cssColor(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  try { return new THREE.Color(raw || fallback); }
  catch { return new THREE.Color(fallback); }
}

const rand = (a, b) => a + Math.random() * (b - a);

// Shared GLSL: idle drift plus the click shockwave, so every layer displaces
// itself the same way and the scene reads as one volume.
const COMMON_GLSL = `
  uniform float uTime, uPulse, uPulseRadius, uFadeNear, uFadeFar;
  uniform vec3  uPulseOrigin;

  vec3 drift(vec3 p, float seed, float amount) {
    float t = uTime * amount + seed * 6.2831;
    return p + vec3(sin(t) * 1.7, cos(t * 0.85) * 1.5, sin(t * 0.62) * 1.2);
  }

  // A ring expanding from the click point shoves everything it passes.
  float shock(inout vec3 p) {
    float d    = distance(p, uPulseOrigin);
    float ring = exp(-pow((d - uPulseRadius) * 0.14, 2.0));
    p += normalize(p - uPulseOrigin + 0.0001) * ring * uPulse * 7.0;
    return ring;
  }
`;

function init() {
  const isLight = () => document.documentElement.getAttribute('data-theme') === 'light';

  // ---------- renderer / scene / camera ----------
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,                 // let the page background show through
    antialias: window.devicePixelRatio < 2,
    powerPreference: 'high-performance',
  });
  renderer.setClearAlpha(0);

  const scene  = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 260);
  camera.position.set(0, 0, CONFIG.cameraZ);

  const small = window.innerWidth < 760;
  const nChains = small ? Math.round(CONFIG.chains * 0.6) : CONFIG.chains;
  const nDust   = small ? Math.round(CONFIG.dust * 0.5)   : CONFIG.dust;

  // Everything lives in this group, so pointer tilt and scroll rotation
  // apply to the whole volume at once and it stays visually coherent.
  const group = new THREE.Group();
  scene.add(group);

  const chains = buildChains(nChains);
  const grid   = buildGrid();
  const dust   = buildDust(nDust);
  group.add(chains, grid, dust);

  // Uniforms shared by every material, so one write drives the whole scene.
  const shared = {
    uTime:        { value: 0 },
    uRotTime:     { value: 0 },
    uPulse:       { value: 0 },
    uPulseRadius: { value: 0 },
    uPulseOrigin: { value: new THREE.Vector3() },
    uFadeNear:    { value: 24 },
    uFadeFar:     { value: 190 },
  };
  for (const o of [chains, grid, dust]) Object.assign(o.material.uniforms, shared);

  // ---------- chains of connected bars ----------
  // A chain is a short random walk. Every vertex in it carries the SAME
  // centre, axis and seed, so the whole run drifts and tumbles as one linked
  // piece — the bars stay joined end to end instead of floating apart.
  function buildChains(n) {
    const offset = [], centre = [], axis = [], seed = [], taper = [];

    const c    = new THREE.Vector3();
    const walk = new THREE.Vector3();
    const step = new THREE.Vector3();
    const mid  = new THREE.Vector3();

    for (let i = 0; i < n; i++) {
      const s = CONFIG.spread;
      c.set(rand(-s.x, s.x), rand(CONFIG.topBand[0], CONFIG.topBand[1]), rand(s.zFar, s.zNear));

      const ax = new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
      const sd = Math.random();
      const count = Math.round(rand(CONFIG.chainNodes[0], CONFIG.chainNodes[1]));

      // random walk -> a run of joined nodes
      const nodes = [];
      walk.set(0, 0, 0);
      for (let k = 0; k < count; k++) {
        nodes.push(walk.clone());
        step.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize()
            .multiplyScalar(rand(CONFIG.barLen[0], CONFIG.barLen[1]));
        walk.add(step);
      }

      // re-centre the walk on its own centroid so it spins about itself
      mid.set(0, 0, 0);
      for (const p of nodes) mid.add(p);
      mid.divideScalar(nodes.length);
      for (const p of nodes) p.sub(mid);

      // brightness ramps along the chain; shared node values keep it seamless
      const at = k => 0.4 + 0.6 * (k / (count - 1));

      for (let k = 0; k < count - 1; k++) {
        for (const [p, idx] of [[nodes[k], k], [nodes[k + 1], k + 1]]) {
          offset.push(p.x, p.y, p.z);
          centre.push(c.x, c.y, c.z);
          axis.push(ax.x, ax.y, ax.z);
          seed.push(sd);
          taper.push(at(idx));
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(offset, 3));
    geo.setAttribute('aCentre',  new THREE.Float32BufferAttribute(centre, 3));
    geo.setAttribute('aAxis',    new THREE.Float32BufferAttribute(axis, 3));
    geo.setAttribute('aSeed',    new THREE.Float32BufferAttribute(seed, 1));
    geo.setAttribute('aTaper',   new THREE.Float32BufferAttribute(taper, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: {
        uOpacity: { value: 0.85 },
        uColorA:  { value: new THREE.Color('#14e0c4') },
        uColorB:  { value: new THREE.Color('#b86bff') },
      },
      vertexShader: `
        ${COMMON_GLSL}
        uniform float uRotTime;
        uniform vec3  uColorA, uColorB;
        attribute vec3  aCentre, aAxis;
        attribute float aSeed, aTaper;
        varying vec3  vColor;
        varying float vAlpha;

        // Rodrigues rotation about an arbitrary axis.
        vec3 spin(vec3 v, vec3 ax, float ang) {
          float c = cos(ang), s = sin(ang);
          return v * c + cross(ax, v) * s + ax * dot(ax, v) * (1.0 - c);
        }

        void main() {
          vec3 c = drift(aCentre, aSeed, ${CONFIG.drift});
          float ring = shock(c);

          float ang = uRotTime * (0.35 + aSeed * 1.3) * ${CONFIG.tumble};
          vec3 off  = spin(position, normalize(aAxis), ang);

          vec4 mv = modelViewMatrix * vec4(c + off, 1.0);
          gl_Position = projectionMatrix * mv;

          vColor  = mix(uColorA, uColorB, aSeed) + ring * uPulse * 0.9;
          vAlpha  = smoothstep(uFadeFar, uFadeNear, -mv.z) * aTaper;
          vAlpha *= 0.75 + 0.25 * sin(uTime * 0.6 + aSeed * 14.0);
        }
      `,
      fragmentShader: `
        uniform float uOpacity;
        varying vec3  vColor;
        varying float vAlpha;
        void main() { gl_FragColor = vec4(vColor, vAlpha * uOpacity); }
      `,
    });

    return new THREE.LineSegments(geo, mat);
  }

  // ---------- wireframe mesh across the bottom ----------
  // A flat lattice laid in the XZ plane and pushed below the content. Running
  // it away from the camera to a horizon is what sells the depth; a rolling
  // sine wave in the vertex shader keeps it alive.
  function buildGrid() {
    const g = CONFIG.grid;
    const halfW = g.width / 2;
    const pos = [], fade = [], mixv = [];

    const xAt = i => -halfW + (g.width * i) / g.cols;
    const zAt = j => g.zNear - ((g.zNear - g.zFar) * j) / g.rows;

    // y is baked in rather than set via object position, so the shockwave
    // (which works in group space) lines up with the rest of the scene.
    const push = (x, z) => {
      pos.push(x, g.y, z);
      const near = 1 - (g.zNear - z) / (g.zNear - g.zFar);   // 1 near .. 0 far
      const edge = 1 - Math.min(Math.abs(x) / halfW, 1);
      fade.push(Math.pow(Math.max(near, 0), 0.85) * Math.pow(edge, 0.5));
      mixv.push((x / halfW + 1) * 0.5);
    };

    for (let j = 0; j <= g.rows; j++)          // lines running side to side
      for (let i = 0; i < g.cols; i++) { push(xAt(i), zAt(j)); push(xAt(i + 1), zAt(j)); }

    for (let i = 0; i <= g.cols; i++)          // lines running into the distance
      for (let j = 0; j < g.rows; j++) { push(xAt(i), zAt(j)); push(xAt(i), zAt(j + 1)); }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('aFade',    new THREE.Float32BufferAttribute(fade, 1));
    geo.setAttribute('aMix',     new THREE.Float32BufferAttribute(mixv, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: {
        uOpacity:   { value: 0.62 },
        uWaveAmp:   { value: g.waveAmp },
        uWaveSpeed: { value: g.waveSpeed },
        uColorA:    { value: new THREE.Color('#14e0c4') },
        uColorB:    { value: new THREE.Color('#b86bff') },
      },
      vertexShader: `
        ${COMMON_GLSL}
        uniform float uWaveAmp, uWaveSpeed;
        uniform vec3  uColorA, uColorB;
        attribute float aFade, aMix;
        varying vec3  vColor;
        varying float vAlpha;

        void main() {
          vec3 p = position;

          // two crossing waves so the surface rolls rather than pulses
          p.y += sin(p.x * 0.075 + uTime * uWaveSpeed)
               * cos(p.z * 0.095 + uTime * uWaveSpeed * 0.8) * uWaveAmp;

          float ring = shock(p);

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;

          vColor = mix(uColorA, uColorB, aMix) + ring * uPulse * 1.1;
          vAlpha = smoothstep(uFadeFar, uFadeNear, -mv.z) * aFade;
        }
      `,
      fragmentShader: `
        uniform float uOpacity;
        varying vec3  vColor;
        varying float vAlpha;
        void main() { gl_FragColor = vec4(vColor, vAlpha * uOpacity); }
      `,
    });

    return new THREE.LineSegments(geo, mat);
  }

  // ---------- ambient dust ----------
  function buildDust(n) {
    const pos   = new Float32Array(n * 3);
    const scale = new Float32Array(n);
    const mix   = new Float32Array(n);
    const seed  = new Float32Array(n);
    const s = CONFIG.spread;

    for (let i = 0; i < n; i++) {
      pos[i * 3]     = rand(-s.x, s.x);
      pos[i * 3 + 1] = rand(-s.y, s.y);
      pos[i * 3 + 2] = rand(s.zFar, s.zNear);
      scale[i] = rand(0.5, 1.8);
      mix[i]   = Math.random();
      seed[i]  = Math.random();
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aScale',   new THREE.BufferAttribute(scale, 1));
    geo.setAttribute('aMix',     new THREE.BufferAttribute(mix, 1));
    geo.setAttribute('aSeed',    new THREE.BufferAttribute(seed, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: {
        uSize:       { value: 2.5 },
        uPixelRatio: { value: 1 },
        uOpacity:    { value: 0.9 },
        uColorA:     { value: new THREE.Color('#14e0c4') },
        uColorB:     { value: new THREE.Color('#b86bff') },
      },
      vertexShader: `
        ${COMMON_GLSL}
        uniform float uSize, uPixelRatio;
        uniform vec3  uColorA, uColorB;
        attribute float aScale, aMix, aSeed;
        varying vec3  vColor;
        varying float vAlpha;

        void main() {
          vec3 pos = drift(position, aSeed, ${CONFIG.drift});
          float ring = shock(pos);

          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          gl_Position  = projectionMatrix * mv;
          gl_PointSize = uSize * aScale * uPixelRatio * (60.0 / max(-mv.z, 1.0));

          vColor  = mix(uColorA, uColorB, aMix) + ring * uPulse * 0.9;
          vAlpha  = smoothstep(uFadeFar, uFadeNear, -mv.z);
          vAlpha *= 0.62 + 0.38 * sin(uTime * 0.9 + aSeed * 20.0);
        }
      `,
      fragmentShader: `
        uniform float uOpacity;
        varying vec3  vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;                        // soft round sprite
          float glow = pow(smoothstep(0.5, 0.0, d), 2.4);
          gl_FragColor = vec4(vColor, glow * vAlpha * uOpacity);
        }
      `,
    });

    return new THREE.Points(geo, mat);
  }

  // ---------- theme ----------
  function applyTheme() {
    const light = isLight();
    const a = cssColor('--accent-1', '#14e0c4');
    const b = cssColor('--accent-2', '#b86bff');

    // Additive blending washes out on a light page, so switch to normal
    // blending and darker ink when the light theme is active.
    const blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
    const ink = c => (light ? c.clone().multiplyScalar(0.62) : c);

    for (const [o, base] of [[chains, 0.85], [grid, 0.62], [dust, 0.9]]) {
      const m = o.material;
      m.uniforms.uColorA.value.copy(ink(a));
      m.uniforms.uColorB.value.copy(ink(b));
      m.uniforms.uOpacity.value = base * (light ? 0.8 : 1);
      m.blending = blending;
      m.needsUpdate = true;
    }
  }

  applyTheme();
  new MutationObserver(applyTheme).observe(document.documentElement, {
    attributes: true, attributeFilter: ['data-theme'],
  });

  // ---------- sizing ----------
  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dust.material.uniforms.uPixelRatio.value = dpr;
  }
  resize();
  window.addEventListener('resize', resize);

  // ---------- interaction state ----------
  const pointer = { x: 0, y: 0 };            // normalised device coords
  const eased   = { x: 0, y: 0 };
  let pulseT    = -1;                         // seconds into a shockwave, -1 = idle
  let spinKick  = 0;                          // extra tumble imparted by a click
  let rotTime   = 0;                          // drives chain rotation
  let scrollN   = 0;                          // 0..1 down the page
  const pulseOrigin = new THREE.Vector3();

  if (!reduceMotion) {
    window.addEventListener('pointermove', e => {
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.y = -((e.clientY / window.innerHeight) * 2 - 1);
    }, { passive: true });

    // Fire on the window so a click anywhere, cards included, pulses.
    window.addEventListener('pointerdown', e => {
      projectToScene(e.clientX, e.clientY, pulseOrigin);
      // The shaders compare the origin against positions in the group's own
      // space, so bring the world-space click point into it.
      group.updateWorldMatrix(true, false);
      group.worldToLocal(pulseOrigin);
      pulseT = 0;
      spinKick = 4;
    }, { passive: true });

    window.addEventListener('scroll', () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      scrollN = max > 0 ? Math.min(window.scrollY / max, 1) : 0;
    }, { passive: true });
  }

  // Screen pixel -> world point on the z = 0 plane.
  function projectToScene(px, py, out) {
    const v = new THREE.Vector3(
      (px / window.innerWidth) * 2 - 1,
      -((py / window.innerHeight) * 2 - 1),
      0.5,
    ).unproject(camera);
    const dir = v.sub(camera.position).normalize();
    out.copy(camera.position).addScaledVector(dir, -camera.position.z / dir.z);
  }

  // ---------- loop ----------
  const clock = new THREE.Clock();

  // Reduced motion: draw one still frame and stop.
  if (reduceMotion) {
    shared.uTime.value = 12;
    shared.uRotTime.value = 12;
    renderer.render(scene, camera);
    window.addEventListener('resize', () => renderer.render(scene, camera));
    return;
  }

  function frame() {
    requestAnimationFrame(frame);

    // Note: deliberately no modal check here. The scene keeps drawing so it
    // stays alive behind the project detail overlay.
    if (document.hidden) { clock.getDelta(); return; }

    const dt = Math.min(clock.getDelta(), 0.05);
    const t  = clock.getElapsedTime();

    // pointer easing -> camera parallax
    eased.x += (pointer.x - eased.x) * Math.min(dt * 2.4, 1);
    eased.y += (pointer.y - eased.y) * Math.min(dt * 2.4, 1);
    camera.position.x = eased.x * CONFIG.parallax;
    camera.position.y = eased.y * CONFIG.parallax * 0.6;
    camera.position.z = CONFIG.cameraZ - scrollN * 12;
    camera.lookAt(0, 0, 0);

    // a click briefly speeds up the tumble, then settles back
    spinKick *= Math.pow(0.15, dt);
    rotTime += (1 + spinKick) * dt;

    // whole scene leans toward the pointer and turns gently as the page scrolls
    group.rotation.x += (eased.y * CONFIG.tilt - group.rotation.x) * Math.min(dt * 2, 1);
    group.rotation.y += (eased.x * CONFIG.tilt + scrollN * CONFIG.scrollTurn - group.rotation.y) * Math.min(dt * 2, 1);

    // shockwave
    if (pulseT >= 0) {
      pulseT += dt;
      const p = pulseT / CONFIG.pulseDuration;
      if (p >= 1) {
        pulseT = -1;
        shared.uPulse.value = 0;
      } else {
        shared.uPulse.value = Math.pow(1 - p, 1.6);       // fade as it travels
        shared.uPulseRadius.value = p * CONFIG.pulseReach;
        shared.uPulseOrigin.value.copy(pulseOrigin);
      }
    }

    shared.uTime.value = t;
    shared.uRotTime.value = rotTime;
    renderer.render(scene, camera);
  }

  requestAnimationFrame(frame);
}

// Kick off last: init() reads module-level consts declared above, which are
// still in the temporal dead zone earlier in this file.
if (canvas && supportsWebGL()) init();
