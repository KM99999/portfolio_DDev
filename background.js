// =====================================================================
//  3D BACKGROUND
//  An ambient three.js scene that sits behind every section: a drifting
//  particle field wrapped around two counter-rotating icosahedral shells.
//  It reacts to pointer movement (parallax + tilt), clicks (a travelling
//  shockwave) and scroll position (rotation + dolly).
//
//  Colours are read from the CSS custom properties in styles.css, so the
//  scene re-tints itself whenever the light/dark toggle flips.
//  Tweak the feel with CONFIG below.
// =====================================================================

import * as THREE from 'three';

const CONFIG = {
  particles:      1500,   // scaled down automatically on small screens
  fieldRadius:    46,     // how far the particle cloud spreads
  coreRadius:     13,     // radius of the inner wireframe shell
  cameraZ:        62,
  parallax:       9,      // how far the camera drifts with the pointer
  tilt:           0.24,   // how far the shells lean toward the pointer
  spin:           0.035,  // idle rotation, radians/sec
  pulseDuration:  1.15,   // seconds for a click shockwave to travel out
  pulseReach:     52,     // world units the shockwave ring travels
};

const canvas = document.getElementById('bg-canvas');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (canvas && supportsWebGL()) init();

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

  // Fewer points on phones — this is decoration, not a centrepiece.
  const count = window.innerWidth < 760
    ? Math.round(CONFIG.particles * 0.45)
    : CONFIG.particles;

  const group = new THREE.Group();
  scene.add(group);

  const particles = buildParticles(count);
  const shellInner = buildShell(CONFIG.coreRadius, 1, 0.55);
  const shellOuter = buildShell(CONFIG.coreRadius * 1.85, 1, 0.28);
  const vertexDots = buildVertexDots(CONFIG.coreRadius);
  group.add(particles, shellInner, shellOuter, vertexDots);

  // ---------- particle field ----------
  function buildParticles(n) {
    const pos   = new Float32Array(n * 3);
    const scale = new Float32Array(n);
    const mix   = new Float32Array(n);
    const seed  = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      // Even distribution through a sphere, biased outward so the middle
      // stays open and hero text keeps its contrast.
      const r = CONFIG.fieldRadius * (0.35 + 0.65 * Math.cbrt(Math.random()));
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      pos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.72; // flatten vertically
      pos[i * 3 + 2] = r * Math.cos(phi);
      scale[i] = 0.5 + Math.random() * 1.4;
      mix[i]   = Math.random();
      seed[i]  = Math.random();
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aScale',   new THREE.BufferAttribute(scale, 1));
    geo.setAttribute('aMix',     new THREE.BufferAttribute(mix, 1));
    geo.setAttribute('aSeed',    new THREE.BufferAttribute(seed, 1));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime:        { value: 0 },
        uSize:        { value: 2.6 },
        uPixelRatio:  { value: 1 },
        uOpacity:     { value: 1 },
        uPulse:       { value: 0 },
        uPulseRadius: { value: 0 },
        uPulseOrigin: { value: new THREE.Vector3() },
        uColorA:      { value: new THREE.Color('#14e0c4') },
        uColorB:      { value: new THREE.Color('#b86bff') },
        uFadeNear:    { value: 20 },
        uFadeFar:     { value: 150 },
      },
      vertexShader: `
        uniform float uTime, uSize, uPixelRatio, uPulse, uPulseRadius, uFadeNear, uFadeFar;
        uniform vec3  uPulseOrigin, uColorA, uColorB;
        attribute float aScale, aMix, aSeed;
        varying vec3  vColor;
        varying float vAlpha;

        void main() {
          vec3 pos = position;

          // slow idle drift so the field never looks frozen
          float t = uTime * 0.18 + aSeed * 6.2831;
          pos.x += sin(t) * 0.9;
          pos.y += cos(t * 0.85) * 0.9;
          pos.z += sin(t * 0.60) * 0.6;

          // click shockwave: a travelling ring shoves points outward
          float d    = distance(pos, uPulseOrigin);
          float ring = exp(-pow((d - uPulseRadius) * 0.16, 2.0));
          pos += normalize(pos - uPulseOrigin + 0.0001) * ring * uPulse * 6.0;

          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = uSize * aScale * uPixelRatio * (60.0 / max(-mv.z, 1.0));

          vColor  = mix(uColorA, uColorB, aMix) + ring * uPulse * 0.8;
          vAlpha  = smoothstep(uFadeFar, uFadeNear, -mv.z);
          vAlpha *= 0.65 + 0.35 * sin(uTime * 0.9 + aSeed * 20.0);
        }
      `,
      fragmentShader: `
        uniform float uOpacity;
        varying vec3  vColor;
        varying float vAlpha;

        void main() {
          float d = length(gl_PointCoord - vec2(0.5));
          if (d > 0.5) discard;                       // soft round sprite
          float glow = pow(smoothstep(0.5, 0.0, d), 2.4);
          gl_FragColor = vec4(vColor, glow * vAlpha * uOpacity);
        }
      `,
    });

    return new THREE.Points(geo, mat);
  }

  // ---------- wireframe shells ----------
  function buildShell(radius, detail, opacity) {
    const geo  = new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(radius, detail));
    const mat  = new THREE.LineBasicMaterial({
      transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.LineSegments(geo, mat);
    mesh.userData.baseOpacity = opacity;
    return mesh;
  }

  // Glowing dots on the inner shell's vertices.
  function buildVertexDots(radius) {
    const src = new THREE.IcosahedronGeometry(radius, 1);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', src.getAttribute('position').clone());
    const mat = new THREE.PointsMaterial({
      size: 0.55, transparent: true, opacity: 0.9,
      depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    src.dispose();
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

    const pm = particles.material;
    pm.uniforms.uColorA.value.copy(light ? a.clone().multiplyScalar(0.62) : a);
    pm.uniforms.uColorB.value.copy(light ? b.clone().multiplyScalar(0.62) : b);
    pm.uniforms.uOpacity.value = light ? 0.75 : 1;
    pm.blending = blending;
    pm.needsUpdate = true;

    for (const [shell, tint] of [[shellInner, a], [shellOuter, b]]) {
      shell.material.color.copy(light ? tint.clone().multiplyScalar(0.55) : tint);
      shell.material.opacity = shell.userData.baseOpacity * (light ? 0.7 : 1);
      shell.material.blending = blending;
      shell.material.needsUpdate = true;
    }

    vertexDots.material.color.copy(light ? a.clone().multiplyScalar(0.55) : a);
    vertexDots.material.blending = blending;
    vertexDots.material.needsUpdate = true;
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
    particles.material.uniforms.uPixelRatio.value = dpr;
  }
  resize();
  window.addEventListener('resize', resize);

  // ---------- interaction state ----------
  const pointer = { x: 0, y: 0 };          // normalised device coords
  const eased   = { x: 0, y: 0 };
  let pulseT    = -1;                       // seconds into a shockwave, -1 = idle
  let spinKick  = 0;                        // extra rotation imparted by a click
  let scrollN   = 0;                        // 0..1 down the page
  const pulseOrigin = new THREE.Vector3();

  if (!reduceMotion) {
    window.addEventListener('pointermove', e => {
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.y = -((e.clientY / window.innerHeight) * 2 - 1);
    }, { passive: true });

    // Fire on the document so a click anywhere — including on cards — pulses.
    window.addEventListener('pointerdown', e => {
      projectToScene(e.clientX, e.clientY, pulseOrigin);
      // The shader compares the origin against particle positions in the
      // field's own space, so bring the world-space click point into it.
      particles.updateWorldMatrix(true, false);
      particles.worldToLocal(pulseOrigin);
      pulseT = 0;
      spinKick = 1.7;
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
    particles.material.uniforms.uTime.value = 12;
    renderer.render(scene, camera);
    window.addEventListener('resize', () => renderer.render(scene, camera));
    return;
  }

  function frame() {
    requestAnimationFrame(frame);

    // Skip GPU work while a project modal covers the page.
    if (document.hidden || document.body.classList.contains('modal-open')) {
      clock.getDelta();
      return;
    }

    const dt = Math.min(clock.getDelta(), 0.05);
    const t  = clock.getElapsedTime();

    // pointer easing -> camera parallax
    eased.x += (pointer.x - eased.x) * Math.min(dt * 2.4, 1);
    eased.y += (pointer.y - eased.y) * Math.min(dt * 2.4, 1);
    camera.position.x = eased.x * CONFIG.parallax;
    camera.position.y = eased.y * CONFIG.parallax * 0.6;
    camera.position.z = CONFIG.cameraZ - scrollN * 12;
    camera.lookAt(0, 0, 0);

    // idle spin + click impulse + scroll-linked rotation
    spinKick *= Math.pow(0.12, dt);
    const spin = CONFIG.spin + spinKick;
    shellInner.rotation.y += spin * dt;
    shellInner.rotation.x += spin * 0.42 * dt;
    shellOuter.rotation.y -= spin * 0.62 * dt;
    shellOuter.rotation.z += spin * 0.30 * dt;
    vertexDots.rotation.copy(shellInner.rotation);
    particles.rotation.y += CONFIG.spin * 0.18 * dt;

    // whole rig leans toward the pointer and turns as the page scrolls
    group.rotation.x += (eased.y * CONFIG.tilt - group.rotation.x) * Math.min(dt * 2, 1);
    group.rotation.y += (eased.x * CONFIG.tilt + scrollN * Math.PI * 0.5 - group.rotation.y) * Math.min(dt * 2, 1);

    // shockwave
    const u = particles.material.uniforms;
    if (pulseT >= 0) {
      pulseT += dt;
      const p = pulseT / CONFIG.pulseDuration;
      if (p >= 1) {
        pulseT = -1;
        u.uPulse.value = 0;
      } else {
        u.uPulse.value = Math.pow(1 - p, 1.6);          // fade as it travels
        u.uPulseRadius.value = p * CONFIG.pulseReach;
        u.uPulseOrigin.value.copy(pulseOrigin);
        const swell = 1 + 0.07 * Math.sin(p * Math.PI); // shells breathe with it
        shellInner.scale.setScalar(swell);
        shellOuter.scale.setScalar(1 + (swell - 1) * 0.6);
        vertexDots.scale.setScalar(swell);
      }
    } else {
      shellInner.scale.setScalar(1);
      shellOuter.scale.setScalar(1);
      vertexDots.scale.setScalar(1);
    }

    u.uTime.value = t;
    renderer.render(scene, camera);
  }

  requestAnimationFrame(frame);
}
