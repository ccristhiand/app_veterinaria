'use strict';

const { Router }      = require('express');
const { masterQuery } = require('../config/masterDB');
const router          = Router();

// GET /admin/api/logs
router.get('/', async (req, res) => {
  try {
    const {
      tenant_id, modulo, accion, resultado,
      usuario, desde, hasta,
      page = 1, limit = 50
    } = req.query;

    const limitN  = parseInt(limit)  || 50;
    const offsetN = (parseInt(page) - 1) * limitN;
    const params  = [];
    let where     = 'WHERE 1=1';

    if (tenant_id?.toString().trim()) { where += ' AND tenant_id = ?';         params.push(parseInt(tenant_id)); }
    if (modulo?.trim())               { where += ' AND modulo = ?';             params.push(modulo); }
    if (accion?.trim())               { where += ' AND accion LIKE ?';          params.push(`%${accion}%`); }
    if (resultado?.trim())            { where += ' AND resultado = ?';          params.push(resultado); }
    if (usuario?.trim())              { where += ' AND usuario_nombre LIKE ?';  params.push(`%${usuario}%`); }
    if (desde?.trim())                { where += ' AND created_at >= ?';        params.push(desde); }
    if (hasta?.trim())                { where += ' AND created_at <= ?';        params.push(hasta + ' 23:59:59'); }

    const countResult = await masterQuery(
      `SELECT COUNT(*) AS total FROM tenant_logs ${where}`, params
    );
    const total = countResult[0]?.total || 0;

    const logs = await masterQuery(
      `SELECT id, tenant_id, tenant_nombre, usuario_id, usuario_nombre, usuario_rol,
              accion, modulo, metodo_http, endpoint, ip,
              data_anterior, data_nueva, resultado, error_mensaje, duracion_ms, created_at
       FROM tenant_logs ${where}
       ORDER BY created_at DESC
       LIMIT ${limitN} OFFSET ${offsetN}`,
      params
    );

    return res.json({
      success: true,
      data   : logs,
      meta   : { total, page: parseInt(page), limit: limitN, pages: Math.ceil(total / limitN) }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /admin/api/logs/stats
router.get('/stats', async (req, res) => {
  try {
    const stats = await masterQuery(`
      SELECT modulo, accion, resultado, COUNT(*) AS total, DATE(created_at) AS fecha
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
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /admin/api/logs/:tenant_id
router.get('/:tenant_id', async (req, res) => {
  try {
    const { page = 1, limit = 50, modulo, accion } = req.query;
    const limitN  = parseInt(limit) || 50;
    const offsetN = (parseInt(page) - 1) * limitN;
    const params  = [parseInt(req.params.tenant_id)];
    let where     = 'WHERE tenant_id = ?';

    if (modulo?.trim()) { where += ' AND modulo = ?';      params.push(modulo); }
    if (accion?.trim()) { where += ' AND accion LIKE ?';   params.push(`%${accion}%`); }

    const countResult = await masterQuery(
      `SELECT COUNT(*) AS total FROM tenant_logs ${where}`, params
    );
    const total = countResult[0]?.total || 0;

    const logs = await masterQuery(
      `SELECT id, usuario_nombre, usuario_rol, accion, modulo,
              metodo_http, ip, data_anterior, data_nueva,
              resultado, error_mensaje, duracion_ms, created_at
       FROM tenant_logs ${where}
       ORDER BY created_at DESC
       LIMIT ${limitN} OFFSET ${offsetN}`,
      params
    );

    return res.json({
      success: true,
      data   : logs,
      meta   : { total, page: parseInt(page), limit: limitN, pages: Math.ceil(total / limitN) }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;