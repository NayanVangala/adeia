"""
Renders the desktop icons from adeia-3d.blend in the soft, liquid style.

    Blender -b scripts/3d/adeia-3d.blend --python scripts/3d/render-icons.py -- OUT_DIR [I_policy ...]

The source models are bevelled boxes. Here every part is inflated — a
bevel close to half its thinnest side, then subdivision — so edges become
pillows, and materials get a clear coat so they read as wet candy rather
than matte plastic. A few glossy motes orbit each object: the particle
language of the hero, at icon scale. Nothing is saved back to the .blend.
"""

import bpy, sys, math, random, os

argv = sys.argv[sys.argv.index("--") + 1 :]
OUT = argv[0]
ONLY = set(argv[1:])
os.makedirs(OUT, exist_ok=True)
scene = bpy.context.scene

# ---------- materials: wet, coated, a touch of subsurface ----------
for m in bpy.data.materials:
    if not m.use_nodes:
        continue
    bsdf = next((n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if not bsdf:
        continue
    metal = bsdf.inputs["Metallic"].default_value
    bsdf.inputs["Coat Weight"].default_value = 1.0
    bsdf.inputs["Coat Roughness"].default_value = 0.04
    bsdf.inputs["Roughness"].default_value = 0.12 if metal > 0.5 else 0.32
    if metal < 0.5:
        bsdf.inputs["Subsurface Weight"].default_value = 0.12
        bsdf.inputs["Subsurface Radius"].default_value = (0.2, 0.15, 0.3)
        bsdf.inputs["Subsurface Scale"].default_value = 0.05

def mote_material(name, rgb, emit):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (*rgb, 1)
    b.inputs["Roughness"].default_value = 0.05
    b.inputs["Coat Weight"].default_value = 1.0
    b.inputs["Emission Color"].default_value = (*rgb, 1)
    b.inputs["Emission Strength"].default_value = emit
    return m

MOTES = [
    mote_material("MoteBlue", (0.05, 0.16, 1.0), 1.5),
    mote_material("MoteViolet", (0.35, 0.08, 1.0), 1.5),
    mote_material("MoteWhite", (1.0, 1.0, 1.0), 3.0),
]

# ---------- inflate ----------
def inflate(obj):
    if obj.type != "MESH":
        return
    dims = sorted(d for d in obj.dimensions if d > 1e-4)
    thin = dims[0] if dims else 0.1
    bev = next((m for m in obj.modifiers if m.type == "BEVEL"), None) or obj.modifiers.new("Bevel", "BEVEL")
    bev.width = thin * 0.42
    bev.segments = 6
    bev.limit_method = "ANGLE"
    bev.harden_normals = False
    if hasattr(bev, "use_clamp_overlap"):
        bev.use_clamp_overlap = True
    sub = obj.modifiers.new("Soft", "SUBSURF")
    sub.levels = 2
    sub.render_levels = 2
    for p in obj.data.polygons:
        p.use_smooth = True

def bounds(objs):
    import mathutils
    lo = mathutils.Vector((1e9,) * 3)
    hi = mathutils.Vector((-1e9,) * 3)
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ mathutils.Vector(c)
            lo = mathutils.Vector(map(min, lo, w))
            hi = mathutils.Vector(map(max, hi, w))
    return lo, hi

def add_motes(col, seed):
    rnd = random.Random(seed)
    objs = [o for o in col.objects if o.type in ("MESH", "FONT", "CURVE")]
    lo, hi = bounds(objs)
    centre = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.5)
    made = []
    for i in range(11):
        a = rnd.uniform(0, math.tau)
        el = rnd.uniform(-0.5, 0.7)
        r = radius * rnd.uniform(1.05, 1.35)
        size = radius * rnd.choice([0.022, 0.03, 0.04, 0.055, 0.07])
        bpy.ops.mesh.primitive_uv_sphere_add(
            radius=size,
            segments=24,
            ring_count=12,
            location=(
                centre.x + math.cos(a) * r * math.cos(el),
                centre.y + math.sin(a) * r * math.cos(el),
                centre.z + math.sin(el) * r * 0.8,
            ),
        )
        s = bpy.context.active_object
        bpy.ops.object.shade_smooth()
        s.data.materials.append(MOTES[i % 3])
        for c in s.users_collection:
            c.objects.unlink(s)
        col.objects.link(s)
        made.append(s)
    return made

# ---------- light: soft studio, no hard shadows ----------
def area(name, loc, energy, size, color=(1, 1, 1)):
    d = bpy.data.lights.new(name, "AREA")
    d.energy, d.size, d.color = energy, size, color
    o = bpy.data.objects.new(name, d)
    scene.collection.objects.link(o)
    o.location = loc
    tgt = bpy.data.objects.get("IconTarget")
    con = o.constraints.new("TRACK_TO")
    con.target = tgt
    con.track_axis, con.up_axis = "TRACK_NEGATIVE_Z", "UP_Y"
    return o

for n in ("Key", "Fill", "Rim"):
    if n in bpy.data.objects:
        bpy.data.objects[n].hide_render = True
area("SoftKey", (-3, -4, 4), 900, 5)
area("SoftFill", (4, -3, 1), 350, 6, (0.85, 0.88, 1.0))
area("SoftRim", (2, 4, 3), 600, 3, (0.75, 0.7, 1.0))
area("SoftUnder", (0, -2, -3), 120, 6, (0.8, 0.85, 1.0))

world = scene.world
if world and world.use_nodes:
    bg = next((n for n in world.node_tree.nodes if n.type == "BACKGROUND"), None)
    if bg:
        bg.inputs["Color"].default_value = (0.82, 0.84, 0.95, 1)
        bg.inputs["Strength"].default_value = 0.6

# ---------- render ----------
try:
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 96
    scene.cycles.use_denoising = True
    try:
        scene.cycles.device = "GPU"
    except Exception:
        pass
except TypeError:
    pass
scene.render.film_transparent = True
scene.render.resolution_x = scene.render.resolution_y = 512
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.camera = bpy.data.objects["IconCam"]
scene.camera.data.lens *= 1.08  # tighter: the old frame left a lot of air

icons = [c for c in bpy.data.collections if c.name.startswith("I_")]
for c in icons:
    c.hide_render = True
for i, col in enumerate(icons):
    if ONLY and col.name not in ONLY:
        continue
    for o in col.objects:
        inflate(o)
    motes = add_motes(col, i)
    for wm in ("Wordmark", "Ring"):
        if wm in bpy.data.objects:
            bpy.data.objects[wm].hide_render = True
    col.hide_render = False
    scene.render.filepath = os.path.join(OUT, f"icon-{col.name[2:]}.png")
    bpy.ops.render.render(write_still=True)
    col.hide_render = True
    print("RENDERED", scene.render.filepath)
