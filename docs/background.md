# Background: lung CT, tumour outlines and measurements

A short primer on the terms this project uses. Research context only; nothing here is clinical guidance.

## CT scans and DICOM

- A CT scan is a stack of slices. Each slice is a 2D image, usually 512 x 512 pixels, stored as its
  own `.dcm` file. One chest scan is a few hundred files.
- DICOM organises data as Patient > Study (a visit) > Series (one scan) > Instance (one slice).
  Each level has a unique identifier (UID).
- Each file carries a header of tags. The ones that matter most here:
  - `PixelSpacing`: millimetres per pixel within a slice
  - `SliceThickness`: thickness of the slice
  - `ImagePositionPatient`: where the slice sits in the body
- A voxel is a 3D pixel. Its volume is the product of the three spacings, which is how a voxel
  count becomes a volume in cubic millimetres.

## Hounsfield units (HU)

CT pixel values measure density on a fixed scale.

| Material | Approximate HU |
| --- | --- |
| Air | -1000 |
| Lung tissue | -900 to -700 |
| Water | 0 |
| Soft tissue, tumour | 20 to 60 |
| Bone | 300 and above |

- A tumour is bright against dark lung, so it is usually easy to see. It becomes hard to outline
  where it touches the chest wall, blood vessels or the mediastinum, because the density is similar
  and the boundary disappears.
- A display window shows only a narrow range of values. The lung window and the mediastinal window
  are two views of the same scan, and readers switch between them.

## Outline formats

- **RTSTRUCT**: contours (polygons) per slice, in patient coordinates. Comes from radiotherapy
  planning systems.
- **DICOM SEG**: a voxel mask (inside or outside the tumour).
- Both point to their CT series by UID.
- **GTV** (gross tumour volume) is the term for the visible tumour volume, and is how the outlines
  in the practice set are labelled.

## What is measured

- **Longest diameter**: the longest line across the tumour in a single slice. The most common
  measurement, and the basis of the RECIST criteria used in clinical trials.
- **Volume**: voxel count times voxel volume. More sensitive to change, but needs a full outline,
  which is the expensive manual step.
- For a sphere, a 20% increase in diameter is about a 73% increase in volume. A small outline error
  therefore moves volume much more than diameter.
- By convention a lesion up to 30 mm is called a nodule, and a larger one a mass.

## Comparing an outline with a reference

- **Dice coefficient**: overlap between two masks, from 0 (none) to 1 (identical). It is harsh on
  small lesions, where a few voxels change the score a lot.
- **Volume difference and diameter difference**: closest to what a researcher records.
- **Repeatability**: how much the same measurement changes between two scans of the same patient on
  the same day. This is the natural bar: a tool that deviates less than this is within the noise of
  the measurement itself.

## Tools

- Python: `pydicom` for reading files, `SimpleITK` for working with volumes.
- Viewing: 3D Slicer (the Quantitative Reporting extension is needed to load DICOM SEG).
