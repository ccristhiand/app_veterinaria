'use strict';

/**
 * VetClinic SaaS — Routes de Facturación Electrónica
 * Base: /api/v1/fe
 */

const { Router }  = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditMiddleware } = require('../middlewares/audit.middleware');
const { emitirComprobante, anularComprobante } = require('../services/nubefact.service');
const { generarPayload, generarPayloadNotaCredito, generarPayloadBaja } = require('../services/sunat.service');
const { masterQuery } = require('../config/masterDB');

const router = Router();
router.use(authenticate);

// ── Helpers ───────────────────────────────────────────────────────
async function getConfigFE(db) {
  const [cfg] = await db.query('SELECT * FROM empresa_config LIMIT 1');
  if (!cfg?.sunat_activo)  throw Object.assign(new Error('Facturación electrónica no activada.'), { status: 422 });
  if (!cfg.nubefact_ruta)  throw Object.assign(new Error('Ruta de Nubefact no configurada. Configura desde el panel admin.'), { status: 422 });
  if (!cfg.nubefact_token) throw Object.assign(new Error('Token de Nubefact no configurado. Configura desde el panel admin.'), { status: 422 });
  if (!cfg.ruc)            throw Object.assign(new Error('RUC de la empresa no configurado.'), { status: 422 });
  return cfg;
}

async function registrarConsumoMaster(tenantId, tenantNombre, tipo, numero, fecha, monto, sunatEstado) {
  try {
    await masterQuery(
      `INSERT INTO tenant_documentos_emitidos
         (tenant_id, tenant_nombre, tipo, numero, fecha, monto, sunat_estado)
       VALUES (?,?,?,?,?,?,?)`,
      [tenantId, tenantNombre, tipo, numero, fecha, monto, sunatEstado]
    );
    const mes = new Date().toISOString().slice(0, 7);
    await masterQuery(
      `INSERT INTO tenant_plan_fe (tenant_id, mes_actual, docs_usados)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE
         docs_usados = IF(mes_actual = VALUES(mes_actual), docs_usados + 1, 1),
         mes_actual  = VALUES(mes_actual)`,
      [tenantId, mes]
    );
  } catch (e) {
    console.error('[FE] Error registrando consumo:', e.message);
  }
}

async function getTenantInfo(req) {
  const tenantHost = req.headers['x-tenant-host'] || req.hostname;
  const [info] = await masterQuery(
    `SELECT t.id AS tenant_id, tc.nombre_clinica, tpf.docs_incluidos, tpf.docs_usados, tpf.mes_actual
     FROM tenants t
     LEFT JOIN tenant_config tc ON tc.tenant_id = t.id
     LEFT JOIN tenant_plan_fe tpf ON tpf.tenant_id = t.id
     WHERE t.subdominio = ? LIMIT 1`,
    [tenantHost]
  ).catch(() => [null]);
  return info;
}

// ── GET /api/v1/fe/config ─────────────────────────────────────────
router.get('/config', async (req, res, next) => {
  try {
    const [cfg] = await req.db.query('SELECT * FROM empresa_config LIMIT 1');
    return res.json({
      success: true,
      data: {
        sunat_activo     : !!cfg?.sunat_activo,
        sunat_modo       : cfg?.sunat_modo || 'beta',
        ruc              : cfg?.ruc || null,
        razon_social     : cfg?.razon_social || null,
        ubigeo           : cfg?.ubigeo || null,
        fe_serie_boleta  : cfg?.fe_serie_boleta  || 'B001',
        fe_serie_factura : cfg?.fe_serie_factura || 'F001',
        tiene_ruta       : !!cfg?.nubefact_ruta,
        tiene_token      : !!cfg?.nubefact_token,
      },
    });
  } catch (err) { next(err); }
});

// ── PUT /api/v1/fe/config — solo admin ───────────────────────────
router.put('/config', authorize('admin'), async (req, res, next) => {
  try {
    const { sunat_activo, sunat_modo, ruc, razon_social, ubigeo,
            fe_serie_boleta, fe_serie_factura, fe_serie_nota_cred } = req.body;

    if (sunat_activo && ruc && !/^\d{11}$/.test(ruc)) {
      return res.status(422).json({ success: false, message: 'RUC inválido.' });
    }

    const updates = { sunat_modo: sunat_modo || 'beta' };
    if (sunat_activo !== undefined) updates.sunat_activo      = sunat_activo ? 1 : 0;
    if (ruc)                        updates.ruc               = ruc;
    if (razon_social)               updates.razon_social      = razon_social;
    if (ubigeo)                     updates.ubigeo            = ubigeo;
    if (fe_serie_boleta)            updates.fe_serie_boleta   = fe_serie_boleta;
    if (fe_serie_factura)           updates.fe_serie_factura  = fe_serie_factura;
    if (fe_serie_nota_cred)         updates.fe_serie_nota_cred= fe_serie_nota_cred;

    const setCols = Object.keys(updates).map(k => `${k}=?`).join(',');
    await req.db.query(`UPDATE empresa_config SET ${setCols} WHERE id=1`, Object.values(updates));

    return res.json({ success: true, message: 'Configuración FE guardada.' });
  } catch (err) { next(err); }
});

// ── POST /api/v1/fe/emitir/:facturaId ────────────────────────────
router.post('/emitir/:facturaId',
  authorize('admin', 'recepcionista'),
  auditMiddleware('facturacion:emitir_sunat', 'facturacion'),
  async (req, res, next) => {
  try {
    const cfg = await getConfigFE(req.db);

    // Verificar cuota
    const tenantInfo = await getTenantInfo(req);
    if (tenantInfo) {
      const mes    = new Date().toISOString().slice(0, 7);
      const usados = tenantInfo.mes_actual === mes ? (tenantInfo.docs_usados || 0) : 0;
      const limite = tenantInfo.docs_incluidos || 50;
      if (usados >= limite) {
        return res.status(422).json({
          success: false,
          message: `Has alcanzado el límite de ${limite} documentos electrónicos del mes.`,
          code   : 'CUOTA_AGOTADA',
        });
      }
    }

    // Obtener factura
    const [factura] = await req.db.query(
      `SELECT f.*,
              CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre,
              p.dni, p.email AS propietario_email, p.direccion AS propietario_dir
       FROM facturas f
       JOIN propietarios p ON p.id = f.propietario_id
       WHERE f.id = ?`, [req.params.facturaId]
    );
    if (!factura)                    return res.status(404).json({ success: false, message: 'Factura no encontrada.' });
    if (factura.estado === 'anulado') return res.status(422).json({ success: false, message: 'No se puede emitir una factura anulada.' });
    if (factura.sunat_estado === '0') return res.status(422).json({ success: false, message: 'Este documento ya fue aceptado por SUNAT.' });

    if (factura.tipo === 'factura') {
      if (!factura.cliente_ruc || !/^\d{11}$/.test(factura.cliente_ruc))
        return res.status(422).json({ success: false, message: 'Se requiere RUC válido del cliente.' });
      if (!factura.cliente_razon_social)
        return res.status(422).json({ success: false, message: 'Se requiere razón social del cliente.' });
    }

    const items = await req.db.query(
      'SELECT * FROM factura_items WHERE factura_id = ? ORDER BY id',
      [req.params.facturaId]
    );

    const { config: nubefactConfig, payload } = generarPayload(factura, items, cfg);
    const respuesta = await emitirComprobante(nubefactConfig, payload);

    if (respuesta.success) {
      const d = respuesta.data;
      await req.db.query(
        `UPDATE facturas SET
           sunat_estado     = '0',
           sunat_hash       = ?,
           sunat_cdr        = ?,
           sunat_enviado_at = NOW(),
           sunat_mensaje    = 'Aceptado',
           enlace_pdf       = ?,
           enlace_xml       = ?
         WHERE id = ?`,
        [
          d.codigo_hash || null,
          JSON.stringify(d.cadena_para_codigo_qr || ''),
          d.enlace_del_pdf || null,
          d.enlace_del_xml || null,
          factura.id,
        ]
      );

      if (tenantInfo) {
        await registrarConsumoMaster(
          tenantInfo.tenant_id, tenantInfo.nombre_clinica,
          factura.tipo, factura.numero, factura.fecha, factura.total, '0'
        );
      }

      return res.json({
        success: true,
        message: `✅ Documento ${factura.numero} aceptado por SUNAT.`,
        data: {
          numero    : factura.numero,
          hash      : d.codigo_hash,
          enlace_pdf: d.enlace_del_pdf,
          enlace_xml: d.enlace_del_xml,
          qr        : d.cadena_para_codigo_qr,
        },
      });
    } else {
      await req.db.query(
        `UPDATE facturas SET sunat_estado=?, sunat_mensaje=?, sunat_enviado_at=NOW() WHERE id=?`,
        [respuesta.codigo || 'error', respuesta.mensaje || 'Error desconocido', factura.id]
      );
      return res.status(422).json({
        success: false,
        message: `Error SUNAT ${respuesta.codigo}: ${respuesta.mensaje}`,
        codigo : respuesta.codigo,
      });
    }
  } catch (err) { next(err); }
});

// ── POST /api/v1/fe/anular/:facturaId — SOLO ADMIN ───────────────
// Solo para documentos YA ACEPTADOS por SUNAT (sunat_estado = '0')
// Genera Nota de Crédito (facturas) o Comunicación de Baja (boletas)
router.post('/anular/:facturaId',
  authorize('admin'),
  auditMiddleware('facturacion:anular_sunat', 'facturacion'),
  async (req, res, next) => {
  try {
    const { motivo } = req.body;
    if (!motivo?.trim()) return res.status(422).json({ success: false, message: 'El motivo de anulación es obligatorio.' });

    const cfg = await getConfigFE(req.db);

    const [factura] = await req.db.query(
      `SELECT f.*,
              CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre,
              p.dni
       FROM facturas f
       JOIN propietarios p ON p.id = f.propietario_id
       WHERE f.id = ?`, [req.params.facturaId]
    );
    if (!factura) return res.status(404).json({ success: false, message: 'Factura no encontrada.' });
    if (factura.sunat_estado !== '0') {
      return res.status(422).json({
        success: false,
        message: 'Solo se pueden anular documentos aceptados por SUNAT. Para documentos no emitidos usa la anulación interna.',
      });
    }
    if (factura.estado === 'anulado') {
      return res.status(422).json({ success: false, message: 'Este documento ya está anulado.' });
    }

    let respuesta;

    if (factura.tipo === 'factura') {
      // Factura → Nota de Crédito electrónica
      const { config: nubefactConfig, payload } = generarPayloadNotaCredito(
        factura, motivo.trim().toUpperCase(), cfg,
        cfg.fe_serie_nota_cred || 'BC01',
        await getCorrelativoNotaCredito(req.db)
      );
      respuesta = await anularComprobante(nubefactConfig, payload);
    } else {
      // Boleta → Comunicación de Baja
      const { config: nubefactConfig, payload } = generarPayloadBaja(
        factura, motivo.trim().toUpperCase(), cfg
      );
      respuesta = await anularComprobante(nubefactConfig, payload);
    }

    if (respuesta.success) {
      // Anular en BD + restaurar stock
      await req.db.query(
        `UPDATE facturas SET
           estado        = 'anulado',
           sunat_estado  = 'anulado_sunat',
           sunat_mensaje = ?,
           observaciones = ?,
           anulado_por   = ?,
           updated_at    = NOW()
         WHERE id = ?`,
        [`Anulado en SUNAT: ${motivo}`, motivo.trim(), req.user.nombre, factura.id]
      );

      // Restaurar stock de inventario
      const itemsInv = await req.db.query(
        'SELECT inventario_id, cantidad FROM factura_items WHERE factura_id = ? AND inventario_id IS NOT NULL',
        [factura.id]
      );
      for (const item of itemsInv) {
        await req.db.query(
          'UPDATE inventario SET cantidad = cantidad + ?, updated_at = NOW() WHERE id = ?',
          [item.cantidad, item.inventario_id]
        );
      }

      // Notificaciones admins
      const admins = await req.db.query("SELECT id FROM usuarios WHERE rol='admin' AND activo=1");
      const msg    = `${factura.tipo === 'factura' ? 'Factura' : 'Boleta'} ${factura.numero} anulada en SUNAT por ${req.user.nombre}. Motivo: ${motivo}`;
      for (const admin of admins) {
        await req.db.query(
          "INSERT INTO notificaciones (usuario_id, tipo, titulo, mensaje) VALUES (?, 'anulacion', '🚫 Documento anulado en SUNAT', ?)",
          [admin.id, msg]
        );
      }

      const io = req.app.get('io');
      if (io) io.to('sala:admin').emit('notif:anulacion', { titulo: '🚫 Anulado en SUNAT', mensaje: msg });

      return res.json({
        success: true,
        message: `✅ Documento ${factura.numero} anulado en SUNAT correctamente.`,
        data   : respuesta.data,
      });
    } else {
      return res.status(422).json({
        success: false,
        message: `Error al anular en SUNAT: ${respuesta.mensaje}`,
        codigo : respuesta.codigo,
      });
    }
  } catch (err) { next(err); }
});

// Correlativo para notas de crédito
async function getCorrelativoNotaCredito(db) {
  const [r] = await db.query(
    "SELECT COUNT(*) AS total FROM facturas WHERE tipo LIKE '%nota%' OR numero LIKE '%BC%' OR numero LIKE '%NC%'"
  );
  return (parseInt(r?.total || 0) + 1);
}

// ── GET /api/v1/fe/stats ─────────────────────────────────────────
router.get('/stats', async (req, res, next) => {
  try {
    const mes    = new Date().toISOString().slice(0, 7);
    const [stats] = await req.db.query(
      `SELECT
         COUNT(*) AS total_emitidos,
         SUM(CASE WHEN sunat_estado = '0'           THEN 1 ELSE 0 END) AS aceptados,
         SUM(CASE WHEN sunat_estado = 'anulado_sunat' THEN 1 ELSE 0 END) AS anulados,
         SUM(CASE WHEN sunat_estado IS NOT NULL AND sunat_estado != '0' AND sunat_estado != 'anulado_sunat' THEN 1 ELSE 0 END) AS con_error,
         SUM(CASE WHEN sunat_estado = '0' THEN total ELSE 0 END) AS monto_aceptado
       FROM facturas WHERE fecha LIKE ?`,
      [`${mes}%`]
    );
    return res.json({ success: true, data: stats });
  } catch (err) { next(err); }
});

module.exports = router;