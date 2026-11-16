"""
Path-traced, photographic versions of every 3D object on the site: the
eleven desktop icons plus a settings gear, in the same light and the same
materials as the hero, so every page reads as one set of real objects.

    Blender -b scripts/3d/adeia-3d.blend --python scripts/3d/render-realistic.py -- OUT_DIR HDRI [I_policy ...]

Each flat material becomes a physical one by role:
  blue / violet  -> tinted glass with depth absorption, like the wordmark
  white / sand   -> frosted acrylic (rough transmission, a little scatter)
  pink           -> pink glass
  steel / chrome -> brushed metal with anisotropic streaks
  black          -> smoked glass
Parts are inflated (deep bevel + subdivision) so nothing has a hard edge,
a few glass marbles float around each object, and a shadow catcher gives
each a soft contact shadow on a transparent background.
"""

import bpy, bmesh, sys, math, random, os
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :]
OUT, HDRI = argv[0], argv[1]
ONLY = set(argv[2:])
os.makedirs(OUT, exist_ok=True)
scene = bpy.context.scene
SIZE = int(os.environ.get("ART_SIZE", "1024"))

def bsdf_of(m):
    m.use_nodes = True
    return next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")

def put(node, name, value):
    if name in node.inputs:
        node.inputs[name].default_value = value

def peel(mat, strength=0.03, scale=160.0):
    nt = mat.node_tree
    b = bsdf_of(mat)
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.inputs["Scale"].default_value = scale
    n.inputs["Detail"].default_value = 4.0
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = strength
    bump.inputs["Distance"].default_value = 0.01
    nt.links.new(n.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    if "Coat Normal" in b.inputs:
        nt.links.new(bump.outputs["Normal"], b.inputs["Coat Normal"])

def smudged_roughness(mat, lo, hi):
    nt = mat.node_tree
    b = bsdf_of(mat)
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.inputs["Scale"].default_value = 3.0
    r = nt.nodes.new("ShaderNodeMapRange")
    r.inputs["To Min"].default_value = lo
    r.inputs["To Max"].default_value = hi
    nt.links.new(n.outputs["Fac"], r.inputs["Value"])
    nt.links.new(r.outputs["Result"], b.inputs["Roughness"])

def absorb(mat, rgb, density):
    nt = mat.node_tree
    v = nt.nodes.new("ShaderNodeVolumeAbsorption")
    v.inputs["Color"].default_value = (*rgb, 1)
    v.inputs["Density"].default_value = density
    out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
    nt.links.new(v.outputs[0], out.inputs["Volume"])

def glass(name, rgb, lift=0.3, density=0.5, rough=(0.015, 0.08)):
    m = bpy.data.materials.new(name)
    b = bsdf_of(m)
    put(b, "Base Color", (*[lift + (1 - lift) * c for c in rgb], 1))
    put(b, "Transmission Weight", 1.0)
    put(b, "IOR", 1.5)
    put(b, "Coat Weight", 1.0)
    put(b, "Coat Roughness", 0.03)
    put(b, "Thin Film Thickness", 300.0)
    put(b, "Thin Film IOR", 1.33)
    smudged_roughness(m, *rough)
    peel(m)
    absorb(m, [0.35 + 0.65 * c for c in rgb], density)
    return m

def frosted(name, rgb):
    m = bpy.data.materials.new(name)
    b = bsdf_of(m)
    put(b, "Base Color", (*rgb, 1))
    put(b, "Transmission Weight", 0.85)
    put(b, "IOR", 1.49)
    put(b, "Subsurface Weight", 0.25)
    put(b, "Subsurface Radius", (0.3, 0.3, 0.35))
    put(b, "Subsurface Scale", 0.08)
    put(b, "Coat Weight", 0.7)
    put(b, "Coat Roughness", 0.06)
    smudged_roughness(m, 0.28, 0.42)
    peel(m, 0.02)
    return m

def brushed(name, rgb):
    m = bpy.data.materials.new(name)
    b = bsdf_of(m)
    nt = m.node_tree
    put(b, "Base Color", (*rgb, 1))
    put(b, "Metallic", 1.0)
    put(b, "Anisotropic", 0.75)
    put(b, "Coat Weight", 0.4)
    put(b, "Coat Roughness", 0.04)
    coord = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (240.0, 1.0, 1.0)
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.inputs["Scale"].default_value = 5.0
    n.inputs["Detail"].default_value = 8.0
    r = nt.nodes.new("ShaderNodeMapRange")
    r.inputs["To Min"].default_value = 0.12
    r.inputs["To Max"].default_value = 0.3
    nt.links.new(coord.outputs["Object"], mp.inputs["Vector"])
    nt.links.new(mp.outputs["Vector"], n.inputs["Vector"])
    nt.links.new(n.outputs["Fac"], r.inputs["Value"])
    nt.links.new(r.outputs["Result"], b.inputs["Roughness"])
    return m

def smoked(name):
    m = glass(name, (0.05, 0.05, 0.08), lift=0.0, density=2.2, rough=(0.02, 0.06))
    return m

ROLE = {
    "Amber": lambda: glass("R_Blue", (0.074, 0.125, 1.0), lift=0.12, density=1.1),
    "Sweep": lambda: glass("R_Sweep", (0.16, 0.05, 1.0), lift=0.12, density=1.1),
    "Copper": lambda: glass("R_Violet", (0.434, 0.072, 1.0), lift=0.12, density=1.0),
    "Rust": lambda: glass("R_Pink", (0.922, 0.198, 0.509), lift=0.25, density=0.6),
    "Bone": lambda: frosted("R_Frost", (0.96, 0.96, 0.98)),
    "Sand": lambda: frosted("R_Sand", (0.86, 0.84, 0.9)),
    "Steel": lambda: brushed("R_Steel", (0.62, 0.62, 0.66)),
    "Chrome": lambda: brushed("R_Chrome", (0.93, 0.93, 0.96)),
    "Ink": lambda: smoked("R_Ink"),
    "Graphite": lambda: smoked("R_Graphite"),
    "Graphite2": lambda: smoked("R_Graphite2"),
}
made = {}
def real(mat):
    if mat is None or mat.name not in ROLE:
        return mat
    if mat.name not in made:
        made[mat.name] = ROLE[mat.name]()
    return made[mat.name]

# ---------- geometry: inflate, and fonts become meshes ----------
def inflate(obj):
    if obj.type == "FONT":
        obj.data.bevel_resolution = max(obj.data.bevel_resolution, 6)
    if obj.type != "MESH":
        return
    dims = sorted(d for d in obj.dimensions if d > 1e-4)
    thin = dims[0] if dims else 0.1
    bev = next((m for m in obj.modifiers if m.type == "BEVEL"), None) or obj.modifiers.new("Bevel", "BEVEL")
    bev.width = thin * 0.42
    bev.segments = 8
    bev.limit_method = "ANGLE"
    if hasattr(bev, "use_clamp_overlap"):
        bev.use_clamp_overlap = True
    sub = obj.modifiers.new("Soft", "SUBSURF")
    sub.levels = sub.render_levels = 2
    for p in obj.data.polygons:
        p.use_smooth = True

def bounds(objs):
    lo = Vector((1e9,) * 3); hi = Vector((-1e9,) * 3)
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
    return lo, hi

MARBLES = [None, None]
def marbles(col, seed):
    if MARBLES[0] is None:
        MARBLES[0] = glass("R_MarbleBlue", (0.1, 0.25, 1.0), lift=0.45, density=0.3)
        MARBLES[1] = glass("R_MarbleClear", (1.0, 1.0, 1.0), lift=1.0, density=0.05)
    rnd = random.Random(seed)
    objs = [o for o in col.objects if o.type in ("MESH", "FONT", "CURVE")]
    lo, hi = bounds(objs)
    centre = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.5)
    for i in range(6):
        a = rnd.uniform(0, math.tau); el = rnd.uniform(-0.4, 0.6)
        r = radius * rnd.uniform(1.05, 1.3)
        s = radius * rnd.choice([0.03, 0.045, 0.06, 0.08])
        bpy.ops.mesh.primitive_uv_sphere_add(radius=s, segments=48, ring_count=24, location=(
            centre.x + math.cos(a) * r * math.cos(el), centre.y + math.sin(a) * r * math.cos(el), centre.z + math.sin(el) * r * 0.8))
        o = bpy.context.active_object
        bpy.ops.object.shade_smooth()
        o.data.materials.append(MARBLES[i % 2])
        for c in o.users_collection:
            c.objects.unlink(o)
        col.objects.link(o)
    return lo

# ---------- a settings gear, built here: there is no model for it ----------
def build_gear():
    col = bpy.data.collections.new("I_settings")
    scene.collection.children.link(col)
    bm = bmesh.new()
    teeth, r_in, r_out, depth = 10, 0.62, 0.86, 0.32
    bmesh.ops.create_cone(bm, cap_ends=True, segments=96, radius1=r_in, radius2=r_in, depth=depth)
    for i in range(teeth):
        a = i / teeth * math.tau
        t = bmesh.ops.create_cube(bm, size=1.0)
        vs = t["verts"]
        bmesh.ops.scale(bm, vec=(0.26, 0.3, depth), verts=vs)
        bmesh.ops.translate(bm, vec=((r_in + r_out) / 2 + 0.02, 0, 0), verts=vs)
        bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=__import__("mathutils").Matrix.Rotation(a, 3, "Z"), verts=vs)
    me = bpy.data.meshes.new("Gear")
    bm.to_mesh(me); bm.free()
    gear = bpy.data.objects.new("Gear", me)
    col.objects.link(gear)
    rm = gear.modifiers.new("Fuse", "REMESH"); rm.mode = "VOXEL"; rm.voxel_size = 0.018
    hole = bpy.data.objects.new("GearHole", bpy.data.meshes.new("Hole"))
    hb = bmesh.new(); bmesh.ops.create_cone(hb, cap_ends=True, segments=64, radius1=0.24, radius2=0.24, depth=1.0); hb.to_mesh(hole.data); hb.free()
    col.objects.link(hole); hole.hide_render = True; hole.hide_viewport = True
    bo = gear.modifiers.new("Hole", "BOOLEAN"); bo.object = hole; bo.operation = "DIFFERENCE"
    sm = gear.modifiers.new("Melt", "SMOOTH"); sm.factor = 1.0; sm.iterations = 6
    sub = gear.modifiers.new("Soft", "SUBSURF"); sub.levels = sub.render_levels = 1
    for p in gear.data.polygons:
        p.use_smooth = True
    gear.data.materials.append(bpy.data.materials["Chrome"])
    gear.rotation_euler = (math.radians(90), 0, 0)
    # A tinted glass hub, so the gear is not all metal.
    bpy.ops.mesh.primitive_torus_add(major_radius=0.36, minor_radius=0.1, major_segments=96, minor_segments=32,
                                     location=(0, -0.2, 0), rotation=(math.radians(90), 0, 0))
    hub = bpy.context.active_object
    bpy.ops.object.shade_smooth()
    hub.data.materials.append(bpy.data.materials["Amber"])
    for c in hub.users_collection:
        c.objects.unlink(hub)
    col.objects.link(hub)
    col.hide_render = True
    return col

build_gear()

# ---------- light and ground, shared with the hero ----------
for n in ("Key", "Fill", "Rim"):
    if n in bpy.data.objects:
        bpy.data.objects[n].hide_render = True
world = scene.world or bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
wt = world.node_tree
for n in list(wt.nodes):
    wt.nodes.remove(n)
env = wt.nodes.new("ShaderNodeTexEnvironment"); env.image = bpy.data.images.load(HDRI)
wc = wt.nodes.new("ShaderNodeTexCoord"); wm = wt.nodes.new("ShaderNodeMapping")
wm.inputs["Rotation"].default_value = (0, 0, 0.6)
bg = wt.nodes.new("ShaderNodeBackground"); bg.inputs["Strength"].default_value = 1.15
wo = wt.nodes.new("ShaderNodeOutputWorld")
wt.links.new(wc.outputs["Generated"], wm.inputs["Vector"])
wt.links.new(wm.outputs["Vector"], env.inputs["Vector"])
wt.links.new(env.outputs["Color"], bg.inputs["Color"])
wt.links.new(bg.outputs[0], wo.inputs["Surface"])

scene.render.engine = "CYCLES"
prefs = bpy.context.preferences.addons["cycles"].preferences
prefs.compute_device_type = "METAL"; prefs.get_devices()
for d in prefs.devices:
    d.use = True
scene.cycles.device = "GPU"
scene.cycles.samples = int(os.environ.get("ART_SAMPLES", "160"))
scene.cycles.use_adaptive_sampling = True
scene.cycles.use_denoising = True
scene.cycles.max_bounces = 16
scene.cycles.transmission_bounces = 16
scene.cycles.blur_glossy = 0.4
scene.render.film_transparent = True
scene.cycles.film_transparent_glass = True
scene.cycles.film_transparent_roughness = 0.12
scene.render.resolution_x = scene.render.resolution_y = SIZE
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
try:
    scene.view_settings.view_transform = "AgX"
except TypeError:
    pass
scene.camera = bpy.data.objects["IconCam"]
scene.camera.data.lens *= 1.05

icons = [c for c in bpy.data.collections if c.name.startswith("I_")]
for c in icons:
    c.hide_render = True
for wm_name in ("Wordmark", "Ring"):
    if wm_name in bpy.data.objects:
        bpy.data.objects[wm_name].hide_render = True

for i, col in enumerate(icons):
    if ONLY and col.name not in ONLY:
        continue
    for o in list(col.objects):
        inflate(o)
        for slot in o.material_slots:
            slot.material = real(slot.material)
    lo = marbles(col, i)
    # A contact shadow reads well in the full render but leaves a hard-edged
    # grey haze on a transparent cut-out; ART_SHADOW=0 leaves it out.
    ground = None
    if os.environ.get("ART_SHADOW", "1") != "0":
        bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, lo.z - 0.02))
        ground = bpy.context.active_object
        ground.is_shadow_catcher = True
    col.hide_render = False
    scene.render.filepath = os.path.join(OUT, f"art-{col.name[2:]}.png")
    bpy.ops.render.render(write_still=True)
    col.hide_render = True
    if ground:
        bpy.data.objects.remove(ground, do_unlink=True)
    print("RENDERED", scene.render.filepath)
