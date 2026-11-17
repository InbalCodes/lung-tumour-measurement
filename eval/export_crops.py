"""Export a cropped CT block and the expert mask for every case, as plain binary files.

The browser tool's own TypeScript code is scored in Node (app/scripts/evaluate.ts). Node reads
these crops instead of parsing 250 DICOM files per case, which keeps each scoring run to seconds.

Per case, under data/derived/crops:
  <case>.json   shape, spacing, crop offset in the full scan, slice numbers
  <case>.i16    CT block in Hounsfield units, int16 little endian, order (z, y, x)
  <case>.u8     expert mask on the same grid, one byte per voxel

Run from the project root:  python eval/export_crops.py [seconds_budget]
"""
import csv
import json
import sys
import time

import numpy as np

from lib import DERIVED, ROOT, load_geometry, load_volume
from validate_reference import load_mask

MARGIN_MM = 35.0
OUT = DERIVED / "crops"


def main():
    budget = float(sys.argv[1]) if len(sys.argv) > 1 else 1e9
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    rows = [r for r in csv.DictReader(open(ROOT / "eval" / "reference" / "reference_measurements.csv"))
            if r["outline"] == "man"]
    left = 0
    for r in rows:
        case = r["case"]
        if (OUT / f"{case}.json").exists():
            continue
        if time.time() - t0 > budget:
            left += 1
            continue
        geo = load_geometry(r["series_uid"])
        mask = load_mask(case, "man")
        zz, yy, xx = np.nonzero(mask)
        sz, sy, sx = geo["dz"], geo["spacing"][0], geo["spacing"][1]
        mz, my, mx = (int(np.ceil(MARGIN_MM / s)) for s in (sz, sy, sx))
        lo = [max(int(zz.min()) - mz, 0), max(int(yy.min()) - my, 0), max(int(xx.min()) - mx, 0)]
        hi = [min(int(zz.max()) + mz + 1, mask.shape[0]), min(int(yy.max()) + my + 1, mask.shape[1]),
              min(int(xx.max()) + mx + 1, mask.shape[2])]
        vol = load_volume(geo)
        block = vol[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]]
        block.astype("<i2").tofile(OUT / f"{case}.i16")
        mask[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]].astype(np.uint8).tofile(OUT / f"{case}.u8")
        auto = load_mask(case, "auto")
        if auto is not None:
            auto[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]].astype(np.uint8).tofile(OUT / f"{case}.auto.u8")
        (OUT / f"{case}.json").write_text(json.dumps({
            "case": case, "patient_id": r["patient_id"], "session": r["session"],
            "shape": list(block.shape), "spacing": [sz, sy, sx], "offset": lo,
            "instance_numbers": geo["instance_numbers"][lo[0]:hi[0]],
            "has_auto": auto is not None,
            "reference": {k: float(r[k]) for k in
                          ("long_axis_mm", "short_axis_mm", "mean_diameter_mm", "volume_mm3")},
            "reference_slice_number": int(r["slice_number"]),
        }))
        print(case, block.shape, flush=True)
    print("left to do:", left)


if __name__ == "__main__":
    main()
