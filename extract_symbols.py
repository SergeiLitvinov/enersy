import ezdxf, math, json
from collections import defaultdict

doc = ezdxf.readfile("C:/Users/skynet-user/Desktop/STO.dxf")
msp = doc.modelspace()

# Collect all entities with their bounding boxes
entities = []
for e in msp:
    dxftype = e.dxftype()
    if dxftype == "LINE":
        x1, y1 = e.dxf.start.x, e.dxf.start.y
        x2, y2 = e.dxf.end.x, e.dxf.end.y
        bb = (min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2))
        entities.append(("LINE", bb, e))
    elif dxftype == "CIRCLE":
        cx, cy, r = e.dxf.center.x, e.dxf.center.y, e.dxf.radius
        bb = (cx - r, cy - r, cx + r, cy + r)
        entities.append(("CIRCLE", bb, e))
    elif dxftype == "ARC":
        cx, cy, r = e.dxf.center.x, e.dxf.center.y, e.dxf.radius
        bb = (cx - r, cy - r, cx + r, cy + r)
        entities.append(("ARC", bb, e))
    elif dxftype == "LWPOLYLINE":
        pts = list(e.get_points())
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        bb = (min(xs), min(ys), max(xs), max(ys))
        entities.append(("LWPOLYLINE", bb, e))

print(f"Total entities: {len(entities)}")

# Find the drawing frame border (the largest rectangle)
max_area = 0
frame_bb = None
for i, (t, bb, e) in enumerate(entities):
    if t == "LINE":
        w = bb[2] - bb[0]
        h = bb[3] - bb[1]
        if w > 100 and h > 100:
            area = w * h
            if area > max_area:
                max_area = area
                frame_bb = bb

print(f"Frame border: {frame_bb}")

# Filter out frame entities (near the border)
margin = 10
SYMBOL_ENTITIES = []
FRAME_ENTITIES = []
for t, bb, e in entities:
    if frame_bb:
        near_left = abs(bb[0] - frame_bb[0]) < margin
        near_right = abs(bb[2] - frame_bb[2]) < margin
        near_top = abs(bb[1] - frame_bb[1]) < margin
        near_bottom = abs(bb[3] - frame_bb[3]) < margin
        if near_left or near_right or near_top or near_bottom:
            FRAME_ENTITIES.append((t, bb, e))
            continue
    SYMBOL_ENTITIES.append((t, bb, e))

print(f"Symbol entities: {len(SYMBOL_ENTITIES)}")
print(f"Frame entities: {len(FRAME_ENTITIES)}")


# Group symbol entities by proximity clustering
def cluster_entities(entities, max_dist=15):
    clusters = []
    assigned = set()
    for i, (t1, bb1, e1) in enumerate(entities):
        if i in assigned:
            continue
        cluster = [i]
        assigned.add(i)
        cx1 = (bb1[0] + bb1[2]) / 2
        cy1 = (bb1[1] + bb1[3]) / 2
        for j, (t2, bb2, e2) in enumerate(entities):
            if j in assigned:
                continue
            cx2 = (bb2[0] + bb2[2]) / 2
            cy2 = (bb2[1] + bb2[3]) / 2
            dist = math.hypot(cx2 - cx1, cy2 - cy1)
            if dist < max_dist:
                cluster.append(j)
                assigned.add(j)
        clusters.append(cluster)
    return clusters


clusters = cluster_entities(SYMBOL_ENTITIES, max_dist=20)
print(f"Found {len(clusters)} clusters")

# Export each cluster as an SVG
outdir = "C:/project/enersy/dxf-sto-symbols-v2"
import os

os.makedirs(outdir, exist_ok=True)


def entity_to_svg(t, e):
    if t == "LINE":
        return f'<line x1="{e.dxf.start.x:.2f}" y1="{e.dxf.start.y:.2f}" x2="{e.dxf.end.x:.2f}" y2="{e.dxf.end.y:.2f}" stroke="#000" stroke-width="1.5"/>'
    elif t == "CIRCLE":
        return f'<circle cx="{e.dxf.center.x:.2f}" cy="{e.dxf.center.y:.2f}" r="{e.dxf.radius:.2f}" fill="none" stroke="#000" stroke-width="1.5"/>'
    elif t == "ARC":
        cx, cy, r = e.dxf.center.x, e.dxf.center.y, e.dxf.radius
        sa, ea = e.dxf.start_angle, e.dxf.end_angle
        # Convert degrees to radians
        sa_r, ea_r = math.radians(sa), math.radians(ea)
        x1 = cx + r * math.cos(sa_r)
        y1 = cy + r * math.sin(sa_r)
        x2 = cx + r * math.cos(ea_r)
        y2 = cy + r * math.sin(ea_r)
        large = 1 if (ea - sa) > 180 else 0
        return f'<path d="M{x1:.2f} {y1:.2f} A{r:.2f} {r:.2f} 0 {large} 1 {x2:.2f} {y2:.2f}" fill="none" stroke="#000" stroke-width="1.5"/>'
    elif t == "LWPOLYLINE":
        pts = list(e.get_points())
        d = "M" + " ".join(f"{p[0]:.2f},{p[1]:.2f}" for p in pts)
        if e.closed:
            d += " Z"
        return f'<path d="{d}" fill="none" stroke="#000" stroke-width="1.5"/>'
    return ""


exported = []
for idx, cluster in enumerate(clusters):
    items = []
    for i in cluster:
        t, bb, e = SYMBOL_ENTITIES[i]
        items.append((t, bb, e))

    # Compute overall bounding box
    xs = [bb[0] for _, bb, _ in items] + [bb[2] for _, bb, _ in items]
    ys = [bb[1] for _, bb, _ in items] + [bb[3] for _, bb, _ in items]
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)

    w = maxx - minx
    h = maxy - miny
    if w < 3 or h < 3:
        continue  # skip tiny clusters

    pad = 10
    vw = w + 2 * pad
    vh = h + 2 * pad

    elements = []
    for t, bb, e in items:
        svg = entity_to_svg(t, e)
        if svg:
            elements.append(svg)

    if not elements:
        continue

    svg_content = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{minx - pad} {miny - pad} {vw} {vh}" width="{vw}" height="{vh}">\n<rect width="100%" height="100%" fill="white"/>\n'
    svg_content += "\n".join(elements)
    svg_content += "\n</svg>"

    fname = f"cluster_{idx:04d}.svg"
    with open(os.path.join(outdir, fname), "w", encoding="utf-8") as f:
        f.write(svg_content)
    exported.append(fname)

print(f"Exported {len(exported)} cluster SVGs to {outdir}")
