/**
 * VetClinic — Service worker de la app de clínicas
 *
 * Estrategia:
 *  - API (/api/) y sockets (/socket.io/): nunca se tocan, siempre van a la red.
 *    Los datos clínicos y de caja no se sirven desde caché.
 *  - Páginas y archivos propios (html/css/js/íconos): red primero; la caché solo
 *    se usa si no hay conexión. Así cada deploy se ve al instante.
 *  - Sin conexión y sin copia de la página → offline.html.
 *  - CDNs (Tailwind, Socket.io, Google Fonts): caché que se refresca en segundo plano.
 *
 * Al cambiar este archivo, sube VERSION: la app mostrará "Hay una nueva versión".
 */
const VERSION      = 'v6-20261103';
const SHELL_CACHE  = `vet-shell-${VERSION}`;
const CDN_CACHE    = 'vet-cdn-v1';
const OFFLINE_URL  = '/offline.html';

const SHELL = [
  OFFLINE_URL,
  '/css/app.css',
  '/js/shared.js',
  '/js/layout.js',
  '/js/pwa.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/favicon-32.png',
];

const CDN_HOSTS = ['cdn.tailwindcss.com', 'cdn.socket.io', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith('vet-shell-') && k !== SHELL_CACHE)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// La página pide activar la versión nueva cuando el usuario acepta el aviso
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
    e.respondWith(redPrimero(req));
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(cacheYRefresca(req));
  }
  // El resto (API en api.<dominio>, imágenes en Azure, etc.) va directo a la red.
});

async function redPrimero(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  } catch {
    const copia = await cache.match(req, { ignoreSearch: true });
    if (copia) return copia;
    if (req.mode === 'navigate') return cache.match(OFFLINE_URL);
    return Response.error();
  }
}

async function cacheYRefresca(req) {
  const cache = await caches.open(CDN_CACHE);
  const copia = await cache.match(req);
  const red   = fetch(req).then(res => {
    if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
    return res;
  }).catch(() => copia || Response.error());
  return copia || red;
}
