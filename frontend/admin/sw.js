/**
 * Service worker mínimo para que el panel se pueda instalar como app.
 * No guarda nada en caché a propósito: el panel siempre debe mostrar
 * datos y código actuales (nginx ya sirve los .html/.js sin caché).
 */
self.addEventListener('install',  () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* red directa, sin caché */ });
