# Experiment: an image model for the outlines the brightness method gets wrong

**Question.** The current outline is drawn from brightness alone, and it fails wherever a tumour
touches the chest wall, mediastinum or diaphragm ([failures](failures.md)). Does a segmentation
model that can run in the browser do better, and what does the reader have to give it?

**Short answer.** The model draws a good outline when it is told where the tumour is on each slice,
and a poor one when it has to work that out from a single line or box. Five boxes per tumour are
enough to beat the current method on every weak case. It is slower and needs a download of about 125 MB.
It is not a replacement for the current outline; it is a second tool for the cases that outline
gets wrong.

Development scans only (10 patients, 19 scans). The 21 test patients were not used.

## Setup

- Model: MedSAM (ViT-B, 8-bit quantised encoder), ONNX files as published in the X-AnyLabeling
  v0.2.0 release. Encoder 109 MB, decoder 9-17 MB. It works on one slice at a time and takes a box.
- Runtime: ONNX Runtime in Node, the same engine family that runs in a browser (ONNX Runtime Web).
  Nothing is uploaded; this matches the lab's constraint.
- Input: the slice in a lung window (-1350 to 150 HU), cropped around the tumour and scaled to 1024 px.
  A soft-tissue window was worse on 4 of 5 probe slices.
- Reference: the expert's manual outline. Same measures as the rest of the project.
- Code: `eval/model/` (`run.mjs`). Weights are not committed.

Two things found on the way, both would have silently spoiled the result:
the exported decoder stretches its full-size mask (an image size was baked in when it was exported),
so the low-resolution output is upsampled in our own code instead; and the encoder expects 0-255
values, not 0-1.

## What the reader gives the model

| Prompt | What it means in use |
|---|---|
| Line (today's gesture) | One line across the tumour. A box is built around it and the outline is carried slice to slice. |
| One box | One box dragged on the measurement slice, carried slice to slice. |
| Current outline's boxes | No extra input: the box around the brightness outline on each slice. |
| 3 boxes / 5 boxes | Boxes on the first and last slice and 1 or 3 between; boxes for other slices are interpolated. |
| Box on every slice | Upper limit. Not practical (7 to 45 slices per tumour here). |

The boxes are simulated from the expert's outline, so they are as good as a careful reader's and
no better than that. Real boxes will be a little looser.

## Results (19 development scans)

| Method | Overlap (Dice) median / mean / worst | Volume error median / worst | Long axis | Short axis |
|---|---|---|---|---|
| Current outline (brightness, from a line) | 0.78 / 0.74 / 0.53 | 16% / 164% | 3.0 mm | 2.7 mm |
| Model, line | 0.59 / 0.61 / 0.24 | 38% / 267% | 2.0 mm | 6.5 mm |
| Model, one box | 0.67 / 0.63 / 0.23 | 30% / 78% | 1.9 mm | 1.8 mm |
| Model, current outline's boxes | 0.74 / 0.69 / 0.48 | 24% / 195% | 1.6 mm | 3.9 mm |
| Model, 3 boxes | 0.79 / 0.77 / 0.61 | 28% / 44% | 3.4 mm | 2.7 mm |
| **Model, 5 boxes** | **0.82 / 0.84 / 0.72** | **12% / 27%** | **1.5 mm** | **2.2 mm** |
| Model, box on every slice | 0.87 / 0.85 / 0.73 | 9% / 23% | 1.4 mm | 3.2 mm |

For scale: two expert outlines of the same tumour on the same day differ by 6.8% in volume (median, all
28 pairs), and the dataset's own automatic outlines overlap the expert's by 0.87 (mean).

The cases from the failure gallery:

| Case | Current outline | Model, 5 boxes |
|---|---|---|
| Along the chest wall (3115188676, two scans) | +164%, +113% | +24%, +1% |
| Touching the mediastinum (1344011628, two scans) | +19%, +16% | +1%, +4% |
| Wide tumour cut short (1532432635) | -48% | -2% |
| Small nodule above the diaphragm (2541949645) | +27% | -22% |

Same-day repeat scans (9 pairs, tumour unchanged), difference between the two volumes: expert 16.6%
median, current outline about 17%, model with 5 boxes about 9%. The boxes come from the expert's
outlines on each scan, so this is not yet a clean test of repeatability.

## What it means

1. **The model's weakness is knowing where to stop, not drawing the edge.** Given a box it separates
   tumour from chest wall far better than brightness can. Carried from slice to slice on its own it
   either shrinks away (tight boxes: most volumes 15-78% small) or runs off into the chest wall (looser
   boxes: up to +800%). Both settings were tried; neither is usable.
2. **Five boxes is the useful point.** Three is too few: the outline comes out 20-40% small.
3. **With boxes it reads small** (about 5-20% under the expert on most scans). A steady offset matters less
   for growth than a random one, but it has to be shown, and Daniel's correction stays the last step.
4. **Small tumours gain nothing.** Under about 2 cm3 the current outline is as good or better.
5. **Cost.** 3.3 seconds per slice on two CPU threads, so 1 to 2.5 minutes of computing for a tumour
   of 20 to 45 slices, plus a one-time download of about 125 MB. Computing can run while the reader moves on.
   Speed in a real browser (WebAssembly or WebGPU) has not been measured.

## Decision

- Keep the current outline as the default: instant, no download, good on tumours surrounded by lung.
- Add the model as an optional "outline from boxes" mode for tumours attached to the wall or
  mediastinum, loaded only when asked for. Not built yet.
- Do not let the model run on its own from a line.

## Not answered yet

- The same comparison on the 21 test patients (one run, at the end).
- Whether five boxes plus corrections is faster for Daniel than Add / Erase on the current outline.
  This needs timing, not Dice.
- Browser speed and memory on the lab's workstation.
- Licence check of the published ONNX files before they are shipped with the tool.
- Other models (a smaller general one, or a 3D lung-tumour model) were not tried.
