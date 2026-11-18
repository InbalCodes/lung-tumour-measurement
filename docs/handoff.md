# Hand-over to the lab

For Dr. Naomi Hart and Dr. Daniel Reyes. What you are getting, how to use it, what to check before
trusting it, and what a pilot on your own scans needs.

**Research use only.** Not a medical device. Do not use it for diagnosis or treatment decisions.

## What you are getting

- The tool: https://inbalcodes.github.io/lung-tumour-measurement/ . It can also be saved and run from
  a folder on the workstation with no internet connection (see "Running it inside the lab").
- The source code and all test results: https://github.com/InbalCodes/lung-tumour-measurement
- This note, and the results write-up ([results.md](results.md)).

Your scans stay on your computer. The tool reads them from disk in the browser and sends nothing
anywhere. The only things it downloads are its own files and, if you use Boxes (AI), the image model.

## A scan, step by step

1. **Open scan folder** and pick the folder of the thinnest axial series.
2. Scroll to a tumour. With **Outline**, drag a line across it, edge to edge, on the slice where it
   looks largest.
3. Check the outline on every slice it covers. Fix it with **Add** and **Erase**. The numbers update
   when you release the mouse.
4. For a tumour attached to the chest wall or mediastinum, use **Boxes (AI)** instead: a box on the
   first and last slice and about three in between, then **Outline from 5 boxes**. Wait one to two
   minutes; you can keep scrolling meanwhile.
5. Fill in lobe and type, then **Sign off**. Only signed-off outlines are exported.
6. **Export**. You get three files: the sheet rows (CSV, your 18 columns), the edit trail, and a
   session file. Keep the session file with the patient's records: the next scan starts from it.

On a follow-up scan, load the prior session file (or accept the one the browser remembers). The tool
marks where each tumour is expected, proposes its outline, and shows the change since the prior scan.
Review every proposed outline before signing off.

## What to check, every time

| Situation | What the tool tends to do | What to do |
| --- | --- | --- |
| Tumour touching the chest wall, mediastinum or diaphragm | The outline from a line leaks into the neighbouring tissue (volume up to 170% too large in testing) | Use Boxes (AI), or erase the leak. Do not sign off without looking at the wall side |
| Wide tumour against the wall | The outline can be cut short, with a straight edge | Add the missing part, or use Boxes (AI) |
| Any outline, slices far from the line you drew | Errors grow away from that slice | Scroll through all slices of the outline, not only the middle one |
| Boxes (AI) | Draws about 12% small on average | Check the edges; add where it is tight |
| Follow-up with a "Large change" warning | In testing, 1 pair in 19 was badly off, and it was flagged | Redraw rather than adjust |
| Small or ground-glass nodules | **Not tested.** The practice data has none | Treat every suggestion as unverified |

Diameters were more reliable than volume in every test.

## What was shown, and what was not

Shown on 21 public test patients: a tumour is re-found on the second scan every time; the carried-over
outline repeats within 5.8% in volume between same-day scans, against 5.2% for two expert outlines.

Not shown: that the tool halves the time per scan. It was never timed with a reader. My estimate from
Daniel's own step times is 10-20% on a new scan and about 30% on a follow-up. Finding the nodules is
still done by scrolling; an automatic search was tested and was not good enough to include.

## Running it inside the lab

The site is plain files. To run it without the public link: download the repository, run
`npm install` and `npm run build` in the `app` folder on any computer with Node.js 22, and copy the
resulting `app/dist` folder to the workstation. It needs to be opened through a local web server
(for example `npx serve dist`) rather than by double-clicking, because browsers restrict what a page
opened from a file can do. Boxes (AI) also needs the two model files in `dist/models`; the README
says where they come from.

## What a pilot needs

1. **A timed session.** Ten scans, half the usual way and half with the tool, timed per step
   (finding, measuring, volume, recording, matching). Include two chest wall cases and two follow-ups.
   This is the measurement that decides whether the tool is worth adopting.
2. **Your own follow-up pairs**, months apart, checked by Daniel. Same-day pairs were the easy case.
3. **Small and ground-glass nodules**, on a public set read by several radiologists, reported by size
   and type.
4. **A decision on automatic finding**: what number of marks per scan is acceptable, before anyone
   builds it.

## Known gaps in the tool

- No automatic finding of nodules.
- No queue for working through a backlog; one scan at a time.
- The solid component of a part-solid nodule is typed in by hand.
- Uncompressed DICOM only.
- The saved session lives in the browser and in the exported file. Clearing browser data removes the
  browser copy; the file is the durable one.
