'use strict';

const { Router }  = require('express');
const multer      = require('multer');
const { BlobServiceClient } = require('@azure/storage-blob');
const { query, queryOne, withTransaction, generarNumeroComprobante } = require('../db');
const { authCliente } = require('../middlewares/auth.middleware');
const emailService    = require('../services/email.service');

const router  = Router();
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── GET /api/cobros/mi-cuenta ─────────────────────────────────
// Resumen de cuenta del cliente
router.get('/mi-cuenta', authCliente, async (req, res, next) => {
  try {
    const tenantId = req.user.tenant_id;

    const suscripcion = await queryOne(
      `SELECT ss.*, sp.nombre AS plan_nombre, sp.codigo AS plan_codigo,
              sp.precio_mensual, sp.max_usuarios, sp.wa_mensajes,
              tc.nombre_clinica
       FROM saas_suscripciones ss
       JOIN saas_planes sp ON sp.id = ss.plan_id
       JOIN tenant_config tc ON tc.tenant_id = ss.tenant_id
       WHERE ss.tenant_id = ?`,
      [tenantId]
    );

    // Días restantes
    const hoy       = new Date();
    const vence     = suscripcion ? new Date(suscripcion.fecha_vencimiento) : null;
    const diasRestantes = vence ? Math.ceil((vence - hoy) / (1000 * 60 * 60 * 24)) : 0;

    // Cobro pendiente actual
    const cobroPendiente = await queryOne(
      `SELECT * FROM saas_cobros WHERE tenant_id=? AND estado='pendiente' ORDER BY id DESC LIMIT 1`,
      [tenantId]
    );

    // Último pago
    const ultimoPago = await queryOne(
      `SELECT p.*, c.periodo FROM saas_pagos p
       JOIN saas_cobros c ON c.id = p.cobro_id
       WHERE p.tenant_id=? ORDER BY p.created_at DESC LIMIT 1`,
      [tenantId]
    );

    return res.json({
      success: true,
      data: { suscripcion, diasRestantes, cobroPendiente, ultimoPago },
    });
  } catch (err) { next(err); }
});

// ── GET /api/cobros/historial ─────────────────────────────────
router.get('/historial', authCliente, async (req, res, next) => {
  try {
    const rows = await query(
      `SELECT c.id, c.periodo, c.meses, c.monto_final, c.estado AS cobro_estado,
              c.fecha_emision, c.fecha_vencimiento, c.numero_cobro,
              p.id AS pago_id, p.estado AS pago_estado, p.metodo,
              p.fecha_operacion, p.numero_comprobante,
              comp.url_blob AS comprobante_url
       FROM saas_cobros c
       LEFT JOIN saas_pagos p ON p.cobro_id = c.id AND p.estado != 'rechazado'
       LEFT JOIN saas_comprobantes comp ON comp.pago_id = p.id AND comp.tipo='comprobante_sistema'
       WHERE c.tenant_id = ?
       ORDER BY c.id DESC`,
      [req.user.tenant_id]
    );
    return res.json({ success: true, data: rows });
  } catch (err) { next(err); }
});

// ── GET /api/cobros/calcular-descuento ───────────────────────
router.get('/calcular-descuento', authCliente, async (req, res, next) => {
  try {
    const { meses } = req.query;
    const n = parseInt(meses) || 1;

    const sus = await queryOne(
      'SELECT precio_acordado FROM saas_suscripciones WHERE tenant_id=?',
      [req.user.tenant_id]
    );
    if (!sus) return res.status(404).json({ success: false, message: 'Sin suscripción.' });

    const precioMes = parseFloat(sus.precio_acordado);
    const descs     = { 1: 0, 3: 10, 6: 13, 12: 20 };
    const pct       = descs[n] ?? (n >= 12 ? 20 : n >= 6 ? 13 : n >= 3 ? 10 : 0);
    const montoBase = precioMes * n;
    const ahorro    = montoBase * (pct / 100);
    const total     = montoBase - ahorro;

    return res.json({ success: true, data: { meses: n, precio_mes: precioMes, descuento_pct: pct, monto_base: montoBase, ahorro, total } });
  } catch (err) { next(err); }
});

// ── POST /api/cobros/:id/pagar — subir comprobante de pago ────
router.post('/:id/pagar', authCliente, upload.single('comprobante'), async (req, res, next) => {
  try {
    const { metodo, numero_operacion, banco_origen, fecha_operacion, notas_cliente, meses } = req.body;
    const cobro = await queryOne(
      `SELECT * FROM saas_cobros WHERE id=? AND tenant_id=? AND estado NOT IN ('pagado','anulado')`,
      [req.params.id, req.user.tenant_id]
    );
    if (!cobro) return res.status(404).json({ success: false, message: 'Cobro no encontrado.' });
    if (!req.file) return res.status(422).json({ success: false, message: 'Debes subir el comprobante de pago.' });
    if (!metodo)   return res.status(422).json({ success: false, message: 'Método de pago requerido.' });

    // Recalcular monto si paga más meses
    let montoPago = cobro.monto_final;
    let mesesPago = cobro.meses;
    if (meses && parseInt(meses) !== cobro.meses) {
      const sus     = await queryOne('SELECT precio_acordado FROM saas_suscripciones WHERE tenant_id=?', [req.user.tenant_id]);
      const n       = parseInt(meses);
      const descs   = { 1: 0, 3: 10, 6: 13, 12: 20 };
      const pct     = descs[n] ?? 0;
      const base    = parseFloat(sus.precio_acordado) * n;
      montoPago     = base - (base * pct / 100);
      mesesPago     = n;
      // Actualizar cobro con nuevos valores
      await query(
        'UPDATE saas_cobros SET meses=?, monto_final=?, descuento_pct=? WHERE id=?',
        [n, montoPago, descs[n] ?? 0, cobro.id]
      );
    }

    // Subir comprobante a Azure Blob
    let urlBlob = null;
    try {
      const blobService = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
      const container   = blobService.getContainerClient(process.env.AZURE_PAGOS_CONTAINER || 'vet-comprobantes');
      await container.createIfNotExists({ access: 'private' });
      const ext      = req.file.originalname.split('.').pop();
      const blobName = `comprobantes/${req.user.tenant_id}/${cobro.numero_cobro}-${Date.now()}.${ext}`;
      const blob     = container.getBlockBlobClient(blobName);
      await blob.uploadData(req.file.buffer, { blobHTTPHeaders: { blobContentType: req.file.mimetype } });
      urlBlob = blob.url;
    } catch (e) {
      console.error('[Pagos] Error subiendo comprobante:', e.message);
    }

    await withTransaction(async (conn) => {
      // Crear pago
      const [res2] = await conn.execute(
        `INSERT INTO saas_pagos
           (tenant_id, cobro_id, monto, metodo, numero_operacion, banco_origen,
            fecha_operacion, estado, notas_cliente)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [req.user.tenant_id, cobro.id, montoPago, metodo,
         numero_operacion || null, banco_origen || null,
         fecha_operacion || new Date().toISOString().split('T')[0],
         'pendiente_validacion', notas_cliente || null]
      );
      const pagoId = res2.insertId;

      // Registrar comprobante
      if (urlBlob) {
        await conn.execute(
          `INSERT INTO saas_comprobantes (pago_id, tenant_id, tipo, nombre_archivo, url_blob, mime_type, tamanio_bytes)
           VALUES (?,?,?,?,?,?,?)`,
          [pagoId, req.user.tenant_id, 'comprobante_cliente',
           req.file.originalname, urlBlob, req.file.mimetype, req.file.size]
        );
      }
    });

    // Notificar al admin
    await emailService.notificarAdminNuevoPago({
      clinica_nombre: req.user.clinica_nombre || 'Clínica',
      monto         : montoPago,
      metodo,
      numero_cobro  : cobro.numero_cobro,
    });

    return res.json({ success: true, message: '✅ Comprobante enviado. Validaremos tu pago en menos de 24 horas.' });
  } catch (err) { next(err); }
});

// ── GET /api/cobros/planes ─────────────────────────────────────
router.get('/planes', authCliente, async (req, res, next) => {
  try {
    const planes = await query('SELECT * FROM saas_planes WHERE activo=1 ORDER BY orden ASC');
    return res.json({ success: true, data: planes });
  } catch (err) { next(err); }
});


// ── GET /api/cobros/config-pago — datos públicos para el portal ──
// No requiere autenticación — solo devuelve datos de pago configurados
router.get('/config-pago', async (req, res, next) => {
  try {
    const claves = ['yape_numero','yape_nombre','banco_nombre','banco_cuenta',
                    'banco_cci','banco_titular','empresa_nombre'];
    const rows   = await query(
      `SELECT clave, valor FROM saas_config WHERE clave IN (${claves.map(() => '?').join(',')})`,
      claves
    );
    const cfg = {};
    rows.forEach(r => { cfg[r.clave] = r.valor; });
    return res.json({ success: true, data: cfg });
  } catch (err) { next(err); }
});


// ── POST /api/cobros/generar-adelantado ──────────────────────
// Genera un cobro para el próximo período si no hay uno pendiente
router.post('/generar-adelantado', authCliente, async (req, res, next) => {
  try {
    const tenantId = req.user.tenant_id;

    // Ver si ya tiene cobro pendiente o en revisión
    const [cobroExistente] = await query(
      `SELECT id FROM saas_cobros
       WHERE tenant_id=? AND estado IN ('pendiente','en_revision')
       ORDER BY id DESC LIMIT 1`,
      [tenantId]
    );
    if (cobroExistente) {
      return res.json({ success: true, data: cobroExistente, message: 'Cobro ya existe.' });
    }

    // Obtener suscripción
    const [sus] = await query(
      `SELECT ss.id, ss.precio_acordado, ss.fecha_vencimiento
       FROM saas_suscripciones ss WHERE ss.tenant_id=?`,
      [tenantId]
    );
    if (!sus) return res.status(404).json({ success: false, message: 'Sin suscripción activa.' });

    // Calcular próximo período
    const vence     = new Date(sus.fecha_vencimiento);
    const hoy       = new Date();
    const base      = vence > hoy ? vence : hoy;
    const proximoMes = new Date(base.getFullYear(), base.getMonth() + 1, 1);
    const periodo   = `${proximoMes.getFullYear()}-${String(proximoMes.getMonth() + 1).padStart(2,'0')}`;
    const fechaVence = new Date(base.getFullYear(), base.getMonth() + 2, 5).toISOString().split('T')[0];
    const hoyStr    = new Date().toISOString().split('T')[0];

    // Verificar que no exista ya ese período
    const [yaExiste] = await query(
      'SELECT id FROM saas_cobros WHERE tenant_id=? AND periodo=?',
      [tenantId, periodo]
    );
    if (yaExiste) {
      return res.json({ success: true, data: yaExiste, message: 'Cobro del período ya existe.' });
    }

    // Generar número de cobro
    const anio      = new Date().getFullYear();
    const [lastCob] = await query(
      `SELECT numero_cobro FROM saas_cobros WHERE numero_cobro LIKE ? ORDER BY id DESC LIMIT 1`,
      [`VN-${anio}-%`]
    );
    const siguiente   = lastCob ? parseInt(lastCob.numero_cobro.split('-')[2]) + 1 : 1;
    const numeroCobro = `VN-${anio}-${String(siguiente).padStart(4,'0')}`;

    // Crear cobro
    const result = await query(
      `INSERT INTO saas_cobros
         (tenant_id, suscripcion_id, periodo, meses, monto_base, descuento_pct,
          monto_final, estado, fecha_emision, fecha_vencimiento, numero_cobro)
       VALUES (?,?,?,1,?,0,?,'pendiente',?,?,?)`,
      [tenantId, sus.id, periodo, sus.precio_acordado, sus.precio_acordado,
       hoyStr, fechaVence, numeroCobro]
    );

    return res.json({
      success: true,
      data   : { id: result.insertId, numero_cobro: numeroCobro, periodo, monto_final: sus.precio_acordado },
      message: 'Cobro generado correctamente.',
    });
  } catch (err) { next(err); }
});

module.exports = router;