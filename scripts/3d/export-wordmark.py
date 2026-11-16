import bpy, struct, sys, bmesh
out = sys.argv[sys.argv.index("--")+1]
w = bpy.data.objects["Wordmark"]
w.data.bevel_resolution = 6
w.data.resolution_u = 8
dg = bpy.context.evaluated_depsgraph_get()
me = bpy.data.meshes.new_from_object(w.evaluated_get(dg))
bm = bmesh.new(); bm.from_mesh(me); bmesh.ops.triangulate(bm, faces=bm.faces); bm.to_mesh(me); bm.free()
try:
    normals = [tuple(n.vector) for n in me.corner_normals]
except AttributeError:
    me.calc_normals_split(); normals = [tuple(l.normal) for l in me.loops]
verts = me.vertices
xs=[v.co.x for v in verts]; ys=[v.co.y for v in verts]; zs=[v.co.z for v in verts]
cx,cy,cz=(min(xs)+max(xs))/2,(min(ys)+max(ys))/2,(min(zs)+max(zs))/2
key={}; pos=[]; nor=[]; idx=[]
for poly in me.polygons:
    for li in poly.loop_indices:
        v = verts[me.loops[li].vertex_index].co
        n = normals[li]
        k = (me.loops[li].vertex_index, round(n[0],3), round(n[1],3), round(n[2],3))
        if k not in key:
            key[k]=len(pos)//3
            pos += [v.x-cx, v.y-cy, v.z-cz]; nor += list(n)
        idx.append(key[k])
nv=len(pos)//3
with open(out,"wb") as f:
    f.write(struct.pack("<II", nv, len(idx)))
    S = 2.0  # positions stored as int16 / 32767 * S
    f.write(struct.pack(f"<{len(pos)}h", *[round(max(-1,min(1,p/S))*32767) for p in pos]))
    nb = [round(max(-1,min(1,n))*127) for n in nor]
    nb += [0]*((-len(nb))%4)
    f.write(struct.pack(f"<{len(nb)}b", *nb))
    f.write(struct.pack(f"<{len(idx)}{'H' if nv<65536 else 'I'}", *idx))
print("WORD verts",nv,"tris",len(idx)//3,"size",(max(xs)-min(xs),max(ys)-min(ys),max(zs)-min(zs)), bpy.app.version_string)
