# Experiment: finding nodules automatically

**Question.** Finding the nodules is the largest step in the researcher's day (10 to 20 minutes of a
25 to 40 minute scan), and it was the lab's first wish. I told the lab I would test it alongside the
main work and report honestly. This is that test.

**Answer.** A simple automatic search is not usable. On the test scans it marked the known tumour in
about half of the scans and added a median of 17 other marks per scan. It was not put in the tool.

## Why this got a small, fixed amount of time

About one hour, on purpose. Three reasons, all known before starting:

1. **The practice data cannot score it properly.** Each scan has one large tumour outlined and nothing
   else. There is no record of small nodules, so a search can be checked for "did it mark the known
   tumour" but not for missed small nodules or for which extra marks are real.
2. **Ready-made detection models are built for a server.** They read a whole scan on a graphics
   card. The lab's scans cannot leave the browser on its own workstation, so such a model is a much
   larger risk than the outlining model that was integrated.
3. **A poor detector costs time.** Daniel said so himself: too many extra marks and he spends more
   time dismissing them than he saves. Detection is only worth shipping if it is good.

So the outlining, export and follow-up were built first, with the lab's agreement, and the time went
there. The cost is that the largest step in the workflow is untouched, which is why the estimated
time saving is well short of the lab's goal ([results](results.md), section 3).

## What was tried

No trained model. The scan is reduced to 2 mm voxels; the lungs are found as the air inside the
body; their outline is smoothed over by 10 mm so that things attached to the chest wall fall inside;
thin structures (vessels) are removed; every solid blob that is left, 6 mm or larger and not
elongated, becomes a mark. About 2 seconds per scan. Code: `app/scripts/detect_experiment.ts`.

Three settings were compared on the development scans, then all three were run once on the test
scans.

## Results

| Setting | Development (19 scans): tumour marked | Test (40 scans): tumour marked | Test: other marks per scan, median (most) |
|---|---|---|---|
| Light vessel removal | 9 | 21 | 17 (47) |
| Heavy vessel removal | 9 | 18 | 11 (24) |
| Combined, large marks kept apart from vessels | 13 | 21 | 64 (125) |

"Tumour marked" means one mark covers at least a fifth of the expert's outline. Of the 17 other marks
in the first setting, typically 12 are 6 to 10 mm, 3 are 10 to 20 mm and 1 is larger.

## What it means

- **Half of the tumours are missed, and these are large tumours** (13 to 95 mm). Most of the misses
  are not the small ones: 16 of the 19 missed in the first setting are longer than 30 mm. They are
  mostly tumours attached to vessels, the mediastinum or the chest wall, which merge
  with those structures into one blob that is too big or too long to count as a mark. It is the same
  weakness as in the outline from a line: there is no brightness difference to separate them.
- **The setting that looked best in development did not hold.** "Combined" went from 13 of 19 to 21
  of 40, with four times the marks. Without the separate test scans it would have looked like progress.
- **17 marks per scan is too many for a search that still misses half.** Daniel would have to dismiss
  the marks and scroll the whole scan anyway.
- **The other marks cannot be judged here.** Some may be real nodules, lymph nodes or scarring; the
  data does not say. They are counted, not called false.
- **Small nodules were not tested at all**, for lack of data.

## What it would take to do this properly

1. A public set with every nodule marked by several radiologists (LIDC-IDRI), so that misses and
   false marks can be counted by size and type, as Daniel asked.
2. A trained detection model, checked first for whether it can run in a browser on the lab's
   workstation at all. If it cannot, the honest options are a local program on that workstation or
   no detection.
3. A limit agreed with Daniel on marks per scan before anything is shown to him as a feature.
