"""The failure-gallery cases again, with the image model's outline from five boxes next to the current one.

    python eval/model_gallery.py      (after eval/model/run.mjs; reads data/derived/model/results.json)

Writes one JPG per case to docs/img/model/. Green = expert (manual), orange = current outline from a
line, blue = image model from five boxes. Both panels show the slice the expert's long axis lies on.
"""
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
D = ROOT / "data/derived"
OUT = ROOT / "docs/img/model"
OUT.mkdir(parents=True, exist_ok=True)
CASES = {
    "RIDER-3115188676_test": "Tumour lying along the chest wall",
    "RIDER-1344011628_test": "Tumour touching the mediastinum",
    "RIDER-1532432635_test": "Wide tumour against the chest wall",
    "RIDER-2541949645_test": "Small nodule just above the diaphragm",
}
results = {r["case"]: r for r in json.loads((D / "model/results.json").read_text())["results"]}
slices = {r["case"]: r["slice"] for r in json.loads((D / "tool/summary.json").read_text())}

for name, title in CASES.items():
    meta = json.loads((D / f"crops/{name}.json").read_text())
    shape = tuple(meta["shape"])
    load = lambda p, t: np.fromfile(p, dtype=t).reshape(shape)
    hu, ref = load(D / f"crops/{name}.i16", "<i2"), load(D / f"crops/{name}.u8", np.uint8) > 0
    masks = {"classical": load(D / f"tool/{name}.u8", np.uint8) > 0, "keys5": load(D / f"model/{name}.keys5.u8", np.uint8) > 0}
    z, r = slices[name], results[name]
    fig, axes = plt.subplots(1, 2, figsize=(10, 5.7), facecolor="black")
    for ax, key, colour, label in [(axes[0], "classical", "#ff9f1c", "Current outline, from one line"), (axes[1], "keys5", "#4cc9f0", "Image model, from five boxes")]:
        ax.imshow(np.clip(hu[z], -1350, 150), cmap="gray", vmin=-1350, vmax=150, interpolation="bilinear")
        ax.contour(ref[z], [0.5], colors=["#3ddc84"], linewidths=1.6)
        if masks[key][z].any():
            ax.contour(masks[key][z], [0.5], colors=[colour], linewidths=1.6)
        m = r[key]
        ax.set_title(f"{label}\nvolume {m['volumePct']:+d}%, {m['long']:.0f} x {m['short']:.0f} mm, overlap {m['dice']:.2f}", fontsize=10, color=colour)
        ax.axis("off")
    e = r["expert"]
    fig.suptitle(f"{title}  -  {name.split('_')[0]}, slice {meta['instance_numbers'][z]}", color="white", fontsize=13, y=0.985)
    fig.text(0.5, 0.045, f"Expert (green): {e['volume'] / 1000:.1f} cm3, {e['long']:.0f} x {e['short']:.0f} mm.   Volume and overlap are for the whole tumour, not only this slice.",
             ha="center", color="white", fontsize=9.5)
    fig.text(0.5, 0.012, "Public practice data (TCIA RIDER Lung CT). Boxes taken from the expert's outline on five slices. Before any manual correction. Research use only.",
             ha="center", color="#9aa", fontsize=8)
    fig.subplots_adjust(left=0.01, right=0.99, top=0.86, bottom=0.09, wspace=0.02)
    fig.savefig(OUT / f"{name.replace('_test', '')}_model.jpg", dpi=130, facecolor="black")
    plt.close(fig)
    print(name, r["classical"], r["keys5"])
