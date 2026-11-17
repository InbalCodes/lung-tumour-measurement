import { useEffect, useMemo, useRef, useState } from 'react';
import { buildVolume, parseSlice } from '../core/dicom.ts';
import type { ParsedSlice } from '../core/dicom.ts';
import { measure } from '../core/measure.ts';
import { DEFAULT_PARAMS, segmentFromStroke } from '../core/segment.ts';
import type { Stroke } from '../core/segment.ts';
import { alignScans, carriedStroke, fromBase64, maskCentroidMm, matchPrior, mmToVoxel, nextTimepoint, parseSession, refinePosition, sessionNodule, thumbnail, toBase64 } from '../core/followup.ts';
import type { Session, Thumb } from '../core/followup.ts';
import { LOBES, MATCHES, TYPES, formatDicomDate, notFoundRow, sheetRow, toCsv } from '../core/sheet.ts';
import type { FindingFields, ScanFields } from '../core/sheet.ts';
import type { Mask, Volume } from '../core/volume.ts';
import { cloneMask, cropMask, maskVoxelCount, paintLine } from '../core/volume.ts';
import { Viewer } from './Viewer.tsx';
import type { Tool } from './Viewer.tsx';
import { WINDOWS } from './types.ts';
import type { Finding, PriorSpot } from './types.ts';

/** A public practice scan packed with the site, offered so the tool can be tried without data. */
interface SampleScan { id: string; label: string; startSlice: number | null; file: string; megabytes: number; volume: Omit<Volume, 'hu'> }

const STORE = 'ltm.sessions';
const storedSessions = (): Session[] => { try { return JSON.parse(localStorage.getItem(STORE) ?? '[]'); } catch { return []; } };

const now = () => new Date().toISOString();
const signedPct = (value: number, before: number) => { const p = before ? (100 * (value - before)) / before : 0; return `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`; };
const signedMm = (d: number) => `${d >= 0 ? '+' : ''}${d.toFixed(1)} mm`;

export function App() {
  const [volume, setVolume] = useState<Volume | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [slice, setSlice] = useState(0);
  const [windowIndex, setWindowIndex] = useState(0);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [scan, setScan] = useState<ScanFields>({ patientId: '', scanDate: '', timepoint: 'Baseline', measuredBy: '' });
  const [startedAt, setStartedAt] = useState(0);
  const [minutes, setMinutes] = useState(0);
  const nextId = useRef(1);
  const picker = useRef<HTMLInputElement>(null);
  const devLoaded = useRef(false);
  const [tool, setTool] = useState<Tool>('outline');
  const [brushMm, setBrushMm] = useState(3);
  const [ball, setBall] = useState(false);
  const [thumb, setThumb] = useState<Thumb | null>(null);
  const [prior, setPrior] = useState<Session | null>(null);
  const [spots, setSpots] = useState<PriorSpot[]>([]);
  const [offered, setOffered] = useState<Session | null>(null);
  const priorPicker = useRef<HTMLInputElement>(null);
  const [samples, setSamples] = useState<SampleScan[]>([]);
  const edit = useRef<{ id: number; mask: Mask; before: number; z: number; last: [number, number] | null } | null>(null);

  // A folder picker reads files straight from disk; nothing is sent anywhere.
  useEffect(() => { picker.current?.setAttribute('webkitdirectory', ''); }, [volume]);

  // Minutes on scan: counted from the moment the scan opens.
  useEffect(() => {
    if (!startedAt) return;
    const tick = () => setMinutes(Math.max(1, Math.ceil((Date.now() - startedAt) / 60000)));
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [startedAt]);

  // Development only: ?series=<uid> loads a downloaded practice series from the dev server.
  useEffect(() => {
    const series = new URLSearchParams(location.search).get('series');
    if (!import.meta.env.DEV || !series || devLoaded.current) return;
    devLoaded.current = true;
    void (async () => {
      const names: string[] = await (await fetch(`/__practice/${series}`)).json();
      await openSources(names.map((n) => () => fetch(`/__practice/${series}/${n}`).then((r) => r.arrayBuffer())));
    })();
  }, []);

  // Sample scans are present only when the site was built with them.
  useEffect(() => {
    fetch('samples/index.json').then((r) => (r.ok ? r.json() : [])).then(setSamples).catch(() => setSamples([]));
  }, []);

  async function openSample(sample: SampleScan) {
    resetScan();
    setProgress({ done: 0, total: sample.megabytes });
    try {
      const response = await fetch(`samples/${sample.file}`);
      if (!response.ok || !response.body) throw new Error('The sample scan could not be loaded.');
      // Count compressed megabytes as they arrive, then unpack in the browser.
      let received = 0;
      const counted = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          received += chunk.length;
          setProgress({ done: Math.min(Math.round(received / 1e6), sample.megabytes), total: sample.megabytes });
          controller.enqueue(chunk);
        },
      }));
      // Some hosts already unpack .gz files on the way; fall back to the raw bytes if so.
      const packed = await new Response(counted).arrayBuffer();
      const head = new Uint8Array(packed, 0, 2);
      const raw = head[0] === 0x1f && head[1] === 0x8b
        ? await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
        : packed;
      showVolume({ ...sample.volume, hu: new Int16Array(raw) });
      const start = sample.startSlice === null ? -1 : sample.volume.sliceNumbers.indexOf(sample.startSlice);
      if (start >= 0) {
        setSlice(start);
        setNotice('The tumour in this sample scan is on this slice. Drag a line across it to outline and measure it.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  }

  function resetScan() {
    setError(''); setNotice(''); setVolume(null); setFindings([]); setSelectedId(null);
    setPrior(null); setSpots([]); setOffered(null); setThumb(null);
  }

  function showVolume(v: Volume) {
    setVolume(v);
    setSlice(Math.floor(v.nz / 2));
    setScan((s) => ({ ...s, timepoint: 'Baseline', patientId: v.meta.patientId, scanDate: formatDicomDate(v.meta.studyDate) }));
    nextId.current = 1;
    setStartedAt(Date.now());
    setThumb(thumbnail(v));
    // A session saved earlier in this browser for the same patient can serve as the prior scan.
    const earlier = storedSessions().filter((x) => x.patientId === v.meta.patientId && x.seriesUid !== v.meta.seriesUid);
    setOffered(earlier.sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0] ?? null);
  }

  const openFiles = (list: FileList | null) =>
    list?.length ? openSources([...list].map((f) => () => f.arrayBuffer())) : Promise.resolve();

  async function openSources(files: (() => Promise<ArrayBuffer>)[]) {
    resetScan();
    setProgress({ done: 0, total: files.length });
    try {
      const slices: ParsedSlice[] = [];
      const batch = 12;
      for (let i = 0; i < files.length; i += batch) {
        const buffers = await Promise.all(files.slice(i, i + batch).map((read) => read()));
        for (const b of buffers) { const s = parseSlice(b); if (s) slices.push(s); }
        setProgress({ done: Math.min(i + batch, files.length), total: files.length });
      }
      showVolume(buildVolume(slices));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  }

  /** Use a saved session as the prior scan: line the scans up and find where each nodule should be. */
  function usePrior(session: Session) {
    if (!volume || !thumb) return;
    const t0 = performance.now();
    const shift = alignScans({ ...session.thumb, data: fromBase64(session.thumb.data) }, thumb);
    const found: PriorSpot[] = session.nodules.map((nodule) => {
      const expected: [number, number, number] = [nodule.centroidMm[0] + shift[0], nodule.centroidMm[1] + shift[1], nodule.centroidMm[2] + shift[2]];
      const at = refinePosition(volume, { ...nodule.patch, data: fromBase64(nodule.patch.data) }, expected);
      const [z, y, x] = mmToVoxel(volume, at);
      return { nodule, at, z, y, x, notFound: false };
    });
    // Propose an outline at each expected position by repeating the prior scan's stroke with the
    // prior scan's density threshold, so both timepoints are cut the same way.
    const carried: Finding[] = [];
    for (const sp of found) {
      if (!sp.nodule.strokeMm) continue; // session saved by an earlier version: positions only
      const stroke = carriedStroke(volume, sp.nodule, sp.at);
      const result = segmentFromStroke(volume, stroke, { ...DEFAULT_PARAMS, fixedThresholdHu: sp.nodule.thresholdHu });
      if (!result) continue;
      const id = nextId.current++;
      carried.push({
        id, mask: result.mask, measurement: measure(result.mask, volume), signedOff: false, stroke, thresholdHu: result.thresholdHu,
        prior: sp.nodule,
        fields: { noduleId: sp.nodule.noduleId, lobe: sp.nodule.lobe, type: sp.nodule.type, solidComponentMm: '', matchToPrior: 'Confident', notes: '' },
        trail: [{ at: now(), event: `Tool carried ${sp.nodule.noduleId} over from the prior scan (${session.timepoint}, ${session.scanDate}) and suggested an outline with the same stroke and threshold (${Math.round(result.thresholdHu)} HU).` }],
      });
    }
    setFindings((all) => [...all, ...carried]);
    setPrior(session); setSpots(found); setOffered(null);
    setScan((s) => ({ ...s, timepoint: nextTimepoint(session.timepoint) }));
    if (found[0]) setSlice(found[0].z);
    if (carried[0]) setSelectedId(carried[0].id);
    setNotice(`Prior scan loaded (${session.timepoint}, ${session.scanDate}). ${carried.length} of ${found.length} tumour${found.length === 1 ? '' : 's'} carried over in ${Math.round(performance.now() - t0)} ms. Review each outline before signing off.`);
  }

  async function openPriorFile(list: FileList | null) {
    if (!list?.[0]) return;
    try { usePrior(parseSession(await list[0].text())); }
    catch (e) { setNotice(e instanceof Error ? e.message : String(e)); }
  }

  function buildSession(): Session | null {
    if (!volume || !thumb) return null;
    return {
      format: 'lung-tumour-measurement/session', version: 1, savedAt: now(),
      patientId: scan.patientId, scanDate: scan.scanDate, timepoint: scan.timepoint, seriesUid: volume.meta.seriesUid,
      thumb: { ...thumb, data: toBase64(thumb.data) },
      nodules: findings.filter((f) => f.signedOff).map((f) => sessionNodule(volume, f.mask, f.measurement, f.fields, f.stroke, f.thresholdHu)),
    };
  }

  /** Keep the session in this browser so the patient's next scan can start from it. */
  function rememberSession(session: Session) {
    try {
      const others = storedSessions().filter((x) => x.seriesUid !== session.seriesUid);
      localStorage.setItem(STORE, JSON.stringify([...others, session].slice(-20)));
    } catch { /* storage full or unavailable: the downloaded file is the durable copy */ }
  }

  function addFinding(stroke: Stroke) {
    if (!volume) return;
    const t0 = performance.now();
    const result = segmentFromStroke(volume, stroke);
    if (!result) {
      setNotice('Drag a line across the tumour, from one edge to the other, to outline it.');
      return;
    }
    setNotice('');
    const id = nextId.current++;
    const fields: FindingFields = { noduleId: `N${id}`, lobe: '', type: 'Solid', solidComponentMm: '', matchToPrior: '', notes: '' };
    const trail = [{ at: now(), event: `Tool suggested an outline from a ${result.strokeMm.toFixed(1)} mm stroke on slice ${volume.sliceNumbers[stroke.z]} (threshold ${Math.round(result.thresholdHu)} HU, ${Math.round(performance.now() - t0)} ms).` }];
    // On a follow-up scan, pair the outline with the nearest unmatched nodule of the prior scan.
    const taken = new Set(findings.map((f) => f.prior?.noduleId).filter((x): x is string => !!x));
    const match = matchPrior(maskCentroidMm(result.mask, volume), spots.filter((sp) => !sp.notFound), taken);
    if (match) {
      Object.assign(fields, { noduleId: match.nodule.noduleId, lobe: match.nodule.lobe, type: match.nodule.type, matchToPrior: match.confidence });
      trail.push({ at: now(), event: `Tool matched it to ${match.nodule.noduleId} of the prior scan (${match.distanceMm.toFixed(1)} mm from the expected position, ${match.confidence.toLowerCase()}).` });
    } else if (prior) {
      // New on this scan: give it an id the prior scan did not use.
      const used = new Set([...prior.nodules.map((n) => n.noduleId), ...findings.map((f) => f.fields.noduleId)]);
      let k = 1;
      while (used.has(`N${k}`)) k++;
      fields.noduleId = `N${k}`;
    }
    const finding: Finding = {
      id, mask: result.mask, measurement: measure(result.mask, volume), fields, signedOff: false, stroke,
      thresholdHu: result.thresholdHu, prior: match?.nodule, trail,
    };
    setFindings((f) => [...f, finding]);
    setSelectedId(id);
  }

  /** Brush and eraser: the researcher corrects the selected outline by hand. */
  function onBrush(phase: 'start' | 'move' | 'end', z: number, x: number, y: number) {
    if (!volume) return;
    if (phase === 'start') {
      const f = findings.find((q) => q.id === selectedId);
      if (!f) { setNotice('Select a tumour in the list first, then correct its outline.'); return; }
      setNotice('');
      edit.current = { id: f.id, mask: cloneMask(f.mask), before: maskVoxelCount(f.mask), z, last: null };
    }
    const e = edit.current;
    if (!e) return;
    if (phase !== 'end') {
      const [lx, ly] = e.last ?? [x, y];
      e.mask = paintLine(e.mask, volume, z, lx, ly, x, y, brushMm, tool === 'brush' ? 1 : 0, ball);
      e.last = [x, y];
      const mask = e.mask;
      update(e.id, (f) => ({ ...f, mask: { ...mask } }));
      return;
    }
    edit.current = null;
    const cropped = cropMask(e.mask);
    if (!cropped) { remove(e.id); setNotice('The outline was erased completely, so it was removed.'); return; }
    const delta = maskVoxelCount(cropped) - e.before;
    update(e.id, (f) => ({
      ...f, mask: cropped, measurement: measure(cropped, volume), signedOff: false,
      trail: [...f.trail, { at: now(), event: `Researcher ${tool === 'brush' ? 'added to' : 'erased from'} the outline on slice ${volume.sliceNumbers[e.z]}${ball ? ' (3D brush)' : ''}: ${delta >= 0 ? '+' : ''}${delta} voxels.${f.signedOff ? ' Sign-off withdrawn.' : ''}` }],
    }));
  }

  const update = (id: number, change: (f: Finding) => Finding) => setFindings((all) => all.map((f) => (f.id === id ? change(f) : f)));
  const setField = (id: number, key: keyof FindingFields, value: string) =>
    update(id, (f) => ({ ...f, fields: { ...f.fields, [key]: value } }));
  const toggleSignOff = (id: number) => update(id, (f) => ({
    ...f, signedOff: !f.signedOff,
    trail: [...f.trail, { at: now(), event: f.signedOff ? 'Sign-off withdrawn.' : `Signed off by ${scan.measuredBy || 'researcher'}.` }],
  }));
  const remove = (id: number) => { setFindings((all) => all.filter((f) => f.id !== id)); if (selectedId === id) setSelectedId(null); };

  // Scroll and slider follow the scanner's slice numbers, whichever way they run along the body.
  const flip = !!volume && volume.sliceNumbers[0] > volume.sliceNumbers[volume.nz - 1];

  const signed = useMemo(() => findings.filter((f) => f.signedOff), [findings]);

  function download(name: string, text: string, type: string) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }
  function exportSheet() {
    if (!volume) return;
    const rows = [
      ...signed.map((f) => sheetRow(volume, scan, f.fields, f.measurement, minutes)),
      ...spots.filter((sp) => sp.notFound).map((sp) => notFoundRow(volume, scan, sp.nodule, minutes)),
    ];
    const stem = `${scan.patientId || 'scan'}_${scan.scanDate || 'undated'}`;
    const session = buildSession();
    if (session) {
      rememberSession(session);
      download(`${stem}_session.json`, JSON.stringify(session), 'application/json');
    }
    download(`${stem}_measurements.csv`, toCsv(rows), 'text/csv');
    download(`${stem}_edit_trail.json`, JSON.stringify(findings.map((f) => ({ noduleId: f.fields.noduleId, signedOff: f.signedOff, trail: f.trail })), null, 2), 'application/json');
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Lung Tumour Measurement</div>
        <span className="badge">Research use only</span>
        <span className="muted">Scans are read on this computer. Nothing is uploaded.</span>
        <div className="spacer" />
        {volume && <span className="muted">Minutes on scan: <b>{minutes}</b></span>}
        {volume && samples.map((sm) => (
          <button key={sm.id} onClick={() => void openSample(sm)}>{sm.label.replace(/ \(.*/, '')}</button>
        ))}
        <button onClick={() => picker.current?.click()}>{volume ? 'Open another scan' : 'Open scan folder'}</button>
        <input ref={picker} type="file" multiple hidden onChange={(e) => { void openFiles(e.target.files); e.target.value = ''; }} />
      </header>

      {!volume && (
        <main className="empty">
          <h1>Open a CT scan to start</h1>
          <p>Choose the folder that holds the DICOM files of one CT series.</p>
          <button className="primary" onClick={() => picker.current?.click()}>Open scan folder</button>
          {samples.length > 0 && (
            <div className="samples">
              <p className="muted">No scan at hand? Try a public practice scan:</p>
              {samples.map((sm) => (
                <button key={sm.id} onClick={() => void openSample(sm)}>{sm.label} · {sm.megabytes} MB</button>
              ))}
              <p className="muted small">
                Measure and export scan 1, then open scan 2: the tool carries the tumour over.
                Sample scans: RIDER Lung CT, The Cancer Imaging Archive, <a href="https://doi.org/10.7937/k9/tcia.2015.u1x8a5nr" target="_blank" rel="noreferrer">doi:10.7937/k9/tcia.2015.u1x8a5nr</a> (CC BY).
              </p>
            </div>
          )}
          {progress && <p className="muted">Loading: {progress.done} of {progress.total}</p>}
          {error && <p className="error">{error}</p>}
          <p className="muted small">This tool supports research measurements only. It is not a medical device and must not be used for diagnosis or treatment decisions.</p>
        </main>
      )}

      {volume && (
        <main className="workspace">
          <section className="viewer">
            <div className="viewer-bar">
              <span>Slice <b>{volume.sliceNumbers[slice]}</b> <span className="muted">of {volume.nz}</span></span>
              <input type="range" min={0} max={volume.nz - 1} value={flip ? volume.nz - 1 - slice : slice}
                onChange={(e) => setSlice(flip ? volume.nz - 1 - Number(e.target.value) : Number(e.target.value))} />
              <span className="group">
                {(['outline', 'brush', 'erase'] as Tool[]).map((t) => (
                  <button key={t} className={t === tool ? 'active' : ''} onClick={() => setTool(t)}>
                    {t === 'outline' ? 'Outline' : t === 'brush' ? 'Add' : 'Erase'}
                  </button>
                ))}
              </span>
              {/* Always laid out, hidden while outlining, so the tool buttons never move under the pointer. */}
              <span className={`group brush ${tool === 'outline' ? 'hidden' : ''}`}>
                <span className="muted">Brush {brushMm} mm</span>
                <input type="range" min={1} max={15} value={brushMm} onChange={(e) => setBrushMm(Number(e.target.value))} />
                <label className="check"><input type="checkbox" checked={ball} onChange={(e) => setBall(e.target.checked)} />3D</label>
              </span>
              {WINDOWS.map((w, i) => (
                <button key={w.name} className={i === windowIndex ? 'active' : ''} onClick={() => setWindowIndex(i)}>{w.name}</button>
              ))}
            </div>
            <Viewer volume={volume} slice={slice} window={WINDOWS[windowIndex]} findings={findings}
              selectedId={selectedId} spots={spots} scrollStep={flip ? -1 : 1} tool={tool} brushMm={brushMm}
              onSlice={setSlice} onStroke={addFinding} onBrush={onBrush} />
            <div className="viewer-hint">
              {notice || (tool === 'outline'
                ? 'Scroll to move through slices. Drag a line across a tumour to outline and measure it. Right-drag to pan, Ctrl+scroll to zoom.'
                : 'Paint on the image to correct the selected outline. Measurements update when you release the mouse.')}
            </div>
          </section>

          <aside className="panel">
            <h2>Scan</h2>
            <div className="grid2">
              <label>Patient ID<input value={scan.patientId} onChange={(e) => setScan({ ...scan, patientId: e.target.value })} /></label>
              <label>Scan date<input value={scan.scanDate} onChange={(e) => setScan({ ...scan, scanDate: e.target.value })} /></label>
              <label>Timepoint<input value={scan.timepoint} onChange={(e) => setScan({ ...scan, timepoint: e.target.value })} /></label>
              <label>Measured by<input value={scan.measuredBy} placeholder="Initials" onChange={(e) => setScan({ ...scan, measuredBy: e.target.value })} /></label>
            </div>
            <p className="muted small">Series {volume.meta.seriesNumber} · slice thickness {volume.meta.sliceThickness} mm · {volume.nz} slices</p>

            <h2>Prior scan</h2>
            {!prior && offered && (
              <div className="card offer">
                <p>A saved session for this patient was found: <b>{offered.timepoint}</b>, {offered.scanDate}, {offered.nodules.length} tumour{offered.nodules.length === 1 ? '' : 's'}.</p>
                <button className="primary" onClick={() => usePrior(offered)}>Use it as the prior scan</button>
              </div>
            )}
            {!prior && (
              <p className="muted small">
                For a follow-up scan, <button className="link" onClick={() => priorPicker.current?.click()}>load the prior session file</button>.
                The tool then shows where each tumour was and matches new outlines to it.
              </p>
            )}
            <input ref={priorPicker} type="file" accept=".json,application/json" hidden onChange={(e) => { void openPriorFile(e.target.files); e.target.value = ''; }} />
            {prior && (
              <>
                <p className="muted small">{prior.timepoint}, {prior.scanDate}. Dashed circles show where each tumour is expected.</p>
                {spots.map((sp) => {
                  const hit = findings.find((f) => f.prior?.noduleId === sp.nodule.noduleId);
                  return (
                    <div key={sp.nodule.noduleId} className="prior-row">
                      <b>{sp.nodule.noduleId}</b>
                      <span className="muted">{sp.nodule.longAxisMm.toFixed(1)} mm · {sp.nodule.volumeMm3.toLocaleString()} mm³</span>
                      <div className="spacer" />
                      {hit ? <span className="status ok">Matched</span>
                        : sp.notFound ? <span className="status todo">Not found</span>
                        : <button onClick={() => setSlice(sp.z)}>Go to</button>}
                      {!hit && (
                        <button onClick={() => setSpots((all) => all.map((q) => (q === sp ? { ...q, notFound: !q.notFound } : q)))}>
                          {sp.notFound ? 'Undo' : 'Not found'}
                        </button>
                      )}
                    </div>
                  );
                })}
              </>
            )}

            <h2>Tumours <span className="muted">({signed.length} of {findings.length} signed off)</span></h2>
            {!findings.length && <p className="muted">No outlines yet. Drag a line across a tumour in the image.</p>}
            {findings.map((f) => (
              <div key={f.id} className={`card ${f.id === selectedId ? 'selected' : ''}`} onClick={() => setSelectedId(f.id)}>
                <div className="card-head">
                  <input className="id" value={f.fields.noduleId} onChange={(e) => setField(f.id, 'noduleId', e.target.value)} />
                  <span className={`status ${f.signedOff ? 'ok' : 'todo'}`}>{f.signedOff ? 'Signed off' : 'Suggested, needs review'}</span>
                  <div className="spacer" />
                  <button onClick={(e) => { e.stopPropagation(); setSelectedId(f.id); setSlice(f.measurement.sliceIndex); }}>Go to slice {volume.sliceNumbers[f.measurement.sliceIndex]}</button>
                </div>
                <div className="numbers">
                  <div><span>Long axis</span><b>{f.measurement.longAxisMm.toFixed(1)} mm</b></div>
                  <div><span>Short axis</span><b>{f.measurement.shortAxisMm.toFixed(1)} mm</b></div>
                  <div><span>Mean diameter</span><b>{f.measurement.meanDiameterMm.toFixed(1)} mm</b></div>
                  <div><span>Volume</span><b>{Math.round(f.measurement.volumeMm3).toLocaleString()} mm³</b></div>
                </div>
                {f.prior && (
                  <div className="change">
                    Since prior: volume <b>{signedPct(f.measurement.volumeMm3, f.prior.volumeMm3)}</b>
                    <span className="muted"> ({f.prior.volumeMm3.toLocaleString()} → {Math.round(f.measurement.volumeMm3).toLocaleString()} mm³)</span>,
                    long axis <b>{signedMm(f.measurement.longAxisMm - f.prior.longAxisMm)}</b>
                    {Math.abs(f.measurement.volumeMm3 - f.prior.volumeMm3) / f.prior.volumeMm3 > 0.25 && (
                      <div className="flag">Large change. This is more than repeat measurements of an unchanged tumour usually differ, so check the outline closely before signing off.</div>
                    )}
                  </div>
                )}
                <div className="grid2">
                  <label>Lobe<select value={f.fields.lobe} onChange={(e) => setField(f.id, 'lobe', e.target.value)}>{LOBES.map((x) => <option key={x}>{x}</option>)}</select></label>
                  <label>Type<select value={f.fields.type} onChange={(e) => setField(f.id, 'type', e.target.value)}>{TYPES.map((x) => <option key={x}>{x}</option>)}</select></label>
                  {f.fields.type === 'Part-solid' && (
                    <label>Solid component (mm)<input value={f.fields.solidComponentMm} onChange={(e) => setField(f.id, 'solidComponentMm', e.target.value)} /></label>
                  )}
                  <label>Match to prior<select value={f.fields.matchToPrior} onChange={(e) => setField(f.id, 'matchToPrior', e.target.value)}>{MATCHES.map((x) => <option key={x}>{x}</option>)}</select></label>
                </div>
                <label>Notes<input value={f.fields.notes} onChange={(e) => setField(f.id, 'notes', e.target.value)} /></label>
                <div className="card-actions">
                  <button className={f.signedOff ? '' : 'primary'} onClick={(e) => { e.stopPropagation(); toggleSignOff(f.id); }}>{f.signedOff ? 'Withdraw sign-off' : 'Sign off'}</button>
                  <button className="danger" onClick={(e) => { e.stopPropagation(); remove(f.id); }}>Delete</button>
                </div>
              </div>
            ))}

            <div className="export">
              <button className="primary" disabled={!signed.length && !spots.some((sp) => sp.notFound)} onClick={exportSheet}>Export {signed.length || ''} row{signed.length === 1 ? '' : 's'} to sheet (CSV)</button>
              <p className="muted small">Only signed-off outlines are exported. The edit trail and a session file are saved next to the sheet. The session file is what the patient's next scan starts from; it holds a small blurred copy of the scan and stays on this computer.</p>
            </div>
          </aside>
        </main>
      )}
    </div>
  );
}
