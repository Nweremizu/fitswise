// FitsWise website: a scroll-driven 3D tour and the download link. No build step, no tracking.

const REPO = "Nweremizu/fitswise";
// Reduced motion: no drift or sway, and the stage only redraws when the scroll position changes. Automated browsers
// (screenshots, tests) get the same calm mode, since a software-rendered loop starves them.
const still = matchMedia("(prefers-reduced-motion: reduce)").matches || navigator.webdriver;

// ---------- download: point the buttons straight at the newest installer ----------
fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
  .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
  .then((release) => {
    const setup = release.assets.find((a) => /x64-setup\.exe$/i.test(a.name));
    if (!setup) return;
    for (const a of document.querySelectorAll("[data-download]")) a.href = setup.browser_download_url;
    const mb = (setup.size / 1048576).toFixed(1);
    for (const m of document.querySelectorAll("[data-download-meta]")) {
      m.textContent = `Version ${release.tag_name.replace(/^v/, "")} · ${mb} MB · no account · updates itself`;
    }
  })
  .catch(() => {}); // the links already go to the releases page

// ---------- scroll: where the reader is in the story ----------
const stage = document.querySelector(".stage");
const canvas = document.getElementById("buds");
const chapters = [...document.querySelectorAll(".chapter")];
const showcase = document.querySelector(".showcase");
const final = document.querySelector(".final");
const modes = [...document.querySelectorAll(".modes li")];

const clamp = (x, a = 0, b = 1) => Math.min(Math.max(x, a), b);
/** 0 before a, 1 after b, eased in between. */
const span = (x, a, b) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * t runs 0..4 across the four chapters: each counts from when its top reaches the middle of the screen (its card is
 * pinning) until its card is about to leave. Then `away` fades the stage out for the plain sections, and `end` brings it
 * back for the last call.
 */
function readScroll() {
  const vh = innerHeight;
  // On narrow screens the card pins to the bottom for the whole chapter, so the chapter runs from entry to exit.
  const narrow = innerWidth < 880;
  const ps = chapters.map((c) => {
    const r = c.getBoundingClientRect();
    return narrow ? clamp((vh - r.top) / r.height) : clamp((vh * 0.5 - r.top) / (r.height - 150));
  });
  const t = ps.reduce((a, b) => a + b, 0);
  const away = span(vh - showcase.getBoundingClientRect().top, vh * 0.35, vh * 0.8);
  const end = span(vh - final.getBoundingClientRect().top, vh * 0.2, vh * 0.9);
  return { t, ps, away, end };
}

// The words: each card fades in as it pins and out before the next arrives, and the noise modes light up in turn.
const cards = chapters.map((c) => c.querySelector(".card"));
let mode = -1;
function onScroll() {
  const { t, ps } = readScroll();
  document.documentElement.style.setProperty("--past-hero", String(clamp(scrollY / (innerHeight * 0.5))));
  cards.forEach((card, i) => {
    const p = ps[i];
    const shown = span(p, 0, 0.1) * (1 - span(p, 0.88, 1));
    card.style.opacity = i === 0 ? 1 - span(p, 0.88, 1) : shown;
    card.style.translate = `0 ${(1 - shown) * (p < 0.5 ? 24 : -24)}px`;
  });
  const m = t < 2 ? -1 : t < 2.36 ? 0 : t < 2.7 ? 1 : 2;
  if (m !== mode) {
    mode = m;
    modes.forEach((li, i) => li.classList.toggle("on", i === m));
  }
}
let queued = false;
addEventListener(
  "scroll",
  () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      onScroll();
    });
  },
  { passive: true },
);
onScroll();

// ---------- the 3D stage ----------
async function tour() {
  const THREE = await import("three");
  const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
  const { RoomEnvironment } = await import("three/addons/environments/RoomEnvironment.js");
  const { MeshoptDecoder } = await import("three/addons/libs/meshopt_decoder.module.js");
  const { MathUtils, Quaternion, Vector3 } = THREE;

  const gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  gl.setPixelRatio(Math.min(devicePixelRatio, 2));
  gl.toneMapping = THREE.NeutralToneMapping;
  gl.toneMappingExposure = 1.25;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(gl);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  scene.environmentIntensity = 0.9;
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(-5, 9, 7);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fd8ea, 1.6);
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
    };
  });
  const caseParts = buds[0].node.parent.children.filter((o) => !buds.some((b) => b.node === o));
  const casePlaces = caseParts.map((o) => o.position.clone());
  const caseSizes = caseParts.map((o) => o.scale.clone());

  // Noise control rings: they pull in for noise cancelling and spread out for transparency.
  const ringGeo = new THREE.RingGeometry(0.96, 1, 96);
  for (const b of buds) {
    for (let k = 0; k < 3; k++) {
      const m = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({ color: 0x9fd8ea, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      scene.add(m);
      b.rings.push(m);
    }
  }

  // Battery pins sit over these points.
  const pins = [...document.querySelectorAll(".pin")];
  const pinAt = { left: new Vector3(), right: new Vector3(), case: new Vector3() };
  const v = new Vector3();

  let w = 1;
  let h = 1;
  let narrow = false;
  const fit = () => {
    w = canvas.clientWidth || 1;
    h = canvas.clientHeight || 1;
    narrow = w < 880;
    gl.setSize(w, h, false);
    cam.aspect = w / h;
  };
  addEventListener("resize", fit);
  fit();

  const pos = new Vector3();
  const rot = new Quaternion();
  const turn = new Quaternion();
  const X = new Vector3(1, 0, 0);
  const look = new Vector3();
  const lookOpen = new Vector3(0, 2.75, -0.6);
  const lookSolo = new Vector3(0, 2.05, 0.6);
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  if (!still) {
    addEventListener("pointermove", (e) => {
      pointer.x = (e.clientX / innerWidth) * 2 - 1;
      pointer.y = (e.clientY / innerHeight) * 2 - 1;
    });
  }

  let shown = readScroll();
  let last = 0;
  let drawn = "";

  gl.setAnimationLoop((now) => {
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0.016;
    last = now;
    const time = now / 1000;
    const want = readScroll();
    // Ease toward the scroll position, so a flick of the wheel glides instead of jumping.
    const k = still ? 1 : 1 - Math.exp(-dt * 7);
    shown = { t: shown.t + (want.t - shown.t) * k, away: want.away, end: want.end };
    const { t, away, end } = shown;
    const ending = end > 0;

    stage.style.setProperty("--show", ending ? end : 1 - away);
    if (!ending && away >= 1) return; // nothing to see: save the work
    const state = `${t.toFixed(4)} ${end.toFixed(3)} ${w}x${h}`;
    if (still && state === drawn) return;
    drawn = state;

    // ---- the pose for this point of the story ----
    const lidOpen = ending ? 0 : span(t, 0.12, 0.7) * (1 - span(t, 3.2, 3.45));
    const aside = ending ? 0 : span(t, 3.0, 3.2) * (1 - span(t, 3.72, 3.95));
    const s = ending ? 0 : span(t, 3.45, 3.72); // case leaving, buds to the "worn" view
    const ringsOn = ending ? 0 : span(t, 2.05, 2.2) * (1 - span(t, 2.85, 3.0));
    const pinsOn = ending ? 0 : span(t, 1.35, 1.55) * (1 - span(t, 1.9, 2.05));
    const noise = t < 2.36 ? 0 : t < 2.7 ? 1 : 2;

    for (const b of buds) {
      const u = ending ? 0 : span(t, 1.05 + b.lag, 1.5 + b.lag);
      pos.lerpVectors(b.at, b.away, u);
      pos.z += Math.sin(u * Math.PI) * 0.7 + (still ? 0 : Math.sin(time * 1.3 + b.side) * 0.06 * u);
      rot.slerpQuaternions(b.rot, b.face, u);
      b.node.position.lerpVectors(pos, b.solo, s);
      b.node.position.x += b.side * (narrow ? 2.1 : 2.7) * (1 - 0.35 * s) * aside * u;
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

    // ---- camera: where the model sits on screen, and from which side ----
    pointer.sx += (pointer.x - pointer.sx) * Math.min(dt * 3, 1);
    pointer.sy += (pointer.y - pointer.sy) * Math.min(dt * 3, 1);
    const idle = still ? 0 : Math.sin(time * 0.35) * 0.35;
    const hero = 1 - span(t, 0, 0.6);
    let yaw = MathUtils.lerp(0.18, 0.55 + idle, hero) + pointer.sx * 0.12;
    if (ending) yaw = (still ? 0.5 : time * 0.25) + pointer.sx * 0.12;
    pivot.rotation.y = -yaw;
    pivot.position.y = still ? 0 : Math.sin(time * 0.9) * 0.06 * (hero + (ending ? 1 : 0));
    cam.position.set(0, 8.2 + pointer.sy * 1.2, 21.5);
    look.set(0, MathUtils.lerp(1.6, lookOpen.y, lidOpen), lookOpen.z).lerp(lookSolo, s);
    cam.lookAt(look);
    // Shift the picture so the model sits beside the words, not under them.
    const cx = narrow || ending ? 0.5 : MathUtils.lerp(0.66, 0.7, hero);
    // Phones: the hero words fill the screen, so the case waits above it and drops in as the tour starts.
    const cy = ending ? 0.36 : narrow ? MathUtils.lerp(0.3, -0.35, hero) : 0.5;
    cam.setViewOffset(w, h, -(cx - 0.5) * w, -(cy - 0.5) * h, w, h);
    const fitWidth = narrow ? Math.min(1, (w / h) * 1.25) : 1;
    // Smaller once the story starts, so the buds have room to step aside without leaving the frame.
    cam.zoom = fitWidth * (ending ? 0.85 : MathUtils.lerp(0.72, narrow ? 0.62 : 1, hero)) * (1 + 0.35 * s);
    cam.updateProjectionMatrix();
    root.updateMatrixWorld(true);

    // ---- noise rings around each bud ----
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
        ring.material.opacity = noise === 2 ? 0 : ringsOn * fade * 0.3 * b.u;
        ring.visible = ring.material.opacity > 0.001;
      });
    }

    gl.render(scene, cam);

    // ---- battery pins, projected onto the screen ----
    buds[0].node.getWorldPosition(pinAt.left).add(v.set(0, 1.35, 0));
    buds[1].node.getWorldPosition(pinAt.right).add(v.set(0, 1.35, 0));
    pinAt.case.set(0, 0.2, 3.4).applyMatrix4(pivot.matrixWorld);
    for (const pin of pins) {
      const p = pinAt[pin.dataset.pin].clone().project(cam);
      pin.style.transform = `translate(${((p.x + 1) / 2) * w}px, ${((1 - p.y) / 2) * h}px)`;
      pin.style.opacity = pinsOn;
    }
  });
  await gl.compileAsync(scene, cam);
  stage.classList.add("live");
}

tour().catch((e) => {
  console.warn("3D view unavailable", e);
  stage.classList.add("fallback");
});
