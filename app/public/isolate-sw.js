/*
 * Makes the page "cross-origin isolated" on plain static hosting (such as GitHub Pages), which
 * cannot send the two response headers a browser asks for before it allows multi-threaded
 * WebAssembly. The image model needs those threads: with one thread a slice takes most of a
 * minute, with eight about six seconds.
 *
 * This worker only adds the headers to responses the page already requested. It does not store,
 * change or send anything else, and the scan never passes through it (scans are read from disk).
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
  event.respondWith(fetch(request).then((response) => {
    if (response.status === 0) return response;
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }));
});
