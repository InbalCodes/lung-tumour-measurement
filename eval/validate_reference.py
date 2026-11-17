"""Check the RTSTRUCT-to-mask conversion in two independent ways.

1. Against the DICOM SEG objects published with the dataset: the same outlines, already stored
   as voxel masks by the dataset authors. Our masks should overlap them almost perfectly.
2. By eye: PNG overlays of the manual outline on its CT slice, written to data/derived/overlays.

Run from the project root:  python eval/validate_reference.py [max_seg_files]
"""
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pydicom

from lib import DICOM, DERIVED, dice, load_geometry


def load_mask(case, kind):
    p = DERIVED / "masks" / f"{case}_{kind}.npz"
    if not p.exists():
        return None
    d = np.load(p)
    mask = np.zeros(tuple(d["shape"]), dtype=bool)
    o, c = d["offset"], d["crop"]
    mask[o[0]:o[0] + c.shape[0], o[1]:o[1] + c.shape[1], o[2]:o[2] + c.shape[2]] = c
    return mask


def seg_masks(path, geo):
    """Read a DICOM SEG into {segment_number: mask} on the CT grid."""
    ds = pydicom.dcmread(path)
    frames = ds.pixel_array
    if frames.ndim == 2:
        frames = frames[None]
    z = np.asarray(geo["z"])
    out = {}
    for i, fg in enumerate(ds.PerFrameFunctionalGroupsSequence):
        seg = int(fg.SegmentIdentificationSequence[0].ReferencedSegmentNumber)
        zpos = float(fg.PlanePositionSequence[0].ImagePositionPatient[2])
        k = int(np.argmin(np.abs(z - zpos)))
        out.setdefault(seg, np.zeros((len(z), geo["rows"], geo["cols"]), dtype=bool))[k] |= frames[i] > 0
    return ds, out


def check_seg(limit):
    done = 0
    worst = 1.0
    for d in sorted((DICOM / "seg").iterdir()):
        f = next(iter(sorted(d.rglob("*.dcm"))), None)
        if f is None:
            continue
        head = pydicom.dcmread(f, stop_before_pixels=True)
        if head.Modality != "SEG":
            continue
        geo = load_geometry(str(head.ReferencedSeriesSequence[0].SeriesInstanceUID))
        session = "retest" if "RETEST" in str(head.SeriesDescription).upper() else "test"
        case = f"{head.PatientID}_{session}"
        _, segs = seg_masks(f, geo)
        ours = {k: load_mask(case, k) for k in ("man", "auto")}
        scores = {s: {k: round(dice(m, ours[k]), 4) for k in ours if ours[k] is not None}
                  for s, m in segs.items()}
        best = [max(v.values()) for v in scores.values()]
        worst = min(worst, min(best))
        print(case, scores, flush=True)
        done += 1
        if done >= limit:
            break
    print(f"checked {done} SEG files; lowest best-match Dice = {worst}")


def overlays(cases):
    out = DERIVED / "overlays"
    out.mkdir(parents=True, exist_ok=True)
    import csv
    from lib import ROOT
    rows = {(r["case"], r["outline"]): r
            for r in csv.DictReader(open(ROOT / "eval" / "reference" / "reference_measurements.csv"))}
    for case in cases:
        r = rows[(case, "man")]
        geo = load_geometry(r["series_uid"])
        k = geo["instance_numbers"].index(int(r["slice_number"]))
        ds = pydicom.dcmread(DICOM / "ct" / geo["series_uid"] / geo["files"][k])
        hu = ds.pixel_array * float(ds.RescaleSlope) + float(ds.RescaleIntercept)
        fig, axes = plt.subplots(1, 2, figsize=(11, 5.5))
        cr, cc = float(r["centroid_row"]), float(r["centroid_col"])
        half = 70
        for ax, (lo, hi, title) in zip(axes, [(-1350, 150, "lung window"), (-160, 240, "soft-tissue window")]):
            ax.imshow(hu, cmap="gray", vmin=lo, vmax=hi)
            for kind, colour in (("man", "lime"), ("auto", "orange")):
                m = load_mask(case, kind)
                if m is not None and m[k].any():
                    ax.contour(m[k], levels=[0.5], colors=colour, linewidths=1)
            ax.set_xlim(cc - half, cc + half); ax.set_ylim(cr + half, cr - half)
            ax.set_title(title, fontsize=10); ax.axis("off")
        fig.suptitle(f"{case}  slice {r['slice_number']}  long axis {r['long_axis_mm']} mm  "
                     f"volume {r['volume_mm3']} mm3   green = expert, orange = dataset auto", fontsize=10)
        fig.tight_layout()
        fig.savefig(out / f"{case}.png", dpi=90)
        plt.close(fig)
        print("wrote", out / f"{case}.png")


if __name__ == "__main__":
    if sys.argv[1] == "seg":
        check_seg(int(sys.argv[2]))
    else:
        overlays(sys.argv[2:])
