import ezdxf, json, os, math

outdir = "C:/project/enersy/dxf-sto-symbols"

# 1. Parse old individual DXF files
old_dir = "C:/project/enersy/dxf-symbols"
for fname in os.listdir(old_dir):
    if not fname.endswith(".dxf"):
        continue
    path = os.path.join(old_dir, fname)
    try:
        doc = ezdxf.readfile(path)
        msp = doc.modelspace()
        entities = list(msp)
        print(f"=== {fname} ({len(entities)} entities) ===")
        for e in entities:
            dxf = e.dxftype()
            if dxf == "LINE":
                print(
                    f"  LINE: ({e.dxf.start.x:.1f},{e.dxf.start.y:.1f}) -> ({e.dxf.end.x:.1f},{e.dxf.end.y:.1f})"
                )
            elif dxf == "CIRCLE":
                print(
                    f"  CIRCLE: center=({e.dxf.center.x:.1f},{e.dxf.center.y:.1f}) r={e.dxf.radius:.1f}"
                )
            elif dxf == "ARC":
                print(
                    f"  ARC: center=({e.dxf.center.x:.1f},{e.dxf.center.y:.1f}) r={e.dxf.radius:.1f} a={e.dxf.start_angle:.0f}-{e.dxf.end_angle:.0f}"
                )
            elif dxf == "LWPOLYLINE":
                pts = list(e.get_points())
                print(f"  LWPOLYLINE: {len(pts)} points")
            elif dxf == "MTEXT":
                print(
                    f'  MTEXT: "{e.dxf.text[:40]}" pos=({e.dxf.insert.x:.1f},{e.dxf.insert.y:.1f})'
                )
            elif dxf == "TEXT":
                print(f'  TEXT: "{e.dxf.text}"')
            else:
                print(f"  {dxf}")
        print()
    except Exception as ex:
        print(f"=== {fname} === ERROR: {ex}\n")

# 2. Parse STO DXF - show layers and entities per layer
sto_path = "C:/Users/skynet-user/Desktop/STO.dxf"
doc = ezdxf.readfile(sto_path)
msp = doc.modelspace()

# Count entities per layer
layer_counts = {}
for e in msp:
    l = e.dxf.layer
    layer_counts[l] = layer_counts.get(l, 0) + 1

print("\n=== STO DXF Layers ===")
for l, c in sorted(layer_counts.items(), key=lambda x: -x[1]):
    print(f"  {l}: {c} entities")

# Check for blocks
print(f"\n=== STO DXF Blocks ===")
for name in doc.blocks:
    blk = doc.blocks[name]
    print(f"  Block: {name} ({len(list(blk))} entities)")
