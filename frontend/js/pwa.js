/**
 * VetClinic — PWA (app instalable)
 *
 * - Registra el service worker (/sw.js).
 * - En producción usa el manifest de la clínica (/api/v1/branding/manifest.webmanifest)
 *   para que la app instalada lleve su nombre y colores.
 * - Botón "Instalar app": cualquier elemento con [data-pwa-install] se muestra cuando
 *   el navegador permite instalar. En iPhone/iPad muestra los pasos manuales.
 * - Aviso "Hay una nueva versión" cuando se publica un sw.js nuevo.
 *
 * No depende de shared.js: también funciona en login y páginas públicas.
 */
(function () {
  'use strict';

  const host     = location.hostname;
  const esLocal  = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.test') || host.endsWith('.local');
  const esIOS    = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                   (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const instalada = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  let promptDiferido = null;

  // ── Manifest de la clínica ──────────────────────────────────────
  // Nginx proxea /api/ en el dominio de cada clínica; en local queda el manifest estático.
  if (!esLocal) {
    const link = document.querySelector('link[rel="manifest"]');
    if (link) link.href = '/api/v1/branding/manifest.webmanifest';
  }

  if (instalada()) document.documentElement.classList.add('pwa-standalone');

  // ── Estilos propios (login y páginas públicas no cargan app.css) ──
  const css = `
  [data-pwa-install][hidden]{display:none!important}
  .pwa-sheet-bg{position:fixed;inset:0;z-index:10000;background:rgba(13,59,46,.45);
    -webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);display:flex;align-items:flex-end;justify-content:center;
    animation:pwaFade .2s ease}
  .pwa-sheet{background:#fff;color:#1a2e28;width:100%;max-width:440px;border-radius:1.4rem 1.4rem 0 0;
    padding:1.3rem 1.4rem max(1.3rem,env(safe-area-inset-bottom));font-family:inherit;
    box-shadow:0 -10px 40px rgba(0,0,0,.15);animation:pwaUp .3s cubic-bezier(.34,1.3,.64,1)}
  @media(min-width:640px){.pwa-sheet-bg{align-items:center}.pwa-sheet{border-radius:1.4rem}}
  .pwa-sheet h3{font-size:1.05rem;font-weight:700;margin:0 0 .3rem;display:flex;align-items:center;gap:.6rem}
  .pwa-sheet h3 img{width:40px;height:40px;border-radius:11px}
  .pwa-sheet p{font-size:.85rem;color:#5b6d66;margin:0 0 1rem;line-height:1.5}
  .pwa-sheet ol{margin:0 0 1.2rem;padding:0;list-style:none;counter-reset:p}
  .pwa-sheet li{counter-increment:p;display:flex;align-items:center;gap:.7rem;font-size:.88rem;padding:.55rem 0;border-top:1px solid #eef2ef}
  .pwa-sheet li::before{content:counter(p);flex-shrink:0;width:26px;height:26px;border-radius:50%;
    background:var(--green-50,#ecfdf5);color:var(--green-700,#15803d);font-weight:700;font-size:.78rem;
    display:flex;align-items:center;justify-content:center}
  .pwa-sheet svg{vertical-align:-4px}
  .pwa-btn{width:100%;min-height:48px;border:none;border-radius:.9rem;cursor:pointer;font:inherit;font-weight:600;font-size:.92rem;
    background:linear-gradient(135deg,var(--green-500,#10b981),var(--accent,#059669));color:var(--on-brand,#fff)}
  .pwa-update{position:fixed;z-index:10000;left:50%;transform:translateX(-50%);
    bottom:max(1rem,env(safe-area-inset-bottom));width:calc(100% - 2rem);max-width:420px;
    background:#1a2e28;color:#fff;border-radius:1rem;padding:.8rem .9rem .8rem 1.1rem;
    display:flex;align-items:center;gap:.8rem;font-size:.85rem;box-shadow:0 12px 34px rgba(0,0,0,.25);
    animation:pwaUp .3s ease}
  .pwa-update span{flex:1}
  .pwa-update button{border:none;border-radius:.7rem;min-height:40px;padding:0 1rem;cursor:pointer;font:inherit;font-weight:600}
  .pwa-update .pwa-ok{background:var(--green-500,#10b981);color:var(--on-brand,#fff)}
  .pwa-update .pwa-no{background:transparent;color:rgba(255,255,255,.65);padding:0 .5rem}
  @keyframes pwaUp{from{transform:translate(var(--pwa-x,0),40px);opacity:0}to{opacity:1}}
  .pwa-update{--pwa-x:-50%}
  @keyframes pwaFade{from{opacity:0}}`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ── Botones de instalar ─────────────────────────────────────────
  function puedeInstalar() {
    if (instalada()) return false;
    return !!promptDiferido || esIOS;
  }

  function actualizarBotones() {
    const visible = puedeInstalar();
    document.querySelectorAll('[data-pwa-install]').forEach(el => { el.hidden = !visible; });
  }

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();          // mostramos nuestro botón en lugar de la mini barra del navegador
    promptDiferido = e;
    actualizarBotones();
  });

  window.addEventListener('appinstalled', () => {
    promptDiferido = null;
    document.documentElement.classList.add('pwa-standalone');
    actualizarBotones();
    if (typeof window.toast === 'function') window.toast('✅ App instalada. Ábrela desde tu pantalla de inicio.', 'success');
  });

  async function pwaInstalar() {
    if (promptDiferido) {
      promptDiferido.prompt();
      await promptDiferido.userChoice.catch(() => null);
      promptDiferido = null;        // el evento solo se puede usar una vez
      actualizarBotones();
      return;
    }
    if (esIOS) mostrarPasosIOS();
  }
  window.pwaInstalar = pwaInstalar;

  function mostrarPasosIOS() {
    const compartir = '<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#0a84ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"/></svg>';
    const agregar   = '<svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="#1a2e28" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';
    const icono = document.querySelector('link[rel="apple-touch-icon"]')?.href || '/icons/icon-192.png';
    const bg = document.createElement('div');
    bg.className = 'pwa-sheet-bg';
    bg.innerHTML = `
      <div class="pwa-sheet" role="dialog" aria-modal="true" aria-label="Instalar app">
        <h3><img src="${icono}" alt=""/>Instalar en tu ${/iPhone|iPod/.test(navigator.userAgent) ? 'iPhone' : 'iPad'}</h3>
        <p>Tendrás la app en tu pantalla de inicio, a pantalla completa y sin la barra del navegador.</p>
        <ol>
          <li><span>Toca <b>Compartir</b> ${compartir} en la barra de Safari</span></li>
          <li><span>Elige <b>Agregar a inicio</b> ${agregar}</span></li>
          <li><span>Toca <b>Agregar</b> arriba a la derecha</span></li>
        </ol>
        <button class="pwa-btn" type="button">Entendido</button>
      </div>`;
    const cerrar = () => bg.remove();
    bg.addEventListener('click', e => { if (e.target === bg) cerrar(); });
    bg.querySelector('.pwa-btn').addEventListener('click', cerrar);
    document.body.appendChild(bg);
  }

  // ── Service worker + aviso de versión nueva ─────────────────────
  function avisarActualizacion(reg) {
    if (document.querySelector('.pwa-update')) return;
    const bar = document.createElement('div');
    bar.className = 'pwa-update';
    bar.setAttribute('role', 'status');
    bar.innerHTML = `<span>🔄 Hay una nueva versión del sistema.</span>
      <button class="pwa-no" type="button">Luego</button>
      <button class="pwa-ok" type="button">Actualizar</button>`;
    bar.querySelector('.pwa-no').onclick = () => bar.remove();
    bar.querySelector('.pwa-ok').onclick = () => {
      bar.remove();
      let recargado = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (recargado) return;
        recargado = true;
        location.reload();
      });
      reg.waiting?.postMessage({ type: 'SKIP_WAITING' });
    };
    document.body.appendChild(bar);
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || esLocal)) {
    window.addEventListener('load', async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        // Solo hay "actualización" si ya había un SW controlando la página
        if (reg.waiting && navigator.serviceWorker.controller) avisarActualizacion(reg);
        reg.addEventListener('updatefound', () => {
          const nuevo = reg.installing;
          nuevo?.addEventListener('statechange', () => {
            if (nuevo.state === 'installed' && navigator.serviceWorker.controller) avisarActualizacion(reg);
          });
        });
        // Revisar si hay versión nueva al volver a la app
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      } catch { /* sin SW la app sigue funcionando normal */ }
    });
  }

  // Botones que se agregan después (layout.js arma el topbar al cargar)
  document.addEventListener('DOMContentLoaded', actualizarBotones);
  window.pwaActualizarBotones = actualizarBotones;
})();
