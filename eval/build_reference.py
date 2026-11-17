"""Build reference measurements from the expert outlines in RIDER-LungCT-Seg.

For every RTSTRUCT file this script:
  1. finds the CT series it refers to,
  2. converts the manual outline (GTVp_*_man) and the dataset's own automatic outline
     (GTVp_*_auto) to voxel masks,
  3. measures each mask (volume, long axis, short axis, mean diameter, slice),
  4. saves the masks under data/derived/masks and the measurements as CSV.

Run from the project root:  python eval/build_reference.py
"""
import csv
import json

import numpy as np
import pydicom

from lib import DICOM, DERIVED, ROOT, compare, contours_to_mask, load_geometry, measure, read_rtstruct

OUT = ROOT / "eval" / "reference"
MASKS = DERIVED / "masks"


def save_mask(path, mask):
    """Store only the bounding box of the mask plus its offset; full volumes are mostly empty."""
    zz, rr, cc = np.nonzero(mask)
    lo = [int(zz.min()), int(rr.min()), int(cc.min())]
    hi = [int(zz.max()) + 1, int(rr.max()) + 1, int(cc.max()) + 1]
    np.savez_compressed(path, crop=mask[lo[0]:hi[0], lo[1]:hi[1], lo[2]:hi[2]],
                        offset=np.array(lo), shape=np.array(mask.shape))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    MASKS.mkdir(parents=True, exist_ok=True)
    rows, problems = [], []
    for d in sorted((DICOM / "seg").iterdir()):
        f = next(iter(sorted(d.rglob("*.dcm"))), None)
        if f is None or pydicom.dcmread(f, stop_before_pixels=True).Modality != "RTSTRUCT":
            continue
        rt = read_rtstruct(f)
        geo = load_geometry(rt["ref_series"])
        if geo["orientation"] != [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]:
            problems.append(f"{rt['patient_id']}: non-axial orientation {geo['orientation']}")
            continue
        masks = {}
        for name, contours in rt["rois"].items():
            parts = name.lower().split("_")            # GTVp_test_man -> session=test, kind=man
            session, kind = parts[1], parts[2]
            if not contours:
                problems.append(f"{rt['patient_id']} {name}: empty outline")
                continue
            mask = contours_to_mask(contours, geo)
            masks[kind] = mask
            case = f"{rt['patient_id']}_{session}"
            save_mask(MASKS / f"{case}_{kind}.npz", mask)
            m = measure(mask, geo)
            z_idx = m["slice_index"]
            rows.append({
                "case": case, "patient_id": rt["patient_id"], "session": session, "outline": kind,
                "series_uid": geo["series_uid"], "study_date": geo["study_date"],
                "series_number": geo["series_number"], "slice_thickness_mm": geo["slice_thickness"],
                "pixel_mm": round(geo["spacing"][0], 4), "n_ct_slices": len(geo["z"]),
                "slice_number": geo["instance_numbers"][z_idx],
                "long_axis_mm": m["long_axis_mm"], "short_axis_mm": m["short_axis_mm"],
                "mean_diameter_mm": m["mean_diameter_mm"], "volume_mm3": round(m["volume_mm3"]),
                "n_outline_slices": m["n_slices"], "n_voxels": m["n_voxels"],
                "centroid_z": round(m["centroid_index"][0], 1),
                "centroid_row": round(m["centroid_index"][1], 1),
                "centroid_col": round(m["centroid_index"][2], 1),
                "n_contours": len(contours),
            })
        if "man" in masks and "auto" in masks:
            rows[-1 if rows[-1]["outline"] == "auto" else -2].update(
                {f"vs_manual_{k}": v for k, v in compare(masks["auto"], masks["man"], geo).items()})
        print(rt["patient_id"], rt["label"], {k: int(v.sum()) for k, v in masks.items()}, flush=True)

    rows.sort(key=lambda r: (r["patient_id"], r["session"], r["outline"]))
    fields = list(dict.fromkeys(k for r in rows for k in r))
    with open(OUT / "reference_measurements.csv", "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    (OUT / "problems.json").write_text(json.dumps(problems, indent=2))
    print(f"\n{len(rows)} outlines written, {len(problems)} problems")
    for p in problems:
        print("  ", p)


if __name__ == "__main__":
    main()
