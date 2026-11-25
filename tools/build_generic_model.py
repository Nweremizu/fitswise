"""Builds the neutral earbuds model for public builds from signed distance fields. Units: cm, z up, front is -y.

    uv run --no-project --python 3.12 --with numpy --with scikit-image --with trimesh \
        --with fast-simplification tools/build_generic_model.py OUT.glb

Nodes the app drives: Lid (origin on the hinge, rotate about x), BudL, BudR.
"""
import sys
from pathlib import Path

import fast_simplification
import numpy as np
import trimesh
from skimage.measure import marching_cubes
from trimesh.visual.material import PBRMaterial


def mat(name, color, rough, metal=0.0):
    c = np.array([int(color[i:i + 2], 16) for i in (1, 3, 5)]) / 255
    lin = np.where(c <= .04045, c / 12.92, ((c + .055) / 1.055) ** 2.4)
    return PBRMaterial(name=name, baseColorFactor=[*lin, 1.0], roughnessFactor=rough, metallicFactor=metal)


SHELL, LINER = mat("Shell", "#E9EAEC", .42), mat("Liner", "#D6DADF", .6)
BUD, TIP = mat("Bud", "#F0F1F2", .38), mat("Tip", "#C9CDD2", .65)
METAL, DARK = mat("Contact", "#D9DADA", .25, 1.0), mat("Dark", "#23262A", .4)


def smin(a, b, k):
    h = np.clip(.5 + .5 * (b - a) / k, 0, 1)
    return b + (a - b) * h - k * h * (1 - h)


def smax(a, b, k): return -smin(-a, -b, k)


def implicit(k, p, eps=2e-3):
    v = k(p)
    g = np.stack([k(p + np.eye(3, dtype=np.float32)[i] * eps) - v for i in range(3)], -1) / eps
    return (v - 1) / np.maximum(np.linalg.norm(g, axis=-1), .08)


def grad(f, p, eps=2e-3):
    e = np.eye(3, dtype=np.float32) * eps
    g = np.stack([f(p + e[i]) - f(p - e[i]) for i in range(3)], -1)
    return g / np.maximum(np.linalg.norm(g, axis=-1, keepdims=True), 1e-9)


def mesh(f, lo, hi, voxel, faces, material, name):
    ax = [np.arange(l - 2 * voxel, h + 3 * voxel, voxel, dtype=np.float32) for l, h in zip(lo, hi)]
    vol = np.empty([len(a) for a in ax], np.float32)
    yz = np.stack(np.meshgrid(ax[1], ax[2], indexing="ij"), -1)
    for i, x in enumerate(ax[0]):
        vol[i] = f(np.concatenate([np.full(yz.shape[:2] + (1,), x, np.float32), yz], -1))
    v, t, _, _ = marching_cubes(vol, 0, spacing=(voxel,) * 3)
    v, t = (v + [a[0] for a in ax]).astype(np.float32), t[:, ::-1]
    if len(t) > faces:
        v, t = fast_simplification.simplify(v, t.astype(np.int32), target_count=faces, agg=3)
    v = np.asarray(v, np.float32)
    for _ in range(3):
        v = v - grad(f, v) * np.clip(f(v), -.4 * voxel, .4 * voxel)[:, None]
    n = grad(f, v)
    tri = v[t]
    if (np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]) * n[t].mean(1)).sum() < 0:
        t = t[:, ::-1]
    m = trimesh.Trimesh(v, t, vertex_normals=n, process=False, metadata={"name": name})
    m.visual = trimesh.visual.TextureVisuals(material=material)
    return m


# Pill-shaped case: wider than deep, so it resembles no particular product.
A, B, H = 3.3, 2.35, 1.3
SEAM = 1.5
HINGE = np.array([0, B - .16, SEAM])
TOP, BOTTOM = 1.15, SEAM


def case(p, inset=0.0, top=TOP):
    a, b = A - inset, B - inset

    def k(q):
        x, y, z = np.abs(q[..., 0]) / a, np.abs(q[..., 1]) / b, q[..., 2] - SEAM
        h = np.where(z > 0, top - inset, BOTTOM - inset)
        return ((x ** 3 + y ** 2.6 + 1e-12) ** (2.4 / 2.8) + (np.abs(z) / h) ** 2.4 + 1e-12) ** (1 / 2.4)
    return implicit(k, p)


def base_shell(p):
    d = smax(case(p), p[..., 2] - (SEAM - .006), .03)
    d = smax(d, -case(p, .1), .02)
    led = np.maximum(np.hypot(p[..., 0], p[..., 2] - .9) - .06, p[..., 1] + 1.5)
    return smax(d, -np.maximum(led, -(case(p) + .05)), .01)


def lid_shell(p):
    return smax(smax(case(p), SEAM + .006 - p[..., 2], .03), -case(p, .1), .02)


def lid_liner(p):
    d = smax(case(p, .085), SEAM + .03 - p[..., 2], .04)
    return smax(d, -case(p, .42, top=TOP + .18), .14)


AXIS = np.array([.9, -.42, -.1], np.float32)
AXIS /= np.linalg.norm(AXIS)
TIPC = np.float32(.8)


def along(p): return p @ AXIS - TIPC
def around(p): return np.linalg.norm(p - (p @ AXIS)[..., None] * AXIS, axis=-1)


def ellipsoid(p, r):
    r = np.asarray(r, np.float32)
    k = np.linalg.norm(p / r, axis=-1)
    return k * (k - 1) / (np.linalg.norm(p / r / r, axis=-1) + 1e-6)


def bud(p):
    d = ellipsoid(p, (.82, .66, .8))
    t = np.clip(p @ AXIS, .2, .84)
    d = smin(d, np.linalg.norm(p - t[..., None] * AXIS, axis=-1) - .3, .2)
    return smax(d, p[..., 1] - .5, .16)  # softly flattened outer face


def tip(p):
    def k(q): return ((around(q) / .6) ** 2.3 + (np.abs(along(q)) / .66) ** 2.3 + 1e-12) ** (1 / 2.3)
    o = implicit(k, p)
    d = smax(o, -.16 - along(p), .06)
    d = smax(d, -np.maximum(o + .1, along(p) - .4), .04)
    return smax(d, -(around(p) - .19), .07)


def dot(p, x, z, r): return smax(np.hypot(p[..., 0] - x, p[..., 2] - z) - r, np.maximum(bud(p) - .02, -bud(p) - .04), .02)


def rot(axis, deg): return trimesh.transformations.rotation_matrix(np.radians(deg), axis)


def seat(side):
    c, s = np.cos(np.radians(20)), np.sin(np.radians(20))
    T = np.eye(4)
    T[:3, 0], T[:3, 1], T[:3, 2] = (-1, 0, 0), (0, -s, c), (0, c, s)
    T = rot([0, 0, 1], 8) @ T
    T[:3, 3] = (-1.15, -.1, 1.55)
    return T if side == "L" else np.diag([-1, 1, 1, 1.]) @ T


def deck(p):
    inv = np.linalg.inv(seat("L")).astype(np.float32)
    z = p[..., 2]
    d = smax(case(p, .085, top=2), (z - SEAM - .04) * .95, .06)
    q = p.copy()
    q[..., 0] = -np.abs(q[..., 0])
    d = smax(d, -ellipsoid(q - np.array([-1.35, -.05, 1.65], np.float32), (1.3, 1.05, .8)), .1)
    b = q @ inv[:3, :3].T + inv[:3, 3]
    c = np.clip(b @ AXIS, .6, 1.2)
    clear = np.minimum(bud(b), np.linalg.norm(b - c[..., None] * AXIS, axis=-1) - .6)
    return smax(d, -(clear - .05), .06)


def main(out):
    s = trimesh.Scene()
    g = s.graph

    def node(name, parent, T=np.eye(4)): g.update(frame_to=name, frame_from=parent, matrix=T)

    def add(m, parent):
        n = m.metadata["name"]
        s.add_geometry(m, node_name=n, geom_name=n, parent_node_name=parent)

    hinge = np.eye(4)
    hinge[:3, 3] = HINGE
    node("Earbuds", "world", rot([1, 0, 0], -90))
    node("Base", "Earbuds")
    node("Lid", "Earbuds", hinge)
    lo, hi = (-A, -B, 0), (A, B, SEAM)
    add(mesh(base_shell, lo, hi, .026, 14000, SHELL, "Base_Shell"), "Base")
    add(mesh(deck, lo, (A, B, SEAM + .1), .03, 14000, LINER, "Base_Deck"), "Base")
    add(mesh(lambda p: np.maximum(np.maximum(np.hypot(p[..., 0], p[..., 2] - .9) - .056, np.abs(case(p) + .04) - .012),
                                  p[..., 1] + 1.5), (-.1, -2.5, .8), (.1, -1.9, 1), .01, 300, DARK, "Base_LED"), "Base")
    for f, n, m in ((lid_shell, "Lid_Shell", SHELL), (lid_liner, "Lid_Liner", LINER)):
        x = mesh(f, (-A, -B, SEAM), (A, B, SEAM + TOP + .2), .026, 12000, m, n)
        x.vertices = x.vertices - HINGE
        add(x, "Lid")
    c = AXIS * TIPC
    for side in "LR":
        T = seat(side)
        node(f"Bud{side}", "Earbuds", T if side == "L" else T @ np.diag([-1., 1, 1, 1]))
        parts = [mesh(bud, (-.9, -.8, -.9), (1.2, .6, .9), .024, 7000, BUD, f"Bud{side}_Body"),
                 mesh(tip, c - .72, c + [.72] * 3, .022, 5000, TIP, f"Bud{side}_Tip"),
                 mesh(lambda p: smax(around(p) - .23, np.abs(along(p) - .4) - .03, .01), c + AXIS * .4 - .3, c + AXIS * .4 + .3,
                      .02, 300, DARK, f"Bud{side}_Grille")]
        for i, z in enumerate((.34, -.36)):
            parts.append(mesh(lambda p, z=z: np.maximum(dot(p, -.1, z, .09), p[..., 1]), (-.25, -.85, z - .15), (.05, 0, z + .15),
                              .012, 500, METAL, f"Bud{side}_Contact{i}"))
        for m in parts:
            if side == "R":  # bake the mirror so the node stays a pure rotation
                m = trimesh.Trimesh(m.vertices * [-1, 1, 1], m.faces[:, ::-1], vertex_normals=m.vertex_normals * [-1, 1, 1],
                                    process=False, metadata=m.metadata, visual=m.visual)
            add(m, f"Bud{side}")
        for part in ("Body", "Tip"):  # fit check
            M, _ = g.get(f"Bud{side}", "Earbuds")
            v = (s.geometry[f"Bud{side}_{part}"].vertices @ M[:3, :3].T + M[:3, 3]).astype(np.float32)
            lid, floor, wall = lid_liner(v).min(), deck(v).min(), case(v, .1).max()
            print(f"Bud{side}_{part}: lid {lid:+.3f}  deck {floor:+.3f}  wall {wall:+.3f}")
            assert lid > 0 and floor > 0 and wall < 0, "the buds don't fit the case"
    Path(out).write_bytes(s.export(file_type="glb", include_normals=True))
    print(out, sum(len(m.faces) for m in s.geometry.values()), "triangles")


main(sys.argv[1])
