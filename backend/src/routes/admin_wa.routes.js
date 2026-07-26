'use strict';

/**
 * VetClinic SaaS — Admin WA Routes
 * Base: /admin/api/wa
 * Gestión de cuotas y estado WA por tenant (panel SaaS admin)
 */

const { Router }     = require('express');
const { masterQuery } = require('../config/masterDB');
const { authenticateAdmin } = require('../middlewares/auth.middleware');

const router = Router();
router.use(authenticateAdmin);

// ── GET /admin/api/wa/:tenantId/config ────────────────────────
// Devuelve cuota y estado WA de un tenant
router.get('/:tenantId/config', async (req, res, next) => {
  try {
    const { tenantId } = req.params;

    const [cfg] = await masterQuery(
      `SELECT activo, ilimitado, msgs_incluidos, msgs_usados, mes_actual
       FROM wa_config_global
       WHERE tenant_id = ?`,
      [tenantId]
    );

    if (!cfg) {
      // Si no existe aún, devolver defaults
      return res.json({
        success: true,
        data: {
          activo        : false,
          ilimitado     : false,
          msgs_incluidos: 100,
          msgs_usados   : 0,
          mes_actual    : null,
        },
      });
    }

    return res.json({ success: true, data: cfg });
  } catch (err) { next(err); }
});

// ── PUT /admin/api/wa/:tenantId/config ────────────────────────
// Actualiza cuota y activación WA de un tenant
router.put('/:tenantId/config', async (req, res, next) => {
  try {
    const { tenantId } = req.params;
    const { activo, ilimitado, msgs_incluidos } = req.body;

    // Verificar que el tenant existe
    const [t] = await masterQuery('SELECT id FROM tenants WHERE id=?', [tenantId]);
    if (!t) return res.status(404).json({ success: false, message: 'Tenant no encontrado' });

    // Upsert — insertar o actualizar
    await masterQuery(
      `INSERT INTO wa_config_global (tenant_id, activo, ilimitado, msgs_incluidos)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         activo         = VALUES(activo),
         ilimitado      = VALUES(ilimitado),
         msgs_incluidos = VALUES(msgs_incluidos)`,
      [
        tenantId,
        activo    ? 1 : 0,
        ilimitado ? 1 : 0,
        parseInt(msgs_incluidos) || 100,
      ]
    );

    return res.json({ success: true, message: 'Configuración WA guardada.' });
  } catch (err) { next(err); }
});

// ── GET /admin/api/wa/estado-global ──────────────────────────
// Estado de todas las sesiones WA (para el panel global)
router.get('/estado-global', async (req, res, next) => {
  try {
    const rows = await masterQuery(
      `SELECT ws.tenant_id, ws.estado, ws.numero_wa, ws.ultima_conexion, ws.ultima_actividad,
              tc.nombre_clinica, t.slug,
              wcg.activo, wcg.ilimitado, wcg.msgs_incluidos, wcg.msgs_usados
       FROM wa_sesiones ws
       JOIN tenants t ON t.id = ws.tenant_id
       LEFT JOIN tenant_config tc ON tc.tenant_id = ws.tenant_id
       LEFT JOIN wa_config_global wcg ON wcg.tenant_id = ws.tenant_id
       WHERE t.activo = 1
       ORDER BY tc.nombre_clinica`
    );
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

module.exports = router;