"""blender -b -P tools/render_poster.py -- IN.glb OUT.webp

Renders the closed case from the app's opening camera (see buds-scene.ts), so the still picture and live 3D line up.
"""
import math
import sys

import bpy
from mathutils import Vector

src, out = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
sc = bpy.context.scene
sc.render.engine = "CYCLES"
sc.cycles.samples, sc.cycles.use_denoising = 96, True
prefs = bpy.context.preferences.addons["cycles"].preferences
for kind in ("OPTIX", "CUDA"):
    try:
        prefs.compute_device_type = kind
        prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type == kind
        sc.cycles.device = "GPU"
        break
    except TypeError:
        pass
sc.render.resolution_x = sc.render.resolution_y = 640
sc.render.film_transparent = True
sc.view_settings.view_transform = "Standard"
sc.world = bpy.data.worlds.new("w")
sc.world.use_nodes = True
sc.world.node_tree.nodes["Background"].inputs[1].default_value = .75
sc.world.node_tree.nodes["Background"].inputs[0].default_value = (1, 1, 1, 1)
for loc, energy in (((-9, -8, 14), 700), ((10, -4, 9), 300)):
    light = bpy.data.lights.new("a", "AREA")
    light.energy, light.size = energy, 9
    o = bpy.data.objects.new("a", light)
    sc.collection.objects.link(o)
    o.location = loc
    o.rotation_euler = (Vector((0, 0, 1)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
cam.data.angle = math.radians(28)
sc.collection.objects.link(cam)
sc.camera = cam
angle, r = .3, 21.5  # three.js (x, y, z) is Blender (x, -z, y)
cam.location = (math.sin(angle) * r, -math.cos(angle) * r, 8.2)
cam.rotation_euler = (Vector((0, .6, 1.6)) - cam.location).to_track_quat("-Z", "Y").to_euler()
sc.render.image_settings.file_format = "WEBP"
sc.render.image_settings.color_mode = "RGBA"
sc.render.image_settings.quality = 82
sc.render.filepath = out
bpy.ops.render.render(write_still=True)
