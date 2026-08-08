'use strict';

const { Router }   = require('express');
const { query, queryOne, withTransaction, generarNumeroComprobante } = require('../db');
const { authAdmin }   = require('../middlewares/auth.middleware');
const emailService    = require('../services/email.service');
const pdfService      = require('../services/pdf.service');

const router = Router();
router.use(authAdmin);

// ── GET /api/admin/dashboard ──────────────────────────────────
router.get('/dashboard', async (req, res, next) => {
  try {
    const mesActual = new Date().toISOString().slice(0, 7);

    const [stats] = await query(
      `SELECT
         SUM(CASE WHEN c.estado='pagado' AND c.periodo=? THEN c.monto_final ELSE 0 END) AS ingresos_mes,
         COUNT(CASE WHEN p.estado='pendiente_validacion' THEN 1 END)                    AS pendientes_validacion,
         COUNT(CASE WHEN c.estado='pagado' AND c.periodo=? THEN 1 END)                  AS pagados_mes,
         COUNT(CASE WHEN c.estado='vencido' THEN 1 END)                                 AS vencidos,
         COUNT(CASE WHEN c.estado='pendiente' THEN 1 END)                               AS por_cobrar
       FROM saas_cobros c
       LEFT JOIN saas_pagos p ON p.cobro_id = c.id`,
      [mesActual, mesActual]
    );

    // Ingresos últimos 6 meses
    const ingresosMeses = await query(
      `SELECT periodo,
              SUM(monto_final) AS total,
              COUNT(*) AS cantidad
       FROM saas_cobros
       WHERE estado='pagado'
         AND periodo >= DATE_FORMAT(NOW() - INTERVAL 6 MONTH, '%Y-%m')
       GROUP BY periodo ORDER BY periodo ASC`
    );

    // Clínicas próximas a vencer (7 días)
    const porVencer = await query(
      `SELECT t.id, tc.nombre_clinica, ss.fecha_vencimiento,
              DATEDIFF(ss.fecha_vencimiento, CURDATE()) AS dias_restantes,
              sp.nombre AS plan_nombre, pu.email
       FROM saas_suscripciones ss
       JOIN tenants t ON t.id = ss.tenant_id
       JOIN tenant_config tc ON tc.tenant_id = t.id
       JOIN saas_planes sp ON sp.id = ss.plan_id
       LEFT JOIN saas_portal_usuarios pu ON pu.tenant_id = t.id
       WHERE ss.fecha_vencimiento BETWEEN CURDATE() AND CURDATE() + INTERVAL 7 DAY
         AND ss.estado = 'activa'
       ORDER BY ss.fecha_vencimiento ASC`
    );

    // Cola de validación
    const colaValidacion = await query(
      `SELECT p.id, p.monto, p.metodo, p.fecha_operacion, p.numero_operacion,
              p.created_at, c.numero_cobro, c.periodo, c.meses,
              tc.nombre_clinica, pu.email,
              comp.url_blob AS comprobante_url
       FROM saas_pagos p
       JOIN saas_cobros c ON c.id = p.cobro_id
       JOIN tenant_config tc ON tc.tenant_id = p.tenant_id
       LEFT JOIN saas_portal_usuarios pu ON pu.tenant_id = p.tenant_id
       LEFT JOIN saas_comprobantes comp ON comp.pago_id = p.id
       WHERE p.estado = 'pendiente_validacion'
       ORDER BY p.created_at ASC`
    );

    return res.json({ success: true, data: { stats, ingresosMeses, porVencer, colaValidacion } });
  } catch (err) { next(err); }
});

// ── GET /api/admin/clientes ───────────────────────────────────
router.get('/clientes', async (req, res, next) => {
  try {
    const { estado, search } = req.query;
    let where = 'WHERE 1=1';
    const params = [];

    if (estado) { where += ' AND ss.estado = ?'; params.push(estado); }
    if (search) {
      where += ' AND (tc.nombre_clinica LIKE ? OR pu.email LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    const clientes = await query(
      `SELECT t.id AS tenant_id, t.slug, tc.nombre_clinica, tc.color_primario,
              ss.id AS sus_id, ss.estado AS sus_estado, ss.fecha_vencimiento,
              ss.precio_acordado, sp.nombre AS plan_nombre, sp.codigo AS plan_codigo,
              pu.email, pu.nombre AS contacto, pu.ultimo_acceso,
              DATEDIFF(ss.fecha_vencimiento, CURDATE()) AS dias_restantes,
              (SELECT COUNT(*) FROM saas_cobros sc WHERE sc.tenant_id=t.id AND sc.estado='pagado') AS total_pagos,
              (SELECT SUM(monto_final) FROM saas_cobros sc WHERE sc.tenant_id=t.id AND sc.estado='pagado') AS total_cobrado
       FROM tenants t
       JOIN tenant_config tc ON tc.tenant_id = t.id
       LEFT JOIN saas_suscripciones ss ON ss.tenant_id = t.id
       LEFT JOIN saas_planes sp ON sp.id = ss.plan_id
       LEFT JOIN saas_portal_usuarios pu ON pu.tenant_id = t.id
       ${where}
       ORDER BY ss.fecha_vencimiento ASC`,
      params
    );

    return res.json({ success: true, data: clientes });
  } catch (err) { next(err); }
});

// ── GET /api/admin/clientes/:id ───────────────────────────────
router.get('/clientes/:id', async (req, res, next) => {
  try {
    const tenantId = req.params.id;

    const cliente = await queryOne(
      `SELECT t.id, t.slug, t.activo, tc.nombre_clinica, tc.email, tc.telefono,
              tc.ruc, tc.direccion, tc.color_primario, tc.logo_url,
              ss.*, sp.nombre AS plan_nombre, sp.precio_mensual,
              pu.email AS portal_email, pu.nombre AS portal_nombre,
              pu.ultimo_acceso
       FROM tenants t
       JOIN tenant_config tc ON tc.tenant_id = t.id
       LEFT JOIN saas_suscripciones ss ON ss.tenant_id = t.id
       LEFT JOIN saas_planes sp ON sp.id = ss.plan_id
       LEFT JOIN saas_portal_usuarios pu ON pu.tenant_id = t.id
       WHERE t.id = ?`,
      [tenantId]
    );

    const historial = await query(
      `SELECT c.*, p.id AS pago_id, p.estado AS pago_estado, p.metodo,
              p.numero_operacion, p.monto AS pago_monto,
              p.numero_comprobante, p.fecha_aprobacion, p.notas_admin,
              p.created_at AS pago_fecha,
              comp.url_blob AS comprobante_url
       FROM saas_cobros c
       LEFT JOIN saas_pagos p ON p.cobro_id = c.id
         AND p.estado != 'rechazado'
       LEFT JOIN saas_comprobantes comp ON comp.pago_id = p.id
       WHERE c.tenant_id = ?
       ORDER BY c.id DESC`,
      [tenantId]
    );

    return res.json({ success: true, data: { cliente, historial } });
  } catch (err) { next(err); }
});

// ── POST /api/admin/pagos/:id/aprobar ─────────────────────────
router.post('/pagos/:id/aprobar', async (req, res, next) => {
  try {
    const { notas_admin } = req.body;
    const pago = await queryOne(
      `SELECT p.*, c.tenant_id, c.meses, c.numero_cobro, c.periodo
       FROM saas_pagos p JOIN saas_cobros c ON c.id = p.cobro_id
       WHERE p.id = ? AND p.estado = 'pendiente_validacion'`,
      [req.params.id]
    );
    if (!pago) return res.status(404).json({ success: false, message: 'Pago no encontrado.' });

    const numComp = await generarNumeroComprobante();

    await withTransaction(async (conn) => {
      // Aprobar pago
      await conn.execute(
        `UPDATE saas_pagos SET estado='aprobado', aprobado_por=?, fecha_aprobacion=NOW(),
           numero_comprobante=?, notas_admin=? WHERE id=?`,
        [req.admin.id, numComp, notas_admin || null, pago.id]
      );

      // Marcar cobro como pagado
      await conn.execute(
        'UPDATE saas_cobros SET estado=\'pagado\', fecha_pago=CURDATE() WHERE id=?',
        [pago.cobro_id]
      );

      // Extender período de suscripción
      await conn.execute(
        `UPDATE saas_suscripciones
         SET fecha_vencimiento = DATE_ADD(
           GREATEST(fecha_vencimiento, CURDATE()),
           INTERVAL ? MONTH
         ), estado = 'activa'
         WHERE tenant_id = ?`,
        [pago.meses, pago.tenant_id]
      );

      // Reactivar tenant si estaba suspendido
      await conn.execute(
        'UPDATE tenants SET activo=1 WHERE id=?',
        [pago.tenant_id]
      );

      // Sincronizar trial_hasta en tenant_config para el acceso al sistema veterinario
      const [[sus2]] = await conn.execute(
        'SELECT fecha_vencimiento FROM saas_suscripciones WHERE tenant_id=?',
        [pago.tenant_id]
      );
      if (sus2?.fecha_vencimiento) {
        await conn.execute(
          'UPDATE tenants SET trial_hasta=? WHERE id=?',
          [sus2.fecha_vencimiento, pago.tenant_id]
        );
      }

      // Auditoría
      await conn.execute(
        `INSERT INTO saas_auditoria (admin_id, accion, entidad, entidad_id, detalle, ip)
         VALUES (?,?,?,?,?,?)`,
        [req.admin.id, 'pago_aprobado', 'saas_pagos', pago.id,
         JSON.stringify({ numero_comprobante: numComp, meses: pago.meses }),
         req.ip]
      );
    });

    // Generar y subir PDF de comprobante
    const cliente = await queryOne(
      `SELECT tc.nombre_clinica, tc.ruc, tc.direccion, pu.email, pu.nombre,
              ss.fecha_vencimiento, sp.nombre AS plan_nombre
       FROM tenant_config tc
       LEFT JOIN saas_portal_usuarios pu ON pu.tenant_id = tc.tenant_id
       LEFT JOIN saas_suscripciones ss ON ss.tenant_id = tc.tenant_id
       LEFT JOIN saas_planes sp ON sp.id = ss.plan_id
       WHERE tc.tenant_id = ?`,
      [pago.tenant_id]
    );

    let pdfUrl = null;
    try {
      pdfUrl = await pdfService.generarComprobante({
        numero_comprobante: numComp,
        clinica_nombre    : cliente?.nombre_clinica,
        clinica_ruc       : cliente?.ruc,
        clinica_direccion : cliente?.direccion,
        plan_nombre       : cliente?.plan_nombre,
        meses             : pago.meses,
        monto             : pago.monto,
        metodo            : pago.metodo,
        periodo           : pago.periodo,
        fecha_aprobacion  : new Date(),
        fecha_vencimiento : cliente?.fecha_vencimiento,
        tenant_id         : pago.tenant_id,
        cobro_id          : pago.cobro_id,
      });
    } catch (e) {
      console.error('[Pagos PDF]', e.message);
    }

    // Enviar email de confirmación al cliente
    await emailService.enviarAprobacion({
      email             : cliente?.email,
      nombre            : cliente?.nombre,
      clinica_nombre    : cliente?.nombre_clinica,
      numero_comprobante: numComp,
      meses             : pago.meses,
      monto             : pago.monto,
      fecha_vencimiento : cliente?.fecha_vencimiento,
      pdf_url           : pdfUrl,
    });

    return res.json({ success: true, message: '✅ Pago aprobado y cliente notificado.', numero_comprobante: numComp });
  } catch (err) { next(err); }
});

// ── POST /api/admin/pagos/:id/rechazar ────────────────────────
router.post('/pagos/:id/rechazar', async (req, res, next) => {
  try {
    const { motivo } = req.body;
    if (!motivo?.trim())
      return res.status(422).json({ success: false, message: 'El motivo de rechazo es obligatorio.' });

    const pago = await queryOne(
      `SELECT p.*, c.tenant_id FROM saas_pagos p JOIN saas_cobros c ON c.id=p.cobro_id
       WHERE p.id=? AND p.estado='pendiente_validacion'`,
      [req.params.id]
    );
    if (!pago) return res.status(404).json({ success: false, message: 'Pago no encontrado.' });

    await query(
      `UPDATE saas_pagos SET estado='rechazado', motivo_rechazo=?,
         aprobado_por=?, fecha_aprobacion=NOW() WHERE id=?`,
      [motivo.trim(), req.admin.id, pago.id]
    );

    const cliente = await queryOne(
      `SELECT tc.nombre_clinica, pu.email, pu.nombre
       FROM tenant_config tc LEFT JOIN saas_portal_usuarios pu ON pu.tenant_id=tc.tenant_id
       WHERE tc.tenant_id=?`,
      [pago.tenant_id]
    );

    await emailService.enviarRechazo({
      email         : cliente?.email,
      nombre        : cliente?.nombre,
      clinica_nombre: cliente?.nombre_clinica,
      motivo        : motivo.trim(),
      monto         : pago.monto,
    });

    return res.json({ success: true, message: 'Pago rechazado y cliente notificado.' });
  } catch (err) { next(err); }
});

// ── POST /api/admin/cobros/generar ────────────────────────────
// Generar cobros manualmente (también lo hace el cron)
router.post('/cobros/generar', async (req, res, next) => {
  try {
    const cronService = require('../services/cron.service');
    const generados   = await cronService.generarCobrosMensuales();
    return res.json({ success: true, message: `✅ ${generados} cobros generados.`, generados });
  } catch (err) { next(err); }
});

// ── PUT /api/admin/clientes/:id/suscripcion ───────────────────
// Ajuste manual de fecha de vencimiento o plan
router.put('/clientes/:id/suscripcion', async (req, res, next) => {
  try {
    const { fecha_vencimiento, plan_id, precio_acordado, notas } = req.body;
    const sets  = [];
    const vals  = [];

    if (fecha_vencimiento) { sets.push('fecha_vencimiento=?'); vals.push(fecha_vencimiento); }
    if (plan_id)           { sets.push('plan_id=?');           vals.push(plan_id); }
    if (precio_acordado)   { sets.push('precio_acordado=?');   vals.push(precio_acordado); }
    if (notas !== undefined){ sets.push('notas_internas=?');   vals.push(notas); }

    if (!sets.length)
      return res.status(422).json({ success: false, message: 'Nada que actualizar.' });

    vals.push(req.params.id);
    await query(`UPDATE saas_suscripciones SET ${sets.join(',')} WHERE tenant_id=?`, vals);

    await query(
      `INSERT INTO saas_auditoria (admin_id, accion, entidad, entidad_id, detalle, ip)
       VALUES (?,?,?,?,?,?)`,
      [req.admin.id, 'suscripcion_ajustada', 'saas_suscripciones', req.params.id,
       JSON.stringify({ sets, fecha_vencimiento, plan_id }), req.ip]
    );

    return res.json({ success: true, message: 'Suscripción actualizada.' });
  } catch (err) { next(err); }
});

// ── POST /api/admin/clientes/:id/recordatorio ─────────────────
router.post('/clientes/:id/recordatorio', async (req, res, next) => {
  try {
    const cliente = await queryOne(
      `SELECT tc.nombre_clinica, pu.email, pu.nombre, ss.fecha_vencimiento,
              sp.nombre AS plan_nombre, ss.precio_acordado
       FROM tenant_config tc
       JOIN saas_portal_usuarios pu ON pu.tenant_id=tc.tenant_id
       JOIN saas_suscripciones ss ON ss.tenant_id=tc.tenant_id
       JOIN saas_planes sp ON sp.id=ss.plan_id
       WHERE tc.tenant_id=?`,
      [req.params.id]
    );
    if (!cliente) return res.status(404).json({ success: false, message: 'Cliente no encontrado.' });

    await emailService.enviarRecordatorio({
      email            : cliente.email,
      nombre           : cliente.nombre,
      clinica_nombre   : cliente.nombre_clinica,
      fecha_vencimiento: cliente.fecha_vencimiento,
      plan_nombre      : cliente.plan_nombre,
      monto            : cliente.precio_acordado,
      forzado          : true,
    });

    return res.json({ success: true, message: `✅ Recordatorio enviado a ${cliente.email}` });
  } catch (err) { next(err); }
});

// ── GET /api/admin/reportes/ingresos ──────────────────────────
router.get('/reportes/ingresos', async (req, res, next) => {
  try {
    const { desde, hasta } = req.query;
    const d = desde || new Date(new Date().getFullYear(), 0, 1).toISOString().split('T')[0];
    const h = hasta || new Date().toISOString().split('T')[0];

    const porMes = await query(
      `SELECT periodo, SUM(monto_final) AS total, COUNT(*) AS cantidad
       FROM saas_cobros WHERE estado='pagado'
         AND fecha_pago BETWEEN ? AND ?
       GROUP BY periodo ORDER BY periodo ASC`,
      [d, h]
    );

    const porPlan = await query(
      `SELECT sp.nombre AS plan, SUM(c.monto_final) AS total, COUNT(*) AS cantidad
       FROM saas_cobros c
       JOIN saas_suscripciones ss ON ss.tenant_id = c.tenant_id
       JOIN saas_planes sp ON sp.id = ss.plan_id
       WHERE c.estado='pagado' AND c.fecha_pago BETWEEN ? AND ?
       GROUP BY sp.id ORDER BY total DESC`,
      [d, h]
    );

    const [totales] = await query(
      `SELECT SUM(monto_final) AS total, COUNT(*) AS cantidad
       FROM saas_cobros WHERE estado='pagado' AND fecha_pago BETWEEN ? AND ?`,
      [d, h]
    );

    return res.json({ success: true, data: { porMes, porPlan, totales } });
  } catch (err) { next(err); }
});

// ── GET /api/admin/config ─────────────────────────────────────
router.get('/config', async (req, res, next) => {
  try {
    const rows = await query('SELECT clave, valor, descripcion FROM saas_config ORDER BY clave');
    const cfg  = {};
    rows.forEach(r => { cfg[r.clave] = r.valor; });
    return res.json({ success: true, data: cfg });
  } catch (err) { next(err); }
});

// ── PUT /api/admin/config ─────────────────────────────────────
router.put('/config', async (req, res, next) => {
  try {
    const { cambios } = req.body; // { clave: valor, ... }
    for (const [clave, valor] of Object.entries(cambios || {})) {
      await query(
        'INSERT INTO saas_config (clave, valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=?',
        [clave, valor, valor]
      );
    }
    return res.json({ success: true, message: 'Configuración guardada.' });
  } catch (err) { next(err); }
});

module.exports = router;