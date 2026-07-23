'use strict';

/**
 * Rutas de logs para el panel admin SaaS
 * GET /admin/api/logs
 * GET /admin/api/logs/:tenant_id
 */

const { Router }     = require('express');
const { masterQuery } = require('../config/masterDB');
const router          = Router();

// GET /admin/api/logs — todos los logs con filtros
router.get('/', async (req, res) => {
  try {
    const {
      tenant_id, modulo, accion, resultado,
      usuario, desde, hasta,
      page = 1, limit = 50
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    let where    = 'WHERE 1=1';

    if (tenant_id?.trim()) { where += ' AND tenant_id = ?';    params.push(tenant_id); }
    if (modulo?.trim())    { where += ' AND modulo = ?';        params.push(modulo); }
    if (accion?.trim())    { where += ' AND accion LIKE ?';     params.push(`%${accion}%`); }
    if (resultado?.trim()) { where += ' AND resultado = ?';     params.push(resultado); }
    if (usuario?.trim())   { where += ' AND usuario_nombre LIKE ?'; params.push(`%${usuario}%`); }
    if (desde?.trim())     { where += ' AND created_at >= ?';   params.push(desde); }
    if (hasta?.trim())     { where += ' AND created_at <= ?';   params.push(hasta+' 23:59:59'); }

    const [{ total }] = await masterQuery(
      `SELECT COUNT(*) AS total FROM tenant_logs ${where}`, params
    );

    const logs = await masterQuery(
      `SELECT id, tenant_id, tenant_nombre, usuario_id, usuario_nombre, usuario_rol,
              accion, modulo, metodo_http, endpoint, ip,
              data_anterior, data_nueva, resultado, error_mensaje, duracion_ms, created_at
       FROM tenant_logs ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    return res.json({
      success: true,
      data   : logs,
      meta   : { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total/limit) }
    });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /admin/api/logs/stats — estadísticas de logs
router.get('/stats', async (req, res) => {
  try {
    const stats = await masterQuery(`
      SELECT
        modulo,
        accion,
        resultado,
        COUNT(*) AS total,
        DATE(created_at) AS fecha
      FROM tenant_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY modulo, accion, resultado, DATE(created_at)
      ORDER BY fecha DESC, total DESC
    `);

    const errores = await masterQuery(`
      SELECT tenant_nombre, accion, error_mensaje, COUNT(*) AS total
      FROM tenant_logs
      WHERE resultado = 'error' AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      GROUP BY tenant_nombre, accion, error_mensaje
      ORDER BY total DESC
      LIMIT 10
    `);

    const actividad = await masterQuery(`
      SELECT tenant_nombre, COUNT(*) AS acciones,
             COUNT(DISTINCT usuario_id) AS usuarios_activos
      FROM tenant_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      GROUP BY tenant_nombre
      ORDER BY acciones DESC
    `);

    return res.json({ success: true, data: { stats, errores, actividad } });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /admin/api/logs/:tenant_id — logs de un tenant específico
router.get('/:tenant_id', async (req, res) => {
  try {
    const { page = 1, limit = 50, modulo, accion } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [req.params.tenant_id];
    let where = 'WHERE tenant_id = ?';

    if (modulo) { where += ' AND modulo = ?'; params.push(modulo); }
    if (accion) { where += ' AND accion LIKE ?'; params.push(`%${accion}%`); }

    const [{ total }] = await masterQuery(
      `SELECT COUNT(*) AS total FROM tenant_logs ${where}`, params
    );

    const logs = await masterQuery(
      `SELECT id, usuario_nombre, usuario_rol, accion, modulo,
              metodo_http, ip, data_anterior, data_nueva,
              resultado, error_mensaje, duracion_ms, created_at
       FROM tenant_logs ${where}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    return res.json({
      success: true,
      data   : logs,
      meta   : { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total/limit) }
    });
  } catch(err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;