'use strict';

const { Router }    = require('express');
const { masterQuery } = require('../config/masterDB');

const router = Router();

// Módulos y permisos disponibles
const MODULOS = {
  dashboard    : ['ver'],
  citas        : ['ver','crear','editar','cancelar','ver_todas'],
  propietarios : ['ver','crear','editar'],
  mascotas     : ['ver','crear','editar'],
  historia     : ['ver','crear','editar'],
  inventario   : ['ver','crear','editar','actualizar_stock'],
  facturacion  : ['ver','crear','anular','ver_reportes'],
  servicios    : ['ver','crear','editar'],
  caja         : ['ver','crear_borrador','cerrar'],
  reportes     : ['ver','exportar'],
  usuarios     : ['ver','crear','editar','toggle'],
  consentimientos: ['ver','crear','firmar'],
  configuracion: ['ver','editar'],
};

// ── GET /api/v1/admin/permisos/:tenantId ──────────────────────
router.get('/:tenantId', async (req, res, next) => {
  try {
    const rows = await masterQuery(
      'SELECT rol, modulo, permiso, activo FROM tenant_permisos WHERE tenant_id=? ORDER BY rol, modulo',
      [req.params.tenantId]
    );

    // Organizar por rol → modulo → permiso
    const result = { admin:{}, veterinario:{}, recepcionista:{} };
    for (const r of rows) {
      if (!result[r.rol]) result[r.rol] = {};
      if (!result[r.rol][r.modulo]) result[r.rol][r.modulo] = {};
      result[r.rol][r.modulo][r.permiso] = !!r.activo;
    }

    return res.json({ success:true, data: result, modulos: MODULOS });
  } catch(err) { next(err); }
});

// ── PUT /api/v1/admin/permisos/:tenantId ──────────────────────
// Body: { rol, modulo, permiso, activo }
router.put('/:tenantId', auditMiddleware('permisos:actualizado', 'permisos'), async (req, res, next) => {
  try {
    const { rol, modulo, permiso, activo } = req.body;
    if (!rol || !modulo || !permiso)
      return res.status(422).json({ success:false, message:'rol, modulo y permiso requeridos.' });

    // Admin siempre tiene todos los permisos — no se puede editar
    if (rol === 'admin') {
      return res.status(422).json({ success:false, message:'Los permisos del Admin no se pueden modificar.' });
    }

    await masterQuery(
      `INSERT INTO tenant_permisos (tenant_id, rol, modulo, permiso, activo)
       VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE activo=?`,
      [req.params.tenantId, rol, modulo, permiso, activo?1:0, activo?1:0]
    );

    return res.json({ success:true, message:'Permiso actualizado.' });
  } catch(err) { next(err); }
});

// ── PUT /api/v1/admin/permisos/:tenantId/bulk ─────────────────
// Guardar todos los permisos de una vez
router.put('/:tenantId/bulk', auditMiddleware('permisos:actualizado', 'permisos'), async (req, res, next) => {
  try {
    const { permisos } = req.body; // [{ rol, modulo, permiso, activo }]
    if (!Array.isArray(permisos) || !permisos.length)
      return res.status(422).json({ success:false, message:'permisos[] requerido.' });

    for (const p of permisos) {
      if (p.rol === 'admin') continue; // Admin no se toca
      await masterQuery(
        `INSERT INTO tenant_permisos (tenant_id, rol, modulo, permiso, activo)
         VALUES (?,?,?,?,?)
         ON DUPLICATE KEY UPDATE activo=?`,
        [req.params.tenantId, p.rol, p.modulo, p.permiso, p.activo?1:0, p.activo?1:0]
      );
    }

    return res.json({ success:true, message:'Permisos guardados correctamente.' });
  } catch(err) { next(err); }
});

module.exports = { router, MODULOS };