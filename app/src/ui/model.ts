import type { ModelReply, ModelRequest } from './modelWorker.ts';

/** The image model, loaded on first use and kept for the rest of the visit. */
export class BoxModel {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private waiting = new Map<number, { resolve: (r: { low: Float32Array; ms: number }) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  threads = 1;

  /** Download (first time only) and start the model. onProgress reports megabytes received. */
  load(onProgress: (megabytes: number, total: number) => void): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL('./modelWorker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      const fail = (message: string) => { this.ready = null; this.worker = null; worker.terminate(); reject(new Error(message)); };
      worker.onerror = (e) => fail(e.message || 'The model could not be started in this browser.');
      worker.onmessage = (e: MessageEvent<ModelReply>) => {
        const m = e.data;
        if (m.type === 'progress') onProgress(m.megabytes, m.total);
        else if (m.type === 'ready') { this.threads = m.threads; resolve(); }
        else if (m.type === 'mask') { this.waiting.get(m.id)?.resolve({ low: m.low, ms: m.ms }); this.waiting.delete(m.id); }
        else if (m.id === undefined) fail(m.message);
        else { this.waiting.get(m.id)?.reject(new Error(m.message)); this.waiting.delete(m.id); }
      };
      const request: ModelRequest = { type: 'load', modelBase: new URL('models/', document.baseURI).href, runtimeBase: new URL('ort/', document.baseURI).href };
      worker.postMessage(request);
    });
    return this.ready;
  }

  /** Outline inside a box on one prepared slice. Returns the model's 256 x 256 score map. */
  slice(image: Float32Array, box: Float32Array): Promise<{ low: Float32Array; ms: number }> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.waiting.set(id, { resolve, reject });
      const request: ModelRequest = { type: 'slice', id, image, box };
      this.worker!.postMessage(request, [image.buffer]);
    });
  }
}
