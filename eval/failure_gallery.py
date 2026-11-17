"""Failure gallery: the expert's outline against the tool's, on the practice data.

    python eval/failure_gallery.py            (after `node app/scripts/dump_outlines.ts <cases>`)

For every case in data/derived/tool/summary.json it writes one JPG to docs/img/failures/:
left, the slice the expert's long axis lies on; right, the slice where the two outlines differ most.
Green = expert (manual), orange = tool, dotted white = the stroke given to the tool.
"""
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
CROPS, TOOL = ROOT / "data/derived/crops", ROOT / "data/derived/tool"
OUT = ROOT / "docs/img/failures"
OUT.mkdir(parents=True, exist_ok=True)

TITLES = {
    "RIDER-3115188676_test": "Tumour lying along the chest wall",
    "RIDER-1344011628_test": "Tumour touching the mediastinum",
    "RIDER-1532432635_test": "Wide tumour against the chest wall, cut short",
    "RIDER-2541949645_test": "Small nodule just above the diaphragm",
    "RIDER-1825099523_test": "For comparison: tumour mostly surrounded by lung",
}


def panel(ax, hu, ref, tool, title, stroke=None):
    ax.imshow(np.clip(hu, -1350, 150), cmap="gray", vmin=-1350, vmax=150, interpolation="bilinear")
    if ref.any():
        ax.contour(ref, [0.5], colors=["#3ddc84"], linewidths=1.6)
    if tool.any():
        ax.contour(tool, [0.5], colors=["#ff9f1c"], linewidths=1.6)
    if stroke:
        ax.plot([stroke[0], stroke[2]], [stroke[1], stroke[3]], ":", color="white", linewidth=1.2)
    ax.set_title(title, fontsize=10, color="white")
    ax.axis("off")


for row in json.loads((TOOL / "summary.json").read_text()):
    name = row["case"]
    meta = json.loads((CROPS / f"{name}.json").read_text())
    shape = tuple(meta["shape"])
    hu = np.fromfile(CROPS / f"{name}.i16", dtype="<i2").reshape(shape)
    ref = np.fromfile(CROPS / f"{name}.u8", dtype=np.uint8).reshape(shape) > 0
    tool = np.fromfile(TOOL / f"{name}.u8", dtype=np.uint8).reshape(shape) > 0
    z = row["slice"]
    diff = (ref ^ tool).sum(axis=(1, 2))
    diff[max(0, z - 2): z + 3] = 0          # make the second panel a different level
    z2 = int(diff.argmax())
    inst = meta["instance_numbers"]
    fig, axes = plt.subplots(1, 2, figsize=(10, 5.6), facecolor="black")
    panel(axes[0], hu[z], ref[z], tool[z], f"Slice {inst[z]} (measurement slice)", row["stroke"])
    panel(axes[1], hu[z2], ref[z2], tool[z2], f"Slice {inst[z2]} (largest disagreement)")
    e, t = row["expert"], row["tool"]
    fig.suptitle(f"{TITLES.get(name, name)}  -  {name.split('_')[0]}", color="white", fontsize=13, y=0.975)
    fig.text(0.5, 0.045,
             f"Expert (green): {e['volume'] / 1000:.1f} cm3, {e['long']:.0f} x {e['short']:.0f} mm      "
             f"Tool (orange): {t['volume'] / 1000:.1f} cm3, {t['long']:.0f} x {t['short']:.0f} mm      "
             f"Volume {row['volumePct']:+d}%   overlap (Dice) {row['dice']:.2f}",
             ha="center", color="white", fontsize=10)
    fig.text(0.5, 0.012, "Public practice data (TCIA RIDER Lung CT). Tool outline before any manual correction. Research use only.",
             ha="center", color="#9aa", fontsize=8)
    fig.subplots_adjust(left=0.01, right=0.99, top=0.9, bottom=0.09, wspace=0.02)
    fig.savefig(OUT / f"{name}.jpg", dpi=130, facecolor="black")
    plt.close(fig)
    print(name, "slices", inst[z], inst[z2])
