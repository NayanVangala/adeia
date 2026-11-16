"""
Exports every desktop object (the eleven icons and a settings gear) as one
Draco-compressed GLB for the live renderer, src/frontend/objects3d.js.

    Blender -b scripts/3d/adeia-3d.blend --python scripts/3d/export-objects.py -- OUT.glb

Each object is inflated (deep bevel + subdivision) like the renders, then
decimated to a budget so a page of them stays light. Each collection
becomes one top-level node named after it ("policy", "audit", ...), centred
on the origin; its parts keep material names, which the page maps to
physical materials by role (glass, frosted acrylic, brushed metal, smoked).
"""

import bpy, bmesh, sys, math
from mathutils import Matrix, Vector

OUT = sys.argv[sys.argv.index("--") + 1]
BUDGET = 9000  # triangles per object

scene = bpy.context.scene

def build_gear():
    col = bpy.data.collections.new("I_settings")
    scene.collection.children.link(col)
    bm = bmesh.new()
    teeth, r_in, r_out, depth = 10, 0.62, 0.86, 0.32
    bmesh.ops.create_cone(bm, cap_ends=True, segments=96, radius1=r_in, radius2=r_in, depth=depth)
    for i in range(teeth):
        a = i / teeth * math.tau
        vs = bmesh.ops.create_cube(bm, size=1.0)["verts"]
        bmesh.ops.scale(bm, vec=(0.26, 0.3, depth), verts=vs)
        bmesh.ops.translate(bm, vec=((r_in + r_out) / 2 + 0.02, 0, 0), verts=vs)
        bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(a, 3, "Z"), verts=vs)
    me = bpy.data.meshes.new("Gear")
    bm.to_mesh(me); bm.free()
    gear = bpy.data.objects.new("Gear", me)
    col.objects.link(gear)
    rm = gear.modifiers.new("Fuse", "REMESH"); rm.mode = "VOXEL"; rm.voxel_size = 0.02
    sm = gear.modifiers.new("Melt", "SMOOTH"); sm.factor = 1.0; sm.iterations = 6
    gear.data.materials.append(bpy.data.materials["Chrome"])
    gear.rotation_euler = (math.radians(90), 0, 0)
    bpy.ops.mesh.primitive_torus_add(major_radius=0.36, minor_radius=0.11, major_segments=64, minor_segments=24,
                                     location=(0, -0.2, 0), rotation=(math.radians(90), 0, 0))
    hub = bpy.context.active_object
    hub.data.materials.append(bpy.data.materials["Amber"])
    for c in hub.users_collection:
        c.objects.unlink(hub)
    col.objects.link(hub)

build_gear()

# Fonts become meshes so they can be inflated and exported.
for o in list(bpy.data.objects):
    if o.type == "FONT" and o.name != "Wordmark":
        o.data.bevel_resolution = 4

out_root = bpy.data.collections.new("Export")
scene.collection.children.link(out_root)
dg = bpy.context.evaluated_depsgraph_get()

for col in [c for c in bpy.data.collections if c.name.startswith("I_")]:
    parts = [o for o in col.objects if o.type in ("MESH", "FONT", "CURVE")]
    if not parts:
        continue
    # Inflate on the source objects, then bake everything to plain meshes.
    for o in parts:
        if o.type != "MESH":
            continue
        dims = sorted(d for d in o.dimensions if d > 1e-4)
        thin = dims[0] if dims else 0.1
        bev = next((m for m in o.modifiers if m.type == "BEVEL"), None) or o.modifiers.new("Bevel", "BEVEL")
        bev.width = thin * 0.42
        bev.segments = 5
        bev.limit_method = "ANGLE"
        if hasattr(bev, "use_clamp_overlap"):
            bev.use_clamp_overlap = True
        if not any(m.type == "REMESH" for m in o.modifiers):
            sub = o.modifiers.new("Soft", "SUBSURF"); sub.levels = 1
    dg = bpy.context.evaluated_depsgraph_get()
    baked = []
    for o in parts:
        me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
        me.transform(o.matrix_world)
        for p in me.polygons:
            p.use_smooth = True
        n = bpy.data.objects.new(o.name + "_x", me)
        out_root.objects.link(n)
        baked.append(n)
    # Budget: decimate proportionally so the whole object fits.
    tris = sum(sum(len(p.vertices) - 2 for p in b.data.polygons) for b in baked)
    if tris > BUDGET:
        ratio = BUDGET / tris
        for b in baked:
            d = b.modifiers.new("Budget", "DECIMATE"); d.ratio = ratio
            bpy.context.view_layer.objects.active = b
            dg2 = bpy.context.evaluated_depsgraph_get()
            me2 = bpy.data.meshes.new_from_object(b.evaluated_get(dg2))
            b.modifiers.clear()
            b.data = me2
    # Centre the group on the origin under a named empty.
    lo = Vector((1e9,) * 3); hi = Vector((-1e9,) * 3)
    for b in baked:
        for v in b.data.vertices:
            lo = Vector(map(min, lo, v.co)); hi = Vector(map(max, hi, v.co))
    centre = (lo + hi) / 2
    root = bpy.data.objects.new(col.name[2:], None)
    out_root.objects.link(root)
    for b in baked:
        b.data.transform(Matrix.Translation(-centre))
        b.parent = root
    print("OBJECT", root.name, "tris", sum(sum(len(p.vertices) - 2 for p in b.data.polygons) for b in baked))

# Export only the baked collection.
for o in bpy.context.view_layer.objects:
    o.select_set(False)
for o in out_root.objects:
    o.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    use_selection=True,
    export_apply=True,
    export_yup=True,
    export_materials="EXPORT",
    export_draco_mesh_compression_enable=True,
    export_draco_mesh_compression_level=7,
    export_draco_position_quantization=14,
    export_draco_normal_quantization=10,
)
print("EXPORTED", OUT)
