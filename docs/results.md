# Results on the test scans

One run, on 18 November 2026, on the 21 patients (40 scans, 19 same-day pairs) that were set aside
at the start and not looked at while the tool was built. Nothing was changed after seeing these
numbers. Raw output: `eval/results/`.

Reference throughout: the expert's manual outline published with the scans (RIDER-LungCT-Seg).
Each number is the tool's first suggestion, **before any correction by the reader**.

## 1. Outlining a tumour

| | Current outline (one line) | Boxes (AI) (five boxes) | Two expert outlines of the same tumour |
|---|---|---|---|
| Overlap with expert (Dice), median | 0.73 | 0.86 | |
| Overlap, worst scan | 0.42 | 0.67 | |
| Volume error, median | 26% | 12% | 5.2% (same-day pairs) |
| Volume error, worst scan | 173% | 29% | 21% |
| Scans more than 25% off in volume | 20 of 40 | 1 of 40 | |
| Average direction of the error | +28% (too big) | -12% (too small) | |
| Long axis error, median | 2.1 mm | 2.0 mm | |
| Short axis error, median | 3.3 mm | 1.6 mm | |
| Time to compute | under 0.2 s | 1 to 2 minutes in Chrome (up to 16 slices at about 6.5 s each) | |

By tumour size (median volume error, current outline / Boxes): under 5 cm3 (12 scans) 27% / 15%;
5 to 30 cm3 (18 scans) 34% / 14%; over 30 cm3 (10 scans) 22% / 8%.

**What this says**

- The outline from one line is a starting point, not a measurement. Half of the test scans are more
  than 25% off in volume before correction. This is worse than on the development scans (16% median
  there), so the development numbers were optimistic. Diameters hold up much better than volume.
- Boxes (AI) is close to what the published automatic outlines of this dataset reach (0.87 mean
  overlap) and brings all but one scan within 25%. It is consistently small, by about 12%.
- **The boxes in this test are taken from the expert's own outline** on five slices. A reader's boxes
  will be looser. In the one case drawn by hand in the browser (a development scan) the volume error
  was +34% where the expert's boxes gave +25%. So read the Boxes column as the best case.

## 2. Follow-up scans (same patient, second scan)

19 same-day pairs. The tumour did not change between the two scans, so any difference is
measurement noise.

| | Result |
|---|---|
| Tumours found on the second scan | 19 of 19, within the tumour's own radius |
| Distance from the expert's tumour centre | 1.7 mm median, 4.7 mm worst (22 mm if the scans are simply overlaid) |
| Volume difference between the two scans, carried-over outline | 5.8% median, 34% worst |
| Same, two expert outlines | 5.2% median, 21% worst |
| Same, tool with a fresh line on each scan | 13.6% median, 69% worst |
| Same, Boxes (AI) on each scan | 9.0% median, 22% worst |
| Pairs flagged by the 25% "large change" warning | 1 of 19 |

**What this says.** For tracking growth, which is the lab's red line, the carried-over outline is the
tool's strongest part: it repeats about as well as an expert does (5.8% against 5.2%), because both
scans are cut the same way. One pair in 19 was badly off and it was flagged. A fresh line on every
scan is not good enough for growth tracking, and the tool should not be used that way.

Same-day pairs are the easy case for matching: same position, minutes apart. Real follow-ups are
months apart, with a changed tumour. This data cannot test that.

## 3. Against the goals

| Goal | Status |
|---|---|
| Halve Daniel's time per scan | **Not measured.** Daniel has not been able to run the tool (no links from the lab), and my own timing would not be his. What is known: the outline and the sheet row take seconds; correction time on hard cases is unknown. |
| Do not harm volume growth tracking | Supported for carried-over outlines on same-day pairs (5.8% vs 5.2%). Not shown for real follow-ups. |
| Runs in the browser, nothing uploaded, no cost | Met, including the image model. |
| Daniel sees, edits and signs off every outline | Met. Unsigned outlines are never exported. |
| Export in the lab's sheet format | Met; confirmed by Daniel. |
| Find nodules automatically | Not built. See limits. |

## 4. Limits

- 31 patients, one public dataset, one scanner protocol (1.25 mm slices). All tumours are large
  (13 to 95 mm). **No small or ground-glass nodules**, which Daniel named as his hardest cases.
- One expert's outlines as the reference. Experts disagree with themselves by 5% in volume.
- Lines and boxes are simulated from the expert outline, so they are better placed than a real
  reader's first try.
- No timing with a real reader. This is the main open question for the pilot.
- Not a medical device. Research measurements only.

## 5. What I would do next

1. A timed session with Daniel on ten scans, tool against his usual method, including two chest
   wall cases. This is the measurement that decides whether the goal is met.
2. A public nodule set with several readers (for example LIDC-IDRI) to cover small and ground-glass
   nodules, reported by size and type as Daniel asked.
3. Real follow-up pairs, months apart.
4. A 3D model (MedSAM2) to remove the need for boxes, if it can run on the lab's workstation.
