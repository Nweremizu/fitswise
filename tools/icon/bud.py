"""blender -b -P tools/icon/bud.py -- MODEL.glb OUT.png SIZE SAMPLES YAW PITCH ROLL

Renders one earbud from the app's generic model for the icon, on a transparent background.
tools/icon/compose.py puts it on the tile. YAW, PITCH and ROLL pose the bud, in degrees.
"""
import math
import sys

import bpy
from mathutils import Euler, Matrix, Vector

model, out, size, samples, yaw, pitch, roll = sys.argv[sys.argv.index("--") + 1:]
size, samples = int(size), int(samples)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=model)

KEEP = ("BudR_Body", "BudR_Tip", "BudR_Grille")
bud = bpy.data.objects["BudR"]
for o in list(sc.objects):
    if o.name not in KEEP and o is not bud:
        bpy.data.objects.remove(o)
# Undo the seat in the case and centre the bud, then pose it for the camera.
bud.parent = None
bpy.context.view_layer.update()
bud.matrix_world = Matrix.Identity(4)
bpy.context.view_layer.update()
pts = [o.matrix_world @ Vector(c) for o in bud.children for c in o.bound_box]
mid = sum(pts, Vector()) / len(pts)
for o in bud.children:
    o.location -= mid
bud.rotation_mode = "XYZ"
bud.rotation_euler = Euler([math.radians(float(a)) for a in (pitch, roll, yaw)], "XYZ")


def srgb(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


def material(color, rough, coat=0.0, sss=0.0, sheen=0.0):
    m = bpy.data.materials.new(color)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*srgb(color), 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Coat Weight"].default_value = coat
    p.inputs["Coat Roughness"].default_value = 0.05
    p.inputs["Subsurface Weight"].default_value = sss
    p.inputs["Subsurface Radius"].default_value = (0.5, 0.6, 0.7)
    p.inputs["Subsurface Scale"].default_value = 0.05
    p.inputs["Sheen Weight"].default_value = sheen
    return m


PAINT = {
    "BudR_Body": material("#f4f6f7", 0.3, coat=0.7, sss=0.06),
    "BudR_Tip": material("#a6d6e6", 0.5, sss=0.3, sheen=0.4),
    "BudR_Grille": material("#1d2429", 0.5),
}
for o in bud.children:
    o.data.materials.clear()
    o.data.materials.append(PAINT[o.name])
    for p in o.data.polygons:
        p.use_smooth = True

w = bpy.data.worlds.new("w")
sc.world = w
w.use_nodes = True
w.node_tree.nodes["Background"].inputs[0].default_value = (0.74, 0.82, 0.88, 1)
w.node_tree.nodes["Background"].inputs[1].default_value = 0.4


def light(loc, energy, size, color=(1, 1, 1)):
    d = bpy.data.lights.new("l", "AREA")
    d.energy, d.size, d.color = energy, size, color
    o = bpy.data.objects.new("l", d)
    sc.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (-Vector(loc)).to_track_quat("-Z", "Y").to_euler()


light((-5, -6, 7), 1100, 6)            # soft key, upper left
light((6, -5, 1), 220, 7, (0.85, 0.93, 1))  # fill
light((3, 7, 4), 900, 3, (0.6, 0.85, 0.96))  # cool rim from behind
light((0, -2, 9), 200, 10)             # top sheen

cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
cam.data.type = "ORTHO"
sc.collection.objects.link(cam)
sc.camera = cam
cam.location = (0, -20, 0)
cam.rotation_euler = (math.pi / 2, 0, 0)
bpy.context.view_layer.update()
# frame the posed bud with a little room
pts = [cam.matrix_world.inverted() @ (o.matrix_world @ Vector(c)) for o in bud.children for c in o.bound_box]
xs, ys = [p.x for p in pts], [p.y for p in pts]
cam.data.ortho_scale = max(max(xs) - min(xs), max(ys) - min(ys)) * 1.12
cam.location += cam.matrix_world.to_3x3() @ Vector(((max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2, 0))

sc.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
for kind in ("OPTIX", "CUDA"):
    try:
        prefs.compute_device_type = kind
        prefs.get_devices()
        for dev in prefs.devices:
            dev.use = dev.type == kind
        sc.cycles.device = "GPU"
        break
    except TypeError:
        pass
sc.cycles.samples, sc.cycles.use_denoising = samples, True
sc.render.resolution_x = sc.render.resolution_y = size
sc.render.film_transparent = True
sc.view_settings.view_transform = "AgX"
sc.view_settings.look = "AgX - Medium High Contrast"
sc.render.image_settings.file_format = "PNG"
sc.render.image_settings.color_mode = "RGBA"
sc.render.image_settings.color_depth = "16"
sc.render.filepath = out
bpy.ops.render.render(write_still=True)
