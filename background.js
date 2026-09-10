// =====================================================================
//  3D BACKGROUND
//  An ambient three.js scene that sits behind every section: a field of
//  drifting points threaded with free-floating line segments, spread
//  evenly across the whole viewport rather than clustered in the middle.
//
//  It reacts to pointer movement (parallax + tilt), clicks (a travelling
//  shockwave) and scroll position (rotation + dolly). It keeps rendering
//  while a project modal is open, so the scene stays behind the overlay.
//
//  Colours are read from the CSS custom properties in styles.css, so the
//  scene re-tints itself whenever the light/dark toggle flips.
//  Tweak the feel with CONFIG below.
// =====================================================================

import * as THREE from 'three';

const CONFIG = {
  points:        2400,   // glowing dots; scaled down on small screens
  segments:       320,   // free-floating line segments
  segmentLen: [4, 11],   // min/max length of a segment
  spread:  { x: 78, y: 48, zNear: 22, zFar: -38 },  // volume everything fills
  cameraZ:         62,
  parallax:         9,   // how far the camera drifts with the pointer
  tilt:          0.24,   // how far the field leans toward the pointer
  drift:         0.16,   // idle translation speed
  tumble:        0.10,   // idle per-segment rotation speed
  scrollTurn:    0.35,   // radians of rotation across the whole page
  pulseDuration: 1.15,   // seconds for a click shockwave to travel out
  pulseReach:      64,   // world units the shockwave ring travels
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

// Shared GLSL: idle drift plus the click shockwave. Both the point field and
// the segment field displace themselves the same way, so the whole volume
// moves as one even though the two are drawn separately.
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
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 240);
  camera.position.set(0, 0, CONFIG.cameraZ);

  const small = window.innerWidth < 760;
  const nPoints   = small ? Math.round(CONFIG.points * 0.45)  : CONFIG.points;
  const nSegments = small ? Math.round(CONFIG.segments * 0.5) : CONFIG.segments;

  // Everything lives in this group, so pointer tilt and scroll rotation
  // apply to the whole volume at once and it stays visually coherent.
  const group = new THREE.Group();
  scene.add(group);

  // A point somewhere in the spread volume.
  function scatter(out) {
    const s = CONFIG.spread;
    return out.set(rand(-s.x, s.x), rand(-s.y, s.y), rand(s.zFar, s.zNear));
  }

  const points   = buildPoints(nPoints);
  const segments = buildSegments(nSegments);
  group.add(points, segments);

  // Uniforms shared by both materials, so one write drives the whole scene.
  const shared = {
    uTime:        { value: 0 },
    uRotTime:     { value: 0 },
    uPulse:       { value: 0 },
    uPulseRadius: { value: 0 },
    uPulseOrigin: { value: new THREE.Vector3() },
    uFadeNear:    { value: 24 },
    uFadeFar:     { value: 165 },
  };
  for (const m of [points.material, segments.material]) Object.assign(m.uniforms, shared);

  // ---------- point field ----------
  function buildPoints(n) {
    const pos   = new Float32Array(n * 3);
    const scale = new Float32Array(n);
    const mix   = new Float32Array(n);
    const seed  = new Float32Array(n);
    const p = new THREE.Vector3();

    for (let i = 0; i < n; i++) {
      scatter(p);
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      scale[i] = rand(0.5, 1.9);
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
        uSize:       { value: 2.6 },
        uPixelRatio: { value: 1 },
        uOpacity:    { value: 1 },
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

  // ---------- free-floating line segments ----------
  // Two vertices per segment. Each vertex carries its own segment centre,
  // spin axis and seed, so the shader can tumble every strut about its own
  // midpoint. They float independently instead of forming one rigid shape.
  function buildSegments(n) {
    const offset = new Float32Array(n * 2 * 3);   // endpoint, relative to centre
    const centre = new Float32Array(n * 2 * 3);
    const axis   = new Float32Array(n * 2 * 3);
    const seed   = new Float32Array(n * 2);
    const taper  = new Float32Array(n * 2);       // fades each strut along its length

    const c = new THREE.Vector3();
    const a = new THREE.Vector3();
    const d = new THREE.Vector3();

    for (let i = 0; i < n; i++) {
      scatter(c);

      // random direction on the unit sphere, scaled to half the strut length
      const th = rand(0, Math.PI * 2), ph = Math.acos(rand(-1, 1));
      d.set(Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph));
      d.multiplyScalar(rand(CONFIG.segmentLen[0], CONFIG.segmentLen[1]) * 0.5);

      a.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();   // spin axis
      const s = Math.random();

      for (let v = 0; v < 2; v++) {
        const k = (i * 2 + v) * 3;
        const sign = v === 0 ? -1 : 1;
        offset[k] = d.x * sign; offset[k + 1] = d.y * sign; offset[k + 2] = d.z * sign;
        centre[k] = c.x;        centre[k + 1] = c.y;        centre[k + 2] = c.z;
        axis[k]   = a.x;        axis[k + 1]   = a.y;        axis[k + 2]   = a.z;
        seed[i * 2 + v]  = s;
        taper[i * 2 + v] = v === 0 ? 0.25 : 1.0;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(offset, 3));
    geo.setAttribute('aCentre',  new THREE.BufferAttribute(centre, 3));
    geo.setAttribute('aAxis',    new THREE.BufferAttribute(axis, 3));
    geo.setAttribute('aSeed',    new THREE.BufferAttribute(seed, 1));
    geo.setAttribute('aTaper',   new THREE.BufferAttribute(taper, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: {
        uOpacity: { value: 0.8 },
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

  // ---------- theme ----------
  function applyTheme() {
    const light = isLight();
    const a = cssColor('--accent-1', '#14e0c4');
    const b = cssColor('--accent-2', '#b86bff');

    // Additive blending washes out on a light page, so switch to normal
    // blending and darker ink when the light theme is active.
    const blending = light ? THREE.NormalBlending : THREE.AdditiveBlending;
    const ink = c => (light ? c.clone().multiplyScalar(0.62) : c);

    for (const [m, base] of [[points.material, 1], [segments.material, 0.8]]) {
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
    points.material.uniforms.uPixelRatio.value = dpr;
  }
  resize();
  window.addEventListener('resize', resize);

  // ---------- interaction state ----------
  const pointer = { x: 0, y: 0 };            // normalised device coords
  const eased   = { x: 0, y: 0 };
  let pulseT    = -1;                         // seconds into a shockwave, -1 = idle
  let spinKick  = 0;                          // extra tumble imparted by a click
  let rotTime   = 0;                          // drives per-segment rotation
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

    // Note: deliberately no modal check here. The canvas has no preserved
    // drawing buffer, so skipping a render blanks it. The scene has to keep
    // drawing to stay visible behind the project detail overlay.
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

    // whole field leans toward the pointer and turns gently as the page scrolls
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
