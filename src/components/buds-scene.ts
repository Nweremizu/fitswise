import glb from "@model/buds.glb?url";
import {
  Color,
  DirectionalLight,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  NeutralToneMapping,
  type Object3D,
  PerspectiveCamera,
  PMREMGenerator,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

export type Seated = { left: boolean; right: boolean };
/**
 * lid: the case is open. showCase: draw the case at all; without it the buds stand side by side and a
 * bud still in the (shut) case is greyed out.
 */
export type SceneOptions = {
  lid: boolean;
  showCase: boolean;
  seated: Seated;
  spin?: boolean;
  dark: boolean;
  zoom: number;
};
export type BudsScene = { set(o: SceneOptions): void; dispose(): void };

const STILL = matchMedia("(prefers-reduced-motion: reduce)");

type Spring = { x: number; v: number };

/** Critically damped: eases in and out, and can change direction at any moment without a jump. */
function glide(s: Spring, to: number, time: number, dt: number) {
  if (STILL.matches) {
    s.x = to;
    s.v = 0;
    return;
  }
  const w = 2 / time;
  const k = w * dt;
  const decay = 1 / (1 + k + 0.48 * k * k + 0.235 * k * k * k);
  const gap = s.x - to;
  const t = (s.v + w * gap) * dt;
  s.v = (s.v - w * t) * decay;
  s.x = to + (gap + t) * decay;
  if (Math.abs(s.x - to) < 0.0008 && Math.abs(s.v) < 0.004) {
    s.x = to;
    s.v = 0;
  }
}

/** Draws only while something moves, so an open window costs nothing when idle. */
export async function createScene(canvas: HTMLCanvasElement, first: SceneOptions): Promise<BudsScene> {
  const gl = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  gl.setPixelRatio(Math.min(devicePixelRatio, 2));
  gl.toneMapping = NeutralToneMapping;
  const scene = new Scene();
  const pmrem = new PMREMGenerator(gl);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  const key = new DirectionalLight(0xffffff, 1.6);
  key.position.set(-5, 9, 7);
  scene.add(key);
  const cam = new PerspectiveCamera(28, 1, 0.1, 100);
  const target = new Vector3(0, 2.75, -0.6);
  const soloTarget = new Vector3(0, 2.05, 0.6);
  const look = new Vector3();

  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(glb)).scene;
  scene.add(root);
  const lid = root.getObjectByName("Lid") as Object3D;
  const shut = lid.quaternion.clone();
  const turn = new Quaternion();
  const X = new Vector3(1, 0, 0);
  // Every bud and the case get their own materials, so each can fade on its own.
  const own = (o: Object3D) =>
    o.traverse((m) => {
      if (m instanceof Mesh) m.material = (m.material as MeshStandardMaterial).clone();
    });
  // Model space is z-up with the front at -y. Out: upright, floating in front of the open case.
  // Solo: the case is gone and the buds stand side by side where it was.
  const buds = (["left", "right"] as const).map((key, i) => {
    const node = root.getObjectByName(i ? "BudR" : "BudL") as Object3D;
    own(node);
    const side = i ? 1 : -1;
    const face = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI - side * 0.45);
    return {
      key,
      node,
      at: node.position.clone(),
      rot: node.quaternion.clone(),
      away: new Vector3(side * 1.65, -2.2, 3.7),
      solo: new Vector3(side * 1.55, -0.6, 2.05),
      face,
      out: { x: 0, v: 0 } as Spring,
      dim: { x: 0, v: 0 } as Spring,
      mats: [] as MeshStandardMaterial[],
      colors: [] as Color[],
    };
  });
  const caseParts = (buds[0].node.parent as Object3D).children.filter((o) => !buds.some((b) => b.node === o));
  const casePlaces = caseParts.map((o) => o.position.z);
  const caseMats: MeshStandardMaterial[] = [];
  for (const o of caseParts) own(o);
  const collect = (list: MeshStandardMaterial[], parts: Object3D[]) => {
    for (const part of parts) part.traverse((m) => m instanceof Mesh && list.push(m.material as MeshStandardMaterial));
  };
  collect(caseMats, caseParts);
  for (const b of buds) {
    collect(b.mats, [b.node]);
    b.colors = b.mats.map((m) => m.color.clone());
  }
  // A bud resting in a shut case is drawn faded towards the background, but stays solid.
  const grey = new Color();
  const greyOut = (b: (typeof buds)[number], amount: number) =>
    b.mats.forEach((m, i) => m.color.lerpColors(b.colors[i], grey, amount));
  const fade = (mats: MeshStandardMaterial[], opacity: number) => {
    for (const m of mats) {
      m.opacity = opacity;
      m.transparent = opacity < 1;
      m.depthWrite = opacity > 0.5;
    }
  };
  const solo: Spring = { x: first.showCase ? 0 : 1, v: 0 };
  const pos = new Vector3();
  const rot = new Quaternion();

  let want = first;
  const open: Spring = { x: 0, v: 0 };
  let angle = 0.3;
  let turned = 0;
  let frame = 0;
  let last = 0;

  const draw = (t: number) => {
    frame = 0;
    const dt = last ? Math.min((t - last) / 1000, 0.05) : 0.016;
    last = t;
    const goal = want.lid && want.showCase ? 1 : 0;
    glide(open, goal, 0.34, dt);
    const soloGoal = want.showCase ? 0 : 1;
    glide(solo, soloGoal, 0.42, dt);
    let moving = open.x !== goal || solo.x !== soloGoal;
    const s = MathUtils.clamp(solo.x, 0, 1);
    for (const b of buds) {
      // Buds rise once the lid is clear of them. The lid never closes before they are back.
      const out = want.showCase && want.lid && !want.seated[b.key];
      const to = out && open.x > 0.55 ? 1 : 0;
      glide(b.out, to, 0.36, dt);
      const dimGoal = !want.showCase && want.seated[b.key] ? 1 : 0;
      glide(b.dim, dimGoal, 0.3, dt);
      moving ||= b.out.x !== to || (out && to === 0) || b.dim.x !== dimGoal;
      const u = MathUtils.clamp(b.out.x, 0, 1);
      pos.lerpVectors(b.at, b.away, u);
      pos.z += Math.sin(u * Math.PI) * 0.7;
      rot.slerpQuaternions(b.rot, b.face, u);
      b.node.position.lerpVectors(pos, b.solo, s);
      b.node.quaternion.slerpQuaternions(rot, b.face, s);
      greyOut(b, 0.72 * MathUtils.clamp(b.dim.x, 0, 1));
    }
    // The case sinks and fades away when it isn't part of the picture.
    caseParts.forEach((o, i) => {
      o.position.z = casePlaces[i] - s * 0.9;
      o.visible = s < 0.995;
    });
    fade(caseMats, 1 - s);
    const spinning = want.spin && !STILL.matches;
    if (spinning) angle = 0.3 + Math.sin((turned += dt) / 2.6) * 0.45;
    lid.quaternion.copy(shut).multiply(turn.setFromAxisAngle(X, MathUtils.degToRad(-100 * open.x)));
    cam.position.set(Math.sin(angle) * 21.5, 8.2, Math.cos(angle) * 21.5);
    cam.zoom = want.zoom * (1 + 0.45 * s);
    cam.updateProjectionMatrix();
    look.set(target.x, MathUtils.lerp(1.6, target.y, open.x), target.z).lerp(soloTarget, s);
    cam.lookAt(look);
    gl.render(scene, cam);
    if (moving || spinning) schedule();
    else last = 0;
  };
  const schedule = () => {
    frame ||= requestAnimationFrame(draw);
  };

  const set = (o: SceneOptions) => {
    want = o;
    cam.zoom = o.zoom;
    cam.updateProjectionMatrix();
    grey.set(o.dark ? 0x23282b : 0xd9dfe2);
    scene.environmentIntensity = o.dark ? 0.95 : 0.75;
    gl.toneMappingExposure = o.dark ? 1.3 : 1.15;
    schedule();
  };
  const fit = new ResizeObserver(() => {
    const { clientWidth: w, clientHeight: h } = canvas;
    if (!w || !h) return;
    const px = gl.getPixelRatio();
    if (canvas.width === Math.floor(w * px) && canvas.height === Math.floor(h * px)) return;
    gl.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    gl.render(scene, cam); // resizing clears the canvas, so redraw in the same frame
  });
  gl.setSize(canvas.clientWidth || 1, canvas.clientHeight || 1, false);
  cam.aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
  set({ ...first, lid: false });
  for (const b of buds) b.dim.x = !first.showCase && first.seated[b.key] ? 1 : 0;
  cam.updateProjectionMatrix();
  await gl.compileAsync(scene, cam); // shaders build now instead of stalling the first movement
  cancelAnimationFrame(frame);
  draw(performance.now());
  fit.observe(canvas);

  return {
    set,
    dispose() {
      cancelAnimationFrame(frame);
      fit.disconnect();
      root.traverse((o) => {
        if (o instanceof Mesh) {
          o.geometry.dispose();
          (o.material as MeshStandardMaterial).dispose();
        }
      });
      scene.environment?.dispose();
      gl.dispose();
      gl.forceContextLoss();
    },
  };
}

