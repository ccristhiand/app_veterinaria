'use strict';

/**
 * VetClinic SaaS — Routes de Facturación Electrónica
 * Base: /api/v1/fe
 */

const { Router }  = require('express');
const { authenticate, authorize } = require('../middlewares/auth.middleware');
const { auditMiddleware } = require('../middlewares/audit.middleware');
const { decrypt, encrypt, encryptIfNeeded } = require('../services/crypto.service');
const { emitirComprobante, emitirNotaCredito, comunicacionBaja } = require('../services/nubefact.service');
const { generarPayload, generarPayloadNotaCredito } = require('../services/sunat.service');
const { masterQuery } = require('../config/masterDB');

const router = Router();
router.use(authenticate);

// ── Helpers ───────────────────────────────────────────────────────
async function getConfigFE(db) {
  const [cfg] = await db.query('SELECT * FROM empresa_config LIMIT 1');
  if (!cfg?.sunat_activo) throw Object.assign(new Error('Facturación electrónica no activada.'), { status: 422 });
  if (!cfg.ose_api_key)   throw Object.assign(new Error('API key de Nubefact no configurada.'), { status: 422 });
  if (!cfg.ruc)           throw Object.assign(new Error('RUC de la empresa no configurado.'), { status: 422 });
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
    // Incrementar contador del mes
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

// ── GET /api/v1/fe/config — obtener config FE del tenant ──────────
router.get('/config', async (req, res, next) => {
  try {
    const [cfg] = await req.db.query('SELECT * FROM empresa_config LIMIT 1');
    // No devolver credenciales encriptadas al frontend — solo estado
    return res.json({
      success: true,
      data: {
        sunat_activo     : !!cfg?.sunat_activo,
        sunat_modo       : cfg?.sunat_modo || 'beta',
        ose_proveedor    : cfg?.ose_proveedor || 'nubefact',
        ruc              : cfg?.ruc || null,
        razon_social     : cfg?.razon_social || null,
        ubigeo           : cfg?.ubigeo || null,
        fe_serie_boleta  : cfg?.fe_serie_boleta || 'B001',
        fe_serie_factura : cfg?.fe_serie_factura || 'F001',
        tiene_api_key    : !!cfg?.ose_api_key,
        tiene_usuario_sol: !!cfg?.sunat_usuario_sol,
        tiene_clave_sol  : !!cfg?.sunat_clave_sol,
      },
    });
  } catch (err) { next(err); }
});

// ── PUT /api/v1/fe/config — guardar config FE (solo admin) ────────
router.put('/config', authorize('admin'), async (req, res, next) => {
  try {
    const {
      sunat_activo, sunat_modo, ose_proveedor,
      ose_api_key, sunat_usuario_sol, sunat_clave_sol,
      ruc, razon_social, ubigeo,
      fe_serie_boleta, fe_serie_factura, fe_serie_nota_cred,
    } = req.body;

    // Validar RUC si se activa
    if (sunat_activo && ruc && !/^\d{11}$/.test(ruc)) {
      return res.status(422).json({ success: false, message: 'RUC inválido — debe tener 11 dígitos.' });
    }

    // Encriptar credenciales solo si se envían nuevas
    const updates = {
      sunat_activo   : sunat_activo ? 1 : 0,
      sunat_modo     : sunat_modo || 'beta',
      ose_proveedor  : ose_proveedor || 'nubefact',
      fe_serie_boleta : fe_serie_boleta || 'B001',
      fe_serie_factura: fe_serie_factura || 'F001',
      fe_serie_nota_cred: fe_serie_nota_cred || 'BC01',
    };

    if (ruc)            updates.ruc = ruc;
    if (razon_social)   updates.razon_social = razon_social;
    if (ubigeo)         updates.ubigeo = ubigeo;
    if (ose_api_key)    updates.ose_api_key = encryptIfNeeded(ose_api_key);
    if (sunat_usuario_sol) updates.sunat_usuario_sol = encryptIfNeeded(sunat_usuario_sol);
    if (sunat_clave_sol)   updates.sunat_clave_sol   = encryptIfNeeded(sunat_clave_sol);

    const setCols = Object.keys(updates).map(k => `${k}=?`).join(',');
    const vals    = [...Object.values(updates), 1];
    await req.db.query(`UPDATE empresa_config SET ${setCols} WHERE id=?`, vals);

    return res.json({ success: true, message: 'Configuración FE guardada.' });
  } catch (err) { next(err); }
});

// ── POST /api/v1/fe/emitir/:facturaId — emitir a SUNAT ───────────
router.post('/emitir/:facturaId', authorize('admin', 'veterinario', 'recepcionista'),
  auditMiddleware('facturacion:emitir_sunat', 'facturacion'),
  async (req, res, next) => {
  try {
    const cfg = await getConfigFE(req.db);

    // Verificar cuota del plan
    const tenantHost = req.headers['x-tenant-host'] || req.hostname;
    const [tenantInfo] = await masterQuery(
      `SELECT t.id AS tenant_id, tc.nombre_clinica, tpf.docs_incluidos, tpf.docs_usados, tpf.mes_actual
       FROM tenants t
       LEFT JOIN tenant_config tc ON tc.tenant_id = t.id
       LEFT JOIN tenant_plan_fe tpf ON tpf.tenant_id = t.id
       WHERE t.subdominio = ? LIMIT 1`,
      [tenantHost]
    ).catch(() => [null]);

    if (tenantInfo) {
      const mes = new Date().toISOString().slice(0, 7);
      const usados = tenantInfo.mes_actual === mes ? (tenantInfo.docs_usados || 0) : 0;
      const limite = tenantInfo.docs_incluidos || 50;
      if (usados >= limite) {
        return res.status(422).json({
          success: false,
          message: `Has alcanzado el límite de ${limite} documentos electrónicos del mes. Contacta al administrador para ampliar tu plan.`,
          code   : 'CUOTA_AGOTADA',
        });
      }
    }

    // Obtener factura completa
    const [factura] = await req.db.query(
      `SELECT f.*,
              CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre,
              p.dni, p.email AS propietario_email, p.direccion AS propietario_dir
       FROM facturas f
       JOIN propietarios p ON p.id = f.propietario_id
       WHERE f.id = ?`, [req.params.facturaId]
    );
    if (!factura) return res.status(404).json({ success: false, message: 'Factura no encontrada.' });
    if (factura.estado === 'anulado') return res.status(422).json({ success: false, message: 'No se puede emitir una factura anulada.' });
    if (factura.sunat_estado === '0') return res.status(422).json({ success: false, message: 'Este documento ya fue aceptado por SUNAT.' });

    // Validar datos para factura
    if (factura.tipo === 'factura') {
      if (!factura.cliente_ruc || !/^\d{11}$/.test(factura.cliente_ruc)) {
        return res.status(422).json({ success: false, message: 'Se requiere RUC válido del cliente para emitir factura.' });
      }
      if (!factura.cliente_razon_social) {
        return res.status(422).json({ success: false, message: 'Se requiere razón social del cliente para emitir factura.' });
      }
    }

    // Obtener items
    const items = await req.db.query(
      'SELECT * FROM factura_items WHERE factura_id = ? ORDER BY id',
      [req.params.facturaId]
    );

    // Generar payload para Nubefact
    const payload = generarPayload(factura, items, cfg);

    // Emitir a Nubefact
    const respuesta = await emitirComprobante(
      { apiKey: decrypt(cfg.ose_api_key), modo: cfg.sunat_modo, ruc: cfg.ruc },
      payload
    );

    if (respuesta.success) {
      const d = respuesta.data;
      // Guardar resultado exitoso
      await req.db.query(
        `UPDATE facturas SET
           sunat_estado     = '0',
           sunat_hash       = ?,
           sunat_cdr        = ?,
           xml_firmado      = ?,
           sunat_enviado_at = NOW(),
           sunat_mensaje    = 'Aceptado',
           enlace_pdf       = ?,
           enlace_xml       = ?
         WHERE id = ?`,
        [
          d.hash || null,
          JSON.stringify(d.cadena_para_codigo_qr || d),
          d.xml_formato_impresion || null,
          d.enlace_del_pdf || null,
          d.enlace_del_xml || null,
          factura.id,
        ]
      );

      // Registrar consumo en vet_master
      if (tenantInfo) {
        await registrarConsumoMaster(
          tenantInfo.tenant_id, tenantInfo.nombre_clinica,
          factura.tipo, factura.numero, factura.fecha,
          factura.total, '0'
        );
      }

      return res.json({
        success     : true,
        message     : `✅ Documento ${factura.numero} aceptado por SUNAT.`,
        data: {
          numero     : factura.numero,
          hash       : d.hash,
          enlace_pdf : d.enlace_del_pdf,
          enlace_xml : d.enlace_del_xml,
          qr         : d.cadena_para_codigo_qr,
        },
      });
    } else {
      // Error de SUNAT — guardar el error
      await req.db.query(
        `UPDATE facturas SET
           sunat_estado  = ?,
           sunat_mensaje = ?,
           sunat_enviado_at = NOW()
         WHERE id = ?`,
        [respuesta.codigo || 'error', respuesta.mensaje || 'Error desconocido', factura.id]
      );
      return res.status(422).json({
        success : false,
        message : `Error SUNAT ${respuesta.codigo}: ${respuesta.mensaje}`,
        codigo  : respuesta.codigo,
      });
    }
  } catch (err) { next(err); }
});

// ── POST /api/v1/fe/anular/:facturaId — nota crédito o baja ──────
router.post('/anular/:facturaId', authorize('admin'),
  auditMiddleware('facturacion:anular_sunat', 'facturacion'),
  async (req, res, next) => {
  try {
    const { motivo } = req.body;
    if (!motivo?.trim()) return res.status(422).json({ success: false, message: 'El motivo es obligatorio.' });

    const cfg = await getConfigFE(req.db);
    const [factura] = await req.db.query(
      `SELECT f.*,
              CONCAT(p.nombre,' ',p.apellido) AS propietario_nombre,
              p.dni, p.ruc AS propietario_ruc
       FROM facturas f
       JOIN propietarios p ON p.id = f.propietario_id
       WHERE f.id = ?`, [req.params.facturaId]
    );
    if (!factura) return res.status(404).json({ success: false, message: 'Factura no encontrada.' });
    if (factura.sunat_estado !== '0') {
      return res.status(422).json({ success: false, message: 'Solo se pueden anular documentos aceptados por SUNAT.' });
    }

    const nubefactConfig = { apiKey: decrypt(cfg.ose_api_key), modo: cfg.sunat_modo, ruc: cfg.ruc };
    let respuesta;

    if (factura.tipo === 'factura') {
      // Factura → Nota de Crédito
      const payload = generarPayloadNotaCredito(factura, motivo, cfg);
      respuesta = await emitirNotaCredito(nubefactConfig, payload);
    } else {
      // Boleta → Comunicación de Baja
      const [serie, numero] = factura.numero.split('-');
      respuesta = await comunicacionBaja(nubefactConfig, {
        tipo_de_comprobante: 2,
        serie,
        numero: parseInt(numero, 10),
        motivo : motivo.toUpperCase(),
        fecha  : factura.fecha,
      });
    }

    if (respuesta.success) {
      await req.db.query(
        `UPDATE facturas SET
           estado        = 'anulado',
           sunat_estado  = 'anulado_sunat',
           sunat_mensaje = ?,
           observaciones = ?,
           anulado_por   = ?,
           updated_at    = NOW()
         WHERE id = ?`,
        [`Anulado en SUNAT: ${motivo}`, motivo, req.user.nombre, factura.id]
      );

      // Restaurar stock de inventario
      const itemsInv = await req.db.query(
        'SELECT inventario_id, cantidad FROM factura_items WHERE factura_id = ? AND inventario_id IS NOT NULL',
        [factura.id]
      );
      for (const item of itemsInv) {
        await req.db.query(
          'UPDATE inventario SET cantidad = cantidad + ? WHERE id = ?',
          [item.cantidad, item.inventario_id]
        );
      }

      return res.json({ success: true, message: `✅ Documento anulado en SUNAT correctamente.` });
    } else {
      return res.status(422).json({
        success: false,
        message: `Error SUNAT: ${respuesta.mensaje}`,
      });
    }
  } catch (err) { next(err); }
});

// ── POST /api/v1/fe/reintentar/:facturaId — reintentar emisión ────
router.post('/reintentar/:facturaId', authorize('admin', 'recepcionista'),
  async (req, res, next) => {
  try {
    // Limpiar estado de error y reenviar
    await req.db.query(
      "UPDATE facturas SET sunat_estado = NULL, sunat_mensaje = NULL WHERE id = ? AND sunat_estado != '0'",
      [req.params.facturaId]
    );
    // Reusar el endpoint de emisión
    req.url = `/emitir/${req.params.facturaId}`;
    return router.handle(req, res, next);
  } catch (err) { next(err); }
});

// ── GET /api/v1/fe/stats — estadísticas FE del mes ───────────────
router.get('/stats', async (req, res, next) => {
  try {
    const mes = new Date().toISOString().slice(0, 7);
    const [stats] = await req.db.query(
      `SELECT
         COUNT(*) AS total_emitidos,
         SUM(CASE WHEN sunat_estado = '0' THEN 1 ELSE 0 END) AS aceptados,
         SUM(CASE WHEN sunat_estado IS NOT NULL AND sunat_estado != '0' AND sunat_estado != 'anulado_sunat' THEN 1 ELSE 0 END) AS con_error,
         SUM(CASE WHEN sunat_estado = 'anulado_sunat' THEN 1 ELSE 0 END) AS anulados,
         SUM(CASE WHEN sunat_estado IS NULL THEN 1 ELSE 0 END) AS pendientes_emision,
         SUM(CASE WHEN sunat_estado = '0' THEN total ELSE 0 END) AS monto_aceptado
       FROM facturas
       WHERE fecha LIKE ?`,
      [`${mes}%`]
    );
    return res.json({ success: true, data: stats });
  } catch (err) { next(err); }
});

module.exports = router;