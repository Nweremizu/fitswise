import glb from "@model/buds.glb?url";
import {
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
export type SceneOptions = { lid: boolean; seated: Seated; spin?: boolean; dark: boolean; zoom: number };
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

  const root = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(glb)).scene;
  scene.add(root);
  const lid = root.getObjectByName("Lid") as Object3D;
  const shut = lid.quaternion.clone();
  const turn = new Quaternion();
  const X = new Vector3(1, 0, 0);
  // Model space is z-up with the front at -y. Out: upright, floating in front of the open case.
  const buds = (["left", "right"] as const).map((key, i) => {
    const node = root.getObjectByName(i ? "BudR" : "BudL") as Object3D;
    const side = i ? 1 : -1;
    const face = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI - side * 0.45);
    return { key, node, at: node.position.clone(), rot: node.quaternion.clone(), away: new Vector3(side * 1.65, -2.2, 3.7), face, out: { x: 0, v: 0 } as Spring };
  });

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
    const goal = want.lid ? 1 : 0;
    glide(open, goal, 0.34, dt);
    let moving = open.x !== goal;
    for (const b of buds) {
      // Buds rise once the lid is clear of them. The lid never closes before they are back.
      const to = want.lid && !want.seated[b.key] && open.x > 0.55 ? 1 : 0;
      glide(b.out, to, 0.36, dt);
      moving ||= b.out.x !== to || (want.lid && !want.seated[b.key] && to === 0);
      const u = MathUtils.clamp(b.out.x, 0, 1);
      b.node.position.lerpVectors(b.at, b.away, u);
      b.node.position.z += Math.sin(u * Math.PI) * 0.7;
      b.node.quaternion.slerpQuaternions(b.rot, b.face, u);
    }
    const spinning = want.spin && !STILL.matches;
    if (spinning) angle = 0.3 + Math.sin((turned += dt) / 2.6) * 0.45;
    lid.quaternion.copy(shut).multiply(turn.setFromAxisAngle(X, MathUtils.degToRad(-100 * open.x)));
    cam.position.set(Math.sin(angle) * 21.5, 8.2, Math.cos(angle) * 21.5);
    cam.lookAt(target.x, MathUtils.lerp(1.6, target.y, open.x), target.z);
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

