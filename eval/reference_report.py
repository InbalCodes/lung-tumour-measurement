"""Summarise the reference data: tumour sizes, same-day repeat noise, and the dev/test split.

Same-day repeat noise: each patient was scanned twice within minutes, so the tumour did not
change. Any difference between the two expert measurements is measurement noise. This is the
bar a tool has to meet to keep growth tracking reliable.

Run from the project root:  python eval/reference_report.py
"""
import csv
import json
import statistics as st
from collections import defaultdict
from pathlib import Path

REF = Path(__file__).resolve().parent / "reference"


def pct_diff(a, b):
    return 100 * (b - a) / ((a + b) / 2)


def spread(values):
    """Mean, SD, 95% limits of agreement and median absolute value of paired differences."""
    values = list(values)
    mean, sd = st.mean(values), st.stdev(values)
    return {"n": len(values), "mean": round(mean, 2), "sd": round(sd, 2),
            "loa_low": round(mean - 1.96 * sd, 2), "loa_high": round(mean + 1.96 * sd, 2),
            "median_abs": round(st.median(abs(v) for v in values), 2),
            "max_abs": round(max(abs(v) for v in values), 2)}


def main():
    rows = list(csv.DictReader(open(REF / "reference_measurements.csv")))
    for r in rows:
        for k in ("long_axis_mm", "short_axis_mm", "mean_diameter_mm", "volume_mm3"):
            r[k] = float(r[k])
    by = defaultdict(dict)
    for r in rows:
        by[(r["patient_id"], r["outline"])][r["session"]] = r

    summary = {}
    for kind in ("man", "auto"):
        pairs = [(v["test"], v["retest"]) for (p, k), v in sorted(by.items())
                 if k == kind and "test" in v and "retest" in v]
        summary[f"repeat_{kind}"] = {
            "volume_pct": spread(pct_diff(a["volume_mm3"], b["volume_mm3"]) for a, b in pairs),
            "long_axis_pct": spread(pct_diff(a["long_axis_mm"], b["long_axis_mm"]) for a, b in pairs),
            "long_axis_mm": spread(b["long_axis_mm"] - a["long_axis_mm"] for a, b in pairs),
            "short_axis_mm": spread(b["short_axis_mm"] - a["short_axis_mm"] for a, b in pairs),
        }
        if kind == "man":
            summary["repeat_man_pairs"] = [
                {"patient_id": a["patient_id"], "volume_test": a["volume_mm3"],
                 "volume_retest": b["volume_mm3"],
                 "volume_pct": round(pct_diff(a["volume_mm3"], b["volume_mm3"]), 1),
                 "long_axis_test": a["long_axis_mm"], "long_axis_retest": b["long_axis_mm"]}
                for a, b in pairs]

    auto = [r for r in rows if r["outline"] == "auto" and r.get("vs_manual_dice")]
    dice = [float(r["vs_manual_dice"]) for r in auto]
    summary["dataset_auto_vs_manual"] = {
        "n": len(auto), "dice_mean": round(st.mean(dice), 3), "dice_median": round(st.median(dice), 3),
        "dice_min": round(min(dice), 3),
        "volume_diff_pct": spread(float(r["vs_manual_volume_diff_pct"]) for r in auto),
        "long_axis_diff_mm": spread(float(r["vs_manual_long_axis_diff_mm"]) for r in auto),
    }

    man = [r for r in rows if r["outline"] == "man"]
    la = sorted(r["long_axis_mm"] for r in man)
    vol = sorted(r["volume_mm3"] for r in man)
    summary["manual_sizes"] = {
        "n_outlines": len(man), "n_patients": len({r["patient_id"] for r in man}),
        "long_axis_mm": {"min": la[0], "median": st.median(la), "max": la[-1]},
        "volume_mm3": {"min": vol[0], "median": st.median(vol), "max": vol[-1]},
        "long_axis_bins": {"<=10": sum(v <= 10 for v in la), "10-30": sum(10 < v <= 30 for v in la),
                           "30-50": sum(30 < v <= 50 for v in la), ">50": sum(v > 50 for v in la)},
    }

    # Dev/test split by patient, balanced by tumour size: sort patients by their test-scan
    # volume and send every third one to the development set.
    size = {}
    for r in man:
        if r["session"] == "test" or r["patient_id"] not in size:
            size[r["patient_id"]] = r["volume_mm3"]
    ordered = sorted(size, key=size.get)
    dev = sorted(ordered[1::3])
    test = sorted(p for p in ordered if p not in dev)
    (REF / "splits.json").write_text(json.dumps(
        {"note": "Split by patient, balanced by tumour volume. Tune on dev only; report on test.",
         "dev": dev, "test": test}, indent=2))
    summary["split"] = {"dev_patients": len(dev), "test_patients": len(test)}

    (REF / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps({k: v for k, v in summary.items() if k != "repeat_man_pairs"}, indent=1))
    print("pairs volume pct:", sorted(p["volume_pct"] for p in summary["repeat_man_pairs"]))


if __name__ == "__main__":
    main()
