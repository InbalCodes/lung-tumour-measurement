import type { Measurement } from './measure.ts';
import type { Volume } from './volume.ts';

/** Column order of the lab's measurement sheet: one row per tumour per timepoint. */
export const SHEET_COLUMNS = [
  'Patient ID', 'Scan date', 'Timepoint', 'Series #', 'Slice thickness', 'Nodule ID', 'Lobe',
  'Slice #', 'Type', 'Long axis', 'Short axis', 'Mean diameter', 'Solid component', 'Volume',
  'Match to prior', 'Minutes on scan', 'Measured by', 'Notes',
] as const;

export const LOBES = ['', 'RUL', 'RML', 'RLL', 'LUL', 'LLL'] as const;
export const TYPES = ['Solid', 'Part-solid', 'Ground-glass'] as const;
export const MATCHES = ['', 'Confident', 'Uncertain', 'Not found'] as const;

export interface ScanFields {
  patientId: string;
  scanDate: string;
  timepoint: string;
  measuredBy: string;
}

export interface FindingFields {
  noduleId: string;
  lobe: string;
  type: string;
  solidComponentMm: string;
  matchToPrior: string;
  notes: string;
}

/** DICOM dates are YYYYMMDD; the sheet uses YYYY-MM-DD. */
export function formatDicomDate(d: string): string {
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d;
}

export function sheetRow(v: Volume, scan: ScanFields, f: FindingFields, m: Measurement, minutes: number): string[] {
  return [
    scan.patientId, scan.scanDate, scan.timepoint, String(v.meta.seriesNumber),
    String(v.meta.sliceThickness), f.noduleId, f.lobe,
    m.sliceIndex >= 0 ? String(v.sliceNumbers[m.sliceIndex]) : '', f.type,
    m.longAxisMm.toFixed(1), m.shortAxisMm.toFixed(1), m.meanDiameterMm.toFixed(1),
    f.type === 'Part-solid' ? f.solidComponentMm : '', String(Math.round(m.volumeMm3)),
    f.matchToPrior, String(minutes), scan.measuredBy, f.notes,
  ];
}

/** Row for a nodule of the prior scan that the researcher could not find on this scan. */
export function notFoundRow(v: Volume, scan: ScanFields, prior: { noduleId: string; lobe: string; type: string }, minutes: number): string[] {
  return [
    scan.patientId, scan.scanDate, scan.timepoint, String(v.meta.seriesNumber), String(v.meta.sliceThickness),
    prior.noduleId, prior.lobe, '', prior.type, '', '', '', '', '', 'Not found', String(minutes), scan.measuredBy, '',
  ];
}

const quote = (cell: string) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

export function toCsv(rows: string[][]): string {
  return [SHEET_COLUMNS as readonly string[], ...rows].map((r) => r.map(quote).join(',')).join('\r\n') + '\r\n';
}
