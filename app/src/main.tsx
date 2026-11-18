import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import './ui/styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Static hosting cannot send the headers that allow multi-threaded WebAssembly, which the image
// model needs to be usable. A small service worker adds them (see public/isolate-sw.js); the page
// reloads once, the first time, so that it takes effect. If anything here fails the tool still
// works, and the image model simply runs on one thread.
if (import.meta.env.PROD && !globalThis.crossOriginIsolated && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('isolate-sw.js').then(async () => {
    await navigator.serviceWorker.ready;
    if (!sessionStorage.getItem('ltm.isolated')) { sessionStorage.setItem('ltm.isolated', '1'); location.reload(); }
  }).catch(() => { /* not available here: carry on without it */ });
}
