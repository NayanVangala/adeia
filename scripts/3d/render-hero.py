"""
Path-traces the hero — the glass word and the orbiting brushed ring — as a
seamless 12-second loop with a transparent background.

    Blender -b scripts/3d/adeia-3d.blend --python scripts/3d/render-hero.py -- OUT_DIR HDRI [first last]

Motion matches src/frontend/hero3d.js exactly (same formulas, in three.js
space, converted per frame), so the live particles drawn over the video can
be driven by the video's own clock and stay in register with the ring.

Every motion has a period that divides LOOP, so frame LOOP*FPS is frame 0.
"""

import bpy, bmesh, sys, math, os
from mathutils import Matrix, Vector

argv = sys.argv[sys.argv.index("--") + 1 :]
OUT, HDRI = argv[0], argv[1]
FIRST = int(argv[2]) if len(argv) > 2 else 0
LOOP, FPS = 12, 24
LAST = int(argv[3]) if len(argv) > 3 else LOOP * FPS - 1
W = 2 * math.pi / LOOP
RING_R, TUBE = 2.4, 0.105
os.makedirs(OUT, exist_ok=True)

scene = bpy.context.scene

# three.js (x, y up, z toward camera)  ->  Blender (x, -z, y)
C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
CI = C.inverted()

def euler_xyz(x, y, z):
    """three.js Euler order 'XYZ': R = Rx * Ry * Rz."""
    return Matrix.Rotation(x, 4, "X") @ Matrix.Rotation(y, 4, "Y") @ Matrix.Rotation(z, 4, "Z")

# ---------- clear everything but what we build ----------
for o in list(bpy.data.objects):
    if o.name != "Wordmark":
        bpy.data.objects.remove(o, do_unlink=True)

# ---------- the word, as a mesh in three-local space, centred ----------
src = bpy.data.objects["Wordmark"]
src.data.bevel_resolution = 10
src.data.resolution_u = 14
dg = bpy.context.evaluated_depsgraph_get()
me = bpy.data.meshes.new_from_object(src.evaluated_get(dg))
xs = [v.co.x for v in me.vertices]; ys = [v.co.y for v in me.vertices]; zs = [v.co.z for v in me.vertices]
centre = Vector(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2))
me.transform(Matrix.Translation(-centre))
HALF_W = (max(xs) - min(xs)) / 2
me.transform(C)  # three-local -> Blender-local
for p in me.polygons:
    p.use_smooth = True
word = bpy.data.objects.new("GlassWord", me)
scene.collection.objects.link(word)
bpy.data.objects.remove(src, do_unlink=True)

# ---------- the ring ----------
bpy.ops.mesh.primitive_torus_add(major_radius=RING_R, minor_radius=TUBE, major_segments=384, minor_segments=64, generate_uvs=True)
ring = bpy.context.active_object
ring.name = "Ring"
ring.data.transform(C)
bpy.ops.object.shade_smooth()

# ---------- materials ----------
def principled(mat):
    mat.use_nodes = True
    return next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")

def set_in(node, name, value):
    if name in node.inputs:
        node.inputs[name].default_value = value

glass = bpy.data.materials.new("Glass")
g = principled(glass)
nt = glass.node_tree
tex = nt.nodes.new("ShaderNodeTexCoord")
sep = nt.nodes.new("ShaderNodeSeparateXYZ")
mr = nt.nodes.new("ShaderNodeMapRange")
mr.inputs["From Min"].default_value = -HALF_W
mr.inputs["From Max"].default_value = HALF_W
ramp = nt.nodes.new("ShaderNodeValToRGB")
lift = 0.24
for pos, rgb in ((0.0, (0.014, 0.06, 1.0)), (0.5, (0.102, 0.024, 1.0)), (1.0, (0.328, 0.006, 1.0))):
    e = ramp.color_ramp.elements[0] if pos == 0 else (ramp.color_ramp.elements[1] if pos == 1 else ramp.color_ramp.elements.new(pos))
    e.position = pos
    e.color = (*[lift + (1 - lift) * c for c in rgb], 1)
nt.links.new(tex.outputs["Object"], sep.inputs[0])
nt.links.new(sep.outputs["X"], mr.inputs["Value"])
nt.links.new(mr.outputs["Result"], ramp.inputs["Fac"])
nt.links.new(ramp.outputs["Color"], g.inputs["Base Color"])
set_in(g, "Transmission Weight", 1.0)
set_in(g, "IOR", 1.5)
set_in(g, "Coat Weight", 1.0)
set_in(g, "Coat Roughness", 0.03)
set_in(g, "Thin Film Thickness", 320.0)
set_in(g, "Thin Film IOR", 1.33)
# Smudges: roughness wanders between polished and faintly hazy.
smudge = nt.nodes.new("ShaderNodeTexNoise")
smudge.inputs["Scale"].default_value = 2.2
smr = nt.nodes.new("ShaderNodeMapRange")
smr.inputs["To Min"].default_value = 0.015
smr.inputs["To Max"].default_value = 0.11
nt.links.new(smudge.outputs["Fac"], smr.inputs["Value"])
nt.links.new(smr.outputs["Result"], g.inputs["Roughness"])
# Orange peel and a few dents in the surface.
peel = nt.nodes.new("ShaderNodeTexNoise")
peel.inputs["Scale"].default_value = 180.0
peel.inputs["Detail"].default_value = 4.0
bump = nt.nodes.new("ShaderNodeBump")
bump.inputs["Strength"].default_value = 0.035
bump.inputs["Distance"].default_value = 0.01
nt.links.new(peel.outputs["Fac"], bump.inputs["Height"])
nt.links.new(bump.outputs["Normal"], g.inputs["Normal"])
if "Coat Normal" in g.inputs:
    nt.links.new(bump.outputs["Normal"], g.inputs["Coat Normal"])
# Depth tint: thicker glass, deeper colour.
vol = nt.nodes.new("ShaderNodeVolumeAbsorption")
vol.inputs["Color"].default_value = (0.42, 0.34, 1.0, 1)
vol.inputs["Density"].default_value = 0.45
out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
nt.links.new(vol.outputs[0], out.inputs["Volume"])
word.data.materials.append(glass)

metal = bpy.data.materials.new("Brushed")
m = principled(metal)
mt = metal.node_tree
set_in(m, "Base Color", (0.93, 0.93, 0.96, 1))
set_in(m, "Metallic", 1.0)
set_in(m, "Anisotropic", 0.8)
set_in(m, "Coat Weight", 0.45)
set_in(m, "Coat Roughness", 0.04)
uv = mt.nodes.new("ShaderNodeTexCoord")
mapping = mt.nodes.new("ShaderNodeMapping")
mapping.inputs["Scale"].default_value = (1.0, 260.0, 1.0)  # streaks run around the ring
streak = mt.nodes.new("ShaderNodeTexNoise")
streak.inputs["Scale"].default_value = 6.0
streak.inputs["Detail"].default_value = 8.0
rr = mt.nodes.new("ShaderNodeMapRange")
rr.inputs["To Min"].default_value = 0.12
rr.inputs["To Max"].default_value = 0.3
mt.links.new(uv.outputs["UV"], mapping.inputs["Vector"])
mt.links.new(mapping.outputs["Vector"], streak.inputs["Vector"])
mt.links.new(streak.outputs["Fac"], rr.inputs["Value"])
mt.links.new(rr.outputs["Result"], m.inputs["Roughness"])
tan = mt.nodes.new("ShaderNodeTangent")
tan.direction_type = "UV_MAP"
if "Tangent" in m.inputs:
    mt.links.new(tan.outputs["Tangent"], m.inputs["Tangent"])
ring.data.materials.append(metal)

# ---------- ground that only catches shadow ----------
bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, -1.95))
ground = bpy.context.active_object
ground.is_shadow_catcher = True

# ---------- light: the same studio HDRI the live scene uses ----------
world = scene.world or bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
wt = world.node_tree
for n in list(wt.nodes):
    wt.nodes.remove(n)
env = wt.nodes.new("ShaderNodeTexEnvironment")
env.image = bpy.data.images.load(HDRI)
wcoord = wt.nodes.new("ShaderNodeTexCoord")
wmap = wt.nodes.new("ShaderNodeMapping")
wmap.inputs["Rotation"].default_value = (0, 0, 0.6)
bg = wt.nodes.new("ShaderNodeBackground")
bg.inputs["Strength"].default_value = 1.1
wout = wt.nodes.new("ShaderNodeOutputWorld")
wt.links.new(wcoord.outputs["Generated"], wmap.inputs["Vector"])
wt.links.new(wmap.outputs["Vector"], env.inputs["Vector"])
wt.links.new(env.outputs["Color"], bg.inputs["Color"])
wt.links.new(bg.outputs[0], wout.inputs["Surface"])

# ---------- camera: three.js PerspectiveCamera(30) at (0, 1.1, 8.6) ----------
cam_data = bpy.data.cameras.new("HeroCam")
cam_data.sensor_fit = "VERTICAL"
cam_data.angle = math.radians(30)
cam = bpy.data.objects.new("HeroCam", cam_data)
scene.collection.objects.link(cam)
cam.location = C @ Vector((0, 1.1, 8.6))
cam.rotation_euler = (cam.location * -1).to_track_quat("-Z", "Y").to_euler()
scene.camera = cam

# ---------- render settings ----------
scene.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
prefs.compute_device_type = "METAL"
prefs.get_devices()
for d in prefs.devices:
    d.use = True
scene.cycles.device = "GPU"
scene.cycles.samples = int(os.environ.get("HERO_SAMPLES", "128"))
scene.cycles.use_adaptive_sampling = True
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 16
scene.cycles.transmission_bounces = 16
scene.cycles.glossy_bounces = 8
scene.cycles.caustics_refractive = True
scene.cycles.caustics_reflective = True
scene.cycles.blur_glossy = 0.4
scene.render.film_transparent = True
scene.cycles.film_transparent_glass = True
scene.cycles.film_transparent_roughness = 0.12
scene.render.use_motion_blur = True
scene.render.motion_blur_shutter = 0.4
scene.render.resolution_x = int(os.environ.get("HERO_W", "1600"))
scene.render.resolution_y = int(os.environ.get("HERO_H", "888"))
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
try:
    scene.view_settings.view_transform = "AgX"
except TypeError:
    pass
scene.render.fps = FPS

# ---------- motion: hero3d.js formulas, keyed per frame ----------
def at(t):
    word_m = Matrix.Translation((0, math.sin(2 * W * t) * 0.06, 0)) @ euler_xyz(0, math.sin(W * t) * 0.18, 0)
    pivot_m = euler_xyz(0, W * t, 0.32)
    ring_m = pivot_m @ euler_xyz(1.15 + math.sin(W * t) * 0.12, 0, 0)
    return C @ word_m @ CI, C @ ring_m @ CI

# Keyed one frame either side of the range so motion blur has neighbours.
for f in range(FIRST - 1, LAST + 2):
    wm, rm = at(f / FPS)
    word.matrix_world = wm
    ring.matrix_world = rm
    for o in (word, ring):
        o.keyframe_insert("location", frame=f)
        o.keyframe_insert("rotation_euler", frame=f)
for o in (word, ring):
    for fc in o.animation_data.action.fcurves if hasattr(o.animation_data.action, "fcurves") else []:
        for k in fc.keyframe_points:
            k.interpolation = "LINEAR"

scene.frame_start, scene.frame_end = FIRST, LAST
scene.render.filepath = os.path.join(OUT, "f_")
bpy.ops.render.render(animation=True)
print("RENDERED", FIRST, LAST)
