'use strict';

const { Router }    = require('express');
const { masterQuery } = require('../config/masterDB');
const { authenticate } = require('../middlewares/auth.middleware');

const router = Router();

// ── GET /api/v1/branding — público, no requiere auth ──────────
// El frontend lo llama al cargar cualquier página
router.get('/', async (req, res, next) => {
  try {
    const host = req.headers['x-tenant-host'] || req.hostname || '';

    const [config] = await masterQuery(
      `SELECT
         tc.nombre_clinica, tc.logo_url, tc.favicon_url,
         tc.color_primario, tc.color_sidebar, tc.color_acento,
         tc.moneda, tc.simbolo_moneda, tc.igv_porcentaje,
         tc.modulo_estetica, tc.modulo_facturacion,
         tc.modulo_inventario, tc.modulo_vacunas,
         tc.modulo_consentimientos, tc.modulo_carnet,
         tc.zona_horaria, tc.pais,
         t.plan, t.activo,
         COALESCE(wcg.ver_qr, 1)   AS wa_ver_qr,
         COALESCE(wcg.ver_meta, 0) AS wa_ver_meta
       FROM tenants t
       JOIN tenant_config tc ON tc.tenant_id = t.id
       LEFT JOIN wa_config_global wcg ON wcg.tenant_id = t.id
       WHERE t.subdominio = ? AND t.activo = 1
       LIMIT 1`, [host]
    );

    if (!config) {
      return res.json({
        success: true,
        data: defaultBranding(),
      });
    }

    return res.json({ success: true, data: config });
  } catch (err) { next(err); }
});

// ── GET /api/v1/branding/manifest.webmanifest — público ───────
// Manifest de la PWA por clínica: nombre y colores propios para "Instalar app".
// En producción el frontend lo pide en su mismo dominio (Nginx proxea /api/ con X-Tenant-Host).
router.get('/manifest.webmanifest', async (req, res, next) => {
  try {
    const b      = await brandingDelHost(req);
    const nombre = String(b.nombre_clinica || 'VetClinic').trim();
    const fondo  = colorHex(b.color_sidebar, '#0d3b2e');

    res.type('application/manifest+json');
    res.set('Cache-Control', 'no-cache');
    return res.json({
      id              : '/',
      name            : nombre,
      short_name      : nombre.length > 12 ? nombre.slice(0, 12).trim() : nombre,
      description     : `Gestión veterinaria de ${nombre}`,
      lang            : 'es',
      dir             : 'ltr',
      start_url       : '/index.html?source=pwa',
      scope           : '/',
      display         : 'standalone',
      orientation     : 'any',
      theme_color     : fondo,
      background_color: '#faf9f6',
      categories      : ['medical', 'business', 'productivity'],
      icons: [
        { src: '/icons/icon-192.png',          sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-512.png',          sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        { src: '/api/v1/branding/icon.svg',    sizes: 'any',     type: 'image/svg+xml', purpose: 'any' },
      ],
      shortcuts: [
        { name: 'Citas',          url: '/citas',       icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
        { name: 'Calendario',     url: '/calendario',  icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
        { name: 'Mascotas',       url: '/mascotas',    icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
        { name: 'Punto de Venta', url: '/punto-venta', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      ],
    });
  } catch (err) { next(err); }
});

// ── GET /api/v1/branding/icon.svg — público ───────────────────
// Ícono de la app con los colores de la clínica (huella sobre degradado).
router.get('/icon.svg', async (req, res, next) => {
  try {
    const b  = await brandingDelHost(req);
    const c1 = colorHex(b.color_primario, '#10b981');
    const c2 = colorHex(b.color_acento,   '#059669');

    res.type('image/svg+xml');
    res.set('Cache-Control', 'public, max-age=3600');
    return res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
  <rect width="512" height="512" rx="112" fill="url(#g)"/>
  <g transform="translate(97 97) scale(13.2)" fill="#ffffff">
    <circle cx="6.5" cy="10" r="2.1"/><circle cx="10" cy="5.8" r="2.1"/><circle cx="14.5" cy="5.8" r="2.1"/><circle cx="18" cy="10" r="2.1"/>
    <ellipse cx="12.2" cy="15.8" rx="5.6" ry="4.2"/>
  </g>
</svg>`);
  } catch (err) { next(err); }
});

// ── GET /api/v1/branding/permisos — requiere auth ─────────────
// Devuelve los permisos del rol del usuario logueado
router.get('/permisos', authenticate, async (req, res, next) => {
  try {
    const host = req.headers['x-tenant-host'] || req.hostname || '';

    // Obtener tenant_id
    const [tenant] = await masterQuery(
      'SELECT id FROM tenants WHERE subdominio=? AND activo=1', [host]
    );

    if (!tenant) {
      return res.json({ success:true, data: permisosDefault(req.user.rol) });
    }

    // Obtener permisos configurados
    const permisos = await masterQuery(
      `SELECT modulo, permiso, activo
       FROM tenant_permisos
       WHERE tenant_id=? AND rol=?
       ORDER BY modulo, permiso`,
      [tenant.id, req.user.rol]
    );

    // Si no hay permisos configurados aún, devolver defaults
    if (!permisos.length) {
      return res.json({ success:true, data: permisosDefault(req.user.rol) });
    }

    // Convertir a objeto: { modulo: { permiso: true/false } }
    const map = {};
    for (const p of permisos) {
      if (!map[p.modulo]) map[p.modulo] = {};
      map[p.modulo][p.permiso] = !!p.activo;
    }

    return res.json({ success:true, data: map });
  } catch (err) { next(err); }
});

// Branding mínimo de la clínica del host actual (o el de por defecto)
async function brandingDelHost(req) {
  const host = req.headers['x-tenant-host'] || req.hostname || '';
  const [config] = await masterQuery(
    `SELECT tc.nombre_clinica, tc.color_primario, tc.color_sidebar, tc.color_acento
     FROM tenants t
     JOIN tenant_config tc ON tc.tenant_id = t.id
     WHERE t.subdominio = ? AND t.activo = 1
     LIMIT 1`, [host]
  );
  return config || defaultBranding();
}

// Solo acepta #rgb / #rrggbb; evita inyectar texto arbitrario en el SVG o el manifest
function colorHex(valor, porDefecto) {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(valor || '').trim())
    ? String(valor).trim() : porDefecto;
}

function defaultBranding() {
  return {
    nombre_clinica       : 'VetClinic',
    logo_url             : null,
    favicon_url          : null,
    color_primario       : '#10b981',
    color_sidebar        : '#0d3b2e',
    color_acento         : '#059669',
    moneda               : 'PEN',
    simbolo_moneda       : 'S/.',
    igv_porcentaje       : 18,
    modulo_estetica      : 1,
    modulo_facturacion   : 1,
    modulo_inventario    : 1,
    modulo_vacunas       : 1,
    modulo_consentimientos: 1,
    modulo_carnet        : 1,
    zona_horaria         : 'America/Lima',
    pais                 : 'Peru',
    plan                 : 'basic',
    activo               : 1,
    wa_ver_qr            : 1,
    wa_ver_meta          : 0,
  };
}

function permisosDefault(rol) {
  const todos = {
    dashboard    : { ver:true },
    citas        : { ver:true, crear:true, editar:true, cancelar:true, ver_todas:true },
    propietarios : { ver:true, crear:true, editar:true },
    mascotas     : { ver:true, crear:true, editar:true },
    historia     : { ver:true, crear:true, editar:true },
    inventario   : { ver:true, crear:true, editar:true, actualizar_stock:true },
    facturacion  : { ver:true, crear:true, anular:true, ver_reportes:true },
    servicios    : { ver:true, crear:true, editar:true },
    caja         : { ver:true, crear_borrador:true, cerrar:true },
    reportes     : { ver:true, exportar:true },
    usuarios     : { ver:true, crear:true, editar:true, toggle:true },
    consentimientos: { ver:true, crear:true, firmar:true },
    configuracion: { ver:true, editar:true },
  };

  if (rol === 'veterinario') {
    todos.facturacion  = { ver:false, crear:false, anular:false, ver_reportes:false };
    todos.caja         = { ver:false, crear_borrador:false, cerrar:false };
    todos.reportes     = { ver:false, exportar:false };
    todos.usuarios     = { ver:false, crear:false, editar:false, toggle:false };
    todos.configuracion= { ver:false, editar:false };
    todos.servicios    = { ver:true, crear:false, editar:false };
    todos.citas.ver_todas = false;
    todos.consentimientos.firmar = true;
  }

  if (rol === 'veterinario_recepcionista') {
    // Combinación: acceso médico completo + caja/facturación del recepcionista
    todos.reportes     = { ver:false, exportar:false };
    todos.usuarios     = { ver:false, crear:false, editar:false, toggle:false };
    todos.configuracion= { ver:false, editar:false };
    todos.servicios    = { ver:true, crear:false, editar:false };
    todos.citas.ver_todas = false;  // solo ve sus propias citas (como veterinario)
    todos.consentimientos.firmar = true;
  }

  if (rol === 'groomer') {
    // Estética: registra baños y agenda sus citas de estética; sin historia clínica ni caja
    todos.dashboard    = { ver:false };
    todos.historia     = { ver:true, crear:false, editar:false };   // solo la pestaña Estética
    todos.inventario   = { ver:false, crear:false, editar:false, actualizar_stock:false };
    todos.facturacion  = { ver:false, crear:false, anular:false, ver_reportes:false };
    todos.servicios    = { ver:true, crear:false, editar:false };
    todos.caja         = { ver:false, crear_borrador:false, cerrar:false };
    todos.reportes     = { ver:false, exportar:false };
    todos.usuarios     = { ver:false, crear:false, editar:false, toggle:false };
    todos.consentimientos = { ver:false, crear:false, firmar:false };
    todos.configuracion= { ver:false, editar:false };
    todos.citas.ver_todas = false;  // solo citas de estética
  }

  if (rol === 'recepcionista') {
    todos.reportes     = { ver:false, exportar:false };
    todos.usuarios     = { ver:false, crear:false, editar:false, toggle:false };
    todos.configuracion= { ver:false, editar:false };
    todos.historia     = { ver:true, crear:false, editar:false };
    todos.caja.cerrar  = false;
    todos.consentimientos.firmar = false;
  }

  return todos;
}

module.exports = router;