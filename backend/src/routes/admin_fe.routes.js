'use strict';

const { Router }    = require('express');
const { masterQuery } = require('../config/masterDB');
const { encrypt, decrypt, encryptIfNeeded } = require('../services/crypto.service');
const mysql         = require('mysql2/promise');
const router        = Router();

// Helper — conectar a la BD de un tenant
async function getTenantConn(tenantId) {
  const [t] = await masterQuery(
    'SELECT db_host, db_port, db_user, db_pass, db_name FROM tenants WHERE id=?',
    [tenantId]
  );
  if (!t) throw Object.assign(new Error('Tenant no encontrado.'), { status: 404 });
  const conn = await mysql.createConnection({
    host    : t.db_host,
    port    : t.db_port || 3306,
    user    : t.db_user,
    password: t.db_pass,
    database: t.db_name,
  });
  return conn;
}

// ── GET /admin/api/fe/resumen — todos los tenants con FE ──────────
router.get('/resumen', async (req, res) => {
  try {
    const tenants = await masterQuery(
      `SELECT t.id, t.slug, t.subdominio, t.activo,
              tc.nombre_clinica,
              tpf.docs_incluidos, tpf.docs_usados, tpf.mes_actual, tpf.precio_extra,
              tde.total_mes, tde.aceptados_mes
       FROM tenants t
       LEFT JOIN tenant_config tc ON tc.tenant_id = t.id
       LEFT JOIN tenant_plan_fe tpf ON tpf.tenant_id = t.id
       LEFT JOIN (
         SELECT tenant_id,
           COUNT(*) AS total_mes,
           SUM(CASE WHEN sunat_estado='0' THEN 1 ELSE 0 END) AS aceptados_mes
         FROM tenant_documentos_emitidos
         WHERE fecha >= DATE_FORMAT(NOW(),'%Y-%m-01')
         GROUP BY tenant_id
       ) tde ON tde.tenant_id = t.id
       ORDER BY tc.nombre_clinica`
    );
    return res.json({ success: true, data: tenants });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── GET /admin/api/fe/:tenant_id/config ───────────────────────────
router.get('/:tenant_id/config', async (req, res) => {
  let conn;
  try {
    conn = await getTenantConn(req.params.tenant_id);
    const [[cfg]] = await conn.execute('SELECT * FROM empresa_config LIMIT 1');
    if (!cfg) return res.status(404).json({ success: false, message: 'Config no encontrada.' });

    // No devolver credenciales — solo indicar si están configuradas
    return res.json({
      success: true,
      data: {
        sunat_activo      : !!cfg.sunat_activo,
        sunat_modo        : cfg.sunat_modo || 'beta',
        ose_proveedor     : cfg.ose_proveedor || 'nubefact',
        ubigeo            : cfg.ubigeo || null,
        fe_serie_boleta   : cfg.fe_serie_boleta || 'B001',
        fe_serie_factura  : cfg.fe_serie_factura || 'F001',
        fe_serie_nota_cred: cfg.fe_serie_nota_cred || 'BC01',
        ruc               : cfg.ruc || null,
        razon_social      : cfg.razon_social || null,
        nombre            : cfg.nombre || null,
        tiene_api_key     : !!cfg.ose_api_key,
        tiene_usuario_sol : !!cfg.sunat_usuario_sol,
        tiene_clave_sol   : !!cfg.sunat_clave_sol,
      },
    });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  } finally { await conn?.end(); }
});

// ── PUT /admin/api/fe/:tenant_id/config ───────────────────────────
router.put('/:tenant_id/config', async (req, res) => {
  let conn;
  try {
    const {
      sunat_activo, sunat_modo, ose_proveedor,
      ose_api_key, sunat_usuario_sol, sunat_clave_sol,
      ubigeo, fe_serie_boleta, fe_serie_factura, fe_serie_nota_cred,
    } = req.body;

    conn = await getTenantConn(req.params.tenant_id);

    const updates = {};
    if (sunat_activo !== undefined) updates.sunat_activo = sunat_activo ? 1 : 0;
    if (sunat_modo)        updates.sunat_modo         = sunat_modo;
    if (ose_proveedor)     updates.ose_proveedor      = ose_proveedor;
    if (ubigeo)            updates.ubigeo             = ubigeo;
    if (fe_serie_boleta)   updates.fe_serie_boleta    = fe_serie_boleta;
    if (fe_serie_factura)  updates.fe_serie_factura   = fe_serie_factura;
    if (fe_serie_nota_cred) updates.fe_serie_nota_cred = fe_serie_nota_cred;

    // Encriptar credenciales
    if (ose_api_key)       updates.ose_api_key       = encryptIfNeeded(ose_api_key);
    if (sunat_usuario_sol) updates.sunat_usuario_sol = encryptIfNeeded(sunat_usuario_sol);
    if (sunat_clave_sol)   updates.sunat_clave_sol   = encryptIfNeeded(sunat_clave_sol);

    if (!Object.keys(updates).length) {
      return res.status(422).json({ success: false, message: 'Sin cambios.' });
    }

    const setCols = Object.keys(updates).map(k => `${k}=?`).join(',');
    await conn.execute(
      `UPDATE empresa_config SET ${setCols} WHERE id=1`,
      Object.values(updates)
    );

    return res.json({ success: true, message: 'Configuración FE guardada.' });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  } finally { await conn?.end(); }
});

// ── POST /admin/api/fe/:tenant_id/activar ─────────────────────────
router.post('/:tenant_id/activar', async (req, res) => {
  let conn;
  try {
    conn = await getTenantConn(req.params.tenant_id);
    const [[cfg]] = await conn.execute(
      'SELECT ose_api_key, ruc, sunat_activo FROM empresa_config LIMIT 1'
    );
    if (!cfg?.ose_api_key) {
      return res.status(422).json({ success: false, message: 'Configura la API key de Nubefact antes de activar.' });
    }
    if (!cfg?.ruc) {
      return res.status(422).json({ success: false, message: 'Configura el RUC de la empresa antes de activar.' });
    }
    await conn.execute('UPDATE empresa_config SET sunat_activo=1 WHERE id=1');
    return res.json({ success: true, message: 'Facturación electrónica activada.' });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  } finally { await conn?.end(); }
});

// ── POST /admin/api/fe/:tenant_id/desactivar ──────────────────────
router.post('/:tenant_id/desactivar', async (req, res) => {
  let conn;
  try {
    conn = await getTenantConn(req.params.tenant_id);
    await conn.execute('UPDATE empresa_config SET sunat_activo=0 WHERE id=1');
    return res.json({ success: true, message: 'Facturación electrónica desactivada.' });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  } finally { await conn?.end(); }
});

// ── GET /admin/api/fe/:tenant_id/stats ────────────────────────────
router.get('/:tenant_id/stats', async (req, res) => {
  try {
    const mes = new Date().toISOString().slice(0, 7);

    const stats = await masterQuery(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN sunat_estado='0' THEN 1 ELSE 0 END) AS aceptados,
         SUM(CASE WHEN sunat_estado='anulado_sunat' THEN 1 ELSE 0 END) AS anulados,
         SUM(CASE WHEN sunat_estado IS NOT NULL AND sunat_estado != '0' AND sunat_estado != 'anulado_sunat' THEN 1 ELSE 0 END) AS con_error,
         SUM(CASE WHEN sunat_estado='0' THEN monto ELSE 0 END) AS monto_aceptado
       FROM tenant_documentos_emitidos
       WHERE tenant_id=? AND fecha LIKE ?`,
      [req.params.tenant_id, `${mes}%`]
    );

    const plan = await masterQuery(
      'SELECT * FROM tenant_plan_fe WHERE tenant_id=?',
      [req.params.tenant_id]
    );

    const historial = await masterQuery(
      `SELECT tipo, numero, fecha, monto, sunat_estado, created_at
       FROM tenant_documentos_emitidos
       WHERE tenant_id=?
       ORDER BY created_at DESC LIMIT 20`,
      [req.params.tenant_id]
    );

    return res.json({
      success: true,
      data: {
        stats   : stats[0] || {},
        plan    : plan[0]  || {},
        historial,
      },
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── PUT /admin/api/fe/:tenant_id/plan ─────────────────────────────
router.put('/:tenant_id/plan', async (req, res) => {
  try {
    const { docs_incluidos, precio_extra } = req.body;
    await masterQuery(
      `INSERT INTO tenant_plan_fe (tenant_id, docs_incluidos, precio_extra)
       VALUES (?,?,?)
       ON DUPLICATE KEY UPDATE
         docs_incluidos=VALUES(docs_incluidos),
         precio_extra=VALUES(precio_extra)`,
      [req.params.tenant_id, docs_incluidos || 50, precio_extra || 0.05]
    );
    return res.json({ success: true, message: 'Plan FE actualizado.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


// ── WA Config por tenant (admin) ──────────────────────────────
router.get('/:tenant_id/wa/config', async (req, res) => {
  try {
    const [cfg] = await masterQuery(
      'SELECT activo, ilimitado, msgs_incluidos, msgs_usados, mes_actual FROM wa_config_global WHERE tenant_id=?',
      [req.params.tenant_id]
    );
    return res.json({ success: true, data: cfg || { activo:0, ilimitado:0, msgs_incluidos:100, msgs_usados:0 } });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

router.put('/:tenant_id/wa/config', async (req, res) => {
  try {
    const { activo, ilimitado, msgs_incluidos } = req.body;
    await masterQuery(
      `INSERT INTO wa_config_global (tenant_id, activo, ilimitado, msgs_incluidos)
       VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE activo=VALUES(activo), ilimitado=VALUES(ilimitado), msgs_incluidos=VALUES(msgs_incluidos)`,
      [req.params.tenant_id, activo?1:0, ilimitado?1:0, msgs_incluidos||100]
    );
    // Actualizar wa_sesiones si existe
    await masterQuery(
      'INSERT IGNORE INTO wa_sesiones (tenant_id) VALUES (?)',
      [req.params.tenant_id]
    ).catch(()=>{});
    return res.json({ success:true, message:'Config WA guardada.' });
  } catch(err) { res.status(500).json({ success:false, message:err.message }); }
});

module.exports = router;