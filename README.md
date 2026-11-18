# Lung Tumour Measurement Tool

A research tool for the Thoracic Oncology Research Lab at Harbor Medical Center. Its goal is to cut
the manual time researchers spend outlining and measuring lung tumours on CT scans, without
reducing the quality of their measurements.

> **Research use only.** This tool is not a medical device and makes no clinical claims. It must
> not be used for diagnosis or treatment decisions.

**Live tool:** https://inbalcodes.github.io/lung-tumour-measurement/ (runs entirely in the browser; scans never leave the machine)

## Status

Work in progress. This README is updated as the project moves forward.

| Stage | State |
| --- | --- |
| Data download | Scripted (see below) |
| Client discovery | Done, scope agreed with the lab |
| Reference measurements and quality bar | Done (see docs/reference.md) |
| Tool | Viewer, outline from a stroke, outline from boxes with an image model, correction, sign-off, sheet export, follow-up against a prior scan |
| Known failures | Development scans (see docs/failures.md) |
| Image model comparison | Development scans (see docs/model-experiment.md) |
| Results | Test set not run yet |

## Repository layout

```
data/tcia-metadata/   Manifests and metadata published by TCIA (committed)
data/dicom/           Downloaded scans and segmentations (not committed)
scripts/              Data download and utility scripts
app/                  The browser tool (React, TypeScript) and its scoring script
eval/                 Reference measurements from the expert outlines (Python)
docs/                 Requirements, decisions and results
```

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

## Running the tool

Requires Node.js 22 or later.

```
cd app
npm install
npm run dev
```

Open the address Vite prints (usually http://localhost:5173), choose "Open scan folder" and pick
one series folder under `data/dicom/ct`. The scan is read by the browser from the local disk.
Nothing is uploaded.

- Scroll to move through slices. Drag a line across a tumour to outline and measure it.
- Review the outline, fill in the sheet fields, and sign off.
- Export writes the signed-off rows as CSV in the lab's sheet format, plus an edit trail.

`npm run build` produces a static site in `app/dist` that can be hosted anywhere.

## Scoring the tool

The outlining code that runs in the browser is scored in Node against the expert outlines:

```
python eval/export_crops.py          # once, after the data download
cd app && npm run evaluate -- --split dev
```

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
