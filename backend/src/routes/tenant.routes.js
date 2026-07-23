'use strict';

const { Router }              = require('express');
const { masterQuery }         = require('../config/masterDB');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditLog, auditMiddleware, auditAuth } = require('../middlewares/audit.middleware');

const { invalidateTenantCache }   = require('../middlewares/tenant.middleware');

const router = Router();

// ── GET /api/v1/tenant/config — público (lo usa el frontend al cargar) ──
router.get('/config', async (req, res) => {
  const t = req.tenant;
  return res.json({
    success: true,
    data: {
      nombre_clinica  : t.nombre_clinica  || 'VetClinic',
      logo_url        : t.logo_url        || null,
      favicon_url     : t.favicon_url     || null,
      color_primario  : t.color_primario  || '#10b981',
      color_sidebar   : t.color_sidebar   || '#0d3b2e',
      color_acento    : t.color_acento    || '#059669',
      moneda          : t.moneda          || 'PEN',
      simbolo_moneda  : t.simbolo_moneda  || 'S/.',
      pais            : t.pais            || 'Peru',
      zona_horaria    : t.zona_horaria    || 'America/Lima',
      igv_porcentaje  : t.igv_porcentaje  || 18,
      // Módulos habilitados
      modulos: {
        estetica    : !!t.modulo_estetica,
        facturacion : !!t.modulo_facturacion,
        inventario  : !!t.modulo_inventario,
        vacunas     : !!t.modulo_vacunas,
      },
    },
  });
});

// ── PUT /api/v1/tenant/config — solo admin ────────────────────────
router.put('/config', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const {
      nombre_clinica, logo_url, favicon_url,
      color_primario, color_sidebar, color_acento,
      moneda, simbolo_moneda, pais, zona_horaria,
    } = req.body;

    await masterQuery(
      `UPDATE tenant_config SET
         nombre_clinica=?, logo_url=?, favicon_url=?,
         color_primario=?, color_sidebar=?, color_acento=?,
         moneda=?, simbolo_moneda=?, pais=?, zona_horaria=?
       WHERE tenant_id=?`,
      [
        nombre_clinica, logo_url||null, favicon_url||null,
        color_primario||'#10b981', color_sidebar||'#0d3b2e', color_acento||'#059669',
        moneda||'PEN', simbolo_moneda||'S/.', pais||'Peru', zona_horaria||'America/Lima',
        req.tenant.tenant_id,
      ]
    );

    // Invalidar caché para que se recargue
    invalidateTenantCache(req.tenant.subdominio);

    return res.json({ success: true, message: 'Configuración actualizada.' });
  } catch (err) { next(err); }
});

module.exports = router;