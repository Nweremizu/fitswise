// FitsWise website: the download link, the dithered cloud, and the live 3D preview. No build step, no tracking.

const REPO = "Nweremizu/fitswise";
// Reduced motion: no autoplay or pulsing rings, and the 3D view only redraws when something changes. Automated browsers
// (screenshots, tests) get the same calm mode, since a software-rendered loop starves them.
const still = matchMedia("(prefers-reduced-motion: reduce)").matches || navigator.webdriver;
const dark = matchMedia("(prefers-color-scheme: dark)");

const clamp = (x, a = 0, b = 1) => Math.min(Math.max(x, a), b);
/** 0 before a, 1 after b, eased in between. */
const span = (x, a, b) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ---------- download: point the buttons straight at the newest installer ----------
fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((release) => {
    const setup = release.assets.find((a) => /x64-setup\.exe$/i.test(a.name));
    if (!setup) return;
    for (const a of document.querySelectorAll("[data-download]")) a.href = setup.browser_download_url;
    const mb = (setup.size / 1048576).toFixed(1);
    for (const m of document.querySelectorAll("[data-download-meta]")) {
      m.textContent = `v${release.tag_name.replace(/^v/, "")} · ${mb} MB · Windows 10 and 11 · no account · updates itself`;
    }
  })
  .catch(() => {}); // the links already go to the releases page

// ---------- the hero's dithered cloud (after devl.dev's) ----------
// A few soft puffs on each side, roughened with noise, then ordered-dithered into 3px dots. Drawn once per size.
const dither = document.querySelector(".dither");
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const hash = (x, y) => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const noise = (x, y) => {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * u;
  const b = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * u;
  return a + (b - a) * v;
};
// [x across the width, y down the height, radius in heights]
const PUFFS = [
  [0.0, 1.0, 0.5], [0.07, 0.8, 0.28], [0.16, 1.0, 0.3],
  [1.0, 0.95, 0.52], [0.93, 0.78, 0.26], [0.84, 1.02, 0.3],
];
let ditherWidth = 0;
function drawDither() {
  const cell = 3;
  const W = Math.ceil(dither.clientWidth / cell);
  const H = Math.ceil(dither.clientHeight / cell);
  if (!W || !H) return;
  ditherWidth = dither.clientWidth;
  dither.width = W;
  dither.height = H;
  const ctx = dither.getContext("2d");
  const img = ctx.createImageData(W, H);
  const [r, g, b, a] = dark.matches ? [255, 255, 255, 22] : [0, 0, 0, 24];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (const [cx, cy, rad] of PUFFS) v = Math.max(v, 1 - Math.hypot(x - cx * W, y - cy * H) / (rad * H));
      v += (noise(x / 14, y / 14) - 0.5) * 0.5 + (noise(x / 5, y / 5) - 0.5) * 0.2;
      if (clamp(v * 1.25) * 16 > BAYER[(y % 4) * 4 + (x % 4)] + 0.5) {
        const i = (y * W + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = a;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}
drawDither();
addEventListener("resize", () => dither.clientWidth !== ditherWidth && drawDither());
dark.addEventListener("change", drawDither);

// ---------- the live preview: steps, status and noise control ----------
const SCENES = [
  { status: "In the case", charging: true, noise: false },
  { status: "Case open", charging: true, noise: false },
  { status: "Connected", charging: false, noise: true },
  { status: "Connected", charging: false, noise: true },
];
const MODES = ["Noise cancelling", "Off", "Transparency"];
const view = { scene: 0, mode: 0 };
let onViewChange = () => {}; // the 3D view hooks in here once it loads

const sceneButtons = [...document.querySelectorAll("[data-scene]")];
const segments = document.querySelector(".segments");
const modeButtons = [...segments.querySelectorAll("[data-mode]")];
const statusText = document.querySelector("[data-status]");
const hint = document.querySelector("[data-hint]");
const charger = document.querySelector(".ring[data-charging]");

function render() {
  const s = SCENES[view.scene];
  sceneButtons.forEach((b, i) => b.setAttribute("aria-pressed", String(i === view.scene)));
  statusText.textContent = s.status;
  charger.toggleAttribute("data-charging", s.charging);
  segments.toggleAttribute("data-disabled", !s.noise);
  segments.style.setProperty("--i", view.mode);
  modeButtons.forEach((b, i) => {
    b.setAttribute("aria-checked", String(i === view.mode));
    b.setAttribute("aria-disabled", String(!s.noise));
    b.tabIndex = i === view.mode ? 0 : -1;
  });
  hint.textContent = s.noise ? MODES[view.mode] : "Put your buds in to change noise control";
  onViewChange();
}

let touched = false; // once the reader picks a step, the preview stops playing by itself
for (const b of sceneButtons) {
  b.addEventListener("click", () => {
    touched = true;
    view.scene = Number(b.dataset.scene);
    render();
  });
}
function pickMode(i) {
  if (!SCENES[view.scene].noise) return;
  view.mode = (i + MODES.length) % MODES.length;
  render();
}
modeButtons.forEach((b, i) => {
  b.addEventListener("click", () => pickMode(i));
  b.addEventListener("keydown", (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    pickMode(view.mode + step);
    modeButtons[view.mode].focus();
  });
});
render();

// Play the story once when the preview first comes into view: open, take them out, put them in.
const stageEl = document.querySelector(".stage");
if (!still) {
  const once = new IntersectionObserver(
    ([e]) => {
      if (!e.isIntersecting) return;
      once.disconnect();
      [1, 2, 3].forEach((scene, k) =>
        setTimeout(() => {
          if (touched) return;
          view.scene = scene;
          render();
        }, 900 + k * 2200),
      );
    },
    { threshold: 0.6 },
  );
  once.observe(stageEl);
}

// ---------- the 3D view ----------
async function preview() {
  const canvas = document.getElementById("buds");
  const THREE = await import("three");
  const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
  const { RoomEnvironment } = await import("three/addons/environments/RoomEnvironment.js");
  const { MeshoptDecoder } = await import("three/addons/libs/meshopt_decoder.module.js");
  const { MathUtils, Quaternion, Vector3 } = THREE;

  const gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  gl.setPixelRatio(Math.min(devicePixelRatio, 2));
  gl.toneMapping = THREE.NeutralToneMapping;
  gl.toneMappingExposure = 1.2;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(gl);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environmentIntensity = 0.9;
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(-5, 9, 7);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xdfe6ee, 1.4);
  rim.position.set(6, 4, -8);
  scene.add(rim);
  const cam = new THREE.PerspectiveCamera(28, 1, 0.1, 200);

  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync("assets/buds.glb")).scene;
  const pivot = new THREE.Group(); // turns the whole model about the case's centre
  pivot.add(root);
  scene.add(pivot);

  // Model space (under the glTF root) is z-up with the front at -y; the same moves as the app's own view.
  const lid = root.getObjectByName("Lid");
  const shut = lid.quaternion.clone();
  const buds = ["BudL", "BudR"].map((name, i) => {
    const node = root.getObjectByName(name);
    const side = i ? 1 : -1;
    return {
      node,
      side,
      at: node.position.clone(),
      rot: node.quaternion.clone(),
      away: new Vector3(side * 1.65, -2.2, 3.7),
      solo: new Vector3(side * 1.55, -0.6, 2.05),
      face: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI - side * 0.45),
      lag: i * 0.06,
      rings: [],
      u: 0,
    };
  });
  const caseParts = buds[0].node.parent.children.filter((o) => !buds.some((b) => b.node === o));
  const casePlaces = caseParts.map((o) => o.position.clone());
  const caseSizes = caseParts.map((o) => o.scale.clone());

  // Noise control rings: they pull in for noise cancelling and spread out for transparency.
  const ringGeo = new THREE.RingGeometry(0.96, 1, 96);
  const ringMat = () => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  for (const b of buds) {
    for (let k = 0; k < 3; k++) {
      const m = new THREE.Mesh(ringGeo, ringMat());
      scene.add(m);
      b.rings.push(m);
    }
  }
  const tintRings = () => {
    const c = dark.matches ? 0xe6e6e6 : 0x2a2a2a;
    for (const b of buds) for (const r of b.rings) r.material.color.setHex(c);
  };
  tintRings();

  let dirty = true;
  let w = 1;
  let h = 1;
  const fit = () => {
    w = canvas.clientWidth || 1;
    h = canvas.clientHeight || 1;
    gl.setSize(w, h, false);
    cam.aspect = w / h;
    dirty = true;
  };
  new ResizeObserver(fit).observe(canvas);

  // Drag to turn.
  let yaw = 0.45;
  let drag = null;
  stageEl.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, yaw };
    stageEl.setPointerCapture(e.pointerId);
  });
  stageEl.addEventListener("pointermove", (e) => {
    if (!drag) return;
    yaw = drag.yaw - (e.clientX - drag.x) * 0.008;
    dirty = true;
  });
  const drop = () => (drag = null);
  stageEl.addEventListener("pointerup", drop);
  stageEl.addEventListener("pointercancel", drop);

  onViewChange = () => (dirty = true);
  dark.addEventListener("change", () => {
    tintRings();
    dirty = true;
  });

  const pos = new Vector3();
  const rot = new Quaternion();
  const turn = new Quaternion();
  const X = new Vector3(1, 0, 0);
  const look = new Vector3();
  const lookSolo = new Vector3(0, 2.05, 0.6);
  const v = new Vector3();
  let t = view.scene; // 0 case shut, 1 open, 2 out, 3 worn: eased toward the chosen step
  let last = 0;

  const frame = (now) => {
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0.016;
    last = now;
    const time = now / 1000;
    // Walk through the steps in order at an even pace, so every jump plays the story in between.
    const goal = view.scene;
    t = still ? goal : t + clamp(goal - t, -dt * 1.25, dt * 1.25);
    const noise = SCENES[view.scene].noise ? view.mode : 1;
    const pulsing = !still && noise !== 1 && t > 1.8;
    if (!dirty && t === goal && !pulsing) return;
    dirty = false;

    // ---- the pose for this point of the story ----
    const lidOpen = span(t, 0.05, 0.85) * (1 - span(t, 2.35, 2.6));
    const aside = span(t, 2.05, 2.3) * (1 - span(t, 2.75, 2.95));
    const s = span(t, 2.55, 2.85); // case leaving, buds to the "worn" view
    for (const b of buds) {
      const u = span(t, 1.1 + b.lag, 1.85 + b.lag);
      pos.lerpVectors(b.at, b.away, u);
      pos.z += Math.sin(u * Math.PI) * 0.7;
      rot.slerpQuaternions(b.rot, b.face, u);
      b.node.position.lerpVectors(pos, b.solo, s);
      b.node.position.x += b.side * 2.4 * (1 - 0.35 * s) * aside * u;
      b.node.quaternion.slerpQuaternions(rot, b.face, s);
      b.u = u;
    }
    caseParts.forEach((o, i) => {
      const k = Math.max(1 - s, 0.001); // base and lid shrink about one point, so they stay one case
      o.position.copy(casePlaces[i]).multiplyScalar(k);
      o.position.z -= s * 0.9;
      o.scale.copy(caseSizes[i]).multiplyScalar(k);
      o.visible = s < 0.995;
    });
    lid.quaternion.copy(shut).multiply(turn.setFromAxisAngle(X, MathUtils.degToRad(-100 * lidOpen)));

    // ---- camera ----
    pivot.rotation.y = -yaw;
    cam.position.set(0, 8.2, 21.5);
    look.set(0, MathUtils.lerp(1.6, 2.75, lidOpen), -0.6).lerp(lookSolo, s);
    cam.lookAt(look);
    const fitWidth = Math.min(1, (w / h) * 1.05);
    cam.zoom = fitWidth * 1.2 * (1 - 0.14 * aside) * (1 + 0.3 * s);
    cam.updateProjectionMatrix();
    root.updateMatrixWorld(true);

    // ---- noise rings around each bud ----
    const ringsOn = span(t, 1.8, 2.0);
    for (const b of buds) {
      b.node.getWorldPosition(v);
      b.rings.forEach((ring, i) => {
        const phase = still ? (i + 1) / 4 : (time * 0.55 + i / 3) % 1;
        const inward = noise === 0;
        const scale = inward ? 2.1 - 1.1 * phase : 1.1 + 1.2 * phase;
        const fade = inward ? Math.sin(phase * Math.PI) : 1 - phase;
        ring.position.copy(v);
        ring.quaternion.copy(cam.quaternion);
        ring.scale.setScalar(scale);
        ring.material.opacity = noise === 1 ? 0 : ringsOn * fade * 0.35 * b.u;
        ring.visible = ring.material.opacity > 0.001;
      });
    }

    gl.render(scene, cam);
  };

  // Only run while the preview is on screen.
  new IntersectionObserver(([e]) => {
    last = 0;
    dirty = true;
    gl.setAnimationLoop(e.isIntersecting ? frame : null);
  }).observe(stageEl);

  await gl.compileAsync(scene, cam);
  stageEl.classList.add("live");
}

preview().catch((e) => {
  console.warn("3D view unavailable", e);
});
