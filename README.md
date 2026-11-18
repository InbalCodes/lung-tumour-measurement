# Lung Tumour Measurement Tool

A research tool built for the Thoracic Oncology Research Lab at Harbor Medical Center (a simulated
client). It cuts the manual work of outlining and measuring lung tumours on CT scans and of tracking
them between scans, and it exports straight into the lab's own measurement sheet.

> **Research use only.** This tool is not a medical device and makes no clinical claims. It must
> not be used for diagnosis or treatment decisions.

**Live tool:** https://inbalcodes.github.io/lung-tumour-measurement/

Everything runs in the browser. Scans are read from the local disk and are never uploaded.

## Try it in two minutes

1. Open the live tool and choose **Sample scan 1**. It opens on the slice with the tumour.
2. Drag a line across the tumour. You get a 3D outline with long axis, short axis, mean diameter
   and volume.
3. Correct the outline with **Add** and **Erase**, fill in lobe and type, **Sign off**, and export.
   The CSV has the lab's 18 columns. An edit trail and a session file are saved with it.
4. Choose **Sample scan 2** (same patient, same day) and accept the saved session as the prior scan.
   The tool finds the tumour, proposes its outline, and shows the change in volume.
5. Optional: choose **Boxes (AI)**, drag a box around the tumour on its first and last slice and about
   three in between, and run the image model. It takes one to two minutes and downloads about 125 MB
   the first time.

The sample scans are public practice data (RIDER Lung CT, see attribution below).

## What it does

| Feature | Why it is there |
| --- | --- |
| Outline from one line, with diameters and volume | The reader's own gesture for measuring a diameter; instant |
| Add / Erase correction and sign-off per tumour | The lab requires the reader to see, fix and approve every outline. Nothing unsigned is exported |
| Export in the lab's sheet format, with minutes on scan | Recording took 3 to 5 minutes per scan by hand |
| Follow-up: line up two scans, find each tumour, carry the outline over, show the change | Matching to the prior scan took about 10 minutes per follow-up scan, and growth tracking is what the lab's grant depends on |
| Boxes (AI): outline from about five boxes with an image model (MedSAM) in the browser | The outline from a line fails where a tumour touches the chest wall or mediastinum |
| Edit trail | A record of what the tool suggested and what the reader changed |

## Results in short

One run on 21 patients (40 scans) that were set aside at the start. Reference: the expert outlines
published with the data. Numbers are the tool's first suggestion, before correction.

| | Result |
| --- | --- |
| Follow-up: volume difference between two same-day scans | 5.8% median (two expert outlines: 5.2%) |
| Follow-up: tumours found on the second scan | 19 of 19 |
| Outline from one line: volume error | 26% median; a starting point for correction, not a measurement |
| Boxes (AI): volume error | 12% median, with boxes taken from the expert outline (best case) |
| Time saved | Not measured with the lab. Estimated at 10-20% on a new scan and about 30% on a follow-up, short of the lab's goal of half |
| Finding nodules automatically | Tested for an hour, not usable, not in the tool |

Full write-ups:

- [docs/results.md](docs/results.md): what works, what fails, how time saved was estimated, limits
- [docs/failures.md](docs/failures.md): the worst cases, with pictures
- [docs/model-experiment.md](docs/model-experiment.md): the image model against the simple outline
- [docs/detection-experiment.md](docs/detection-experiment.md): the test of automatic finding
- [docs/handoff.md](docs/handoff.md): for the lab: how to use it, what to check, what a pilot needs
- [docs/reference.md](docs/reference.md) and [docs/background.md](docs/background.md): the quality bar and a primer

## Running the tool locally

Requires Node.js 22 or later.

```
cd app
npm install
npm run dev
```

Open the address Vite prints (usually http://localhost:5173), choose **Open scan folder** and pick the
folder of one CT series. `npm run build` produces a static site in `app/dist` that can be hosted
anywhere.

Two things are fetched when the public site is built and are not in the repository: the two sample
scans, and the image model files (`app/public/models`, see `.github/workflows/pages.yml`). Without
them the tool still works on scans opened from disk; the sample buttons and Boxes (AI) are missing.

## Getting the data

The project uses the lab's public practice set from The Cancer Imaging Archive (TCIA): 31 patients
with two same-day CT scans each, and expert tumour outlines for both scans.

Requires Python 3.9 or later. No extra packages.

```
python scripts/download_tcia.py --only seg   # tumour outlines, about 1 GB
python scripts/download_tcia.py --only ct    # matching CT scans, about 7.5 GB
```

Files are written to `data/dicom/seg` and `data/dicom/ct`, one folder per DICOM series. The script
can be stopped and re-run; finished series are skipped.

No patient data from the lab is used or stored anywhere in this repository. The lab's own scans
never leave the hospital.

## Reproducing the numbers

Requires the data above, Python 3.9 or later with `numpy`, `pydicom` and `matplotlib`, and Node.js 22.

```
python eval/index_ct.py                              # slice geometry of every scan
python eval/build_reference.py                       # expert measurements from the outlines
python eval/export_crops.py                          # the region around each tumour, for scoring
cd app
node scripts/evaluate.ts --split test                # outline from one line
node scripts/evaluate_followup.ts --split test       # follow-up between same-day scans
node scripts/detect_experiment.ts --split test       # automatic finding
```

The image model is scored from `eval/model` (`npm install` there, and the two MedSAM ONNX files in
`eval/model/weights`): `node check_tool.mjs --split test` runs the tool's own code on every test scan.
The development / test split is fixed in `eval/reference/splits.json`. The outputs of the one test
run are kept in `eval/results`.

## Repository layout

```
app/                  The browser tool (React, TypeScript)
  src/core/           Reading scans, outlining, measuring, follow-up, sheet export; no UI
  src/ui/             Viewer and panels; the image model runs in a web worker
  scripts/            Scoring scripts that run the same core code in Node
eval/                 Reference measurements from the expert outlines (Python), results, model experiment
scripts/              Data download
data/tcia-metadata/   Manifests published by TCIA (committed); scans are downloaded, never committed
docs/                 Results and write-ups
```

## Limits

- 31 patients from one public dataset, one scanner protocol, large tumours only (13 to 95 mm).
  No small or ground-glass nodules were tested.
- Same-day scan pairs test repeatability, not follow-up months apart.
- No timing with a real reader yet.
- No patient data from the lab is used or stored anywhere in this repository.

## Image model

Boxes (AI) uses MedSAM (Ma, J., He, Y., Li, F., et al. Segment anything in medical images. Nature
Communications 15, 654 (2024)), released under the Apache License 2.0, in the ONNX form published
with X-AnyLabeling v0.2.0. It runs in the browser with ONNX Runtime Web.

## Data attribution

This project uses data from The Cancer Imaging Archive, under the Creative Commons Attribution
licences stated on each dataset page.

- Zhao, B., Schwartz, L. H., Kris, M. G., & Riely, G. J. (2015). Coffee-break lung CT collection
  with scan images reconstructed at multiple imaging parameters (Version 3) [Dataset]. The Cancer
  Imaging Archive. https://doi.org/10.7937/k9/tcia.2015.u1x8a5nr
- Wee, L., Aerts, H., Kalendralis, P., & Dekker, A. (2020). RIDER Lung CT Segmentation Labels
  from: Decoding tumour phenotype by noninvasive imaging using a quantitative radiomics approach
  [Data set]. The Cancer Imaging Archive. https://doi.org/10.7937/tcia.2020.jit9grk8
- Zhao, B., James, L. P., Moskowitz, C. S., et al. (2009). Evaluating Variability in Tumor
  Measurements from Same-day Repeat CT Scans of Patients with Non-Small Cell Lung Cancer.
  Radiology, 252(1), 263-272. https://doi.org/10.1148/radiol.2522081593
- Aerts, H. J. W. L., Velazquez, E. R., Leijenaar, R. T. H., et al. (2014). Decoding tumour
  phenotype by noninvasive imaging using a quantitative radiomics approach. Nature Communications,
  5, 4006. https://doi.org/10.1038/ncomms5006
