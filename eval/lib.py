"""Shared helpers for preparing reference data and scoring outlines.

Everything here works on plain numpy arrays so the same measurements can be applied to an
expert outline and to a tool-generated outline.

Conventions
- A mask is a boolean array shaped (slices, rows, cols), slices ordered by increasing z.
- Geometry for a CT series is a dict: origin (x, y of the first pixel centre, mm), spacing
  (row mm, col mm), z (list of slice positions, mm), dz (median slice spacing, mm).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pydicom
from matplotlib.path import Path as MplPath

ROOT = Path(__file__).resolve().parent.parent
DICOM = ROOT / "data" / "dicom"
DERIVED = ROOT / "data" / "derived"


# ---------------------------------------------------------------- CT geometry

def series_files(series_dir: Path) -> list[Path]:
    return sorted(p for p in series_dir.rglob("*.dcm"))


def read_geometry(series_dir: Path) -> dict:
    """Read slice positions and pixel spacing for one CT series (headers only)."""
    slices = []
    first = None
    for f in series_files(series_dir):
        ds = pydicom.dcmread(f, stop_before_pixels=True)
        if first is None:
            first = ds
        slices.append((float(ds.ImagePositionPatient[2]), str(ds.SOPInstanceUID), f.name,
                       int(ds.InstanceNumber)))
    slices.sort()
    z = [s[0] for s in slices]
    orientation = [round(float(v), 4) for v in first.ImageOrientationPatient]
    return {
        "series_uid": str(first.SeriesInstanceUID),
        "study_uid": str(first.StudyInstanceUID),
        "patient_id": str(first.PatientID),
        "study_date": str(getattr(first, "StudyDate", "")),
        "series_number": int(getattr(first, "SeriesNumber", 0) or 0),
        "slice_thickness": float(first.SliceThickness),
        "rows": int(first.Rows),
        "cols": int(first.Columns),
        "origin": [float(first.ImagePositionPatient[0]), float(first.ImagePositionPatient[1])],
        "spacing": [float(first.PixelSpacing[0]), float(first.PixelSpacing[1])],  # row, col
        "orientation": orientation,
        "z": z,
        "dz": float(np.median(np.diff(z))) if len(z) > 1 else float(first.SliceThickness),
        "sop_uids": [s[1] for s in slices],
        "files": [s[2] for s in slices],
        "instance_numbers": [s[3] for s in slices],
    }


def load_geometry(series_uid: str) -> dict:
    """Geometry for a series, cached as JSON under data/derived/geometry."""
    cache = DERIVED / "geometry" / f"{series_uid}.json"
    if cache.exists():
        return json.loads(cache.read_text())
    geo = read_geometry(DICOM / "ct" / series_uid)
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(geo))
    return geo


def load_volume(geo: dict) -> np.ndarray:
    """Load the CT volume in Hounsfield units, shaped (slices, rows, cols)."""
    series_dir = DICOM / "ct" / geo["series_uid"]
    vol = np.empty((len(geo["files"]), geo["rows"], geo["cols"]), dtype=np.int16)
    for i, name in enumerate(geo["files"]):
        ds = pydicom.dcmread(series_dir / name)
        hu = ds.pixel_array.astype(np.float32) * float(ds.RescaleSlope) + float(ds.RescaleIntercept)
        vol[i] = hu.astype(np.int16)
    return vol


# ------------------------------------------------------------ RTSTRUCT -> mask

def read_rtstruct(path: Path) -> dict:
    """Return {roi_name: [contour, ...]} where a contour is an (n, 3) array in mm."""
    ds = pydicom.dcmread(path)
    names = {int(r.ROINumber): str(r.ROIName) for r in ds.StructureSetROISequence}
    ref_series = str(ds.ReferencedFrameOfReferenceSequence[0].RTReferencedStudySequence[0]
                     .RTReferencedSeriesSequence[0].SeriesInstanceUID)
    rois: dict[str, list[np.ndarray]] = {}
    for rc in ds.ROIContourSequence:
        name = names[int(rc.ReferencedROINumber)]
        contours = []
        for c in getattr(rc, "ContourSequence", []):
            pts = np.asarray(c.ContourData, dtype=float).reshape(-1, 3)
            if len(pts) >= 3:
                contours.append(pts)
        rois[name] = contours
    return {"patient_id": str(ds.PatientID), "ref_series": ref_series, "rois": rois,
            "label": str(getattr(ds, "StructureSetLabel", ""))}


def contours_to_mask(contours: list[np.ndarray], geo: dict) -> np.ndarray:
    """Fill planar contours into a voxel mask.

    A pixel belongs to the outline when its centre lies inside the polygon. Several contours
    on one slice are combined with XOR, the usual convention for holes.
    """
    z = np.asarray(geo["z"])
    mask = np.zeros((len(z), geo["rows"], geo["cols"]), dtype=bool)
    x0, y0 = geo["origin"]
    sr, sc = geo["spacing"]
    for pts in contours:
        k = int(np.argmin(np.abs(z - pts[0, 2])))
        if abs(z[k] - pts[0, 2]) > geo["dz"] / 2 + 1e-3:
            raise ValueError(f"contour at z={pts[0, 2]} does not sit on a slice")
        cols = (pts[:, 0] - x0) / sc
        rows = (pts[:, 1] - y0) / sr
        c0, c1 = int(np.floor(cols.min())), int(np.ceil(cols.max())) + 1
        r0, r1 = int(np.floor(rows.min())), int(np.ceil(rows.max())) + 1
        c0, r0 = max(c0, 0), max(r0, 0)
        c1, r1 = min(c1, geo["cols"]), min(r1, geo["rows"])
        if c1 <= c0 or r1 <= r0:
            continue
        cc, rr = np.meshgrid(np.arange(c0, c1), np.arange(r0, r1))
        inside = MplPath(np.column_stack([cols, rows])).contains_points(
            np.column_stack([cc.ravel(), rr.ravel()])).reshape(rr.shape)
        mask[k, r0:r1, c0:c1] ^= inside
    return mask


# ----------------------------------------------------------------- measuring

def voxel_volume_mm3(geo: dict) -> float:
    return geo["spacing"][0] * geo["spacing"][1] * geo["dz"]


def volume_mm3(mask: np.ndarray, geo: dict) -> float:
    return float(mask.sum()) * voxel_volume_mm3(geo)


def _boundary(mask2d: np.ndarray) -> np.ndarray:
    """Pixels of a 2D mask that touch the background (4-neighbourhood)."""
    p = np.pad(mask2d, 1)
    interior = p[1:-1, 1:-1] & p[:-2, 1:-1] & p[2:, 1:-1] & p[1:-1, :-2] & p[1:-1, 2:]
    return mask2d & ~interior


def slice_axes_mm(mask2d: np.ndarray, spacing: list[float]) -> tuple[float, float]:
    """Long axis and perpendicular short axis of one slice, in mm.

    Long axis: the largest distance between two boundary pixel centres, plus one pixel so the
    length runs edge to edge rather than centre to centre.
    Short axis: the largest extent perpendicular to the long axis, measured the same way.
    """
    rr, cc = np.nonzero(_boundary(mask2d))
    if len(rr) == 0:
        return 0.0, 0.0
    pts = np.column_stack([cc * spacing[1], rr * spacing[0]]).astype(float)
    pixel = float(np.mean(spacing))
    if len(pts) == 1:
        return pixel, pixel
    d = np.linalg.norm(pts[:, None, :] - pts[None, :, :], axis=2)
    i, j = np.unravel_index(np.argmax(d), d.shape)
    long_axis = float(d[i, j])
    direction = (pts[j] - pts[i]) / long_axis
    normal = np.array([-direction[1], direction[0]])
    proj = pts @ normal
    return long_axis + pixel, float(proj.max() - proj.min()) + pixel


def measure(mask: np.ndarray, geo: dict) -> dict:
    """Measurements in the units of the lab's sheet (mm, mm3)."""
    counts = mask.reshape(mask.shape[0], -1).sum(axis=1)
    used = np.nonzero(counts)[0]
    if len(used) == 0:
        return {"volume_mm3": 0.0, "long_axis_mm": 0.0, "short_axis_mm": 0.0,
                "mean_diameter_mm": 0.0, "slice_index": -1, "n_slices": 0, "n_voxels": 0}
    best = (0.0, 0.0, -1)
    for k in used:
        la, sa = slice_axes_mm(mask[k], geo["spacing"])
        if la > best[0]:
            best = (la, sa, int(k))
    zz, rr, cc = np.nonzero(mask)
    return {
        "volume_mm3": volume_mm3(mask, geo),
        "long_axis_mm": round(best[0], 1),
        "short_axis_mm": round(best[1], 1),
        "mean_diameter_mm": round((best[0] + best[1]) / 2, 1),
        "slice_index": best[2],
        "n_slices": int(len(used)),
        "n_voxels": int(mask.sum()),
        "centroid_index": [float(zz.mean()), float(rr.mean()), float(cc.mean())],
        "bbox_index": [int(zz.min()), int(zz.max()), int(rr.min()), int(rr.max()),
                       int(cc.min()), int(cc.max())],
    }


# ------------------------------------------------------------------- scoring

def dice(a: np.ndarray, b: np.ndarray) -> float:
    total = a.sum() + b.sum()
    return float(2 * (a & b).sum() / total) if total else 1.0


def compare(pred: np.ndarray, ref: np.ndarray, geo: dict) -> dict:
    """Score a predicted outline against a reference, in the terms the lab uses."""
    mp, mr = measure(pred, geo), measure(ref, geo)
    vr = mr["volume_mm3"]
    return {
        "dice": round(dice(pred, ref), 4),
        "volume_diff_pct": round(100 * (mp["volume_mm3"] - vr) / vr, 2) if vr else None,
        "long_axis_diff_mm": round(mp["long_axis_mm"] - mr["long_axis_mm"], 1),
        "short_axis_diff_mm": round(mp["short_axis_mm"] - mr["short_axis_mm"], 1),
    }
