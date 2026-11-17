"""Cache slice geometry for every downloaded CT series (headers only). Safe to re-run."""
import sys, time
from lib import DICOM, DERIVED, load_geometry

t0 = time.time()
todo = [d.name for d in sorted((DICOM / "ct").iterdir())
        if d.is_dir() and not (DERIVED / "geometry" / f"{d.name}.json").exists()]
budget = float(sys.argv[1]) if len(sys.argv) > 1 else 1e9
for i, uid in enumerate(todo):
    if time.time() - t0 > budget:
        print(f"stopped after {i} series, {len(todo) - i} left"); sys.exit(0)
    g = load_geometry(uid)
    print(f"{g['patient_id']} {len(g['z'])} slices dz={g['dz']:.2f}", flush=True)
print("all series indexed")
