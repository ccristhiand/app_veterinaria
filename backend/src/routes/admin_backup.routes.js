'use strict';

const { Router }      = require('express');
const { masterQuery } = require('../config/masterDB');
const router          = Router();

// Lazy load del job para no bloquear el inicio
function getBackupJob() {
  return require('../jobs/backup.job');
}

// GET /admin/api/backups — historial
router.get('/', async (req, res) => {
  try {
    const { tenant_id, estado, tipo, page = 1, limit = 50 } = req.query;
    const limitN  = parseInt(limit) || 50;
    const offsetN = (parseInt(page) - 1) * limitN;
    const params  = [];
    let where     = 'WHERE 1=1';

    if (tenant_id?.toString().trim()) { where += ' AND tenant_id=?'; params.push(parseInt(tenant_id)); }
    if (estado?.trim())               { where += ' AND estado=?';    params.push(estado); }
    if (tipo?.trim())                 { where += ' AND tipo=?';      params.push(tipo); }

    const countResult = await masterQuery(
      `SELECT COUNT(*) AS total FROM tenant_backups ${where}`, params
    );
    const total = countResult[0]?.total || 0;

    const backups = await masterQuery(
      `SELECT b.*, t.subdominio
       FROM tenant_backups b
       LEFT JOIN tenants t ON t.id = b.tenant_id
       ${where} ORDER BY b.created_at DESC
       LIMIT ${limitN} OFFSET ${offsetN}`,
      params
    );

    return res.json({
      success: true,
      data   : backups,
      meta   : { total, page: parseInt(page), limit: limitN, pages: Math.ceil(total / limitN) }
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /admin/api/backups/stats
router.get('/stats', async (req, res) => {
  try {
    const stats = await masterQuery(`
      SELECT tenant_id, tenant_nombre,
        COUNT(*) AS total,
        SUM(CASE WHEN estado='exitoso' THEN 1 ELSE 0 END) AS exitosos,
        SUM(CASE WHEN estado='fallido' THEN 1 ELSE 0 END) AS fallidos,
        MAX(CASE WHEN estado='exitoso' THEN created_at END) AS ultimo_exitoso,
        SUM(CASE WHEN estado='exitoso' THEN tamaño_mb ELSE 0 END) AS total_mb
      FROM tenant_backups
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY tenant_id, tenant_nombre
      ORDER BY ultimo_exitoso DESC
    `);

    const totalResult = await masterQuery(
      `SELECT ROUND(SUM(tamaño_mb) / 1024, 2) AS total_gb
       FROM tenant_backups WHERE estado='exitoso'`
    );

    return res.json({
      success: true,
      data   : { stats, total_gb: totalResult[0]?.total_gb || 0 }
    });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// GET /admin/api/backups/config
router.get('/config', async (req, res) => {
  try {
    const config = await masterQuery(
      `SELECT tbc.*, tc.nombre_clinica, t.subdominio
       FROM tenant_backup_config tbc
       JOIN tenants t ON t.id = tbc.tenant_id
       LEFT JOIN tenant_config tc ON tc.tenant_id = tbc.tenant_id
       ORDER BY tc.nombre_clinica`
    );
    return res.json({ success: true, data: config });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PUT /admin/api/backups/config/:tenant_id
router.put('/config/:tenant_id', async (req, res) => {
  try {
    const { activo, hora_backup, retener_diarios, retener_semanales, retener_mensuales } = req.body;
    await masterQuery(
      `INSERT INTO tenant_backup_config
         (tenant_id, activo, hora_backup, retener_diarios, retener_semanales, retener_mensuales)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         activo=VALUES(activo), hora_backup=VALUES(hora_backup),
         retener_diarios=VALUES(retener_diarios),
         retener_semanales=VALUES(retener_semanales),
         retener_mensuales=VALUES(retener_mensuales)`,
      [req.params.tenant_id, activo?1:0, hora_backup||'02:00:00',
       retener_diarios||7, retener_semanales||4, retener_mensuales||3]
    );
    return res.json({ success: true, message: 'Configuración guardada.' });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /admin/api/backups/manual/:tenant_id — backup de una clínica
router.post('/manual/:tenant_id', async (req, res) => {
  try {
    const [tenant] = await masterQuery(
      `SELECT t.*, tc.nombre_clinica
       FROM tenants t
       LEFT JOIN tenant_config tc ON tc.tenant_id = t.id
       WHERE t.id=? AND t.activo=1`,
      [req.params.tenant_id]
    );
    if (!tenant) return res.status(404).json({ success: false, message: 'Tenant no encontrado.' });

    // Responder inmediatamente y ejecutar en background
    res.json({ success: true, message: `Backup de ${tenant.nombre_clinica} iniciado.` });

    // Ejecutar en background sin bloquear
    const { backupTenant } = getBackupJob();
    backupTenant(tenant, 'manual').catch(err =>
      console.error('[backup] Error manual:', err.message)
    );
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// POST /admin/api/backups/manual-all — backup de todas las clínicas
router.post('/manual-all', async (req, res) => {
  try {
    res.json({ success: true, message: 'Backup general iniciado. Puedes seguir el progreso en el historial.' });

    const { backupTodos } = getBackupJob();
    backupTodos('manual').catch(err =>
      console.error('[backup] Error manual-all:', err.message)
    );
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;