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
         t.plan, t.activo
       FROM tenants t
       JOIN tenant_config tc ON tc.tenant_id = t.id
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
    plan                 : 'basic',
    activo               : 1,
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