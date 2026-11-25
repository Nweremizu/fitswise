// FitsWise website: the 3D hero and the download link. No build step, no tracking.

const REPO = "Nweremizu/fitswise";
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

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

// ---------- hero: the generic earbuds and case ----------
const stage = document.querySelector(".stage");
const canvas = document.getElementById("buds");

async function hero() {
  const THREE = await import("three");
  const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
  const { OrbitControls } = await import("three/addons/controls/OrbitControls.js");
  const { RoomEnvironment } = await import("three/addons/environments/RoomEnvironment.js");
  const { MeshoptDecoder } = await import("three/addons/libs/meshopt_decoder.module.js");

  const gl = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  gl.setPixelRatio(Math.min(devicePixelRatio, 2));
  gl.toneMapping = THREE.NeutralToneMapping;
  gl.toneMappingExposure = 1.2;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(gl);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.9;
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(-5, 9, 7);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9fd8ea, 1.2);
  rim.position.set(6, 4, -8);
  scene.add(rim);

  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 200);
  cam.position.set(11, 10, 22);
  const orbit = new OrbitControls(cam, canvas);
  Object.assign(orbit, {
    enableDamping: true,
    enablePan: false,
    enableZoom: false,
    autoRotate: !still,
    autoRotateSpeed: 0.8,
    minPolarAngle: 0.5,
    maxPolarAngle: 1.35,
  });
  orbit.target.set(0, 2.1, 0.8);

  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync("assets/buds.glb")).scene;
  scene.add(root);
  const lid = root.getObjectByName("Lid");
  const shut = lid.quaternion.clone();
  const X = new THREE.Vector3(1, 0, 0);
  // Model space is z-up with the front at -y. Each bud lifts out and turns to face the viewer.
  const buds = ["BudL", "BudR"].map((name, i) => {
    const o = root.getObjectByName(name);
    const side = i ? 1 : -1;
    return {
      o,
      at: o.position.clone(),
      rot: o.quaternion.clone(),
      away: new THREE.Vector3(side * 1.9, -2.6, 3.4),
      face: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI - side * 0.5),
      delay: i * 0.25,
    };
  });

  const fit = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    gl.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
  };
  new ResizeObserver(fit).observe(canvas);
  fit();

  const ease = (t) => 1 - (1 - Math.min(Math.max(t, 0), 1)) ** 3;
  const turn = new THREE.Quaternion();
  let start = 0;
  let visible = true;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(stage);

  gl.setAnimationLoop((t) => {
    if (!visible) return;
    start ||= t;
    const s = still ? 10 : (t - start) / 1000;
    const open = ease((s - 0.4) / 1.1);
    lid.quaternion.copy(shut).multiply(turn.setFromAxisAngle(X, THREE.MathUtils.degToRad(-100 * open)));
    for (const b of buds) {
      const out = ease((s - 1.4 - b.delay) / 1.1);
      b.o.position.lerpVectors(b.at, b.away, out);
      b.o.position.z += Math.sin(out * Math.PI) * 0.8 + (still ? 0 : Math.sin(s * 1.4 + b.delay * 6) * 0.08 * out);
      b.o.quaternion.slerpQuaternions(b.rot, b.face, out);
    }
    orbit.update();
    gl.render(scene, cam);
  });
  stage.classList.add("live");
}

hero().catch((e) => {
  console.warn("3D view unavailable", e);
  stage.querySelector(".stage-poster").hidden = false;
});
