// =====================================================================
//  3D BACKGROUND
//  An ambient three.js scene sitting behind every section, in three parts:
//
//    1. Meteors - luminous shooting stars that fall from above and streak
//                 down into the mesh, arriving a few at a time.
//    2. Mesh    - a wavy wireframe net across the bottom, receding toward a
//                 horizon, which is what gives the page its sense of depth.
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
  // --- shooting stars falling into the mesh ---
  meteors: {
    count:        28,
    yTop:         48,        // where they enter, well above the content
    tail:    [7, 20],        // streak length
    rate: [0.05, 0.13],      // falls per second -> one every 8-20s each
    activeFrac:  0.2,        // fraction of that cycle spent falling
    drift:      0.30,        // sideways lean per unit fallen
    headSize:     9,
  },

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
// itself the same way and the scene reads as one volume. Declares uTime,
// uPulse* and uFade*, which the meteor chunk below relies on.
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

// Meteor motion, shared by the trail streaks and the glowing heads so the two
// stay locked together. Entirely time-driven, so the CPU never touches them.
const METEOR_GLSL = `
  uniform float uActiveFrac, uYTop, uYFloor;
  attribute vec3  aSpawn;
  attribute vec2  aDrift;
  attribute float aRate, aStagger, aTail, aHue;

  // Each meteor only falls for uActiveFrac of its cycle and waits out the
  // rest, so the sky stays mostly empty and streaks arrive a few at a time.
  float meteorQ(out float alive) {
    float cycle = fract(uTime * aRate + aStagger);
    alive = step(cycle, uActiveFrac);
    return clamp(cycle / uActiveFrac, 0.0, 1.0);
  }

  vec3 meteorDir() { return normalize(vec3(aDrift.x, -1.0, aDrift.y)); }

  // Head position at progress q: falls from uYTop down to the mesh, leaning
  // sideways as it goes.
  vec3 meteorHead(float q) {
    float y = mix(uYTop, uYFloor, q);
    float fallen = uYTop - y;
    return vec3(aSpawn.x + aDrift.x * fallen, y, aSpawn.z + aDrift.y * fallen);
  }

  // Bright on arrival, snuffed out as it enters the net.
  float meteorFade(float q) {
    return smoothstep(0.0, 0.06, q) * smoothstep(1.0, 0.86, q);
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
  const nMeteors = small ? Math.round(CONFIG.meteors.count * 0.6) : CONFIG.meteors.count;
  const nDust    = small ? Math.round(CONFIG.dust * 0.5)          : CONFIG.dust;

  // Everything lives in this group, so pointer tilt and scroll rotation
  // apply to the whole volume at once and it stays visually coherent.
  const group = new THREE.Group();
  scene.add(group);

  const { trails, heads } = buildMeteors(nMeteors);
  const grid = buildGrid();
  const dust = buildDust(nDust);
  group.add(grid, trails, heads, dust);

  const layers = [grid, trails, heads, dust];

  // Uniforms shared by every material, so one write drives the whole scene.
  const shared = {
    uTime:        { value: 0 },
    uPulse:       { value: 0 },
    uPulseRadius: { value: 0 },
    uPulseOrigin: { value: new THREE.Vector3() },
    uFadeNear:    { value: 24 },
    uFadeFar:     { value: 190 },
  };
  for (const o of layers) Object.assign(o.material.uniforms, shared);

  // ---------- shooting stars ----------
  // One entry per meteor, shared between a 2-vertex trail and a 1-vertex head.
  // Positions are computed in the shader, so both objects opt out of frustum
  // culling — their buffer positions are only placeholders.
  function buildMeteors(n) {
    const M = CONFIG.meteors;
    // Two vertex buffers: the trail (2 verts per meteor) and the head (1).
    const T = { pos: [], spawn: [], drift: [], rate: [], stagger: [], tail: [], hue: [], end: [] };
    const H = { pos: [], spawn: [], drift: [], rate: [], stagger: [], tail: [], hue: [] };

    for (let i = 0; i < n; i++) {
      const s = CONFIG.spread;
      const sx = rand(-s.x, s.x), sz = rand(s.zFar, s.zNear);
      const dx = rand(-M.drift, M.drift), dz = rand(-M.drift, M.drift) * 0.5;
      const rt = rand(M.rate[0], M.rate[1]);
      const st = Math.random();
      const tl = rand(M.tail[0], M.tail[1]);
      const hu = Math.random();

      // every vertex of one meteor gets identical parameters, so the trail
      // and its head resolve to exactly the same position each frame
      const put = o => {
        o.pos.push(sx, M.yTop, sz);            // placeholder; shader positions it
        o.spawn.push(sx, M.yTop, sz);
        o.drift.push(dx, dz);
        o.rate.push(rt); o.stagger.push(st); o.tail.push(tl); o.hue.push(hu);
      };

      put(T); T.end.push(0);                   // trail: tail vertex
      put(T); T.end.push(1);                   // trail: head vertex
      put(H);                                  // glowing head
    }

    function geom(src, extra = []) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(src.pos, 3));
      g.setAttribute('aSpawn',   new THREE.Float32BufferAttribute(src.spawn, 3));
      g.setAttribute('aDrift',   new THREE.Float32BufferAttribute(src.drift, 2));
      g.setAttribute('aRate',    new THREE.Float32BufferAttribute(src.rate, 1));
      g.setAttribute('aStagger', new THREE.Float32BufferAttribute(src.stagger, 1));
      g.setAttribute('aTail',    new THREE.Float32BufferAttribute(src.tail, 1));
      g.setAttribute('aHue',     new THREE.Float32BufferAttribute(src.hue, 1));
      for (const [name, data, size] of extra) {
        g.setAttribute(name, new THREE.Float32BufferAttribute(data, size));
      }
      return g;
    }

    const trailGeo = geom(T, [['aEnd', T.end, 1]]);
    const headGeo  = geom(H);

    const common = {
      uActiveFrac: { value: M.activeFrac },
      uYTop:       { value: M.yTop },
      uYFloor:     { value: CONFIG.grid.y + 1 },
      uColorA:     { value: new THREE.Color('#14e0c4') },
      uColorB:     { value: new THREE.Color('#b86bff') },
    };

    const trailMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { ...common, uOpacity: { value: 0.95 } },
      vertexShader: `
        ${COMMON_GLSL}
        ${METEOR_GLSL}
        uniform vec3 uColorA, uColorB;
        attribute float aEnd;
        varying vec3  vColor;
        varying float vAlpha;

        void main() {
          float alive;
          float q = meteorQ(alive);
          // tail trails behind the head, along the direction of travel
          vec3 pos = meteorHead(q) - meteorDir() * aTail * (1.0 - aEnd);

          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mv;

          vColor = mix(uColorA, uColorB, aHue) + aEnd * 0.95;   // hot at the head
          vAlpha = pow(aEnd, 1.1) * meteorFade(q) * alive
                 * smoothstep(uFadeFar, uFadeNear, -mv.z);
        }
      `,
      fragmentShader: `
        uniform float uOpacity;
        varying vec3  vColor;
        varying float vAlpha;
        void main() { gl_FragColor = vec4(vColor, vAlpha * uOpacity); }
      `,
    });

    const headMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: {
        ...common,
        uOpacity:    { value: 1 },
        uSize:       { value: M.headSize },
        uPixelRatio: { value: 1 },
      },
      vertexShader: `
        ${COMMON_GLSL}
        ${METEOR_GLSL}
        uniform float uSize, uPixelRatio;
        uniform vec3  uColorA, uColorB;
        varying vec3  vColor;
        varying float vAlpha;

        void main() {
          float alive;
          float q = meteorQ(alive);
          vec4 mv = modelViewMatrix * vec4(meteorHead(q), 1.0);
          gl_Position  = projectionMatrix * mv;
          gl_PointSize = uSize * uPixelRatio * (60.0 / max(-mv.z, 1.0));

          vColor = mix(uColorA, uColorB, aHue) + 0.85;          // white-hot core
          vAlpha = meteorFade(q) * alive * smoothstep(uFadeFar, uFadeNear, -mv.z);
        }
      `,
      fragmentShader: `
        uniform float uOpacity;
        varying vec3  vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;
          float glow = pow(smoothstep(0.5, 0.0, d), 1.7) + pow(smoothstep(0.16, 0.0, d), 1.0) * 0.8;
          gl_FragColor = vec4(vColor, glow * vAlpha * uOpacity);
        }
      `,
    });

    const trailsObj = new THREE.LineSegments(trailGeo, trailMat);
    const headsObj  = new THREE.Points(headGeo, headMat);
    trailsObj.frustumCulled = false;
    headsObj.frustumCulled  = false;
    return { trails: trailsObj, heads: headsObj };
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

    for (const [o, base] of [[grid, 0.62], [trails, 0.95], [heads, 1], [dust, 0.9]]) {
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
    heads.material.uniforms.uPixelRatio.value = dpr;
  }
  resize();
  window.addEventListener('resize', resize);

  // ---------- interaction state ----------
  const pointer = { x: 0, y: 0 };            // normalised device coords
  const eased   = { x: 0, y: 0 };
  let pulseT    = -1;                         // seconds into a shockwave, -1 = idle
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
    renderer.render(scene, camera);
  }

  requestAnimationFrame(frame);
}

// Kick off last: init() reads module-level consts declared above, which are
// still in the temporal dead zone earlier in this file.
if (canvas && supportsWebGL()) init();
