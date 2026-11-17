import type { Measurement } from '../core/measure.ts';
import type { Stroke } from '../core/segment.ts';
import type { FindingFields } from '../core/sheet.ts';
import type { PointMm, SessionNodule } from '../core/followup.ts';
import type { Mask } from '../core/volume.ts';

/** One outlined tumour on the open scan. */
export interface Finding {
  id: number;
  mask: Mask;
  measurement: Measurement;
  fields: FindingFields;
  /** The researcher has reviewed the outline and takes responsibility for it. */
  signedOff: boolean;
  stroke: Stroke;
  thresholdHu: number;
  /** The nodule from the prior scan this outline was matched to, if any. */
  prior?: SessionNodule;
  /** Plain-language record of what the tool suggested and what the researcher changed. */
  trail: { at: string; event: string }[];
}

/** Where a nodule from the prior scan is expected on the open scan. */
export interface PriorSpot {
  nodule: SessionNodule;
  at: PointMm;
  z: number;
  y: number;
  x: number;
  notFound: boolean;
}

export interface WindowPreset { name: string; center: number; width: number }

export const WINDOWS: WindowPreset[] = [
  { name: 'Lung', center: -600, width: 1500 },
  { name: 'Mediastinum', center: 40, width: 400 },
];
