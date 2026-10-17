'use strict';

/**
 * VetClinic SaaS — Admin WA Routes
 * Base: /admin/api/wa
 *
 * Controla por clínica:
 *  - WhatsApp activo / cuota de mensajes (Baileys)
 *  - Qué pantallas ve la clínica: WhatsApp (QR) y/o WhatsApp Meta
 *  - Umbral de aviso mensual de mensajes Meta
 */

const { Router }      = require('express');
const jwt             = require('jsonwebtoken');
const { masterQuery } = require('../config/masterDB');

const router       = Router();
const ADMIN_SECRET = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'admin-secret';

// ── Auth admin (antes estas rutas quedaban abiertas) ─────────────
router.use((req, res, next) => {
  const token = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Token requerido.' });
  try {
    req.adminUser = jwt.verify(token, ADMIN_SECRET);
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Token inválido.' });
  }
});

const DEFAULTS = {
  activo: 0, ilimitado: 0, msgs_incluidos: 100, msgs_usados: 0,
  ver_qr: 1, ver_meta: 0, meta_alerta_mensual: 1000,
};

// ── GET /admin/api/wa/estado-global ──────────────────────────────
// DEBE ir antes de /:tenantId
// Parte de tenants (no de wa_sesiones) para incluir clínicas que solo usan Meta.
router.get('/estado-global', async (req, res, next) => {
  try {
    const rows = await masterQuery(
      `SELECT t.id AS tenant_id, t.slug, t.subdominio, tc.nombre_clinica,
              ws.estado, ws.numero_wa, ws.ultima_conexion,
              wcg.activo, wcg.ilimitado, wcg.msgs_incluidos, wcg.msgs_usados,
              COALESCE(wcg.ver_qr, 1)                AS ver_qr,
              COALESCE(wcg.ver_meta, 0)              AS ver_meta,
              COALESCE(wcg.meta_alerta_mensual, 1000) AS meta_alerta_mensual,
              wm.estado         AS meta_estado,
              wm.numero_display AS meta_numero,
              wm.coexistencia   AS meta_coexistencia,
              wm.calidad        AS meta_calidad
       FROM tenants t
       LEFT JOIN tenant_config    tc  ON tc.tenant_id  = t.id
       LEFT JOIN wa_sesiones      ws  ON ws.tenant_id  = t.id
       LEFT JOIN wa_config_global wcg ON wcg.tenant_id = t.id
       LEFT JOIN wa_meta_cuentas  wm  ON wm.tenant_id  = t.id
       WHERE t.activo = 1
       ORDER BY tc.nombre_clinica`
    );

    // Proveedor que se usa realmente para enviar
    for (const r of rows) {
      r.proveedor_activo = (r.ver_meta && r.meta_estado === 'conectado') ? 'meta' : 'qr';
    }
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /admin/api/wa/:tenantId/config ────────────────────────────
router.get('/:tenantId/config', async (req, res, next) => {
  try {
    const [cfg] = await masterQuery(
      `SELECT activo, ilimitado, msgs_incluidos, msgs_usados, mes_actual,
              ver_qr, ver_meta, meta_alerta_mensual
       FROM wa_config_global WHERE tenant_id=?`,
      [req.params.tenantId]
    );
    const [meta] = await masterQuery(
      `SELECT estado, numero_display, nombre_verificado, coexistencia, calidad, conectado_at
       FROM wa_meta_cuentas WHERE tenant_id=?`,
      [req.params.tenantId]
    );
    return res.json({
      success: true,
      data: { ...DEFAULTS, ...(cfg || {}), meta: meta || null },
    });
  } catch (err) { next(err); }
});

// ── PUT /admin/api/wa/:tenantId/config ────────────────────────────
// Solo cambia los campos enviados; el resto se conserva.
router.put('/:tenantId/config', async (req, res, next) => {
  try {
    const { tenantId } = req.params;

    const [t] = await masterQuery('SELECT id FROM tenants WHERE id=?', [tenantId]);
    if (!t) return res.status(404).json({ success: false, message: 'Tenant no encontrado' });

    const [actual] = await masterQuery(
      `SELECT activo, ilimitado, msgs_incluidos, ver_qr, ver_meta, meta_alerta_mensual
       FROM wa_config_global WHERE tenant_id=?`, [tenantId]
    );
    const base = { ...DEFAULTS, ...(actual || {}) };
    const b    = req.body || {};
    const bool = (v, def) => (v === undefined ? (def ? 1 : 0) : (v ? 1 : 0));
    const ent  = (v, def, min = 1) => {
      if (v === undefined) return def;
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n >= min ? n : def;
    };

    const nuevo = {
      activo             : bool(b.activo,    base.activo),
      ilimitado          : bool(b.ilimitado, base.ilimitado),
      msgs_incluidos     : ent(b.msgs_incluidos, base.msgs_incluidos),
      ver_qr             : bool(b.ver_qr,    base.ver_qr),
      ver_meta           : bool(b.ver_meta,  base.ver_meta),
      meta_alerta_mensual: ent(b.meta_alerta_mensual, base.meta_alerta_mensual),
    };

    await masterQuery(
      `INSERT INTO wa_config_global
         (tenant_id, activo, ilimitado, msgs_incluidos, ver_qr, ver_meta, meta_alerta_mensual)
       VALUES (?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         activo=VALUES(activo), ilimitado=VALUES(ilimitado),
         msgs_incluidos=VALUES(msgs_incluidos),
         ver_qr=VALUES(ver_qr), ver_meta=VALUES(ver_meta),
         meta_alerta_mensual=VALUES(meta_alerta_mensual)`,
      [tenantId, nuevo.activo, nuevo.ilimitado, nuevo.msgs_incluidos,
       nuevo.ver_qr, nuevo.ver_meta, nuevo.meta_alerta_mensual]
    );

    return res.json({ success: true, message: 'Configuración WA guardada.', data: nuevo });
  } catch (err) { next(err); }
});

module.exports = router;